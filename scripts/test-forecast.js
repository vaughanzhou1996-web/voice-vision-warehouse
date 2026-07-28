#!/usr/bin/env node
/**
 * scripts/test-forecast.js — 建造周期×库存趋势预测验收
 * 1. 验证预埋的 4 个断料案例全部被算出，断料日手算核对正确
 * 2. 验证计划出库数字与 build-schedule.json 一致、当前库存与 DB 一致
 * 3. 验证安全备件 status=green 无误报
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
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Parse error: ' + data.substring(0, 200))); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// 手算预期断料案例（基于实际 DB 库存）
const EXPECTED_STOCKOUTS = [
  { name: '截止阀', spec: 'GB/T587 DN50 PN16', stock: 0, planned: 5, stockout_date: '2026-08-05' },
  { name: '泵用机械密封', spec: '104-25 碳化硅/碳', stock: 2, planned: 5, stockout_date: '2026-08-08' },
  { name: '船用断路器', spec: 'DZ47-63 C32 2P', stock: 0, planned: 6, stockout_date: '2026-08-10' },
  { name: '球阀', spec: 'Q41F-16C DN25', stock: 0, planned: 5, stockout_date: '2026-08-12' },
];

// 安全备件（不应误报）
const EXPECTED_SAFE = [
  { name: '蝶阀', spec: 'D71X-16 DN200', stock: 14 },
  { name: '止回阀', spec: 'H44H-16C DN50', stock: 46 },
  { name: '交流接触器', spec: 'CJX2-2510 220V', stock: 27 },
];

async function main() {
  console.log('====== 建造周期×库存趋势预测验收 ======\n');

  // 1. 登录
  const login = await request('POST', '/api/login', { username: 'caojie', password: 'demo1234' });
  if (!login.success) { console.error('❌ 登录失败'); process.exit(1); }
  const token = login.data.token;
  console.log('✅ 登录成功\n');

  // 2. 调用预测接口
  console.log('--- 调用 GET /api/forecast ---');
  const res = await request('GET', '/api/forecast', null, token);
  if (!res.success) { console.error('❌ 预测接口失败:', res.error); process.exit(1); }
  const forecast = res.data.forecast;
  console.log(`  返回 ${forecast.length} 条预测结果\n`);

  // 3. 验证断料案例
  console.log('--- 断料案例验证（手算核对）---');
  let pass = 0, fail = 0;
  for (const exp of EXPECTED_STOCKOUTS) {
    const found = forecast.find(f => f.product === exp.name && f.spec === exp.spec);
    if (!found) {
      console.log(`  ❌ 未找到: ${exp.name} ${exp.spec}`);
      fail++; continue;
    }
    // 验证当前库存
    if (found.current_stock !== exp.stock) {
      console.log(`  ❌ ${exp.name} 库存不一致: 预期${exp.stock} 实际${found.current_stock}`);
      fail++; continue;
    }
    // 验证计划出库总量
    if (found.total_planned !== exp.planned) {
      console.log(`  ❌ ${exp.name} 计划出库不一致: 预期${exp.planned} 实际${found.total_planned}`);
      fail++; continue;
    }
    // 验证断料日
    if (found.stockout_date !== exp.stockout_date) {
      console.log(`  ❌ ${exp.name} 断料日不一致: 预期${exp.stockout_date} 实际${found.stockout_date}`);
      fail++; continue;
    }
    // 验证状态
    if (found.status !== 'red') {
      console.log(`  ❌ ${exp.name} 状态应为red，实际${found.status}`);
      fail++; continue;
    }
    console.log(`  ✅ ${exp.name}(${exp.spec}) 库存${exp.stock}→计划${exp.planned}→断料${exp.stockout_date}`);
    pass++;
  }

  // 4. 验证与 build-schedule.json 一致性
  console.log('\n--- 计划出库与 build-schedule.json 一致性 ---');
  const schedule = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'build-schedule.json'), 'utf8'));
  // 聚合 schedule 中每个备件的总计划量
  const scheduleMap = {};
  const now = new Date();
  const horizon = new Date(now.getTime() + 60 * 86400000);
  for (const entry of schedule) {
    const d = new Date(entry.date + 'T00:00:00');
    if (d < now || d > horizon) continue;
    for (const part of entry.required_parts) {
      const key = `${part.name}|${part.spec || ''}`;
      scheduleMap[key] = (scheduleMap[key] || 0) + part.qty;
    }
  }
  let schedPass = 0;
  for (const f of forecast) {
    const key = `${f.product}|${f.spec}`;
    const expected = scheduleMap[key] || 0;
    if (f.total_planned !== expected) {
      console.log(`  ❌ ${f.product}(${f.spec}) 计划量不一致: json=${expected} api=${f.total_planned}`);
      fail++;
    } else {
      schedPass++;
    }
  }
  console.log(`  ✅ ${schedPass}/${forecast.length} 条计划出库量与 build-schedule.json 一致`);

  // 5. 验证安全备件无误报
  console.log('\n--- 安全备件无误报验证 ---');
  for (const exp of EXPECTED_SAFE) {
    const found = forecast.find(f => f.product === exp.name && f.spec === exp.spec);
    if (!found) {
      console.log(`  ⚠️ ${exp.name}(${exp.spec}) 不在预测列表中（可能无计划出库）`);
      continue;
    }
    if (found.status !== 'green') {
      console.log(`  ❌ ${exp.name} 误报！状态=${found.status}（应为green）`);
      fail++;
    } else {
      console.log(`  ✅ ${exp.name}(${exp.spec}) 库存${found.current_stock}→最低${found.projected_min} → green`);
      pass++;
    }
  }

  // 6. AI 洞察
  console.log('\n--- AI 预测洞察 ---');
  if (res.data.insight) {
    console.log('  ' + res.data.insight.substring(0, 150) + '...');
    console.log('  ✅ AI 洞察生成成功');
  } else {
    console.log('  ⚠️ AI 洞察为空（可能 LLM 不可用）');
  }

  // 汇总
  console.log(`\n====== 结果: ${pass} 通过, ${fail} 失败 ${fail === 0 ? '✅ 全部验收通过' : '❌ 存在失败'} ======`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('❌ 异常:', e.message); process.exit(1); });
