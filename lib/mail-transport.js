/**
 * lib/mail-transport.js — 真实沙箱邮箱收发通道
 * 
 * 安全铁律：
 * - SMTP 收件人在发送函数里硬编码校验：recipient === MAIL_USER
 * - 不等直接 throw（不是配置项，是 if 硬校验）
 * - 严禁连接任何其他邮箱
 * 
 * 导出:
 *   sendRealMail({ subject, body, displayTo }) → 真实 SMTP 发送
 *   fetchInbox(limit) → IMAP 回读收件箱
 */

const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const fs = require('fs');
const path = require('path');

// ====== 读取 .env 配置 ======
function getEnv(key) {
  if (process.env[key]) return process.env[key];
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    const m = content.match(new RegExp(key + '=(\\S+)'));
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

const MAIL_USER = getEnv('MAIL_USER');
const MAIL_PASS = getEnv('MAIL_PASS');
const MAIL_SMTP_HOST = getEnv('MAIL_SMTP_HOST');
const MAIL_IMAP_HOST = getEnv('MAIL_IMAP_HOST');

// ====== SMTP 发送（白名单硬校验）======
/**
 * @param {Object} opts - { subject, body, displayTo }
 *   displayTo: 前端展示的虚构收件人（仅用于正文标注）
 *   实际 SMTP envelope To 永远是沙箱邮箱自身
 */
async function sendRealMail({ subject, body, displayTo }) {
  // ====== 安全铁律：收件人白名单硬编码校验 ======
  // 实际发送目标只能是沙箱邮箱自身，不等直接 throw
  const recipient = MAIL_USER; // 永远发给自己
  if (recipient !== 'yuanyangdemo@163.com') {
    throw new Error('【安全拦截】收件人不在白名单，拒绝发送');
  }
  // 二次硬校验：即使 MAIL_USER 被篡改，也必须等于沙箱地址
  if (MAIL_USER !== 'yuanyangdemo@163.com') {
    throw new Error('【安全拦截】MAIL_USER 配置异常，拒绝发送');
  }

  const transporter = nodemailer.createTransport({
    host: MAIL_SMTP_HOST,
    port: 465,
    secure: true, // SSL
    auth: {
      user: MAIL_USER,
      pass: MAIL_PASS
    }
  });

  // 正文开头加沙箱标注
  const sandboxNote = `【沙箱演示】模拟发往：${displayTo || '供应商'}\n实际收件人：${MAIL_USER}（沙箱自身）\n${'─'.repeat(40)}\n\n`;
  const fullBody = sandboxNote + (body || '');

  const info = await transporter.sendMail({
    from: `"远洋船厂物资系统" <${MAIL_USER}>`,
    to: MAIL_USER, // 硬编码：永远发给沙箱自身
    subject: subject || '（无主题）',
    text: fullBody
  });

  console.log(`[SMTP] 发送成功 messageId=${info.messageId}`);
  return { messageId: info.messageId, to: MAIL_USER };
}

// ====== IMAP 收件箱回读 ======
/**
 * @param {number} limit - 最多返回几封（默认20）
 * @returns {Array} [{ subject, from, date, body }]
 */
async function fetchInbox(limit = 20) {
  const client = new ImapFlow({
    host: MAIL_IMAP_HOST,
    port: 993,
    secure: true,
    auth: {
      user: MAIL_USER,
      pass: MAIL_PASS
    },
    logger: false
  });

  const emails = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const mailbox = client.mailbox;
      const total = mailbox.exists || 0;
      const start = Math.max(1, total - limit + 1);

      for (let seq = total; seq >= start; seq--) {
        try {
          const msg = await client.fetchOne(seq, {
            envelope: true,
            source: { start: 1, maxLength: 5000 }
          });
          if (msg && msg.envelope) {
            const env = msg.envelope;
            // 提取纯文本正文
            let bodyText = '';
            if (msg.source) {
              const src = msg.source.toString('utf8');
              // 简单提取：找第一个空行后的内容
              const parts = src.split('\r\n\r\n');
              bodyText = parts.length > 1 ? parts[parts.length - 1].substring(0, 500) : '';
              // 去除 base64/quoted-printable 标记
              bodyText = bodyText.replace(/=\n/g, '').replace(/<[a-f0-9]+>/gi, '').trim();
            }
            emails.push({
              subject: env.subject || '（无主题）',
              from: env.from?.[0]?.address || env.from?.[0]?.name || '未知',
              from_name: env.from?.[0]?.name || env.from?.[0]?.address || '未知',
              date: env.date ? new Date(env.date).toISOString().split('T')[0] : '',
              body: bodyText.substring(0, 300)
            });
          }
        } catch (e) { /* skip single msg error */ }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    try { await client.logout(); } catch (_) {}
    throw new Error('IMAP 连接失败: ' + e.message);
  }
  return emails;
}

module.exports = { sendRealMail, fetchInbox, MAIL_USER };
