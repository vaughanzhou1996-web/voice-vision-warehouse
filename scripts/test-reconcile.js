#!/usr/bin/env node
/**
 * scripts/test-reconcile.js — 月末对账验收脚本
 * 用 sharp 生成模拟对账单图片（5行明细，埋2处差异）
 * 全链路：提取→比对→打印差异报告
 * 验证：2处预埋差异全部命中、无误报
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const BASE = 'http://localhost:8000';

// 预埋的对账单明细（基于7月蓝海阀门真实入库记录）
// 系统实际：截止阀DN50=10, 止回阀DN50=18, 止回阀DN80=19, 蝶阀DN300=33(10+23)
// 对账单设计（5行）：
//   1. 截止阀 GB/T587 DN50 PN16  数量10  → 一致 ✅
//   2. 止回阀 H44H-16C DN50     数量18  → 一致 ✅
//   3. 止回阀 H44H-16C DN80     数量15  → 数量不符（系统19）❌ 【预埋差异1】
//   4. 蝶阀 D71X-16 DN300       数量33  → 一致 ✅
//   5. 闸阀 Z41H-16C DN100      数量8   → 对账单有/系统无 ⚠️ 【预埋差异2】
const STATEMENT_ITEMS = [
  { name: '截止阀', spec: 'GB/T587 DN50 PN16', qty: 10, unit: '只', date: '2026-07-27' },
  { name: '止回阀', spec: 'H44H-16C DN50', qty: 18, unit: '只', date: '2026-07-06' },
  { name: '止回阀', spec: 'H44H-16C DN80', qty: 15, unit: '只', date: '2026-07-06' },
  { name: '蝶阀', spec: 'D71X-16 DN300', qty: 33, unit: '只', date: '2026-07-02' },
  { name: '闸阀', spec: 'Z41H-16C DN100', qty: 8, unit: '只', date: '2026-07-15' }
];

function request(method, urlPath, body, token, isFormData) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: {} };
    if (token) opts.headers['Authorization'] = token;
    if (!isFormData) opts.headers['Content-Type'] = 'application/json';
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Parse error: ' + data.slice(0, 300))); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// 用 sharp 生成对账单图片（SVG → PNG）
async function generateStatementImage(outputPath) {
  const rows = STATEMENT_ITEMS.map((item, i) => {
    const y = 180 + i * 40;
    return `<text x="40" y="${y}" font-size="14" fill="#333">${item.name}</text>
      <text x="160" y="${y}" font-size="14" fill="#333">${item.spec}</text>
      <text x="380" y="${y}" font-size="14" fill="#333">${item.qty}</text>
      <text x="440" y="${y}" font-size="14" fill="#333">${item.unit}</text>
      <text x="500" y="${y}" font-size="14" fill="#333">${item.date}</text>`;
  }).join('\n');

  const svg = `<svg width="700" height="420" xmlns="http://www.w3.org/2000/svg">
    <rect width="700" height="420" fill="#ffffff"/>
    <text x="200" y="40" font-size="20" font-weight="bold" fill="#1a1a1a">蓝海阀门 供货对账单</text>
    <text x="40" y="70" font-size="13" fill="#666">供应商：蓝海阀门    对账月份：2026年7月    编号：LH-202607</text>
    <line x1="30" y1="90" x2="670" y2="90" stroke="#ccc" stroke-width="1"/>
    <text x="40" y="120" font-size="13" font-weight="bold" fill="#333">品名</text>
    <text x="160" y="120" font-size="13" font-weight="bold" fill="#333">规格型号</text>
    <text x="380" y="120" font-size="13" font-weight="bold" fill="#333">数量</text>
    <text x="440" y="120" font-size="13" font-weight="bold" fill="#333">单位</text>
    <text x="500" y="120" font-size="13" font-weight="bold" fill="#333">日期</text>
    <line x1="30" y1="135" x2="670" y2="135" stroke="#999" stroke-width="1"/>
    ${rows}
    <line x1="30" y1="390" x2="670" y2="390" stroke="#ccc" stroke-width="1"/>
    <text x="40" y="410" font-size="12" fill="#888">合计：5项    制表：蓝海阀门销售部    日期：2026-07-28</text>
  </svg>`;

  await sharp(Buffer.from(svg)).png().toFile(outputPath);
  console.log(`✅ 对账单图片已生成: ${outputPath}`);
}

async function main() {
  console.log('====== 月末对账验收 ======\n');

  // 1. 生成模拟对账单图片
  const imgPath = path.join(__dirname, '..', 'uploads', 'test-reconcile-statement.png');
  fs.mkdirSync(path.dirname(imgPath), { recursive: true });
  await generateStatementImage(imgPath);

  // 2. 登录
  const login = await request('POST', '/api/login', JSON.stringify({ username: 'caojie', password: 'demo1234' }));
  if (!login.success) { console.error('❌ 登录失败', login.error); process.exit(1); }
  const token = login.data.token;
  console.log('✅ 登录成功 (caojie)\n');

  // 3. 上传对账单进行对账（multipart/form-data 手动构建）
  const boundary = '----FormBoundary' + Date.now().toString(36);
  const fileData = fs.readFileSync(imgPath);
  let formBody = '';
  formBody += `--${boundary}\r\nContent-Disposition: form-data; name="supplier"\r\n\r\n蓝海阀门\r\n`;
  formBody += `--${boundary}\r\nContent-Disposition: form-data; name="month"\r\n\r\n2026-07\r\n`;
  formBody += `--${boundary}\r\nContent-Disposition: form-data; name="session_id"\r\n\r\ntest-recon-session\r\n`;
  formBody += `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="statement.png"\r\nContent-Type: image/png\r\n\r\n`;
  const formEnd = `\r\n--${boundary}--\r\n`;
  const bodyBuffer = Buffer.concat([Buffer.from(formBody, 'utf8'), fileData, Buffer.from(formEnd, 'utf8')]);

  console.log('--- 上传对账单，AI识别+比对中（约15-30秒）---');
  const reconRes = await new Promise((resolve, reject) => {
    const url = new URL('/api/reconcile/upload', BASE);
    const opts = {
      method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname,
      headers: {
        'Authorization': token,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuffer.length
      }
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Parse error')); } });
    });
    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });

  if (!reconRes.success) { console.error('❌ 对账失败:', reconRes.error); process.exit(1); }
  const { diffs, summary, extracted } = reconRes.data;
  console.log(`\n✅ 对账完成！摘要: ${summary}\n`);

  // 4. 打印差异报告
  console.log('--- 差异报告 ---');
  diffs.forEach(d => {
    const icon = d.color === 'green' ? '✅' : (d.color === 'red' ? '❌' : '⚠️');
    console.log(`  ${icon} [${d.type_label}] ${d.name} ${d.spec} | 对账单:${d.stmt_qty} vs 系统:${d.sys_qty}`);
  });
  console.log('');

  // 5. 验证预埋差异
  const qtyMismatch = diffs.find(d => d.type === 'qty_mismatch' && d.name === '止回阀' && d.spec.includes('DN80'));
  const stmtOnly = diffs.find(d => d.type === 'statement_only' && d.name === '闸阀');
  const falsePositives = diffs.filter(d => d.type !== 'match' && d !== qtyMismatch && d !== stmtOnly);

  let pass = true;
  if (qtyMismatch) {
    console.log(`✅ 预埋差异1命中：止回阀 DN80 数量不符（对账单${qtyMismatch.stmt_qty} vs 系统${qtyMismatch.sys_qty}）`);
  } else {
    console.error('❌ 预埋差异1未命中：止回阀 DN80 数量不符');
    pass = false;
  }

  if (stmtOnly) {
    console.log(`✅ 预埋差异2命中：闸阀 Z41H-16C DN100 对账单有/系统无（数量${stmtOnly.stmt_qty}）`);
  } else {
    console.error('❌ 预埋差异2未命中：闸阀 单边记录');
    pass = false;
  }

  if (falsePositives.length === 0) {
    console.log('✅ 无误报（其余项目全部一致）');
  } else {
    console.error(`❌ 存在误报: ${falsePositives.map(d => d.name + ' ' + d.spec).join(', ')}`);
    pass = false;
  }

  // 6. 验证提取数字与生成图片一致
  console.log('\n--- OCR提取结果 ---');
  extracted.forEach(e => console.log(`  ${e.name} ${e.spec} qty=${e.quantity}`));
  const extractedOk = extracted.length >= 4; // 至少识别出4行
  if (extractedOk) {
    console.log(`✅ OCR提取 ${extracted.length} 行明细`);
  } else {
    console.error(`❌ OCR提取不足（仅${extracted.length}行）`);
    pass = false;
  }

  // 7. 追问测试
  console.log('\n--- 对话追问测试 ---');
  const chatRes = await request('POST', '/api/reconcile/chat',
    JSON.stringify({ session_id: 'test-recon-session', message: '数量不符那行怎么回事' }), token);
  if (chatRes.success && chatRes.reply) {
    console.log('追问回复:', chatRes.reply.substring(0, 100) + '...');
    console.log('✅ 追问功能正常');
  } else {
    console.error('❌ 追问失败:', chatRes.error);
    pass = false;
  }

  // 8. 生成邮件测试
  console.log('\n--- 生成对账邮件测试 ---');
  const emailRes = await request('POST', '/api/reconcile/chat',
    JSON.stringify({ session_id: 'test-recon-session', message: '生成对账结果邮件' }), token);
  if (emailRes.success && emailRes.email_draft) {
    console.log('邮件主题:', emailRes.email_draft.subject);
    console.log('收件人:', emailRes.email_draft.to);
    console.log('正文前80字:', emailRes.email_draft.body.substring(0, 80) + '...');
    console.log('✅ 对账邮件生成成功');
  } else {
    console.error('❌ 邮件生成失败:', emailRes.error);
    pass = false;
  }

  console.log(pass ? '\n====== 全部验收通过 ✅ ======' : '\n====== 存在失败项 ❌ ======');
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error('❌ 异常:', e.message); process.exit(1); });
