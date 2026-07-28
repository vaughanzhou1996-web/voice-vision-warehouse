// scripts/reset-demo.js — 演示数据一键还原（清空全部表 + 重新播种）
// 用途：演示日/提交前恢复出厂数据；评审 clone 后想重置也可用
// 用法：node scripts/reset-demo.js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let DATABASE_URL = 'postgres://localhost:5432/inventory_demo';
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const m = fs.readFileSync(envPath, 'utf8').match(/DATABASE_URL=(\S+)/);
  if (m) DATABASE_URL = m[1];
}

(async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  console.log('====== 演示数据重置 ======\n');

  // 1. 查出 public 下所有表，全部清空
  const { rows } = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public'");
  const tables = rows.map(r => r.tablename);
  console.log('将清空表:', tables.join(', '));
  await pool.query(`TRUNCATE ${tables.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  console.log('✅ 全部表已清空（含自增ID重置）\n');
  await pool.end();

  // 2. 重新播种
  console.log('--- 重新播种 ---');
  execSync(`node "${path.join(__dirname, 'seed-demo.js')}"`, { stdio: 'inherit' });

  // 2.5 主演示备件保底：手册示例/对话演示要用的备件，库存必须 ≥ 演示基线
  console.log('\n--- 主演示备件保底检查 ---');
  const guard = new Pool({ connectionString: DATABASE_URL });
  // 保底基线与卡11预埋断料案例联动：必须 ≥对话演示所需 且 <计划出库量(保持断料剧情)
  const HEROES = [
    { like: '%截止阀%', spec: '%DN50%', min: 4 },  // 对话出3剩1 + 计划5断料（差1只）
    { like: '%球阀%', spec: '%DN25%', min: 2 },    // 语音查询有货 + 计划5断料
  ];
  for (const h of HEROES) {
    const r = await guard.query(`SELECT p.id, p.name, p.spec,
      COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE product_id=p.id),0)
      - COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE product_id=p.id),0) AS stock
      FROM products p WHERE p.name LIKE $1 AND p.spec LIKE $2 LIMIT 1`, [h.like, h.spec]);
    if (!r.rows[0]) { console.log(`⚠️ 未找到 ${h.like}${h.spec}`); continue; }
    const cur = parseFloat(r.rows[0].stock);
    if (cur < h.min) {
      await guard.query(
        'INSERT INTO inbound_records (product_id, quantity, remark) VALUES ($1,$2,$3)',
        [r.rows[0].id, h.min - cur, '演示保底补录']);
      console.log(`✅ ${r.rows[0].name} ${r.rows[0].spec}: ${cur} → ${h.min}（补录 ${h.min - cur}）`);
    } else {
      console.log(`✅ ${r.rows[0].name} ${r.rows[0].spec}: 库存 ${cur} ≥ ${h.min}，无需补录`);
    }
  }
  await guard.end();

  // 3. 验证关键数字
  const check = new Pool({ connectionString: DATABASE_URL });
  const p = await check.query('SELECT COUNT(*) c FROM products');
  const i = await check.query('SELECT COUNT(*) c FROM inbound_records');
  const o = await check.query('SELECT COUNT(*) c FROM outbound_records');
  const s = await check.query(`SELECT p.name,
    COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE product_id=p.id),0)
    - COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE product_id=p.id),0) AS stock
    FROM products p WHERE p.name LIKE '%截止阀%' AND p.spec LIKE '%DN50%'`);
  console.log('\n--- 重置后验证 ---');
  console.log(`备件: ${p.rows[0].c} | 入库: ${i.rows[0].c} | 出库: ${o.rows[0].c}`);
  console.log(`抽查 截止阀DN50: 库存=${s.rows[0]?.stock}（保底≥6）`);
  await check.end();
  console.log('\n🎉 演示数据已恢复出厂状态');
})().catch(e => { console.error('❌ 重置失败:', e.message); process.exit(1); });
