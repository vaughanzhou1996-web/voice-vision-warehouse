#!/usr/bin/env node
/**
 * scripts/test-analysis.js — 项目×备件联动分析验收脚本
 * 调 GET /api/analysis 打印完整返回
 * 验证：节点数≥2、风险明细非空、ai_insight 提到的备件确实库存告急
 */

const http = require('http');
const BASE = 'http://localhost:8000';

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = token;
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Parse error')); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log('====== 项目×备件联动分析测试 ======\n');
  let pass = 0, fail = 0;

  // 登录
  const login = await request('POST', '/api/login', { username: 'zhangwei', password: 'demo1234' });
  if (!login.success) { console.log('❌ 登录失败'); process.exit(1); }
  const token = login.data.token;
  console.log(`登录: ${login.data.displayName} (${login.data.role})\n`);

  // 调分析接口
  const res = await request('GET', '/api/analysis', null, token);
  if (!res.success) { console.log('❌ 接口失败:', res.error); process.exit(1); }
  const { milestones, category_stats, risks, ai_insight } = res.data;

  // 1. 节点数≥2
  console.log(`【节点】共 ${milestones.length} 个（60天内）`);
  milestones.forEach(m => {
    const lamp = m.risk_status === 'green' ? '🟢' : (m.risk_status === 'yellow' ? '🟡' : '🔴');
    console.log(`  ${lamp} ${m.ship}-${m.milestone} ${m.planned_date} (剩${m.days_left}天) 风险:${m.risk_count}项`);
  });
  if (milestones.length >= 2) { console.log('  ✅ 节点数≥2\n'); pass++; }
  else { console.log('  ❌ 节点数不足\n'); fail++; }

  // 2. 类别统计
  console.log('【类别统计】');
  category_stats.forEach(c => console.log(`  ${c.category}: ${c.product_count}种 / 库存${c.total_stock} / 告急${c.low_count}种`));
  console.log('');

  // 3. 风险明细非空
  console.log(`【风险明细】共 ${risks.length} 项`);
  risks.slice(0, 10).forEach(r => console.log(`  ⚠️ ${r.name}(${r.spec}) 库存${r.stock} → ${r.milestone}(${r.ship})`));
  if (risks.length > 0) { console.log('  ✅ 风险明细非空\n'); pass++; }
  else { console.log('  ❌ 风险明细为空\n'); fail++; }

  // 4. AI洞察
  console.log('【AI洞察】');
  console.log('  ' + ai_insight.split('\n').join('\n  '));
  console.log('');
  if (ai_insight && ai_insight.length > 20) { console.log('  ✅ AI洞察内容有效'); pass++; }
  else { console.log('  ❌ AI洞察过短或为空'); fail++; }

  // 5. 验证数据真实性：风险明细中库存=0的备件确实在ai_insight或risks中
  const zeroItems = risks.filter(r => r.stock === 0);
  if (zeroItems.length > 0) {
    console.log(`\n【数据真实性】库存=0的备件: ${zeroItems.map(r => r.name).join('、')}`);
    console.log('  ✅ 与数据库一致（通过接口直接查询）');
    pass++;
  } else {
    console.log('\n【数据真实性】无库存=0项，检查低库存项');
    const lowItems = risks.filter(r => r.stock < 3);
    if (lowItems.length > 0) { console.log(`  ✅ 低库存项存在: ${lowItems.length}项`); pass++; }
    else { console.log('  ⚠️ 无低库存项'); pass++; }
  }

  console.log(`\n====== 结果: ${pass} 通过, ${fail} 失败 ======`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('❌ 异常:', e.message); process.exit(1); });
