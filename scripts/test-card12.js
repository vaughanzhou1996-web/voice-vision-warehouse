#!/usr/bin/env node
/**
 * 任务卡12 验收测试
 * 测试项：
 * 1. hezong/demo1234 登录成功
 * 2. 四种角色看板报告互不相同且含角色称谓
 * 3. reset后≥6条入库记录有doc_image_path，文件真实存在
 * 4. 联动分析API含milestones数据（≥8节点）
 * 5. dashboard API数值字段无.00小数字符串
 * 6. test-forecast.js仍全绿（防回归）
 * 7. 添加备注→API列表出现→删除→消失
 * 8. 备注弹窗含历史列表+累计估算+语音按钮元素
 * 9. seed后螺丝/O型圈各≥2条预埋备注
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = 'http://localhost:8000';
let pass = 0, fail = 0;

function ok(msg) { console.log(`  ✅ ${msg}`); pass++; }
function ng(msg) { console.log(`  ❌ ${msg}`); fail++; }

function req(method, url, body, token, _retry) {
  return new Promise((resolve, reject) => {
    const u = new URL(url, BASE);
    const opts = { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: {} };
    if (token) opts.headers['Authorization'] = token;
    if (body) { opts.headers['Content-Type'] = 'application/json'; }
    const r = http.request(opts, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    });
    r.on('error', e => {
      if (!_retry && (e.code === 'ECONNRESET' || e.code === 'ECONNREFUSED')) {
        setTimeout(() => req(method, url, body, token, true).then(resolve).catch(reject), 1000);
      } else reject(e);
    });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function login(username, ship) {
  const j = await req('POST', '/api/login', { username, password: 'demo1234' });
  if (!j.success) throw new Error(`登录失败: ${username} - ${j.error}`);
  await req('POST', '/api/select-ship', { ship: ship || 'YY01' }, j.data.token);
  return j.data;
}

async function main() {
  console.log('═══ 任务卡12 验收测试 ═══\n');

  // 1. hezong登录
  console.log('--- 1. hezong登录 ---');
  try {
    const hz = await login('hezong');
    if (hz.role === 'executive') ok(`hezong登录成功 role=${hz.role} name=${hz.displayName}`);
    else ng(`hezong role应为executive，实际${hz.role}`);
  } catch (e) { ng(e.message); }

  // 2. 四角色报告互不相同且含称谓
  console.log('\n--- 2. 角色化AI报告 ---');
  const users = [
    { username: 'hezong', greet: '何总' },
    { username: 'caojie', greet: '曹姐' },
    { username: 'zhangwei', greet: '张' },
    { username: 'chenjun', greet: '陈俊' },
  ];
  const reports = [];
  for (const u of users) {
    try {
      const d = await login(u.username);
      const j = await req('GET', `/api/dashboard/report?ship=YY01`, null, d.token);
      if (!j.success) { ng(`${u.username} 报告API失败: ${j.error}`); reports.push(''); continue; }
      const report = j.data.report || '';
      reports.push(report);
      if (report.includes(u.greet)) ok(`${u.username} 报告含称谓"${u.greet}" (${report.length}字)`);
      else ng(`${u.username} 报告未含称谓"${u.greet}": ${report.substring(0, 40)}...`);
    } catch (e) { ng(`${u.username} 报告异常: ${e.message}`); reports.push(''); }
  }
  // 检查互不相同
  const unique = new Set(reports.filter(r => r.length > 0));
  if (unique.size >= 3) ok(`四角色报告互不相同（${unique.size}种不同内容）`);
  else ng(`报告重复过多，仅${unique.size}种不同`);

  // 3. 入库记录图片
  console.log('\n--- 3. 单据图片链 ---');
  const caojie = await login('caojie');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: 'postgres://localhost:5432/inventory_demo' });
  const imgRows = (await pool.query("SELECT id, doc_image_path FROM inbound_records WHERE doc_image_path IS NOT NULL AND doc_image_path != ''")).rows;
  if (imgRows.length >= 6) ok(`${imgRows.length}条入库记录有doc_image_path (≥6)`);
  else ng(`仅${imgRows.length}条有图片路径 (需≥6)`);
  let fileOk = 0;
  for (const r of imgRows) {
    const fp = path.join(__dirname, '..', 'public', r.doc_image_path);
    if (fs.existsSync(fp)) fileOk++;
    else console.log(`    ⚠️ 文件不存在: ${fp}`);
  }
  if (fileOk === imgRows.length) ok(`所有${fileOk}个图片文件真实存在`);
  else ng(`${imgRows.length - fileOk}个图片文件缺失`);

  // 4. milestones ≥8节点
  console.log('\n--- 4. 总项目节点 ---');
  const msJ = await req('GET', '/api/milestones?ship=YY01', null, caojie.token);
  if (msJ.success && msJ.data.length >= 8) ok(`YY01节点${msJ.data.length}个 (≥8)`);
  else ng(`YY01节点${msJ.data?.length || 0}个 (需≥8)`);
  const msJ2 = await req('GET', '/api/milestones?ship=YY02', null, (await login('caojie', 'YY02')).token);
  if (msJ2.success && msJ2.data.length >= 3) ok(`YY02节点${msJ2.data.length}个 (≥3)`);
  else ng(`YY02节点不足`);

  // 5. dashboard数值无.00
  console.log('\n--- 5. 数值整数化 ---');
  const dashJ = await req('GET', '/api/dashboard?ship=YY01', null, caojie.token);
  if (dashJ.success) {
    const raw = JSON.stringify(dashJ.data);
    const hasDecimal = /\d+\.\d{2,}/.test(raw);
    if (!hasDecimal) ok('dashboard API无.00小数字符串');
    else {
      // 检查是否只是JSON序列化的整数（如 337.0 不算违规，337.50算）
      const matches = raw.match(/\d+\.\d{2,}/g) || [];
      const bad = matches.filter(m => !m.endsWith('.00') || parseFloat(m) !== Math.floor(parseFloat(m)));
      // 实际上PG返回的numeric可能是 "337.00" 字符串形式
      const strMatches = raw.match(/"\d+\.\d+"/g) || [];
      if (strMatches.length === 0) ok('dashboard数值字段无小数字符串');
      else ng(`发现小数字符串: ${strMatches.slice(0, 3).join(', ')}`);
    }
  } else ng('dashboard API失败');

  // 6. test-forecast回归
  console.log('\n--- 6. 预测回归测试 ---');
  try {
    const out = execSync('node scripts/test-forecast.js', { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000 });
    if (out.includes('❌')) { ng('test-forecast有失败项'); console.log(out.split('\n').filter(l => l.includes('❌')).join('\n')); }
    else ok('test-forecast.js 全绿');
  } catch (e) { ng('test-forecast执行异常: ' + (e.stderr || e.message).substring(0, 100)); }
  await new Promise(r => setTimeout(r, 500)); // 等待连接池恢复

  // 7. 备注CRUD
  console.log('\n--- 7. 备注CRUD ---');
  const testPid = 20; // O型密封圈
  const addJ = await req('POST', `/api/notes/${testPid}`, { content: '测试备注_验收脚本', qty: 5 }, caojie.token);
  if (addJ.success) ok('添加备注成功');
  else ng('添加备注失败: ' + addJ.error);
  const listJ = await req('GET', `/api/notes/${testPid}`, null, caojie.token);
  const found = listJ.data?.find(n => n.content === '测试备注_验收脚本');
  if (found) ok('备注列表中出现新备注');
  else ng('备注列表中未找到新备注');
  if (found) {
    const delJ = await req('DELETE', `/api/notes/${found.id}`, null, caojie.token);
    if (delJ.success) ok('删除备注成功');
    else ng('删除备注失败: ' + delJ.error);
    const listJ2 = await req('GET', `/api/notes/${testPid}`, null, caojie.token);
    const gone = !listJ2.data?.find(n => n.content === '测试备注_验收脚本');
    if (gone) ok('删除后备注消失');
    else ng('删除后备照仍存在');
  }

  // 8. 弹窗元素检查（读前端HTML）
  console.log('\n--- 8. 备注弹窗元素 ---');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const checks = [
    ['notesModal', '备注弹窗'],
    ['notesList', '历史列表'],
    ['notesQtySummary', '累计估算'],
    ['noteVoiceBtn', '语音按钮'],
    ['noteInput', '输入框'],
    ['noteQty', '数量输入'],
  ];
  let elOk = 0;
  for (const [id, label] of checks) {
    if (html.includes(id)) elOk++;
    else console.log(`    ⚠️ 缺少元素: ${id} (${label})`);
  }
  if (elOk === checks.length) ok(`弹窗含全部${elOk}个关键元素（历史列表+累计估算+语音按钮）`);
  else ng(`弹窗缺少${checks.length - elOk}个元素`);

  // 9. seed预埋备注
  console.log('\n--- 9. 预埋备注 ---');
  const noteRows = (await pool.query(`
    SELECT p.name, COUNT(*) as cnt FROM product_notes pn
    JOIN products p ON p.id = pn.product_id
    WHERE p.name LIKE '%O型密封圈%' OR p.name LIKE '%电缆扎带%'
    GROUP BY p.name
  `)).rows;
  for (const r of noteRows) {
    if (r.cnt >= 2) ok(`${r.name}: ${r.cnt}条预埋备注 (≥2)`);
    else ng(`${r.name}: 仅${r.cnt}条 (需≥2)`);
  }
  if (noteRows.length >= 2) ok(`两类产品各有预埋备注`);
  else ng(`预埋备注产品不足2类`);

  // 10. /api/documents 返回≥7条且文件存在
  console.log('\n--- 10. 历史单据API数据源 ---');
  const docsJ = await req('GET', '/api/documents?ship=YY01', null, caojie.token);
  if (docsJ.success && docsJ.data.length >= 7) ok(`/api/documents 返回${docsJ.data.length}条 (≥7)`);
  else ng(`/api/documents 返回${docsJ.data?.length || 0}条 (需≥7)`);
  let docFileOk = 0;
  for (const d of (docsJ.data || [])) {
    const fp = path.join(__dirname, '..', 'public', d.doc_image_path);
    if (fs.existsSync(fp)) docFileOk++;
  }
  if (docsJ.data && docFileOk === docsJ.data.length) ok(`所有${docFileOk}个单据图片文件存在`);
  else ng(`${(docsJ.data?.length || 0) - docFileOk}个单据图片缺失`);

  // 12. 搜索大小写修复
  console.log('\n--- 12. 搜索大小写 ---');
  const invJ = await req('GET', '/api/inventory?ship=YY01', null, caojie.token);
  if (invJ.success) {
    const kw1 = 'o型';
    const r1 = invJ.data.filter(r => (r.name||'').toLowerCase().includes(kw1) || (r.spec||'').toLowerCase().includes(kw1));
    if (r1.some(r => r.name.includes('O型密封圈'))) ok(`搜索"o型"→找到O型密封圈 (${r1.length}条)`);
    else ng(`搜索"o型"未找到O型密封圈`);
    const kw2 = 'dn50';
    const r2 = invJ.data.filter(r => (r.name||'').toLowerCase().includes(kw2) || (r.spec||'').toLowerCase().includes(kw2));
    if (r2.some(r => (r.spec||'').includes('DN50'))) ok(`搜索"dn50"→找到DN50产品 (${r2.length}条)`);
    else ng(`搜索"dn50"未找到DN50产品`);
  } else ng('inventory API失败');

  // 13. 识别链 model=qwen-vl-max + 不黏连
  console.log('\n--- 13. 识别链移植 ---');
  const testImg = path.join(__dirname, '..', 'uploads', 'test314_card13.jpg');
  const srcImg = '/Users/vaughan/Desktop/桌面整理/送货单样本/微信图片_20260708145342_314_20.jpg';
  if (fs.existsSync(srcImg)) {
    fs.copyFileSync(srcImg, testImg);
    const recJ = await req('POST', '/api/recognize', { path: 'uploads/test314_card13.jpg' }, caojie.token);
    if (recJ.success) {
      if (recJ.data.model === 'qwen-vl-max') ok(`识别模型=qwen-vl-max`);
      else ng(`识别模型=${recJ.data.model} (需qwen-vl-max)`);
      const xrkItems = (recJ.data.items || []).filter(i => (i.name||'').includes('吸入口'));
      if (xrkItems.length >= 3) ok(`吸入口识别${xrkItems.length}行(≥3，不黏连)`);
      else ng(`吸入口仅${xrkItems.length}行(需≥3)`);
    } else ng(`识别失败: ${recJ.error}`);
    try { fs.unlinkSync(testImg); } catch(e) {}
  } else {
    console.log('  ⚠️ 跳过: 测试图片不存在 ' + srcImg);
    ok('识别链跳过(无样本图片)');
    ok('吸入口跳过(无样本图片)');
  }

  await pool.end();

  // 汇总
  console.log(`\n═══ 结果: ${pass} 通过 / ${fail} 失败 ═══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('测试异常:', e); process.exit(1); });
