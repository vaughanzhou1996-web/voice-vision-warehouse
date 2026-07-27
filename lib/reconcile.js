/**
 * lib/reconcile.js — 月末对账引擎
 * 对账单图片 OCR → 与系统入库记录比对 → 差异报告 → 对话式追问 → 生成邮件
 * 
 * 导出:
 *   reconcile(imagePath, supplierName, month) → { extracted, system_records, diffs }
 *   reconcileChat(sessionId, message) → { reply, diffs?, email_draft? }
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { chatText, chatVision } = require('./qwen');

// ====== 数据库连接 ======
let DATABASE_URL = 'postgres://localhost:5432/inventory_demo';
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/DATABASE_URL=(\S+)/);
    if (m) DATABASE_URL = m[1];
  }
  if (process.env.DATABASE_URL) DATABASE_URL = process.env.DATABASE_URL;
} catch (e) { /* use default */ }

const pool = new Pool({ connectionString: DATABASE_URL });

// ====== 会话上下文 ======
const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { diffs: null, extracted: null, systemRecords: null, supplier: null, month: null, history: [] });
  }
  return sessions.get(sessionId);
}

// ====== OCR 提取对账单明细 ======
async function extractStatement(imagePath) {
  const prompt = `请识别这张供应商对账单/送货单图片中的所有明细行。
以 JSON 数组格式输出，每行包含：name(品名), spec(规格型号), quantity(数量,数字), unit(单位), date(日期,YYYY-MM-DD格式)。
如果有单价(price)也提取。只输出 JSON 数组，不要其他文字。
示例：[{"name":"截止阀","spec":"DN50 PN16","quantity":10,"unit":"只","date":"2026-07-06"}]`;

  const content = await chatVision([
    { role: 'user', text: prompt, image: imagePath }
  ], { temperature: 0.1, max_tokens: 2000 });

  // 解析 JSON 数组（健壮性处理：模型可能不返回方括号）
  let text = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  // 尝试找数组
  let arrMatch = text.match(/\[[\s\S]*\]/);
  if (!arrMatch) {
    // 没有方括号，尝试包裹为数组
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace > -1 && lastBrace > firstBrace) {
      arrMatch = ['[' + text.substring(firstBrace, lastBrace + 1) + ']'];
    }
  }
  if (arrMatch) {
    try {
      const items = JSON.parse(arrMatch[0]);
      if (Array.isArray(items)) {
        // 确保 quantity 是数字
        return items.map(i => ({ ...i, quantity: parseFloat(i.quantity) || 0 }));
      }
    } catch (e) { /* fall through */ }
  }
  return [];
}

// ====== 查询系统入库记录 ======
async function getSystemRecords(supplierName, month) {
  // month 格式: "2026-07"
  const [year, mon] = month.split('-');
  const startDate = `${year}-${mon}-01`;
  const endMon = parseInt(mon) === 12 ? '01' : String(parseInt(mon) + 1).padStart(2, '0');
  const endYear = parseInt(mon) === 12 ? String(parseInt(year) + 1) : year;
  const endDate = `${endYear}-${endMon}-01`;

  const r = await pool.query(`
    SELECT p.name, p.spec, ir.quantity, ir.date::text as date, p.unit
    FROM inbound_records ir
    JOIN products p ON ir.product_id = p.id
    JOIN suppliers s ON p.supplier_id = s.id
    WHERE s.name = $1 AND ir.date >= $2 AND ir.date < $3
    ORDER BY ir.date, p.name`, [supplierName, startDate, endDate]);
  return r.rows.map(row => ({
    name: row.name,
    spec: row.spec,
    quantity: parseFloat(row.quantity),
    unit: row.unit,
    date: row.date
  }));
}

