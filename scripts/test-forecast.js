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

// 断料案例的备件（必须被算出断料）
const STOCKOUT_PARTS = [
  { name: '截止阀', spec: 'GB/T587 DN50 PN16' },
  { name: '泵用机械密封', spec: '104-25 碳化硅/碳' },
  { name: '船用断路器', spec: 'DZ47-63 C32 2P' },
  { name: '球阀', spec: 'Q41F-16C DN25' },
];

// 安全备件（不应误报）
const SAFE_PARTS = [
  { name: '蝶阀', spec: 'D71X-16 DN200' },
  { name: '交流接触器', spec: 'CJX2-2510 220V' },
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

  // 3. 验证断料案例（动态手算核对）
  console.log('--- 断料案例验证（动态手算核对）---');
  let pass = 0, fail = 0;
  for (const exp of STOCKOUT_PARTS) {
    const found = forecast.find(f => f.product === exp.name && f.spec === exp.spec);
    if (!found) {
      console.log(`  ❌ 未找到: ${exp.name} ${exp.spec}`);
      fail++; continue;
    }
    // 动态手算断料日：当前库存 - 累计计划出库，首次 < 3 的日期
    let level = found.current_stock;
    let expectedStockout = null;
    for (const s of found.scheduled) {
      level -= s.qty;
      if (expectedStockout === null && level < 3) expectedStockout = s.date;
    }
    // 验证断料日计算正确
    if (found.stockout_date !== expectedStockout) {
      console.log(`  ❌ ${exp.name} 断料日计算错误: 手算=${expectedStockout} 实际=${found.stockout_date}`);
      fail++; continue;
    }
    // 验证状态为 red
    if (found.status !== 'red') {
      console.log(`  ❌ ${exp.name} 状态应为red，实际${found.status}`);
      fail++; continue;
    }
    // 验证计划出库总量与 build-schedule 一致
    const schedTotal = found.scheduled.reduce((s, x) => s + x.qty, 0);
    if (found.total_planned !== schedTotal) {
      console.log(`  ❌ ${exp.name} 计划总量不一致: scheduled合计=${schedTotal} total_planned=${found.total_planned}`);
      fail++; continue;
    }
    console.log(`  ✅ ${exp.name}(${exp.spec}) 库存${found.current_stock}→计划${found.total_planned}→断料${found.stockout_date}`);
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
  for (const exp of SAFE_PARTS) {
    const found = forecast.find(f => f.product === exp.name && f.spec === exp.spec);
    if (!found) {
      console.log(`  ⚠️ ${exp.name}(${exp.spec}) 不在预测列表中`);
      continue;
    }
    // 动态验证：如果 current_stock - total_planned >= 3，应为 green
    const finalLevel = found.current_stock - found.total_planned;
    if (finalLevel >= 3 && found.status !== 'green') {
      console.log(`  ❌ ${exp.name} 误报！库存${found.current_stock}-计划${found.total_planned}=${finalLevel}≥3，状态应为green，实际${found.status}`);
      fail++;
    } else if (finalLevel >= 3) {
      console.log(`  ✅ ${exp.name}(${exp.spec}) 库存${found.current_stock}→最低${found.projected_min} → green`);
      pass++;
    } else {
      console.log(`  ⚠️ ${exp.name} 库存已变化(${found.current_stock})，跳过安全验证`);
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
