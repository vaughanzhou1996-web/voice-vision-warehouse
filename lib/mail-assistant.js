/**
 * lib/mail-assistant.js — AI 邮件助手引擎
 * 对话式起草/修改供应商邮件，沙箱发送
 * 
 * 可插拔设计：当前读 seed 数据，预留 IMAP/SMTP 配置位（.env 驱动，本次不实装）
 * 
 * 导出:
 *   getThreads()          → 线程列表
 *   draftMail(sessionId, message) → 对话式起草
 *   sendMail(to, subject, body)   → 写入 sent-box.json
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { chatText } = require('./qwen');

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

// ====== 配置路径 ======
const DATA_DIR = path.join(__dirname, '..', 'data');
const SEED_PATH = path.join(DATA_DIR, 'mailbox-seed.json');
const SENT_BOX_PATH = path.join(DATA_DIR, 'sent-box.json');
const PLAN_PATH = path.join(DATA_DIR, 'project-plan.json');

// ====== 预留 IMAP/SMTP 配置位（本次不实装）======
// const IMAP_HOST = process.env.MAIL_IMAP_HOST || '';
// const IMAP_PORT = process.env.MAIL_IMAP_PORT || 993;
// const SMTP_HOST = process.env.MAIL_SMTP_HOST || '';
// const SMTP_PORT = process.env.MAIL_SMTP_PORT || 465;
// const MAIL_USER = process.env.MAIL_USER || '';
// const MAIL_PASS = process.env.MAIL_PASS || '';

// ====== 供应商映射 ======
const SUPPLIER_MAP = {
  '蓝海阀门': { email: 'sales@lanhai-valve.example', name: '蓝海阀门·王经理', keywords: ['阀', '截止阀', '闸阀', '球阀'] },
  '海德密封': { email: 'quality@haidi-seal.example', name: '海德密封·李工', keywords: ['密封', 'O型圈', '垫片', '填料'] },
  '沪东泵业': { email: 'logistics@hudong-pump.example', name: '沪东泵业·发货组', keywords: ['泵', '叶轮', '机封'] },
  '远航机械': { email: 'sales@yuanhang-mech.example', name: '远航机械·赵经理', keywords: ['泵轴', '轴承'] },
  '明珠电气': { email: 'sales@mingzhu-elec.example', name: '明珠电气·孙经理', keywords: ['断路器', '接触器', '电缆', '电气'] }
};

// ====== 会话上下文 ======
const sessions = new Map(); // sessionId → { drafts: [], history: [], lastSupplier, lastContext }

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { drafts: [], history: [], lastSupplier: null, lastContext: null });
  }
  return sessions.get(sessionId);
}

// ====== 线程列表 ======
function getThreads() {
  const mails = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  // 按 thread_id 分组，返回每个线程的最新一封 + 数量
  const threadMap = {};
  for (const mail of mails) {
    if (!threadMap[mail.thread_id]) {
      threadMap[mail.thread_id] = { thread_id: mail.thread_id, mails: [] };
    }
    threadMap[mail.thread_id].mails.push(mail);
  }
  return Object.values(threadMap).map(t => {
    const latest = t.mails[t.mails.length - 1];
    return {
      thread_id: t.thread_id,
      subject: latest.subject.replace(/^Re:\s*/, ''),
      from_name: latest.from_name,
      from: latest.from,
      date: latest.date,
      count: t.mails.length,
      mails: t.mails
    };
  });
}

// ====== 识别供应商 ======
function identifySupplier(message) {
  for (const [name, info] of Object.entries(SUPPLIER_MAP)) {
    if (message.includes(name)) return { name, ...info };
    for (const kw of info.keywords) {
      if (message.includes(kw)) return { name, ...info };
    }
  }
  return null;
}

// ====== 获取备件实时库存 ======
async function getProductStock(keyword) {
  try {
    const r = await pool.query(`
      SELECT p.name, p.spec,
        COALESCE(inb.t,0)-COALESCE(outb.t,0) AS stock
      FROM products p
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM inbound_records GROUP BY product_id) inb ON p.id=inb.product_id
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM outbound_records GROUP BY product_id) outb ON p.id=outb.product_id
      WHERE p.name ILIKE $1
      ORDER BY stock ASC LIMIT 5`, [`%${keyword}%`]);
    return r.rows;
  } catch (e) { return []; }
}

// ====== 获取项目节点风险 ======
function getMilestoneRisk() {
  try {
    const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
    const now = new Date();
    const upcoming = plan.filter(m => {
      const d = new Date(m.planned_date + 'T00:00:00');
      const diff = (d - now) / 86400000;
      return diff >= 0 && diff <= 60;
    }).sort((a, b) => new Date(a.planned_date) - new Date(b.planned_date));
    return upcoming.slice(0, 3).map(m => ({
      milestone: m.milestone,
      ship: m.ship,
      date: m.planned_date,
      days_left: Math.round((new Date(m.planned_date + 'T00:00:00') - now) / 86400000)
    }));
  } catch (e) { return []; }
}

