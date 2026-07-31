// scripts/reset-demo.js — 演示数据一键还原（安全清空 + 重新播种）
// 用途：一键恢复演示数据到初始状态
// 用法：node scripts/reset-demo.js
// 安全: 仅操作白名单表，需数据库名匹配或 DEMO_RESET_ALLOWED=true

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
if (process.env.DATABASE_URL) DATABASE_URL = process.env.DATABASE_URL;

// ====== 安全检查 ======
const ALLOWED_DB_NAMES = ['inventory_demo', 'inventory_demo_test'];
const FORBIDDEN_DB_NAMES = ['metabase_data', 'postgres', 'template0', 'template1'];

function extractDbName(connStr) {
  try {
    const url = new URL(connStr);
    return url.pathname.replace(/^\//, '');
  } catch {
    // fallback: 从字符串末尾提取
    const m = connStr.match(/\/([^/?]+)(\?|$)/);
    return m ? m[1] : '';
  }
}

function safetyCheck(dbName) {
  // 绝对禁止操作 metabase 等库
  if (FORBIDDEN_DB_NAMES.includes(dbName)) {
    console.error(`❌ 安全拒绝: 数据库 "${dbName}" 是受保护数据库，禁止操作！`);
    process.exit(1);
  }

  // 如果设置了 DEMO_RESET_ALLOWED=true，允许操作任何非禁止库
  if (process.env.DEMO_RESET_ALLOWED === 'true') {
    console.log(`⚠️  DEMO_RESET_ALLOWED=true，允许操作数据库 "${dbName}"`);
    return;
  }

  // 否则数据库名必须在白名单中
  if (!ALLOWED_DB_NAMES.includes(dbName)) {
    console.error(`❌ 安全拒绝: 数据库名 "${dbName}" 不在允许列表中`);
    console.error(`   允许的数据库: ${ALLOWED_DB_NAMES.join(', ')}`);
    console.error(`   或设置环境变量 DEMO_RESET_ALLOWED=true`);
    process.exit(1);
  }
}

// ====== 白名单表 ======
const TABLES_WHITELIST = [
  'users',
  'suppliers',
  'products',
  'inbound_records',
  'outbound_records',
  'change_log',
  'product_notes',
  'milestones',
];

(async () => {
  const dbName = extractDbName(DATABASE_URL);
  console.log('====== 演示数据重置 ======\n');
  console.log(`目标数据库: ${dbName}`);

  // 安全检查
  safetyCheck(dbName);

  const pool = new Pool({ connectionString: DATABASE_URL });

  // 1. 验证白名单表存在，然后清空
  const { rows } = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public'");
  const existingTables = new Set(rows.map(r => r.tablename));

  const tablesToTruncate = TABLES_WHITELIST.filter(t => existingTables.has(t));
  const missingTables = TABLES_WHITELIST.filter(t => !existingTables.has(t));

  if (missingTables.length > 0) {
    console.log(`⚠️  以下表不存在（将由 seed 创建）: ${missingTables.join(', ')}`);
  }

  if (tablesToTruncate.length > 0) {
    console.log(`将清空表: ${tablesToTruncate.join(', ')}`);
    await pool.query(
      `TRUNCATE ${tablesToTruncate.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`
    );
    console.log('✅ 白名单表已清空（含自增ID重置）\n');
  } else {
    console.log('✅ 无需清空（表不存在）\n');
  }

  await pool.end();

  // 2. 重新播种（seed 本身产生精确值，无需后续补丁）
  console.log('--- 重新播种 ---');
  execSync(`node "${path.join(__dirname, 'seed-demo.js')}"`, { stdio: 'inherit' });

  // 3. 验证关键数字
  const check = new Pool({ connectionString: DATABASE_URL });
  const p = await check.query('SELECT COUNT(*) c FROM products');
  const i = await check.query('SELECT COUNT(*) c FROM inbound_records');
  const o = await check.query('SELECT COUNT(*) c FROM outbound_records');
  const ms = await check.query('SELECT COUNT(*) c FROM milestones');
  const s = await check.query(`SELECT p.name, p.spec,
    COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE product_id=p.id),0)
    - COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE product_id=p.id),0) AS stock
    FROM products p WHERE p.name LIKE '%截止阀%' AND p.spec LIKE '%DN50%'`);
  const s2 = await check.query(`SELECT p.name, p.spec,
    COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE product_id=p.id),0)
    - COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE product_id=p.id),0) AS stock
    FROM products p WHERE p.name LIKE '%轴接地阳极%'`);
  const s3 = await check.query(`SELECT p.name, p.spec,
    COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE product_id=p.id),0)
    - COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE product_id=p.id),0) AS stock
    FROM products p WHERE p.name LIKE '%球阀%' AND p.spec LIKE '%DN25%'`);

  console.log('\n--- 重置后验证 ---');
  console.log(`备件: ${p.rows[0].c} | 入库: ${i.rows[0].c} | 出库: ${o.rows[0].c} | 里程碑: ${ms.rows[0].c}`);
  console.log(`锚点 截止阀DN50: 库存=${s.rows[0]?.stock}（期望=4）`);
  console.log(`锚点 轴接地阳极: 库存=${s2.rows[0]?.stock}（期望=21）`);
  console.log(`锚点 球阀DN25: 库存=${s3.rows[0]?.stock}（期望=2）`);
  await check.end();
  console.log('\n🎉 演示数据已恢复出厂状态');
})().catch(e => { console.error('❌ 重置失败:', e.message); process.exit(1); });
