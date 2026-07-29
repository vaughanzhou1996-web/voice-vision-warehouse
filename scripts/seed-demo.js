/**
 * seed-demo.js — 虚构演示数据种子脚本
 * 用法: node scripts/seed-demo.js
 * 幂等: 重跑时先清空业务表再插入
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// ====== 读取 .env ======
const envPath = path.join(__dirname, '..', '.env');
let DATABASE_URL = 'postgres://localhost:5432/inventory_demo';
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  const m = envContent.match(/DATABASE_URL=(\S+)/);
  if (m) DATABASE_URL = m[1];
}
if (process.env.DATABASE_URL) DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({ connectionString: DATABASE_URL });

// ====== 密码哈希 (SHA-256) ======
function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}

// ====== 建表 SQL（与 server.js 结构一致）======
const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  display_name VARCHAR(100) DEFAULT '',
  role VARCHAR(50) DEFAULT 'user'
);

CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  spec VARCHAR(300) DEFAULT '',
  unit VARCHAR(50) DEFAULT '个',
  supplier_id INTEGER REFERENCES suppliers(id),
  project_no VARCHAR(50) DEFAULT 'YY01'
);

CREATE TABLE IF NOT EXISTS inbound_records (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id),
  quantity NUMERIC(12,2) NOT NULL,
  date DATE,
  operator VARCHAR(100) DEFAULT '',
  remark TEXT DEFAULT '',
  doc_type VARCHAR(50) DEFAULT '入库单',
  doc_ref VARCHAR(200) DEFAULT '',
  doc_image_path TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outbound_records (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id),
  quantity NUMERIC(12,2) NOT NULL,
  date DATE,
  department VARCHAR(100) DEFAULT '',
  remark TEXT DEFAULT '',
  doc_type VARCHAR(50) DEFAULT '出库单',
  doc_ref VARCHAR(200) DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS change_log (
  id SERIAL PRIMARY KEY,
  action_type VARCHAR(50),
  product_id INTEGER,
  product_name VARCHAR(200),
  product_spec VARCHAR(300),
  quantity NUMERIC(12,2),
  quantity_before NUMERIC(12,2),
  quantity_after NUMERIC(12,2),
  operator VARCHAR(100),
  details TEXT DEFAULT '',
  ref_table VARCHAR(50) DEFAULT '',
  ref_record_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_notes (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id),
  content TEXT NOT NULL,
  qty NUMERIC(12,2) DEFAULT 0,
  created_by VARCHAR(100) DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW()
);
`;

// ====== 虚构数据定义 ======

const SUPPLIERS = ['蓝海阀门', '远航机械', '海德密封', '沪东泵业', '明珠电气'];

const USERS = [
  { username: 'caojie', password: 'demo1234', display_name: '曹洁', role: 'admin' },
  { username: 'zhangwei', password: 'demo1234', display_name: '张威', role: 'leader' },
  { username: 'chenjun', password: 'demo1234', display_name: '陈俊', role: 'analyst' },
  { username: 'hezong', password: 'demo1234', display_name: '何总', role: 'executive' },
];

// 备件定义: [name, spec, unit, supplierIdx(0-4), category]
const PRODUCTS_DEF = [
  // === 阀门类 (supplier: 蓝海阀门 idx=0) ===
  ['截止阀', 'GB/T587 DN50 PN16', '只', 0, '阀门类'],
  ['截止阀', 'GB/T587 DN80 PN16', '只', 0, '阀门类'],
  ['截止阀', 'GB/T587 DN100 PN25', '只', 0, '阀门类'],
  ['闸阀', 'GB/T12232 DN65 PN16', '只', 0, '阀门类'],
  ['闸阀', 'GB/T12232 DN100 PN16', '只', 0, '阀门类'],
  ['闸阀', 'GB/T12232 DN150 PN10', '只', 0, '阀门类'],
  ['球阀', 'Q41F-16C DN25', '只', 0, '阀门类'],
  ['球阀', 'Q41F-16C DN50', '只', 0, '阀门类'],
  ['蝶阀', 'D71X-16 DN200', '只', 0, '阀门类'],
  ['蝶阀', 'D71X-16 DN300', '只', 0, '阀门类'],
  ['止回阀', 'H44H-16C DN50', '只', 0, '阀门类'],
  ['止回阀', 'H44H-16C DN80', '只', 0, '阀门类'],
  ['安全阀', 'A48Y-16C DN50×80', '只', 0, '阀门类'],
  ['减压阀', 'Y43H-16C DN40', '只', 0, '阀门类'],
  // === 密封件 (supplier: 海德密封 idx=2) ===
  ['氟橡胶垫片', 'DN50 PN16 耐油', '片', 2, '密封件'],
  ['氟橡胶垫片', 'DN80 PN16 耐油', '片', 2, '密封件'],
  ['氟橡胶垫片', 'DN100 PN25', '片', 2, '密封件'],
  ['石墨缠绕垫片', 'DN65 PN16 金属缠绕', '片', 2, '密封件'],
  ['石墨缠绕垫片', 'DN150 PN16', '片', 2, '密封件'],
  ['O型密封圈', 'NBR φ50×3.5', '个', 2, '密封件'],
  ['O型密封圈', 'NBR φ80×3.5', '个', 2, '密封件'],
  ['O型密封圈', 'FKM φ35×2.5 耐高温', '个', 2, '密封件'],
  ['阀门填料', '柔性石墨 10×10mm', 'kg', 2, '密封件'],
  ['油封', 'TC型 65×90×12 丁腈橡胶', '个', 2, '密封件'],
  ['油封', 'TC型 45×72×10 氟橡胶', '个', 2, '密封件'],
  ['机械密封垫片', 'BIA-25 碳化硅', '套', 2, '密封件'],
  // === 牺牲阳极 (supplier: 沪东泵业 idx=3) ===
  ['锌合金阳极块', 'AZ-5 船体用 5kg', '块', 3, '牺牲阳极'],
  ['锌合金阳极块', 'AZ-10 船体用 10kg', '块', 3, '牺牲阳极'],
  ['铝合金阳极块', 'AL-15 压载舱用', '块', 3, '牺牲阳极'],
  ['铝合金阳极块', 'AL-8 海水管路用', '块', 3, '牺牲阳极'],
  ['轴接地阳极', '铜轴专用 环形', '个', 3, '牺牲阳极'],
  ['阳极固定螺栓', 'M16×80 316L不锈钢', '套', 3, '牺牲阳极'],
  // === 泵配件 (supplier: 远航机械 idx=1) ===
  ['离心泵叶轮', 'IS80-50-200 铜合金', '个', 1, '泵配件'],
  ['离心泵叶轮', 'IS100-65-250 铸铁', '个', 1, '泵配件'],
  ['泵用机械密封', '104-25 碳化硅/碳', '套', 1, '泵配件'],
  ['泵用机械密封', '109-35 硬质合金', '套', 1, '泵配件'],
  ['泵轴', 'IS80-50-200 45#钢 φ35', '根', 1, '泵配件'],
  ['泵轴', 'IS100-65-250 不锈钢 φ45', '根', 1, '泵配件'],
  ['泵轴承', '6207-2RS 深沟球', '个', 1, '泵配件'],
  ['泵轴承', '6309-2RS 深沟球', '个', 1, '泵配件'],
  ['泵联轴器', 'LM梅花型 L090', '个', 1, '泵配件'],
  ['泵壳体密封环', 'IS80 铜合金 口环', '个', 1, '泵配件'],
  ['海水泵叶轮', 'CWZ-65 铝青铜', '个', 1, '泵配件'],
  ['海水泵机封', 'CWZ-65 双端面', '套', 1, '泵配件'],
  ['潜水泵电机', 'QDX-15 1.5kW 380V', '台', 1, '泵配件'],
  // === 电气件 (supplier: 明珠电气 idx=4) ===
  ['船用断路器', 'DZ47-63 C32 2P', '个', 4, '电气件'],
  ['船用断路器', 'DZ47-63 C63 3P', '个', 4, '电气件'],
  ['交流接触器', 'CJX2-2510 220V', '个', 4, '电气件'],
  ['交流接触器', 'CJX2-4011 380V', '个', 4, '电气件'],
  ['热继电器', 'JR36-25 7-10A', '个', 4, '电气件'],
  ['船用电缆', 'CEF80/DA 3×2.5mm²', '米', 4, '电气件'],
  ['船用电缆', 'CEF80/DA 3×16mm²', '米', 4, '电气件'],
  ['接线端子排', 'UK-10N 导轨式', '个', 4, '电气件'],
  ['防水接线盒', 'F10 铸铝 IP66', '个', 4, '电气件'],
  ['船用指示灯', 'AD16-22 绿色 24V', '个', 4, '电气件'],
  ['船用按钮', 'LA38-11 红色 自复位', '个', 4, '电气件'],
  ['绝缘胶带', 'PVC 19mm×20m 阻燃', '卷', 4, '电气件'],
  ['电缆扎带', '300mm 尼龙 耐候', '包', 4, '电气件'],
  ['应急照明灯', 'YD-2 双头 LED 船用', '个', 4, '电气件'],
  ['船用配电箱', 'PZ30-24 24回路 IP44', '个', 4, '电气件'],
];

// ====== 工具函数 ======

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDate(daysAgo, daysEnd = 0) {
  const now = new Date();
  const start = new Date(now.getTime() - daysAgo * 86400000);
  const end = new Date(now.getTime() - daysEnd * 86400000);
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

// 工作日权重更高
function randomDateWeighted(daysAgo, daysEnd = 0) {
  let d;
  do {
    d = randomDate(daysAgo, daysEnd);
  } while (Math.random() < 0.4 && (d.getDay() === 0 || d.getDay() === 6));
  return d;
}

const DEPARTMENTS = ['轮机部', '甲板部', '电气部', '管系班', '舾装班'];
const OPERATORS = ['曹洁', '张威'];

// ====== 主逻辑 ======

async function main() {
  console.log('🌱 开始播种虚构演示数据...');
  console.log('   数据库:', DATABASE_URL);

  // 1. 建表
  await pool.query(CREATE_TABLES);
  console.log('✅ 建表完成 (IF NOT EXISTS)');

  // 2. 幂等清空
  await pool.query('TRUNCATE change_log, outbound_records, inbound_records, products, suppliers, users RESTART IDENTITY CASCADE');
  console.log('✅ 已清空业务表');

  // 3. 插入用户
  for (const u of USERS) {
    await pool.query(
      'INSERT INTO users (username, password, display_name, role) VALUES ($1,$2,$3,$4)',
      [u.username, hashPassword(u.password), u.display_name, u.role]
    );
  }
  console.log(`✅ 插入 ${USERS.length} 个用户 (密码SHA-256哈希)`);

  // 4. 插入供应商
  const supplierIds = [];
  for (const name of SUPPLIERS) {
    const r = await pool.query('INSERT INTO suppliers (name) VALUES ($1) RETURNING id', [name]);
    supplierIds.push(r.rows[0].id);
  }
  console.log(`✅ 插入 ${SUPPLIERS.length} 家供应商`);

  // 5. 插入备件 (~60种)
  const productIds = [];
  const productInfos = [];
  for (const [name, spec, unit, supIdx, category] of PRODUCTS_DEF) {
    // 70% 给 YY01, 30% 给 YY02；但含大写型号的产品强制 YY01（保证搜索测试稳定）
    const forceYY01 = name.includes('O型') || /DN50/i.test(spec);
    const projectNo = forceYY01 ? 'YY01' : (Math.random() < 0.7 ? 'YY01' : 'YY02');
    const r = await pool.query(
      'INSERT INTO products (name, spec, unit, supplier_id, project_no) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [name, spec, unit, supplierIds[supIdx], projectNo]
    );
    productIds.push(r.rows[0].id);
    productInfos.push({ id: r.rows[0].id, name, spec, unit, category, projectNo });
  }
  console.log(`✅ 插入 ${PRODUCTS_DEF.length} 种备件`);

  // 6. 生成入库/出库记录
  // 策略:
  //   - 前10种产品: 库存告急（入库少，出库多，最终库存<3）
  //   - 第50-55种产品: 呆滞（只有早期入库，近30天无出库）
  //   - 其余正常

  let inboundCount = 0;
  let outboundCount = 0;

  const LOW_STOCK_INDICES = [0, 1, 6, 33, 34, 45, 46]; // ≥5种库存告急
  const STAGNANT_INDICES = [50, 51, 52, 53, 54, 55]; // ≥5种呆滞

  for (let i = 0; i < productInfos.length; i++) {
    const p = productInfos[i];
    const isLowStock = LOW_STOCK_INDICES.includes(i);
    const isStagnant = STAGNANT_INDICES.includes(i);

    if (isStagnant) {
      // 呆滞: 60-90天前入库一次，无出库
      const inDate = randomDateWeighted(90, 35);
      const qty = randomInt(8, 20);
      await pool.query(
        `INSERT INTO inbound_records (product_id, quantity, date, operator, remark, doc_type, doc_ref, created_at)
         VALUES ($1,$2,$3,$4,$5,'入库单',$6,$7)`,
        [p.id, qty, formatDate(inDate), OPERATORS[randomInt(0, 1)], '期初入库', formatDate(inDate), inDate]
      );
      inboundCount++;
      continue;
    }

    if (isLowStock) {
      // 库存告急: 入库少量(2-4)，出库多(接近全部)
      const inQty = randomInt(3, 5);
      const inDate = randomDateWeighted(60);
      await pool.query(
        `INSERT INTO inbound_records (product_id, quantity, date, operator, remark, doc_type, doc_ref, created_at)
         VALUES ($1,$2,$3,$4,$5,'入库单',$6,$7)`,
        [p.id, inQty, formatDate(inDate), OPERATORS[randomInt(0, 1)], '采购入库', formatDate(inDate), inDate]
      );
      inboundCount++;

      // 出库接近全部，留0-2
      const outQty = inQty - randomInt(0, 2);
      if (outQty > 0) {
        const outDate = randomDateWeighted(20);
        await pool.query(
          `INSERT INTO outbound_records (product_id, quantity, date, department, remark, doc_type, created_at)
           VALUES ($1,$2,$3,$4,$5,'出库单',$6)`,
          [p.id, outQty, formatDate(outDate), DEPARTMENTS[randomInt(0, 4)], '现场领用', outDate]
        );
        outboundCount++;
      }
      continue;
    }

    // 正常产品: 1-3次入库，0-2次出库
    const inTimes = randomInt(1, 3);
    let totalIn = 0;
    for (let t = 0; t < inTimes; t++) {
      const qty = randomInt(5, 30);
      totalIn += qty;
      const d = randomDateWeighted(90);
      await pool.query(
        `INSERT INTO inbound_records (product_id, quantity, date, operator, remark, doc_type, doc_ref, created_at)
         VALUES ($1,$2,$3,$4,$5,'入库单',$6,$7)`,
        [p.id, qty, formatDate(d), OPERATORS[randomInt(0, 1)], '常规补货', formatDate(d), d]
      );
      inboundCount++;
    }

    const outTimes = randomInt(0, 2);
    let totalOut = 0;
    for (let t = 0; t < outTimes; t++) {
      const qty = randomInt(2, Math.max(3, Math.floor(totalIn / (outTimes + 1))));
      totalOut += qty;
      const d = randomDateWeighted(60);
      await pool.query(
        `INSERT INTO outbound_records (product_id, quantity, date, department, remark, doc_type, created_at)
         VALUES ($1,$2,$3,$4,$5,'出库单',$6)`,
        [p.id, qty, formatDate(d), DEPARTMENTS[randomInt(0, 4)], '项目领用', d]
      );
      outboundCount++;
    }
  }

  // 补充额外记录确保总数 ≥ 100
  const extraNeeded = Math.max(0, 110 - inboundCount - outboundCount);
  for (let e = 0; e < extraNeeded; e++) {
    const p = productInfos[randomInt(0, productInfos.length - 1)];
    if (STAGNANT_INDICES.includes(productInfos.indexOf(p))) continue;
    const isInbound = Math.random() < 0.5;
    const d = randomDateWeighted(90);
    if (isInbound) {
      await pool.query(
        `INSERT INTO inbound_records (product_id, quantity, date, operator, remark, doc_type, doc_ref, created_at)
         VALUES ($1,$2,$3,$4,$5,'入库单',$6,$7)`,
        [p.id, randomInt(2, 15), formatDate(d), OPERATORS[randomInt(0, 1)], '补充入库', formatDate(d), d]
      );
      inboundCount++;
    } else {
      await pool.query(
        `INSERT INTO outbound_records (product_id, quantity, date, department, remark, doc_type, created_at)
         VALUES ($1,$2,$3,$4,$5,'出库单',$6)`,
        [p.id, randomInt(1, 8), formatDate(d), DEPARTMENTS[randomInt(0, 4)], '维修领用', d]
      );
      outboundCount++;
    }
  }

  console.log(`✅ 入库记录: ${inboundCount} 条`);
  console.log(`✅ 出库记录: ${outboundCount} 条`);
  console.log(`✅ 总计: ${inboundCount + outboundCount} 条出入库记录`);

  // 6.5 挂载单据图片（给YY01前7条入库记录挂虚构送货单）
  const imgRecords = await pool.query(`SELECT r.id FROM inbound_records r JOIN products p ON p.id=r.product_id WHERE p.project_no='YY01' ORDER BY r.id LIMIT 7`);
  for (let i = 0; i < imgRecords.rows.length; i++) {
    await pool.query('UPDATE inbound_records SET doc_image_path=$1 WHERE id=$2',
      ['/doc-samples/delivery-' + (i + 1) + '.svg', imgRecords.rows[i].id]);
  }
  console.log(`✅ 单据图片: ${imgRecords.rows.length} 条入库记录已挂载`);

  // 6.6 预埋产品备注（螺丝/O型圈各 2-3 条）
  const noteProducts = await pool.query(
    "SELECT id, name FROM products WHERE name LIKE '%O型密封圈%' LIMIT 1");
  const noteProducts2 = await pool.query(
    "SELECT id, name FROM products WHERE name LIKE '%电缆扎带%' LIMIT 1");
  const allNoteProducts = [...noteProducts.rows, ...noteProducts2.rows];
  const sampleNotes = [
    { content: '7/25 管系班领走30个，余量充足', qty: 30, by: '曹洁' },
    { content: '7/22 机务组领用15个，用于YY01舾装', qty: 15, by: '张威' },
    { content: '7/20 散装小件盘点，实际库存与账面基本一致', qty: 0, by: '曹洁' },
    { content: '7/18 电气班领走20个，用于配电箱接线', qty: 20, by: '张威' },
  ];
  let noteCount = 0;
  for (let i = 0; i < Math.min(allNoteProducts.length, 2); i++) {
    const pid = allNoteProducts[i].id;
    const notes = i === 0 ? sampleNotes.slice(0, 3) : sampleNotes.slice(1, 4);
    for (const n of notes) {
      await pool.query(
        'INSERT INTO product_notes (product_id, content, qty, created_by, created_at) VALUES ($1,$2,$3,$4,NOW() - INTERVAL \'' + (noteCount * 2 + 1) + ' days\')',
        [pid, n.content, n.qty, n.by]);
      noteCount++;
    }
  }
  console.log(`✅ 产品备注: ${noteCount} 条预埋`);

  // 7. 验证输出
  console.log('\n====== 数据验证 ======');

  const shipCount = await pool.query(`SELECT DISTINCT project_no FROM products`);
  console.log(`船舶数: ${shipCount.rows.length}`, shipCount.rows.map(r => r.project_no));

  const supCount = await pool.query(`SELECT COUNT(*) FROM suppliers`);
  console.log(`供应商数: ${supCount.rows[0].count}`);

  const prodCount = await pool.query(`SELECT COUNT(*) FROM products`);
  console.log(`备件种类: ${prodCount.rows[0].count}`);

  const inCount = await pool.query(`SELECT COUNT(*) FROM inbound_records`);
  const outCount = await pool.query(`SELECT COUNT(*) FROM outbound_records`);
  console.log(`入库记录: ${inCount.rows[0].count}, 出库记录: ${outCount.rows[0].count}`);

  // 库存告急验证
  const lowStock = await pool.query(`
    SELECT p.name, p.spec,
      COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE product_id=p.id),0) -
      COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE product_id=p.id),0) AS stock
    FROM products p
    WHERE COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE product_id=p.id),0) -
      COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE product_id=p.id),0) < 3
    ORDER BY stock
  `);
  console.log(`\n📛 库存告急 (< 3): ${lowStock.rows.length} 种`);
  lowStock.rows.forEach(r => console.log(`   ${r.name} ${r.spec} → 库存: ${r.stock}`));

  // 呆滞验证
  const stagnant = await pool.query(`
    SELECT p.name, p.spec, MAX(o.date) as last_out
    FROM products p
    LEFT JOIN outbound_records o ON o.product_id = p.id
    GROUP BY p.id, p.name, p.spec
    HAVING MAX(o.date) IS NULL OR MAX(o.date) < CURRENT_DATE - INTERVAL '30 days'
    ORDER BY last_out NULLS FIRST
  `);
  console.log(`\n🕸️  呆滞物料 (30天未出库): ${stagnant.rows.length} 种`);
  stagnant.rows.slice(0, 10).forEach(r => console.log(`   ${r.name} ${r.spec} → 最后出库: ${r.last_out || '从未'}`));

  console.log('\n🎉 演示数据播种完成！');
  await pool.end();
}

main().catch(async (e) => {
  console.error('❌ 种子脚本失败:', e.message);
  await pool.end();
  process.exit(1);
});
