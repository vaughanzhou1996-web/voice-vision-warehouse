/**
 * lib/chat-ops.js — 对话式库存操作引擎
 * 多轮上下文 + 指代解析 + 真实数据库执行
 * 
 * 用法:
 *   const { processMessage } = require('./lib/chat-ops');
 *   const result = await processMessage(sessionId, message, operatorName);
 */

const { Pool } = require('pg');
const { chatText, extractJson } = require('./qwen');
const fs = require('fs');
const path = require('path');

// 数据库连接：优先读 .env 的 DATABASE_URL，默认 inventory_demo
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
const sessions = new Map(); // sessionId → { lastProductId, lastProductName, lastProductSpec, history[] }

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { lastProductId: null, lastProductName: null, lastProductSpec: null, history: [] });
  }
  return sessions.get(sessionId);
}

// ====== 数据库工具（复用 server.js 模式）======
async function getStock(productId) {
  const r = await pool.query(
    `SELECT COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE product_id=$1),0)
     - COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE product_id=$1),0) AS stock`,
    [productId]
  );
  return parseFloat(r.rows[0].stock) || 0;
}

async function logChange(actionType, productId, productName, productSpec, quantity, qtyBefore, qtyAfter, operator, details, refTable, refId) {
  await pool.query(
    `INSERT INTO change_log (action_type,product_id,product_name,product_spec,quantity,quantity_before,quantity_after,operator,details,ref_table,ref_record_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [actionType, productId, productName, productSpec, quantity, qtyBefore, qtyAfter, operator, details || '', refTable || '', refId || null]
  );
}

// ====== 库存上下文检索 ======
async function searchProducts(message) {
  // 提取关键词：去掉常见停用词，用剩余部分搜索
  const stopWords = /还有|多少|库存|出库|入库|领用|领的|查一下|帮我|请|把|给|这个|那个|它|的|了|吗|呢|啊|出|入|要|想|查|看|有|几个|几|多少|什么|哪|种|个|只|件|套/g;
  const keywords = message.replace(stopWords, ' ').trim().split(/\s+/).filter(w => w.length >= 1);
  
  let rows = [];
  if (keywords.length > 0) {
    // 按关键词搜索 products 表（name 或 spec 匹配）
    const conditions = keywords.map((_, i) => `(p.name ILIKE $${i * 2 + 1} OR p.spec ILIKE $${i * 2 + 2})`);
    const params = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);
    try {
      const r = await pool.query(`
        SELECT p.id, p.name, p.spec, p.unit,
          COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE product_id=p.id),0)
          - COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE product_id=p.id),0) AS stock
        FROM products p
        WHERE ${conditions.join(' OR ')}
        ORDER BY p.name
        LIMIT 10
      `, params);
      rows = r.rows;
    } catch (e) { /* fallback: 空结果 */ }
  }
  
  // 如果关键词搜索无结果，尝试单字模糊
  if (rows.length === 0 && keywords.length > 0) {
    const mainKw = keywords.reduce((a, b) => a.length >= b.length ? a : b);
    if (mainKw.length >= 2) {
      try {
        const r = await pool.query(`
          SELECT p.id, p.name, p.spec, p.unit,
            COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE product_id=p.id),0)
            - COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE product_id=p.id),0) AS stock
          FROM products p
          WHERE p.name ILIKE $1 OR p.spec ILIKE $1
          ORDER BY p.name LIMIT 10
        `, [`%${mainKw}%`]);
        rows = r.rows;
      } catch (e) { /* ignore */ }
    }
  }
  
  return rows.map(r => ({ id: r.id, name: r.name, spec: r.spec, unit: r.unit, stock: parseFloat(r.stock) || 0 }));
}

// ====== 主处理函数 ======
/**
 * @param {string} sessionId - 会话ID
 * @param {string} message - 用户消息
 * @param {string} operator - 操作人名称
 * @returns {{ reply, action, executed, stock_after, need_confirm }}
 */
async function processMessage(sessionId, message, operator) {
  const session = getSession(sessionId);
  
  // 1. 检索相关库存上下文
  const products = await searchProducts(message);
  
  // 2. 构建系统提示
  const inventoryCtx = products.length > 0
    ? products.map(p => `  id=${p.id} | ${p.name} ${p.spec} | 库存:${p.stock} ${p.unit}`).join('\n')
    : '  (无匹配备件)';
  
  const lastCtx = session.lastProductId
    ? `上一轮讨论的备件: id=${session.lastProductId} ${session.lastProductName} ${session.lastProductSpec || ''}`
    : '上一轮无特定备件';
  
  const historyCtx = session.history.slice(-4).map(h => `${h.role}: ${h.text}`).join('\n');
  
  const systemPrompt = `你是船舶备件库存管理系统的AI操作助手。根据用户消息和库存数据，输出严格JSON（不要输出其他内容）。

输出格式（严格JSON，无注释）：
{"action":"query|outbound|inbound|clarify|chat","product_id":数字或null,"qty":数字或null,"department":"领用部门或null","reply":"给用户的中文回复","need_confirm":false}

规则：
- action=query: 用户查库存，reply中告知库存数量
- action=outbound: 用户要出库/领用，需填product_id和qty和department
- action=inbound: 用户要入库，需填product_id和qty
- action=clarify: 匹配到多个备件或信息不足，需追问用户
- action=chat: 闲聊或与库存无关的问题
- 当用户说"这个""它""那个"时，指代的是上一轮讨论的备件
- product_id必须来自下方库存列表中的id
- reply要简洁友好，包含关键数据

