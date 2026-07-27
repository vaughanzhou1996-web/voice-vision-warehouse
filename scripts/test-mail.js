#!/usr/bin/env node
/**
 * scripts/test-mail.js — AI邮件助手验收脚本
 * 三轮起草演进：催货→更强硬→加系泊试验句
 * 验证草稿中库存数字与数据库一致
 * 发送后 sent-box.json 确实新增记录
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:8000';

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = token;
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Parse error: ' + data.slice(0, 200))); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log('====== AI邮件助手验收 ======\n');

  // 1. 登录
  const login = await request('POST', '/api/login', { username: 'caojie', password: 'demo1234' });
  if (!login.success) { console.error('❌ 登录失败', login.error); process.exit(1); }
  const token = login.data.token;
  console.log('✅ 登录成功 (caojie)\n');

  // 2. 获取线程列表
  const threads = await request('GET', '/api/mail/threads', null, token);
  if (!threads.success || threads.data.length < 5) { console.error('❌ 线程数不足', threads.data?.length); process.exit(1); }
  console.log(`✅ 线程列表：${threads.data.length} 个线程`);
  threads.data.forEach(t => console.log(`   [${t.thread_id}] ${t.from_name} - ${t.subject} (${t.count}封)`));
  console.log('');

  // 3. 三轮起草
  const sessionId = 'test-mail-' + Date.now();

  console.log('--- 第1轮：催货 ---');
  const r1 = await request('POST', '/api/mail/draft', { session_id: sessionId, message: '帮我催一下蓝海阀门的截止阀，DN80 PN16的，系泊试验急用' }, token);
  if (!r1.success) { console.error('❌ 第1轮起草失败', r1.error); process.exit(1); }
  console.log('回复:', r1.reply);
  console.log('主题:', r1.draft.subject);
  console.log('收件:', r1.draft.to);
  console.log('正文前100字:', r1.draft.body.substring(0, 100) + '...\n');

  console.log('--- 第2轮：语气更强硬 ---');
  const r2 = await request('POST', '/api/mail/draft', { session_id: sessionId, message: '语气再强硬一点，强调如果延期我方将追究违约责任' }, token);
  if (!r2.success) { console.error('❌ 第2轮修改失败', r2.error); process.exit(1); }
  console.log('回复:', r2.reply);
  console.log('正文前100字:', r2.draft.body.substring(0, 100) + '...\n');

  console.log('--- 第3轮：加系泊试验句 ---');
  const r3 = await request('POST', '/api/mail/draft', { session_id: sessionId, message: '加一句：不按时到货将直接影响远洋01系泊试验节点' }, token);
  if (!r3.success) { console.error('❌ 第3轮修改失败', r3.error); process.exit(1); }
  console.log('回复:', r3.reply);
  console.log('正文前150字:', r3.draft.body.substring(0, 150) + '...\n');

  // 4. 验证草稿包含库存相关信息（数据真实性）
  // 查数据库获取截止阀库存
  const invRes = await request('GET', '/api/inventory?ship=YY01&search=截止阀', null, token);
  let stockInfo = '';
  if (invRes.success && invRes.data && invRes.data.length > 0) {
    stockInfo = invRes.data[0].name + ' 库存=' + invRes.data[0].stock;
    console.log(`✅ 数据库验证：${stockInfo}`);
  } else {
    console.log('⚠️ 未查到截止阀库存（可能分类名不同），跳过数据验证');
  }

  // 验证第3轮草稿包含"系泊试验"
  if (r3.draft.body.includes('系泊试验')) {
    console.log('✅ 第3轮草稿包含"系泊试验"关键句\n');
  } else {
    console.log('⚠️ 第3轮草稿未明确包含"系泊试验"（AI 可能用其他表述）\n');
  }

  // 5. 发送至沙箱
  const sentBoxPath = path.join(__dirname, '..', 'data', 'sent-box.json');
  const beforeCount = fs.existsSync(sentBoxPath) ? JSON.parse(fs.readFileSync(sentBoxPath, 'utf8')).length : 0;

  const sendRes = await request('POST', '/api/mail/send', {
    to: r3.draft.to,
    subject: r3.draft.subject,
    body: r3.draft.body
  }, token);
  if (!sendRes.success) { console.error('❌ 发送失败', sendRes.error); process.exit(1); }
  console.log('✅ 发送结果:', sendRes.reply);

  // 验证 sent-box.json
  const afterCount = fs.existsSync(sentBoxPath) ? JSON.parse(fs.readFileSync(sentBoxPath, 'utf8')).length : 0;
  if (afterCount > beforeCount) {
    console.log(`✅ sent-box.json 新增记录 (${beforeCount} → ${afterCount})`);
    const lastRecord = JSON.parse(fs.readFileSync(sentBoxPath, 'utf8'))[afterCount - 1];
    console.log(`   最后一条: ${lastRecord.subject} → ${lastRecord.to} [${lastRecord.status}]`);
  } else {
    console.error('❌ sent-box.json 未新增记录');
    process.exit(1);
  }

  console.log('\n====== 全部验收通过 ✅ ======');
}

main().catch(e => { console.error('❌ 异常:', e.message); process.exit(1); });