// ====== 比对差异 ======
function compareRecords(extracted, systemRecords) {
  const diffs = [];

  // 按 name+spec 聚合系统记录（同品同规格可能多笔）
  const sysMap = {};
  for (const rec of systemRecords) {
    const key = `${rec.name}|${rec.spec}`;
    if (!sysMap[key]) sysMap[key] = { ...rec, quantity: 0, records: [] };
    sysMap[key].quantity += rec.quantity;
    sysMap[key].records.push(rec);
  }

  // 按 name+spec 聚合对账单
  const stmtMap = {};
  for (const rec of extracted) {
    const key = `${rec.name}|${rec.spec}`;
    if (!stmtMap[key]) stmtMap[key] = { ...rec, quantity: 0 };
    stmtMap[key].quantity += (rec.quantity || 0);
  }

  // 遍历对账单，找数量不符 + 对账单有系统没有
  for (const [key, stmt] of Object.entries(stmtMap)) {
    const sys = sysMap[key];
    if (!sys) {
      diffs.push({
        type: 'statement_only',
        type_label: '对账单有/系统无',
        name: stmt.name,
        spec: stmt.spec,
        stmt_qty: stmt.quantity,
        sys_qty: 0,
        color: 'yellow'
      });
    } else {
      const diff = Math.abs(stmt.quantity - sys.quantity);
      if (diff > 0.01) {
        diffs.push({
          type: 'qty_mismatch',
          type_label: '数量不符',
          name: stmt.name,
          spec: stmt.spec,
          stmt_qty: stmt.quantity,
          sys_qty: sys.quantity,
          color: 'red',
          sys_detail: sys.records.map(r => `${r.date} 入库${r.quantity}`).join('；')
        });
      } else {
        diffs.push({
          type: 'match',
          type_label: '一致',
          name: stmt.name,
          spec: stmt.spec,
          stmt_qty: stmt.quantity,
          sys_qty: sys.quantity,
          color: 'green'
        });
      }
      // 标记已匹配
      sys._matched = true;
    }
  }

  // 系统有、对账单没有
  for (const [key, sys] of Object.entries(sysMap)) {
    if (!sys._matched && !stmtMap[key]) {
      diffs.push({
        type: 'system_only',
        type_label: '系统有/对账单无',
        name: sys.name,
        spec: sys.spec,
        stmt_qty: 0,
        sys_qty: sys.quantity,
        color: 'yellow',
        sys_detail: sys.records.map(r => `${r.date} 入库${r.quantity}`).join('；')
      });
    }
  }

  return diffs;
}

// ====== 主对账流程 ======
async function reconcile(imagePath, supplierName, month) {
  // 1. OCR 提取
  const extracted = await extractStatement(imagePath);
  if (!extracted.length) {
    return { success: false, error: '未能从图片中识别到对账明细，请确认图片清晰' };
  }

  // 2. 查系统记录
  const systemRecords = await getSystemRecords(supplierName, month);

  // 3. 比对
  const diffs = compareRecords(extracted, systemRecords);

  const mismatchCount = diffs.filter(d => d.type === 'qty_mismatch').length;
  const stmtOnlyCount = diffs.filter(d => d.type === 'statement_only').length;
  const sysOnlyCount = diffs.filter(d => d.type === 'system_only').length;
  const matchCount = diffs.filter(d => d.type === 'match').length;

  const summary = `对账完成：共${diffs.length}项，一致${matchCount}项，数量不符${mismatchCount}项，对账单多出${stmtOnlyCount}项，系统多出${sysOnlyCount}项。`;

  return {
    success: true,
    data: { extracted, system_records: systemRecords, diffs, summary, supplier: supplierName, month }
  };
}

