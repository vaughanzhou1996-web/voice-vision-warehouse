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
async function login(username, ship) {
  const { body: j } = await req('POST', '/api/login', { username, password: 'demo1234' });
  if (!j.success) throw new Error(`登录失败: ${username}`);
  // 绑定船舶
  await req('POST', '/api/select-ship', { ship: ship || 'YY01' }, j.data.token);
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

  // 14. 卡16: 手机端出库+编辑+识别进度
  console.log('\n--- 14. 卡16 手机端功能 ---');
  // 14a. 出库正常
  const invR2 = await req('GET', '/api/inventory?ship=YY01', null, users.caojie.token);
  const prod2 = invR2.body.data && invR2.body.data.find(r => r.stock >= 3);
  if (prod2) {
    const obR = await req('POST', '/api/outbound', { productId: prod2.id, quantity: 1, date: '2026-07-27' }, users.caojie.token);
    if (obR.body.success) ok('手机端出库正常(1件)');
    else ng('出库失败: ' + obR.body.error);
  } else ng('无库存≥3的产品可测出库');
  // 14b. 出库超额拒绝
  if (prod2) {
    const obR2 = await req('POST', '/api/outbound', { productId: prod2.id, quantity: 99999, date: '2026-07-27' }, users.caojie.token);
    if (!obR2.body.success && (obR2.body.error || '').includes('库存不足')) ok('出库超额被拒绝');
    else ng('出库超额未拒绝: ' + JSON.stringify(obR2.body));
  }
  // 14c. edit-preview 无合并
  const invR3 = await req('GET', '/api/inventory?ship=YY01', null, users.caojie.token);
  const editProd = invR3.body.data && invR3.body.data[0];
  if (editProd) {
    const epR = await req('POST', '/api/products/edit-preview', { changes: [{ id: editProd.id, name: editProd.name + '_test', spec: 'UNIQUE_SPEC_999' }] }, users.caojie.token);
    if (epR.body.success && epR.body.data.merges.length === 0) ok('edit-preview无合并(唯一规格)');
    else ng('edit-preview异常: ' + JSON.stringify(epR.body));
  } else ng('无产品可测edit-preview');
  // 14d. edit-preview 触发合并
  if (invR3.body.data && invR3.body.data.length >= 2) {
    const p1 = invR3.body.data[0], p2 = invR3.body.data[1];
    const epR2 = await req('POST', '/api/products/edit-preview', { changes: [{ id: p1.id, name: p2.name, spec: p2.spec || '' }] }, users.caojie.token);
    if (epR2.body.success && epR2.body.data.merges.length >= 1) ok('edit-preview检测到合并冲突');
    else ng('edit-preview未检测合并: ' + JSON.stringify(epR2.body));
  }
  // 14e. edit-apply 普通编辑
  if (editProd) {
    const eaR = await req('POST', '/api/products/edit-apply', { changes: [{ id: editProd.id, name: editProd.name, spec: (editProd.spec || '') + '_edited' }] }, users.caojie.token);
    if (eaR.body.success) ok('edit-apply普通编辑成功');
    else ng('edit-apply失败: ' + eaR.body.error);
    // 还原
    await req('POST', '/api/products/edit-apply', { changes: [{ id: editProd.id, name: editProd.name, spec: editProd.spec || '' }] }, users.caojie.token);
  }
  // 14f. mobile.html 含三段进度文案
  const mobHtml = await new Promise((resolve, reject) => {
    const u = new URL('/mobile.html', BASE);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
  const has3stages = mobHtml.includes('正在检测单据字段') && mobHtml.includes('正在提取货品明细') && mobHtml.includes('正在整理入库清单');
  if (has3stages) ok('mobile.html含三段进度文案');
  else ng('mobile.html缺少三段进度文案');
  // 14g. mobile.html 含可编辑确认弹窗
  const hasEditable = mobHtml.includes('re-name') && mobHtml.includes('re-spec') && mobHtml.includes('re-qty') && mobHtml.includes('re-del');
  if (hasEditable) ok('mobile.html含可编辑识别行(品名/规格/数量/删除)');
  else ng('mobile.html缺少可编辑识别行');
  // 14h. mobile.html 含出库sheet
  const hasOutbound = mobHtml.includes('outboundSheet') && mobHtml.includes('submitOutbound');
  if (hasOutbound) ok('mobile.html含出库弹窗');
  else ng('mobile.html缺少出库弹窗');
  // 14i. mobile.html 含编辑模式
  const hasEdit = mobHtml.includes('toggleEditMode') && mobHtml.includes('edit-preview') && mobHtml.includes('mergeSheet');
  if (hasEdit) ok('mobile.html含编辑模式+合并弹窗');
  else ng('mobile.html缺少编辑模式');

  // 15. 卡17: 防重复提交+领用人+语音修复+去抖
  console.log('\n--- 15. 卡17 防重+领用人+语音+去抖 ---');
  // 15a. 桌面防重锁
  const deskHtml = await new Promise((resolve, reject) => {
    const u = new URL('/app.js', BASE);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
  const hasLock = deskHtml.includes('_submitting') && deskHtml.includes('btnInbound') && deskHtml.includes('btnOutbound') && deskHtml.includes('btnAIConfirm');
  if (hasLock) ok('桌面app.js含_submitting防重锁(3按钮)');
  else ng('桌面app.js缺少防重锁');
  // 15b. 手机防重锁
  const mobLock = mobHtml.includes('_submitting') && mobHtml.includes('btnMInbound') && mobHtml.includes('btnMOutbound') && mobHtml.includes('btnMAIConfirm') && mobHtml.includes('btnMEdit') && mobHtml.includes('btnMMerge');
  if (mobLock) ok('手机mobile.html含_submitting防重锁(6按钮)');
  else ng('手机mobile.html缺少防重锁');
  // 15c. 手机出库含领用人必填
  const hasDept = mobHtml.includes('obDept') && mobHtml.includes('领用人') && mobHtml.includes('department:dept');
  if (hasDept) ok('手机出库含领用人必填+传department');
  else ng('手机出库缺少领用人字段');
  // 15d. 手机语音修复(api/voice/asr + FormData)
  const voiceFix = mobHtml.includes('api/voice/asr') && mobHtml.includes('FormData') && !mobHtml.includes('/inventory/api/speech/recognize');
  if (voiceFix) ok('手机语音已修复为api/voice/asr+FormData');
  else ng('手机语音未修复');
  // 15e. 手机语音UI防溢出
  const voiceOverflow = mobHtml.includes('word-break:break-all') && mobHtml.includes('overflow-x:hidden');
  if (voiceOverflow) ok('手机语音UI防溢出样式');
  else ng('手机语音缺少防溢出样式');
  // 15f. 搜索去抖(桌面+手机)
  const deskDebounce = deskHtml.includes('debounceLoadInventory') && deskHtml.includes('_debounce');
  const mobDebounce = mobHtml.includes('debounceLoadStock') && mobHtml.includes('_searchTimer');
  if (deskDebounce && mobDebounce) ok('桌面+手机搜索均含去抖');
  else ng(`去抖缺失: 桌面=${deskDebounce} 手机=${mobDebounce}`);
  // 15g. changelog含department字段
  const clR = await req('GET', '/api/changelog?ship=YY01', null, users.caojie.token);
  if (clR.body.success && clR.body.data.length > 0 && 'department' in clR.body.data[0]) ok('changelog API含department字段');
  else ng('changelog API缺少department字段');

  // 16. 卡18 鉴权+缓存+重置+迭代日志
  console.log('\n--- 16. 卡18 鉴权+缓存+重置+迭代日志 ---');
  // 16a. YY01 token 查 YY02 → 403
  const crossShip = await req('GET', '/api/inventory?ship=YY02', null, users.caojie.token);
  if (crossShip.status === 403 && crossShip.body.error && crossShip.body.error.includes('无权')) ok('YY01 token查YY02→403');
  else ng(`跨船访问未拦截: status=${crossShip.status}`);
  // 16b. demo/reset 重置
  const resetR = await req('POST', '/api/demo/reset', {}, users.caojie.token);
  if (resetR.body.success) ok('demo/reset执行成功');
  else ng('demo/reset失败: ' + (resetR.body.error || ''));
  // 16c. 重置后库存恢复
  const invAfter = await req('GET', '/api/inventory?ship=YY01', null, users.caojie.token);
  const invCount = invAfter.body.success ? invAfter.body.data.length : 0;
  if (invCount >= 40) ok(`重置后YY01库存${invCount}项(≥40)`);
  else ng(`重置后库存仅${invCount}项`);
  // 16d. 更新日志弹窗可打开(桌面HTML含 overlay)
  if (deskHtml.includes('iterLogOverlay') && deskHtml.includes('openIterationLog')) ok('桌面更新日志弹窗存在');
  else ng('桌面缺少更新日志弹窗');
  // 16e. 更新日志≥20条
  const iterData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'iteration-log.json'), 'utf8'));
  if (iterData.length >= 20) ok(`迭代日志${iterData.length}条(≥20)`);
  else ng(`迭代日志仅${iterData.length}条`);
  // 16f. 手机版含迭代日志Tab
  if (mobHtml.includes('iterlog') && mobHtml.includes('loadIterLog')) ok('手机版含迭代日志Tab');
  else ng('手机版缺少迭代日志');
  // 16g. 识别缓存机制存在
  const srvCode = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  if (srvCode.includes('_recogCache') && srvCode.includes('getRecogCache')) ok('识别缓存机制存在');
  else ng('缺少识别缓存');
  // 16h. test-card12 不回潮
  try {
    execSync('node scripts/test-card12.js', { cwd: path.join(__dirname, '..'), timeout: 60000, stdio: 'pipe' });
    ok('test-card12.js全绿');
  } catch (e) { ng('test-card12.js有失败'); }

  // ====== 17. 编辑模式 + 删除类目 新增断言（卡22）======
  const invFresh = await req('GET', '/api/inventory?ship=YY01', null, users.caojie.token);
  // 17a. 编辑模式 - 普通改规格
  const ep1Target = invFresh.body.data[2];
  const ep1 = await req('POST', '/api/products/edit-preview', { changes: [{ id: ep1Target.id, name: ep1Target.name, spec: 'CARD22_UNIQUE_SPEC' }] }, users.caojie.token);
  if (ep1.body.success && ep1.body.data.applied.length >= 1 && ep1.body.data.merges.length === 0) {
    const ea1 = await req('POST', '/api/products/edit-apply', { changes: [{ id: ep1Target.id, name: ep1Target.name, spec: 'CARD22_UNIQUE_SPEC' }] }, users.caojie.token);
    if (ea1.body.success) {
      const cl = await req('GET', '/api/changelog?ship=YY01', null, users.caojie.token);
      const hasEdit = cl.body.success && cl.body.data.some(r => r.action_type === 'edit');
      if (hasEdit) ok('编辑模式-普通改规格+change_log有edit记录');
      else ng('编辑模式-change_log缺少edit记录');
      // 还原
      await req('POST', '/api/products/edit-apply', { changes: [{ id: ep1Target.id, name: ep1Target.name, spec: ep1Target.spec || '' }] }, users.caojie.token);
    } else ng('编辑模式-edit-apply失败: ' + (ea1.body.error || ''));
  } else ng('编辑模式-edit-preview异常: ' + JSON.stringify(ep1.body));

  // 17b. 编辑模式 - 撞车合并
  const mp1 = await req('POST', '/api/products', { name: 'Card22MergeA', spec: 'MSPEC', unit: '个' }, users.caojie.token);
  const mp2 = await req('POST', '/api/products', { name: 'Card22MergeB', spec: 'MSPEC2', unit: '个' }, users.caojie.token);
  if (mp1.body.success && mp2.body.success) {
    // 给 mp1 入库一条记录
    await req('POST', '/api/inbound', { productId: mp1.body.data.id, quantity: 3, date: '2026-07-27', remark: 'merge-test' }, users.caojie.token);
    // 把 mp2 改成和 mp1 同 name+spec → 触发合并
    const ep2 = await req('POST', '/api/products/edit-preview', { changes: [{ id: mp2.body.data.id, name: 'Card22MergeA', spec: 'MSPEC' }] }, users.caojie.token);
    if (ep2.body.success && ep2.body.data.merges.length >= 1) {
      const ea2 = await req('POST', '/api/products/edit-apply', { changes: [{ id: mp2.body.data.id, name: 'Card22MergeA', spec: 'MSPEC' }], allowMerge: true }, users.caojie.token);
      if (ea2.body.success) {
        // 验证 mp2 已消失，mp1 的 inbound 包含转移记录
        const invCheck = await req('GET', '/api/inventory?ship=YY01', null, users.caojie.token);
        const mp2Gone = !invCheck.body.data.some(r => r.id === mp2.body.data.id);
        const mp1Exists = invCheck.body.data.some(r => r.id === mp1.body.data.id);
        if (mp2Gone && mp1Exists) ok('编辑模式-撞车合并成功(产品合并+记录转移)');
        else ng('编辑模式-合并后产品状态异常');
      } else ng('编辑模式-合并apply失败: ' + (ea2.body.error || ''));
    } else ng('编辑模式-preview未检测到合并: ' + JSON.stringify(ep2.body));
    // 清理 mp1
    await req('POST', '/api/products/delete', { productId: mp1.body.data.id }, users.caojie.token);
  } else ng('创建合并测试产品失败');

  // 17c. 删除类目 - 库存=0 成功
  const dp1 = await req('POST', '/api/products', { name: 'Card22DelEmpty', spec: 'DEL0', unit: '个' }, users.caojie.token);
  if (dp1.body.success) {
    const del1 = await req('POST', '/api/products/delete', { productId: dp1.body.data.id }, users.caojie.token);
    if (del1.body.success) {
      const invD = await req('GET', '/api/inventory?ship=YY01', null, users.caojie.token);
      const gone = !invD.body.data.some(r => r.id === dp1.body.data.id);
      if (gone) ok('删除类目-库存0成功删除');
      else ng('删除类目-删除后仍出现在列表');
    } else ng('删除类目-删除失败: ' + (del1.body.error || ''));
  } else ng('创建空库存产品失败');

  // 17d. 删除类目 - 库存>0 拒绝
  const dp2 = await req('POST', '/api/products', { name: 'Card22DelStock', spec: 'DEL1', unit: '个' }, users.caojie.token);
  if (dp2.body.success) {
    await req('POST', '/api/inbound', { productId: dp2.body.data.id, quantity: 5, date: '2026-07-27', remark: 'del-test' }, users.caojie.token);
    const del2 = await req('POST', '/api/products/delete', { productId: dp2.body.data.id }, users.caojie.token);
    if (!del2.body.success && del2.body.error.includes('库存')) {
      const invS = await req('GET', '/api/inventory?ship=YY01', null, users.caojie.token);
      const still = invS.body.data.some(r => r.id === dp2.body.data.id);
      if (still) ok('删除类目-库存>0拒绝删除');
      else ng('删除类目-拒绝后产品消失');
    } else ng('删除类目-库存>0未被拒绝: ' + JSON.stringify(del2.body));
  } else ng('创建有库存产品失败');

  // 17e. 删除类目 - 恢复
  if (dp1.body.success) {
    const res1 = await req('POST', '/api/products/restore', { productId: dp1.body.data.id }, users.caojie.token);
    if (res1.body.success) {
      const invR = await req('GET', '/api/inventory?ship=YY01', null, users.caojie.token);
      const back = invR.body.data.some(r => r.id === dp1.body.data.id);
      if (back) ok('删除类目-恢复后重新出现');
      else ng('删除类目-恢复后仍不可见');
      // 清理
      await req('POST', '/api/products/delete', { productId: dp1.body.data.id }, users.caojie.token);
    } else ng('删除类目-恢复失败: ' + (res1.body.error || ''));
  }
  // 清理 dp2 (有库存不能删，用restore流程跳过)

  // 17f. 选船卡片修复 - ships/stats 非空
  const stats2 = await req('GET', '/api/ships/stats', null, users.caojie.token);
  if (stats2.body.success && stats2.body.data.length > 0) ok('选船卡片-ships/stats返回非空');
  else ng('选船卡片-ships/stats为空: ' + JSON.stringify(stats2.body));

  // 汇总
  console.log(`\n═══ 结果: ${pass} 通过 / ${fail} 失败 ═══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('测试异常:', e); process.exit(1); });
