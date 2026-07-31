#!/usr/bin/env node
/**
 * smoke-demo.js — 只读线上 smoke 测试
 * 用法: node scripts/smoke-demo.js [BASE_URL]
 * 默认: http://localhost:8000
 * 禁止调用: reset, inbound, outbound, edit, rollback, mail, AI识别
 */
const http = require('http');
const https = require('https');

const BASE = process.argv[2] || 'http://localhost:8000';
let pass = 0, fail = 0;
const times = [];

function ok(msg, ms) { console.log(`  ✅ ${msg}${ms ? ' (' + ms + 'ms)' : ''}`); pass++; }
function ng(msg) { console.log(`  ❌ ${msg}`); fail++; }

function req(method, urlPath, body, token) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const mod = u.protocol === 'https:' ? https : http;
    const opts = { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: {} };
    if (token) opts.headers['Authorization'] = token;
    if (body) opts.headers['Content-Type'] = 'application/json';
    const r = mod.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const ms = Date.now() - start;
        try { resolve({ status: res.statusCode, body: JSON.parse(d), ms, headers: res.headers }); }
        catch (e) { resolve({ status: res.statusCode, body: d, ms, headers: res.headers }); }
      });
    });
    r.on('error', reject);
    r.setTimeout(10000, () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function main() {
  console.log(`═══ 只读 Smoke 测试 ═══`);
  console.log(`目标: ${BASE}\n`);

  // 1. 首页 200
  try {
    const r = await req('GET', '/');
    if (r.status === 200) ok(`首页 200`, r.ms); else ng(`首页 ${r.status}`);
  } catch (e) { ng('首页不可达: ' + e.message); }

  // 2. 手机 UA → 302 mobile.html
  try {
    const u = new URL('/', BASE);
    const opts = { method: 'GET', hostname: u.hostname, port: u.port, path: '/', headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)' } };
    const r = await new Promise((resolve, reject) => {
      const rq = http.request(opts, res => { resolve({ status: res.statusCode, headers: res.headers }); res.resume(); });
      rq.on('error', reject); rq.end();
    });
    if (r.status === 302 && (r.headers.location || '').includes('mobile')) ok('手机UA→302→mobile', 0);
    else ng(`手机UA: status=${r.status} loc=${r.headers.location}`);
  } catch (e) { ng('手机UA测试失败: ' + e.message); }

  // 3. 登录
  let token = '';
  try {
    const r = await req('POST', '/api/login', { username: 'caojie', password: 'demo1234' });
    if (r.body.success && r.body.data.token) { token = r.body.data.token; ok('登录成功', r.ms); }
    else ng('登录失败: ' + (r.body.error || ''));
  } catch (e) { ng('登录异常: ' + e.message); }

  // 4. 版本
  try {
    const r = await req('GET', '/api/version');
    if (r.body.version) ok(`版本: ${r.body.version}`, r.ms); else ng('无版本信息');
  } catch (e) { ng('版本接口异常'); }

  // 5. ships/stats 至少两艘船
  try {
    const r = await req('GET', '/api/ships/stats', null, token);
    if (r.body.success && r.body.data && r.body.data.length >= 2) ok(`ships/stats ${r.body.data.length}艘船`, r.ms);
    else ng(`ships/stats: ${JSON.stringify(r.body).slice(0, 100)}`);
  } catch (e) { ng('ships/stats异常: ' + e.message); }

  // 6. 选择 YY01
  try {
    const r = await req('POST', '/api/select-ship', { ship: 'YY01' }, token);
    if (r.body.success) ok('选择YY01成功', r.ms); else ng('选择YY01失败');
  } catch (e) { ng('select-ship异常'); }

  // 7. inventory 非空
  try {
    const r = await req('GET', '/api/inventory?ship=YY01', null, token);
    if (r.body.success && r.body.data && r.body.data.length > 0) ok(`YY01库存${r.body.data.length}项`, r.ms);
    else ng('YY01库存为空');
  } catch (e) { ng('inventory异常'); }

  // 8. milestones
  try {
    const r = await req('GET', '/api/milestones?ship=YY01', null, token);
    if (r.body.success && r.body.data && r.body.data.length >= 8) ok(`YY01节点${r.body.data.length}个`, r.ms);
    else ng(`milestones: ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
  } catch (e) { ng('milestones异常'); }

  // 9. forecast 路由存在 (不触发 LLM)
  try {
    const r = await req('GET', '/api/forecast?ship=YY01', null, token);
    if (r.status === 200) ok('forecast路由存在', r.ms); else ng(`forecast: ${r.status}`);
  } catch (e) { ng('forecast异常'); }

  // 10. 核心静态资源
  for (const p of ['/style.css', '/app.js', '/mobile.html', '/lib/echarts.min.js']) {
    try {
      const r = await req('GET', p);
      if (r.status === 200) ok(`静态 ${p}`, r.ms); else ng(`静态 ${p}: ${r.status}`);
    } catch (e) { ng(`静态 ${p} 不可达`); }
  }

  console.log(`\n═══ Smoke结果: ${pass} 通过 / ${fail} 失败 ═══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('Smoke异常:', e); process.exit(1); });