// ====== 对话式起草 ======
async function draftMail(sessionId, message) {
  const session = getSession(sessionId);
  session.history.push({ role: 'user', content: message });

  // 识别供应商
  let supplier = identifySupplier(message);
  if (!supplier && session.lastSupplier) supplier = session.lastSupplier;
  if (supplier) session.lastSupplier = supplier;

  // 判断意图：修改现有草稿 vs 新建
  const hasDraft = session.drafts.length > 0;
  const isModify = hasDraft && (
    message.includes('强硬') || message.includes('委婉') || message.includes('语气') ||
    message.includes('加一句') || message.includes('加上') || message.includes('修改') ||
    message.includes('改一下') || message.includes('调整') || message.includes('补充') ||
    message.includes('删掉') || message.includes('去掉')
  );

  let contextInfo = '';
  let stockItems = [];

  if (!isModify) {
    // 新建草稿：组装上下文
    // 1. 往来邮件
    const threads = getThreads();
    let relatedMails = [];
    if (supplier) {
      relatedMails = threads.filter(t =>
        t.mails.some(m => m.from.includes(supplier.email.split('@')[1]) || m.to.includes(supplier.email.split('@')[1]))
      ).flatMap(t => t.mails);
    }

    // 2. 实时库存
    const keywords = supplier ? supplier.keywords : [];
    for (const kw of keywords.slice(0, 2)) {
      const items = await getProductStock(kw);
      stockItems.push(...items);
    }
    // 去重
    const seen = new Set();
    stockItems = stockItems.filter(i => {
      const k = i.name + i.spec;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // 3. 项目节点
    const milestones = getMilestoneRisk();

    // 组装上下文
    contextInfo = `【供应商往来邮件摘要】\n`;
    if (relatedMails.length) {
      relatedMails.slice(-3).forEach(m => {
        contextInfo += `[${m.date}] ${m.from_name} → ${m.subject}\n${m.body.substring(0, 200)}\n\n`;
      });
    } else {
      contextInfo += '（无历史往来）\n';
    }
    contextInfo += `\n【相关备件实时库存】\n`;
    if (stockItems.length) {
      stockItems.forEach(i => {
        contextInfo += `- ${i.name} ${i.spec}：当前库存 ${i.stock} 件${i.stock < 3 ? '（⚠️告急）' : ''}\n`;
      });
    } else {
      contextInfo += '（未匹配到相关备件）\n';
    }
    contextInfo += `\n【项目节点风险】\n`;
    milestones.forEach(m => {
      contextInfo += `- ${m.ship}「${m.milestone}」${m.date}（还剩${m.days_left}天）\n`;
    });

    session.lastContext = { supplier, stockItems, milestones, relatedMails };
  }

  // 构建 prompt
  let systemPrompt, userPrompt;

  if (isModify) {
    const lastDraft = session.drafts[session.drafts.length - 1];
    systemPrompt = `你是一位船舶备件采购邮件助手。用户要求修改已起草的邮件。
请根据用户指令修改以下邮件，保持商务格式。
只输出修改后的完整邮件（主题+正文），不要解释。格式：
主题：xxx
正文：
xxx`;
    userPrompt = `【当前邮件】\n主题：${lastDraft.subject}\n正文：\n${lastDraft.body}\n\n【用户修改指令】\n${message}`;
  } else {
    systemPrompt = `你是一位船舶备件采购邮件助手，署名"曹洁，远洋船厂 物资部"。
根据用户需求和以下上下文信息，起草一封完整的商务邮件。
要求：商务语气、简洁有力、具体到品名规格数量。
只输出邮件（主题+正文），不要解释。格式：
主题：xxx
正文：
xxx`;
    userPrompt = `【用户需求】\n${message}\n\n【上下文信息】\n${contextInfo}`;
  }

  try {
    const reply = await chatText([
      { role: 'system', text: systemPrompt },
      { role: 'user', text: userPrompt }
    ], { temperature: 0.3, max_tokens: 1500 });

    // 解析主题和正文
    const subjectMatch = reply.match(/主题[：:]\s*(.+)/);
    const bodyMatch = reply.match(/正文[：:]\s*\n?([\s\S]*)/);
    const subject = subjectMatch ? subjectMatch[1].trim() : (supplier ? `关于${supplier.keywords[0]}事宜` : '商务函件');
    const body = bodyMatch ? bodyMatch[1].trim() : reply;

    const draft = {
      to: supplier ? supplier.email : 'unknown@example.com',
      to_name: supplier ? supplier.name : '收件人',
      subject,
      body
    };
    session.drafts.push(draft);

    const replyText = isModify
      ? `已按要求修改邮件（第${session.drafts.length}版）。`
      : `已为您起草邮件致${supplier ? supplier.name : '供应商'}，请查看草稿。`;

    return { success: true, draft, reply: replyText };
  } catch (e) {
    // 降级：返回模板邮件
    const fallbackDraft = {
      to: supplier ? supplier.email : 'unknown@example.com',
      to_name: supplier ? supplier.name : '收件人',
      subject: supplier ? `关于${supplier.keywords[0]}催货事宜` : '商务函件',
      body: `${supplier ? supplier.name.split('·')[0] : '供应商'}您好：\n\n${message}\n\n请尽快回复确认。\n\n曹洁\n远洋船厂 物资部`
    };
    session.drafts.push(fallbackDraft);
    return { success: true, draft: fallbackDraft, reply: `（AI 服务暂时不可用，已生成模板邮件）` };
  }
}

// ====== 沙箱发送 ======
function sendMail(to, subject, body) {
  let sentBox = [];
  if (fs.existsSync(SENT_BOX_PATH)) {
    try { sentBox = JSON.parse(fs.readFileSync(SENT_BOX_PATH, 'utf8')); } catch (e) { sentBox = []; }
  }
  const record = {
    id: `SENT-${Date.now()}`,
    to,
    subject,
    body,
    sent_at: new Date().toISOString(),
    status: 'sandbox_sent'
  };
  sentBox.push(record);
  fs.writeFileSync(SENT_BOX_PATH, JSON.stringify(sentBox, null, 2), 'utf8');
  return record;
}

module.exports = { getThreads, draftMail, sendMail };