${lastCtx}

当前匹配库存:
${inventoryCtx}

近几轮对话:
${historyCtx || '  (无历史)'}`;

  // 3. 调用 LLM
  let parsed = null;
  try {
    const raw = await chatText([
      { role: 'system', text: systemPrompt },
      { role: 'user', text: message }
    ], { jsonMode: true, temperature: 0.05 });
    
    try { parsed = JSON.parse(raw); } catch (e) {
      // 尝试修复常见 JSON 问题
      try { parsed = JSON.parse(raw.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')); } catch (e2) { /* ignore */ }
    }
  } catch (e) {
    return { reply: '❌ AI服务暂时不可用: ' + e.message, action: 'chat', executed: false, stock_after: null, need_confirm: false };
  }
  
  if (!parsed || !parsed.action) {
    return { reply: parsed?.reply || '抱歉，我没有理解您的意思，请再说一次。', action: 'chat', executed: false, stock_after: null, need_confirm: false };
  }
  
  // 4. 执行操作
  let executed = false;
  let stockAfter = null;
  let reply = parsed.reply || '';
  let action = parsed.action;
  const needConfirm = parsed.need_confirm || false;
  
  // 更新上下文中的 lastProduct
  if (parsed.product_id) {
    const prod = products.find(p => p.id === parsed.product_id);
    if (prod) {
      session.lastProductId = prod.id;
      session.lastProductName = prod.name;
      session.lastProductSpec = prod.spec;
    } else {
      // product_id 可能来自上下文（指代解析），从DB查
      try {
        const r = await pool.query('SELECT id,name,spec FROM products WHERE id=$1', [parsed.product_id]);
        if (r.rows.length) {
          session.lastProductId = r.rows[0].id;
          session.lastProductName = r.rows[0].name;
          session.lastProductSpec = r.rows[0].spec;
        }
      } catch (e) { /* ignore */ }
    }
  }
  
  // 出库
  if (action === 'outbound' && parsed.product_id && parsed.qty) {
    const productId = parsed.product_id;
    const qty = parsed.qty;
    const currentStock = await getStock(productId);
    
    if (qty > currentStock) {
      // 库存不足，拒绝
      const prod = await pool.query('SELECT name,spec,unit FROM products WHERE id=$1', [productId]);
      const pName = prod.rows[0] ? `${prod.rows[0].name} ${prod.rows[0].spec}` : `ID:${productId}`;
      const unit = prod.rows[0]?.unit || '个';
      reply = `❌ 库存不足！${pName} 当前库存仅 ${currentStock} ${unit}，无法出库 ${qty} ${unit}。请调整数量或先补货。`;
      action = 'clarify';
    } else {
      // 执行出库
      const prod = (await pool.query('SELECT name,spec,unit FROM products WHERE id=$1', [productId])).rows[0];
      const stockBefore = currentStock;
      const r = await pool.query(
        `INSERT INTO outbound_records (product_id,quantity,date,department,remark,doc_type) VALUES ($1,$2,$3,$4,$5,'出库单') RETURNING *`,
        [productId, qty, new Date(), parsed.department || '', '对话式出库']
      );
      stockAfter = await getStock(productId);
      await logChange('outbound', productId, prod.name, prod.spec, qty, stockBefore, stockAfter, operator, `对话出库: ${parsed.department || ''}`, 'outbound_records', r.rows[0].id);
      executed = true;
      reply = `✅ 已出库 ${prod.name} ${prod.spec} × ${qty} ${prod.unit}（${parsed.department || '未指定部门'}领用）。出库后库存: ${stockAfter} ${prod.unit}`;
    }
  }
  
  // 入库
  if (action === 'inbound' && parsed.product_id && parsed.qty) {
    const productId = parsed.product_id;
    const qty = parsed.qty;
    const prod = (await pool.query('SELECT name,spec,unit FROM products WHERE id=$1', [productId])).rows[0];
    if (prod) {
      const stockBefore = await getStock(productId);
      const r = await pool.query(
        `INSERT INTO inbound_records (product_id,quantity,date,operator,remark,doc_type,doc_ref,doc_image_path) VALUES ($1,$2,$3,$4,$5,'入库单','','') RETURNING *`,
        [productId, qty, new Date(), operator, '对话式入库']
      );
      stockAfter = await getStock(productId);
      await logChange('inbound', productId, prod.name, prod.spec, qty, stockBefore, stockAfter, operator, '对话入库', 'inbound_records', r.rows[0].id);
      executed = true;
      reply = `✅ 已入库 ${prod.name} ${prod.spec} × ${qty} ${prod.unit}。入库后库存: ${stockAfter} ${prod.unit}`;
    }
  }
  
  // 查询时更新 stock_after
  if (action === 'query' && parsed.product_id) {
    stockAfter = await getStock(parsed.product_id);
  }
  
  // 5. 记录历史
  session.history.push({ role: 'user', text: message });
  session.history.push({ role: 'assistant', text: reply });
  if (session.history.length > 20) session.history = session.history.slice(-10);
  
  return { reply, action, executed, stock_after: stockAfter, qty: parsed.qty || null, need_confirm: needConfirm };
}

module.exports = { processMessage, getStock, pool, sessions };
