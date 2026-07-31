/**
 * seed-demo.js — 完全确定性演示数据种子脚本
 * 用法: node scripts/seed-demo.js
 * 幂等: 重跑时先清空业务表再插入
 *
 * 确定性保证:
 *   - 使用 mulberry32 PRNG (seed=42)，无 Math.random()
 *   - 使用固定参考日期 2026-07-01，无 new Date()
 *   - 船舶分配为固定规则，锚点库存为硬编码值
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

// ====== 确定性 PRNG (mulberry32, seed=42) ======
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(42);

function randInt(min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

// ====== 固定参考日期 ======
const REF_DATE = new Date('2026-07-01T00:00:00Z');

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

/** 参考日期前 days 天 */
function dateBefore(days) {
  return new Date(REF_DATE.getTime() - days * 86400000);
}

// ====== 密码哈希 (SHA-256) ======
function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}

// ====== 建表 SQL ======
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
  project_no VARCHAR(50) DEFAULT 'YY01',
  deleted_at TIMESTAMP
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

CREATE TABLE IF NOT EXISTS milestones (
  id SERIAL PRIMARY KEY,
  project_no VARCHAR(50) NOT NULL,
  milestone VARCHAR(200) NOT NULL,
  planned_date DATE,
  status VARCHAR(50) DEFAULT 'pending',
  sort_order INTEGER DEFAULT 0
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
  // === 阀门类 (supplier: 蓝海阀门 idx=0) === 0-13
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
  // === 密封件 (supplier: 海德密封 idx=2) === 14-24
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
  // === 牺牲阳极 (supplier: 沪东泵业 idx=3) === 25-30
  ['锌合金阳极块', 'AZ-5 船体用 5kg', '块', 3, '牺牲阳极'],
  ['锌合金阳极块', 'AZ-10 船体用 10kg', '块', 3, '牺牲阳极'],
  ['铝合金阳极块', 'AL-15 压载舱用', '块', 3, '牺牲阳极'],
  ['铝合金阳极块', 'AL-8 海水管路用', '块', 3, '牺牲阳极'],
  ['轴接地阳极', '铜轴专用 环形', '个', 3, '牺牲阳极'],
  ['阳极固定螺栓', 'M16×80 316L不锈钢', '套', 3, '牺牲阳极'],
  // === 泵配件 (supplier: 远航机械 idx=1) === 31-43
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
  // === 电气件 (supplier: 明珠电气 idx=4) === 44-61
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
  ['船用断路器', 'DZ47-63 C16 1P', '个', 4, '电气件'],
  ['船用熔断器', 'RT18-32 32A', '个', 4, '电气件'],
  ['防水插座', 'SF-16 3芯 船用', '个', 4, '电气件'],
];

// ====== 固定船舶分配 ======
// 基础规则: indices 0-41 → YY01, indices 42-61 → YY02
// 交换: 12,13 (阀门) 和 27,28 (阳极) → YY02; 58,59,60,61 (电气) → YY01
// 结果: YY01=42种, YY02=20种(含阀门2+阳极2+电气16)
const YY02_FROM_LOW = new Set([12, 13, 27, 28]);
const YY01_FROM_HIGH = new Set([58, 59, 60, 61]);

function getProjectNo(index) {
  if (YY02_FROM_LOW.has(index)) return 'YY02';
  if (YY01_FROM_HIGH.has(index)) return 'YY01';
  return index <= 41 ? 'YY01' : 'YY02';
}

// ====== 库存策略常量 ======
// 锚点产品 (硬编码精确库存)
const ANCHORS = {
  0: { inbound: 5, outbound: 1, stock: 4 },   // 截止阀 DN50 → stock=4
  30: { inbound: 21, outbound: 0, stock: 21 }, // 轴接地阳极 → stock=21
  6: { inbound: 4, outbound: 2, stock: 2 },    // 球阀 DN25 → stock=2
  34: { inbound: 4, outbound: 0, stock: 4 },   // 泵用机械密封 104-25 → stock=4 (计划5→断料)
};

