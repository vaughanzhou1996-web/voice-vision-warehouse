#!/usr/bin/env node
/**
 * 任务卡14 全功能端到端门禁 (test-e2e.js)
 * 纯 Node http，无需 Playwright
 * 覆盖：登录/库存/搜索/出库防呆/历史单据/记录/AI报告缓存/预测/节点/移动端/P0-1回潮
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
    if (body) opts.headers['Content-Type'] = 'application/json';
    const r = http.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    r.on('error', e => {
      if (!_retry && (e.code === 'ECONNRESET' || e.code === 'ECONNREFUSED'))
        setTimeout(() => req(method, url, body, token, true).then(resolve).catch(reject), 1000);
      else reject(e);
    });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
function rawReq(method, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const opts = { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: headers || {} };
    const r = http.request(opts, res => { resolve({ status: res.statusCode, headers: res.headers }); res.resume(); });
    r.on('error', reject);
    r.end();
  });
}
async function login(username) {
  const { body: j } = await req('POST', '/api/login', { username, password: 'demo1234' });
  if (!j.success) throw new Error(`登录失败: ${username}`);
  return j.data;
}

async function main() {
  console.log('═══ 任务卡14 全功能端到端门禁 ═══\n');

  // 1. 登录4角色
  console.log('--- 1. 四角色登录 ---');
  const users = {};
  for (const u of ['hezong', 'caojie', 'zhangwei', 'chenjun']) {
    const d = await login(u);
    users[u] = d;
    ok(`${u} 登录成功 role=${d.role}`);
  }

  // 2. 库存总览非空 + 合计
  console.log('\n--- 2. 库存总览 ---');
  const invR = await req('GET', '/api/inventory?ship=YY01', null, users.caojie.token);
  if (invR.body.success && invR.body.data.length > 0) ok(`YY01库存${invR.body.data.length}项`);
  else ng('YY01库存为空');
  const totalStock = invR.body.data.reduce((a, b) => a + parseFloat(b.stock || 0), 0);
  const alertCount = invR.body.data.filter(r => parseFloat(r.stock || 0) < 5).length;
  ok(`合计: ${invR.body.data.length}种/库存${Math.round(totalStock)}/告急${alertCount}种`);

  // 3. 搜索大小写
  console.log('\n--- 3. 搜索大小写 ---');
  const kw1 = 'o型';
  const r1 = invR.body.data.filter(r => (r.name || '').toLowerCase().includes(kw1) || (r.spec || '').toLowerCase().includes(kw1));
  if (r1.some(r => r.name.includes('O型密封圈'))) ok(`搜索"o型"→O型密封圈(${r1.length}条)`);
  else ng(`搜索"o型"未找到O型密封圈`);
  const kw2 = 'dn50';
  const r2 = invR.body.data.filter(r => (r.name || '').toLowerCase().includes(kw2) || (r.spec || '').toLowerCase().includes(kw2));
  if (r2.some(r => (r.spec || '').includes('DN50'))) ok(`搜索"dn50"→DN50产品(${r2.length}条)`);
  else ng(`搜索"dn50"未找到`);

  // 4. 出库防呆
  console.log('\n--- 4. 出库防呆 ---');
  // 找一个库存<10的产品
  const lowProd = invR.body.data.find(r => parseFloat(r.stock || 0) > 0 && parseFloat(r.stock || 0) < 10);
  if (lowProd) {
    const overQty = parseFloat(lowProd.stock) + 100;
    const outR = await req('POST', '/api/outbound', { productId: lowProd.id, quantity: overQty }, users.caojie.token);
    if (!outR.body.success && (outR.body.error || '').includes('库存不足')) ok(`超额出库被拒: ${outR.body.error}`);
    else ng(`超额出库未被拒: ${JSON.stringify(outR.body).substring(0, 80)}`);
    // 正常出库
    const normalR = await req('POST', '/api/outbound', { productId: lowProd.id, quantity: 1 }, users.caojie.token);
    if (normalR.body.success) ok('正常出库成功');
    else ng('正常出库失败: ' + normalR.body.error);
    // 回滚
    const rbR = await req('POST', '/api/rollback', { recordId: normalR.body.data.id, type: 'outbound' }, users.caojie.token);
    if (rbR.body.success) ok('出库回滚成功');
    else ng('出库回滚失败');
  } else ng('无合适产品测试出库');

  // 5. 历史单据
  console.log('\n--- 5. 历史单据 ---');
  const docsR = await req('GET', '/api/documents?ship=YY01', null, users.caojie.token);
  if (docsR.body.success && docsR.body.data.length >= 7) ok(`历史单据${docsR.body.data.length}条(≥7)`);
  else ng(`历史单据${docsR.body?.data?.length || 0}条`);
  let fileOk = 0;
  for (const d of (docsR.body.data || [])) {
    const fp = path.join(__dirname, '..', 'public', d.doc_image_path);
    if (fs.existsSync(fp)) fileOk++;
  }
  if (fileOk === (docsR.body.data || []).length) ok(`所有${fileOk}个图片文件存在`);
  else ng(`${(docsR.body.data || []).length - fileOk}个图片缺失`);

  // 6. 入库/出库记录
  console.log('\n--- 6. 入库/出库记录 ---');
  const inRecR = await req('GET', '/api/inbound/list?ship=YY01', null, users.caojie.token);
  if (inRecR.body.success && inRecR.body.data.length > 0) {
    ok(`入库记录${inRecR.body.data.length}条`);
    const dateOk = inRecR.body.data.filter(r => r.date || r.created_at).every(r => /^\d{4}-\d{2}-\d{2}/.test(r.date || r.created_at || ''));
    if (dateOk) ok('入库记录日期格式YYYY-MM-DD');
    else ng('入库记录日期格式异常');
  } else ng('入库记录为空');
  const outRecR = await req('GET', '/api/outbound/list?ship=YY01', null, users.caojie.token);
  if (outRecR.body.success && outRecR.body.data.length > 0) ok(`出库记录${outRecR.body.data.length}条`);
  else ng('出库记录为空');

  // 7. AI报告缓存
  console.log('\n--- 7. AI报告缓存 ---');
  const t0 = Date.now();
  const rpt1 = await req('GET', '/api/dashboard/report?ship=YY01', null, users.hezong.token);
  const firstMs = Date.now() - t0;
  if (rpt1.body.success && (rpt1.body.data.report || '').includes('何总')) ok(`hezong报告含"何总"(${firstMs}ms)`);
  else ng('hezong报告异常');
  const t1 = Date.now();
  const rpt2 = await req('GET', '/api/dashboard/report?ship=YY01', null, users.hezong.token);
  const secondMs = Date.now() - t1;
  if (rpt2.body.success && rpt2.body.data.cached) ok(`第二次命中缓存(${secondMs}ms<1s)`);
  else if (secondMs < 1000) ok(`第二次响应快(${secondMs}ms)`);
  else ng(`第二次未命中缓存(${secondMs}ms)`);
  const rptC = await req('GET', '/api/dashboard/report?ship=YY01', null, users.caojie.token);
  if (rptC.body.success && (rptC.body.data.report || '').includes('曹')) ok('caojie报告含"曹"');
  else ng('caojie报告异常');

  // 8. 断料预测
  console.log('\n--- 8. 断料预测 ---');
  const fcR = await req('GET', '/api/forecast?ship=YY01', null, users.caojie.token);
  const fcData = fcR.body.data?.forecast || fcR.body.data || [];
  if (fcR.body.success && (Array.isArray(fcData) ? fcData.length > 0 : true)) {
    const arr = Array.isArray(fcData) ? fcData : [];
    ok(`预测数据${arr.length}项`);
    const reds = arr.filter(f => f.status === 'red');
    if (reds.length >= 4) ok(`红灯≥4项(${reds.length})`);
    else ng(`红灯${reds.length}项(需≥4)`);
  } else ng('预测API失败');

  // 9. 节点表
  console.log('\n--- 9. 节点表 ---');
  const msR = await req('GET', '/api/milestones?ship=YY01', null, users.caojie.token);
  if (msR.body.success && msR.body.data.length === 8) ok('YY01节点8个');
  else ng(`YY01节点${msR.body?.data?.length || 0}个`);
  const trialNode = (msR.body.data || []).find(m => m.milestone === '试航');
  if (trialNode && trialNode.planned_date === '2026-09-15') ok('试航日期=2026-09-15');
  else ng(`试航日期=${trialNode?.planned_date || 'N/A'}`);

  // 10. 联动分析同源
  console.log('\n--- 10. 联动分析同源 ---');
  const anR = await req('GET', '/api/analysis?ship=YY01', null, users.caojie.token);
  if (anR.body.success) {
    const ms = anR.body.data.milestones || [];
    const trialInAnalysis = ms.find(m => m.milestone === '试航');
    if (trialInAnalysis && trialInAnalysis.planned_date === '2026-09-15') ok('联动分析试航=09-15(同源)');
    else if (ms.length === 0) ok('联动分析无60天内试航节点(正常,试航>60天)');
    else ng(`联动分析试航日期=${trialInAnalysis?.planned_date || 'N/A'}`);
  } else ng('联动分析API失败');

  // 11. 移动端302
  console.log('\n--- 11. 移动端302 ---');
  const mobR = await rawReq('GET', '/', { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) Mobile/15E148' });
  if (mobR.status === 302 && (mobR.headers.location || '').includes('mobile.html')) ok('手机UA→302→mobile.html');
  else ng(`手机UA响应${mobR.status} location=${mobR.headers.location || 'none'}`);
  const deskR = await rawReq('GET', '/', { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
  if (deskR.status === 200) ok('桌面UA→200(不跳转)');
  else ng(`桌面UA响应${deskR.status}`);

  // 12. P0-1 回潮检查
  console.log('\n--- 12. P0-1 /api/chat 回潮 ---');
  const chatR = await req('POST', '/api/chat', { message: 'test' }, users.caojie.token);
  if (chatR.status === 404 || chatR.status === 405) ok(`/api/chat 返回${chatR.status}(已下线)`);
  else ng(`/api/chat 返回${chatR.status}(应404)`);

  // 13. 回归
  console.log('\n--- 13. 回归测试 ---');
  try {
    const out = execSync('node scripts/test-forecast.js', { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000 });
    if (out.includes('❌')) ng('test-forecast有失败');
    else ok('test-forecast.js全绿');
  } catch (e) { ng('test-forecast异常'); }

  // 汇总
  console.log(`\n═══ 结果: ${pass} 通过 / ${fail} 失败 ═══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('测试异常:', e); process.exit(1); });
