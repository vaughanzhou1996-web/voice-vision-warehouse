#!/usr/bin/env node
/**
 * test-safety.js — 安全回归测试
 * 覆盖: 输入校验、跨船隔离、并发安全
 * 用法: node scripts/test-safety.js [BASE_URL]
 * 默认: http://localhost:8000
 * 前置: 服务已启动，数据库为 inventory_demo
 */
const http = require('http');

const BASE = process.argv[2] || 'http://localhost:8000';
let pass = 0, fail = 0;

function ok(msg) { console.log(`  ✅ ${msg}`); pass++; }
function ng(msg) { console.log(`  ❌ ${msg}`); fail++; }

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
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
    r.on('error', reject);
    r.setTimeout(15000, () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function main() {
  console.log('═══ 安全回归测试 ═══');
  console.log(`目标: ${BASE}\n`);

  // ─── 登录 & 选船 ───
  console.log('--- 准备: 登录 ---');
  const loginR = await req('POST', '/api/login', { username: 'caojie', password: 'demo1234' });
  if (!loginR.body.success) { console.error('登录失败，无法继续'); process.exit(1); }
  const token = loginR.body.data.token;
  ok('caojie 登录成功');

  await req('POST', '/api/select-ship', { ship: 'YY01' }, token);
  ok('选择 YY01');

  // 获取库存，找一个有库存的产品
  const invR = await req('GET', '/api/inventory?ship=YY01', null, token);
  if (!invR.body.success || !invR.body.data.length) { console.error('库存为空，无法继续'); process.exit(1); }
  const products = invR.body.data;
  const prod = products.find(p => parseFloat(p.stock) >= 5);
  if (!prod) { console.error('无库存≥5的产品'); process.exit(1); }
  const prodId = prod.id;
  const stock = parseFloat(prod.stock);
  ok(`测试产品: ${prod.name} (id=${prodId}, stock=${stock})`);

  // ─── 1. 出库输入校验 ───
  console.log('\n--- 1. 出库输入校验 ---');

  // 1a. quantity = 0 → 400
  {
    const r = await req('POST', '/api/outbound', { productId: prodId, quantity: 0 }, token);
    if (r.status === 400 || (r.body && !r.body.success)) ok('outbound qty=0 → 拒绝');
    else ng(`outbound qty=0: status=${r.status} ${JSON.stringify(r.body).slice(0, 60)}`);
  }

  // 1b. quantity = -1 → 400
  {
    const r = await req('POST', '/api/outbound', { productId: prodId, quantity: -1 }, token);
    if (r.status === 400 || (r.body && !r.body.success)) ok('outbound qty=-1 → 拒绝');
    else ng(`outbound qty=-1: status=${r.status}`);
  }

  // 1c. quantity = "abc" → 400
  {
    const r = await req('POST', '/api/outbound', { productId: prodId, quantity: 'abc' }, token);
    if (r.status === 400 || (r.body && !r.body.success)) ok('outbound qty="abc" → 拒绝');
    else ng(`outbound qty="abc": status=${r.status}`);
  }

  // 1d. quantity = Infinity → 400
  {
    const r = await req('POST', '/api/outbound', { productId: prodId, quantity: Infinity }, token);
    if (r.status === 400 || (r.body && !r.body.success)) ok('outbound qty=Infinity → 拒绝');
    else ng(`outbound qty=Infinity: status=${r.status}`);
  }

  // 1e. quantity = stock+1 → 业务失败(库存不足)
  {
    const r = await req('POST', '/api/outbound', { productId: prodId, quantity: stock + 1 }, token);
    if (!r.body.success && (r.body.error || '').includes('库存不足')) ok(`outbound qty=${stock + 1} → 库存不足`);
    else ng(`outbound qty=${stock + 1}: ${JSON.stringify(r.body).slice(0, 80)}`);
  }

  // ─── 2. 入库输入校验 ───
  console.log('\n--- 2. 入库输入校验 ---');

  // 2a. inbound quantity = -1 → 400
  {
    const r = await req('POST', '/api/inbound', { productId: prodId, quantity: -1 }, token);
    if (r.status === 400 || (r.body && !r.body.success)) ok('inbound qty=-1 → 拒绝');
    else ng(`inbound qty=-1: status=${r.status}`);
  }

  // ─── 3. 批量出库原子性 ───
  console.log('\n--- 3. 批量出库原子性 ---');
  {
    // 找一个库存少的产品
    const lowProd = products.find(p => parseFloat(p.stock) > 0 && parseFloat(p.stock) < 5);
    const goodProd = prod;
    if (lowProd) {
      const items = [
        { productId: goodProd.id, quantity: 1 },
        { productId: lowProd.id, quantity: parseFloat(lowProd.stock) + 100 }  // 超额
      ];
      const r = await req('POST', '/api/outbound/batch', { items, date: '2026-07-31' }, token);
      if (!r.body.success) ok('批量出库含超额项 → 整批失败');
      else ng('批量出库含超额项未被拒: ' + JSON.stringify(r.body).slice(0, 80));
    } else {
      // 所有产品库存都>=5, 用 stock+1 构造超额
      const items = [
        { productId: goodProd.id, quantity: 1 },
        { productId: goodProd.id, quantity: stock + 100 }
      ];
      const r = await req('POST', '/api/outbound/batch', { items, date: '2026-07-31' }, token);
      if (!r.body.success) ok('批量出库含超额项 → 整批失败');
      else ng('批量出库含超额项未被拒');
    }
  }

  // ─── 4. 跨船隔离 ───
  console.log('\n--- 4. 跨船隔离 ---');

  // 获取 YY02 的一个产品 ID
  // 先切到 YY02 获取产品列表
  await req('POST', '/api/select-ship', { ship: 'YY02' }, token);
  const inv2R = await req('GET', '/api/inventory?ship=YY02', null, token);
  let yy02ProdId = null;
  if (inv2R.body.success && inv2R.body.data && inv2R.body.data.length > 0) {
    yy02ProdId = inv2R.body.data[0].id;
  }
  // 切回 YY01
  await req('POST', '/api/select-ship', { ship: 'YY01' }, token);

  // 4a. YY01 token + YY02 productId → 403
  if (yy02ProdId) {
    const r = await req('POST', '/api/outbound', { productId: yy02ProdId, quantity: 1 }, token);
    if (r.status === 403 || (r.body && !r.body.success && (r.body.error || '').includes('无权'))) ok('YY01 token出库YY02产品 → 403');
    else ng(`跨船出库: status=${r.status} ${JSON.stringify(r.body).slice(0, 60)}`);
  } else {
    ng('无法获取YY02产品ID(跳过跨船出库测试)');
  }

  // 4b. YY01 token + YY02 note → 403
  if (yy02ProdId) {
    const r = await req('POST', `/api/notes/${yy02ProdId}`, { content: 'cross-ship test', qty: 1 }, token);
    if (r.status === 403 || (r.body && !r.body.success && (r.body.error || '').includes('无权'))) ok('YY01 token写YY02备注 → 403');
    else ng(`跨船备注: status=${r.status} ${JSON.stringify(r.body).slice(0, 60)}`);
  } else {
    ng('无法获取YY02产品ID(跳过跨船备注测试)');
  }

  // 4c. 选择 YY02 → 正常访问 → 200
  {
    const selR = await req('POST', '/api/select-ship', { ship: 'YY02' }, token);
    const invYY02 = await req('GET', '/api/inventory?ship=YY02', null, token);
    if (selR.body.success && invYY02.status === 200 && invYY02.body.success) ok('切换YY02后正常访问 → 200');
    else ng(`YY02正常访问失败: sel=${selR.body.success} inv=${invYY02.status}`);
    // 切回 YY01
    await req('POST', '/api/select-ship', { ship: 'YY01' }, token);
  }

  // 4d. 未选船直接带 ?ship= 访问 → 400（卡23 鉴权漏洞修复）
  {
    const login2 = await req('POST', '/api/login', { username: 'caojie', password: 'demo1234' });
    const token2 = login2.body.data && login2.body.data.token;
    if (token2) {
      const r = await req('GET', '/api/inventory?ship=YY01', null, token2);
      if (r.status === 400 && r.body.error && r.body.error.includes('请先选择船舶')) ok('未选船带?ship=访问 → 400');
      else ng(`未选船访问: status=${r.status} ${JSON.stringify(r.body).slice(0, 60)}`);
    } else ng('无法获取第二个token');
  }

  // ─── 5. 并发安全 ───
  console.log('\n--- 5. 并发安全 ---');
  {
    // 找一个库存恰好>=5的产品(用 prod)
    // 先出库使库存降到5: 出库 stock-5
    if (stock > 5) {
      const drainR = await req('POST', '/api/outbound', { productId: prodId, quantity: stock - 5 }, token);
      if (!drainR.body.success) { ng(`调整库存失败: ${drainR.body.error}`); }
    }
    // 现在库存应该约为5，两个并发出库各4 → 只有一个成功
    const [r1, r2] = await Promise.all([
      req('POST', '/api/outbound', { productId: prodId, quantity: 4 }, token),
      req('POST', '/api/outbound', { productId: prodId, quantity: 4 }, token)
    ]);
    const s1 = r1.body.success;
    const s2 = r2.body.success;
    if ((s1 && !s2) || (!s1 && s2)) ok('并发出库qty=4×2(stock=5) → 仅一个成功');
    else if (!s1 && !s2) ok('并发出库qty=4×2(stock=5) → 均失败(保守策略,可接受)');
    else ng(`并发出库: 两个都成功(超卖!) s1=${s1} s2=${s2}`);

    // 回滚: 将成功的出库回滚
    if (s1 && r1.body.data && r1.body.data.id) {
      await req('POST', '/api/rollback', { recordId: r1.body.data.id, type: 'outbound' }, token);
    }
    if (s2 && r2.body.data && r2.body.data.id) {
      await req('POST', '/api/rollback', { recordId: r2.body.data.id, type: 'outbound' }, token);
    }
    // 回滚之前 drain 的出库(通过 reset 太重，这里简单处理)
    // 注意: 并发测试会改变库存，后续 e2e 应先 reset
  }

  // ─── 汇总 ───
  console.log(`\n═══ 安全测试结果: ${pass} 通过 / ${fail} 失败 ═══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('安全测试异常:', e); process.exit(1); });