// 库存告急 (stock < 3)
const LOW_STOCK = {
  1: { inbound: 3, outbound: 2 },  // 截止阀 DN80 → stock=1
  33: { inbound: 3, outbound: 2 }, // 泵用机械密封 109-35 → stock=1
  45: { inbound: 4, outbound: 3 }, // 船用断路器 C63 → stock=1
  46: { inbound: 3, outbound: 2 }, // 交流接触器 CJX2-2510 → stock=1
};
// 注: index 6 也是 low stock (stock=2) 但已在 ANCHORS 中定义

// 呆滞产品 (只有60-90天前入库，无出库)
const STAGNANT_INDICES = new Set([50, 51, 52, 53, 54, 55]);

const DEPARTMENTS = ['轮机部', '甲板部', '电气部', '管系班', '舾装班'];
const OPERATORS = ['曹洁', '张威'];

// ====== 里程碑定义 ======
const MILESTONES_YY01 = ['开工', '钢板切割', '船体合拢', '主机组安装', '管路系统', '电气敷设', '舾装', '系泊试验', '海试', '交船'];
const MILESTONES_YY02 = ['开工', '钢板切割', '船体合拢', '主机组安装', '管路系统'];

// ====== 主逻辑 ======

async function main() {
  console.log('🌱 开始播种确定性演示数据 (seed=42, ref=2026-07-01)...');
  console.log('   数据库:', DATABASE_URL);

  // 1. 建表
  await pool.query(CREATE_TABLES);
  console.log('✅ 建表完成 (IF NOT EXISTS)');

  // 2. 幂等清空
  await pool.query(
    'TRUNCATE change_log, outbound_records, inbound_records, product_notes, milestones, products, suppliers, users RESTART IDENTITY CASCADE'
  );
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

  // 5. 插入备件 (62种, 固定船舶分配)
  const productIds = [];
  const productInfos = [];
  for (let i = 0; i < PRODUCTS_DEF.length; i++) {
    const [name, spec, unit, supIdx, category] = PRODUCTS_DEF[i];
    const projectNo = getProjectNo(i);
    const r = await pool.query(
      'INSERT INTO products (name, spec, unit, supplier_id, project_no) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [name, spec, unit, supplierIds[supIdx], projectNo]
    );
    productIds.push(r.rows[0].id);
    productInfos.push({ id: r.rows[0].id, name, spec, unit, category, projectNo, index: i });
  }
  const yy01Count = productInfos.filter(p => p.projectNo === 'YY01').length;
  const yy02Count = productInfos.filter(p => p.projectNo === 'YY02').length;
  console.log(`✅ 插入 ${PRODUCTS_DEF.length} 种备件 (YY01: ${yy01Count}, YY02: ${yy02Count})`);

  // 6. 生成入库/出库记录 (完全确定性)
  let inboundCount = 0;
  let outboundCount = 0;

  for (let i = 0; i < productInfos.length; i++) {
    const p = productInfos[i];

    // === 锚点产品: 硬编码精确值 ===
    if (ANCHORS[i]) {
      const a = ANCHORS[i];
      const inDate = formatDate(dateBefore(45));
      await pool.query(
        `INSERT INTO inbound_records (product_id, quantity, date, operator, remark, doc_type, doc_ref, created_at)
         VALUES ($1,$2,$3,$4,$5,'入库单',$6,$7)`,
        [p.id, a.inbound, inDate, OPERATORS[0], '采购入库', inDate, dateBefore(45)]
      );
      inboundCount++;
      if (a.outbound > 0) {
        const outDate = formatDate(dateBefore(10));
        await pool.query(
          `INSERT INTO outbound_records (product_id, quantity, date, department, remark, doc_type, created_at)
           VALUES ($1,$2,$3,$4,$5,'出库单',$6)`,
          [p.id, a.outbound, outDate, DEPARTMENTS[0], '项目领用', outDate]
        );
        outboundCount++;
      }
      continue;
    }

    // === 库存告急产品: 固定少量 ===
    if (LOW_STOCK[i]) {
      const ls = LOW_STOCK[i];
      const inDate = formatDate(dateBefore(40 + (i % 15)));
      await pool.query(
        `INSERT INTO inbound_records (product_id, quantity, date, operator, remark, doc_type, doc_ref, created_at)
         VALUES ($1,$2,$3,$4,$5,'入库单',$6,$7)`,
        [p.id, ls.inbound, inDate, OPERATORS[i % 2], '采购入库', inDate, dateBefore(40 + (i % 15))]
      );
      inboundCount++;
      const outDate = formatDate(dateBefore(5 + (i % 10)));
      await pool.query(
        `INSERT INTO outbound_records (product_id, quantity, date, department, remark, doc_type, created_at)
         VALUES ($1,$2,$3,$4,$5,'出库单',$6)`,
        [p.id, ls.outbound, outDate, DEPARTMENTS[i % 5], '现场领用', outDate]
      );
      outboundCount++;
      continue;
    }

    // === 呆滞产品: 60-90天前入库一次，无出库 ===
    if (STAGNANT_INDICES.has(i)) {
      const daysAgo = 60 + randInt(0, 30);
      const qty = 8 + randInt(0, 12);
      const inDate = formatDate(dateBefore(daysAgo));
      await pool.query(
        `INSERT INTO inbound_records (product_id, quantity, date, operator, remark, doc_type, doc_ref, created_at)
         VALUES ($1,$2,$3,$4,$5,'入库单',$6,$7)`,
        [p.id, qty, inDate, OPERATORS[randInt(0, 1)], '期初入库', inDate, dateBefore(daysAgo)]
      );
      inboundCount++;
      continue;
    }

    // === 正常产品: 确定性 PRNG 生成数量 ===
    const inTimes = 1 + randInt(0, 2); // 1-3 次入库
    let totalIn = 0;
    for (let t = 0; t < inTimes; t++) {
      const qty = 5 + randInt(0, 15); // 5-20
      totalIn += qty;
      const daysAgo = 20 + randInt(0, 60); // 20-80 天前
      const d = dateBefore(daysAgo);
      await pool.query(
        `INSERT INTO inbound_records (product_id, quantity, date, operator, remark, doc_type, doc_ref, created_at)
         VALUES ($1,$2,$3,$4,$5,'入库单',$6,$7)`,
        [p.id, qty, formatDate(d), OPERATORS[randInt(0, 1)], '常规补货', formatDate(d), d]
      );
      inboundCount++;
    }

    const outTimes = 1 + randInt(0, 1); // 1-2 次出库
    let totalOut = 0;
    for (let t = 0; t < outTimes; t++) {
      const maxOut = Math.max(2, Math.floor((totalIn - totalOut) / (outTimes - t + 1)));
      const qty = 2 + randInt(0, Math.min(6, maxOut - 2)); // 2-8, 不超过库存
      totalOut += qty;
      const daysAgo = 5 + randInt(0, 25); // 5-30 天前
      const d = dateBefore(daysAgo);
      await pool.query(
        `INSERT INTO outbound_records (product_id, quantity, date, department, remark, doc_type, created_at)
         VALUES ($1,$2,$3,$4,$5,'出库单',$6)`,
        [p.id, qty, formatDate(d), DEPARTMENTS[randInt(0, 4)], '项目领用', formatDate(d)]
      );
      outboundCount++;
    }
  }

  console.log(`✅ 入库记录: ${inboundCount} 条`);
  console.log(`✅ 出库记录: ${outboundCount} 条`);
  console.log(`✅ 总计: ${inboundCount + outboundCount} 条出入库记录`);

  // 7. 挂载单据图片（给YY01前7条入库记录挂虚构送货单）
  const imgRecords = await pool.query(
    `SELECT r.id FROM inbound_records r JOIN products p ON p.id=r.product_id
     WHERE p.project_no='YY01' ORDER BY r.id LIMIT 7`
  );
  for (let i = 0; i < imgRecords.rows.length; i++) {
    await pool.query('UPDATE inbound_records SET doc_image_path=$1 WHERE id=$2',
      ['/doc-samples/delivery-' + (i + 1) + '.svg', imgRecords.rows[i].id]);
  }
  console.log(`✅ 单据图片: ${imgRecords.rows.length} 条入库记录已挂载`);

  // 8. 预埋产品备注 (6条: O型密封圈3条 + 电缆扎带3条)
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
      const daysBack = noteCount * 2 + 1;
      await pool.query(
        `INSERT INTO product_notes (product_id, content, qty, created_by, created_at)
         VALUES ($1,$2,$3,$4, $5::timestamp - ($6 || ' days')::interval)`,
        [pid, n.content, n.qty, n.by, REF_DATE.toISOString(), daysBack]);
      noteCount++;
    }
  }
  console.log(`✅ 产品备注: ${noteCount} 条预埋`);

  // 9. 里程碑数据
  for (let i = 0; i < MILESTONES_YY01.length; i++) {
    const plannedDate = formatDate(dateBefore(-(30 * (i + 1)))); // 未来每月一个
    const status = i < 4 ? 'completed' : i === 4 ? 'in_progress' : 'pending';
    await pool.query(
      'INSERT INTO milestones (project_no, milestone, planned_date, status, sort_order) VALUES ($1,$2,$3,$4,$5)',
      ['YY01', MILESTONES_YY01[i], plannedDate, status, i + 1]
    );
  }
  for (let i = 0; i < MILESTONES_YY02.length; i++) {
    const plannedDate = formatDate(dateBefore(-(45 * (i + 1))));
    const status = i < 2 ? 'completed' : i === 2 ? 'in_progress' : 'pending';
    await pool.query(
      'INSERT INTO milestones (project_no, milestone, planned_date, status, sort_order) VALUES ($1,$2,$3,$4,$5)',
      ['YY02', MILESTONES_YY02[i], plannedDate, status, i + 1]
    );
  }
  console.log(`✅ 里程碑: YY01 ${MILESTONES_YY01.length} 个, YY02 ${MILESTONES_YY02.length} 个`);

  // 10. 验证输出
  console.log('\n====== 数据验证 ======');
  const prodCount = await pool.query('SELECT COUNT(*) FROM products');
  console.log(`备件种类: ${prodCount.rows[0].count}`);

  const shipCount = await pool.query(
    'SELECT project_no, COUNT(*) c FROM products GROUP BY project_no ORDER BY project_no');
  shipCount.rows.forEach(r => console.log(`  ${r.project_no}: ${r.c} 种`));

  const inCount = await pool.query('SELECT COUNT(*) FROM inbound_records');
  const outCount = await pool.query('SELECT COUNT(*) FROM outbound_records');
  console.log(`入库记录: ${inCount.rows[0].count}, 出库记录: ${outCount.rows[0].count}`);

  const msCount = await pool.query(
    'SELECT project_no, COUNT(*) c FROM milestones GROUP BY project_no ORDER BY project_no');
  msCount.rows.forEach(r => console.log(`  里程碑 ${r.project_no}: ${r.c}`));

  // 库存告急验证
  const lowStock = await pool.query(`
    SELECT p.name, p.spec, p.project_no,
      COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE product_id=p.id),0) -
      COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE product_id=p.id),0) AS stock
    FROM products p
    WHERE COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE product_id=p.id),0) -
      COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE product_id=p.id),0) < 3
    ORDER BY stock
  `);
  console.log(`\n📛 库存告急 (< 3): ${lowStock.rows.length} 种`);
  lowStock.rows.forEach(r => console.log(`   [${r.project_no}] ${r.name} ${r.spec} → 库存: ${r.stock}`));

  // 锚点验证
  console.log('\n🎯 锚点验证:');
  const anchorCheck = await pool.query(`
    SELECT p.name, p.spec,
      COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE product_id=p.id),0) -
      COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE product_id=p.id),0) AS stock
    FROM products p
    WHERE (p.name='截止阀' AND p.spec LIKE '%DN50%')
       OR (p.name='轴接地阳极')
       OR (p.name='球阀' AND p.spec LIKE '%DN25%')
    ORDER BY p.id
  `);
  anchorCheck.rows.forEach(r => console.log(`   ${r.name} ${r.spec} → 库存: ${r.stock}`));

  console.log('\n🎉 确定性演示数据播种完成！');
  await pool.end();
}

main().catch(async (e) => {
  console.error('❌ 种子脚本失败:', e.message);
  await pool.end();
  process.exit(1);
});