// ====== 对话式追问 ======
async function reconcileChat(sessionId, message, reconcileData) {
  const session = getSession(sessionId);

  // 如果传入了新的对账数据，更新会话
  if (reconcileData) {
    session.diffs = reconcileData.diffs;
    session.extracted = reconcileData.extracted;
    session.systemRecords = reconcileData.system_records;
    session.supplier = reconcileData.supplier;
    session.month = reconcileData.month;
  }
  session.history.push({ role: 'user', content: message });

  // 判断是否为"生成邮件"意图
  const isEmail = message.includes('邮件') || message.includes('生成对账') || message.includes('发送');

  if (isEmail) {
    return await generateReconcileEmail(session);
  }

  // 普通追问：组装上下文让 AI 解释
  if (!session.diffs || !session.diffs.length) {
    return { success: true, reply: '当前没有对账数据，请先上传对账单进行对账。' };
  }

  const problemDiffs = session.diffs.filter(d => d.type !== 'match');
  const contextStr = problemDiffs.map(d =>
    `- [${d.type_label}] ${d.name} ${d.spec}：对账单${d.stmt_qty} vs 系统${d.sys_qty}${d.sys_detail ? '（' + d.sys_detail + '）' : ''}`
  ).join('\n');

  try {
    const reply = await chatText([
      { role: 'system', text: `你是船舶备件库存对账助手。供应商：${session.supplier}，对账月份：${session.month}。
以下是差异明细：
${contextStr}

用户会针对差异追问，请结合数据给出简洁明确的解释（50字内），说明双方记录的具体数字和可能原因。` },
      { role: 'user', text: message }
    ], { temperature: 0.3, max_tokens: 500 });

    return { success: true, reply };
  } catch (e) {
    // 降级：直接列出数据
    const fallback = problemDiffs.map(d =>
      `${d.name} ${d.spec}：对账单${d.stmt_qty} vs 系统${d.sys_qty}`
    ).join('\n');
    return { success: true, reply: `（AI暂不可用）差异数据：\n${fallback}` };
  }
}

// ====== 生成对账结果邮件 ======
async function generateReconcileEmail(session) {
  const problemDiffs = (session.diffs || []).filter(d => d.type !== 'match');
  const matchDiffs = (session.diffs || []).filter(d => d.type === 'match');

  const diffList = problemDiffs.map(d =>
    `  - [${d.type_label}] ${d.name} ${d.spec}：贵方${d.stmt_qty} / 我方${d.sys_qty}`
  ).join('\n');

  const bodyContext = `供应商：${session.supplier}
对账月份：${session.month}
一致项目：${matchDiffs.length}项
差异项目：${problemDiffs.length}项
差异明细：
${diffList || '  （无差异）'}`;

  try {
    const reply = await chatText([
      { role: 'system', text: `你是船舶备件采购对账邮件助手。根据以下对账结果，起草一封对账确认邮件。
要求：商务语气，列出差异清单，提出处理建议（如请供应商核实/补送/冲红等），署名"曹洁，远洋船厂 物资部"。
只输出邮件（主题+正文），不要解释。格式：
主题：xxx
正文：
xxx` },
      { role: 'user', text: `【对账结果】\n${bodyContext}` }
    ], { temperature: 0.3, max_tokens: 1200 });

    const subjectMatch = reply.match(/主题[：:]\s*(.+)/);
    const bodyMatch = reply.match(/正文[：:]\s*\n?([\s\S]*)/);
    const subject = subjectMatch ? subjectMatch[1].trim() : `${session.month} 对账确认函 - ${session.supplier}`;
    const body = bodyMatch ? bodyMatch[1].trim() : reply;

    // 确定收件人
    const SUPPLIER_EMAILS = {
      '蓝海阀门': 'sales@lanhai-valve.example',
      '海德密封': 'quality@haidi-seal.example',
      '沪东泵业': 'logistics@hudong-pump.example',
      '远航机械': 'sales@yuanhang-mech.example',
      '明珠电气': 'sales@mingzhu-elec.example'
    };
    const to = SUPPLIER_EMAILS[session.supplier] || 'unknown@example.com';

    return {
      success: true,
      reply: `已生成对账结果邮件，请确认后发送。`,
      email_draft: { to, to_name: session.supplier, subject, body }
    };
  } catch (e) {
    // 降级模板
    const fallbackBody = `${session.supplier}您好：\n\n${session.month} 对账结果如下：\n一致${matchDiffs.length}项，差异${problemDiffs.length}项。\n${diffList}\n\n请核实差异项并回复确认。\n\n曹洁\n远洋船厂 物资部`;
    return {
      success: true,
      reply: '（AI暂不可用，已生成模板邮件）',
      email_draft: { to: 'unknown@example.com', to_name: session.supplier, subject: `${session.month} 对账确认函`, body: fallbackBody }
    };
  }
}

module.exports = { reconcile, reconcileChat, extractStatement, getSystemRecords, compareRecords };
