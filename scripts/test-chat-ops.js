/**
 * test-chat-ops.js — 对话式库存操作多轮验收脚本
 * 用法: node scripts/test-chat-ops.js
 * 
 * 场景1: 查询 → 指代 → 出库执行
 * 场景2: 库存不足防呆拒绝
 */

const { processMessage, getStock, pool } = require('../lib/chat-ops');

function printTurn(step, userMsg, result) {
  console.log(`\n--- 第${step}轮 ---`);
  console.log(`👤 用户: ${userMsg}`);
  console.log(`🤖 回复: ${result.reply}`);
  console.log(`   action=${result.action} | executed=${result.executed} | stock_after=${result.stock_after} | need_confirm=${result.need_confirm}`);
}

async function findProduct(nameKw, specKw) {
  const r = await pool.query(
    `SELECT id, name, spec, unit FROM products WHERE name ILIKE $1 AND spec ILIKE $2 LIMIT 1`,
    [`%${nameKw}%`, `%${specKw}%`]
  );
  return r.rows[0] || null;
}

async function scenario1() {
  console.log('\n══════════════════════════════════════');
  console.log('  场景1: 查询 + 指代 + 出库执行');
  console.log('══════════════════════════════════════');
  
  const sessionId = 'test-scenario-1-' + Date.now();
  
  // 先查出 DN50 截止阀的初始库存
  const prod = await findProduct('截止阀', 'DN50');
  if (!prod) { console.log('❌ 未找到截止阀 DN50 测试数据'); return false; }
  let stockBefore = await getStock(prod.id);
  console.log(`\n📦 测试目标: ${prod.name} ${prod.spec} (id=${prod.id})，初始库存: ${stockBefore}`);
  
  // 如果库存不足3，先通过引擎入库补充
  if (stockBefore < 3) {
    console.log(`   库存不足3，先入库补充...`);
    await processMessage(sessionId, `截止阀 ${prod.spec} 入10个`, '曹洁');
    stockBefore = await getStock(prod.id);
    console.log(`   补充后库存: ${stockBefore}`);
  }
  
  // 第1轮: 模糊查询 → 应该 clarify
  const r1 = await processMessage(sessionId, '截止阀还有多少', '曹洁');
  printTurn(1, '截止阀还有多少', r1);
  
  const step1Ok = (r1.action === 'clarify' || r1.action === 'query');
  console.log(`   → 期望 clarify/query，实际 ${r1.action}: ${step1Ok ? '✅' : '⚠️'}`);
  
  // 第2轮: 指定规格 → 应该回答库存
  const r2 = await processMessage(sessionId, 'DN50的', '曹洁');
  printTurn(2, 'DN50的', r2);
  
  const step2Ok = (r2.action === 'query' || r2.action === 'clarify');
  console.log(`   → 期望 query，实际 ${r2.action}: ${step2Ok ? '✅' : '⚠️'}`);
  
  // 第3轮: 指代出库 → 应该执行
  const r3 = await processMessage(sessionId, '这个出3个，机务组领的', '曹洁');
  printTurn(3, '这个出3个，机务组领的', r3);
  
  const step3Ok = r3.executed === true;
  console.log(`   → 期望执行出库，实际 executed=${r3.executed}: ${step3Ok ? '✅' : '❌'}`);
  
  // 验证库存确实减3
  const stockAfter = await getStock(prod.id);
  const stockDiff = stockBefore - stockAfter;
  const stockOk = stockDiff === 3;
  console.log(`\n📊 库存验证: 之前=${stockBefore} → 之后=${stockAfter} (差=${stockDiff})`);
  console.log(`   期望减3: ${stockOk ? '✅' : '❌'}`);
  
  return step1Ok && step3Ok && stockOk;
}

async function scenario2() {
  console.log('\n══════════════════════════════════════');
  console.log('  场景2: 库存不足防呆');
  console.log('══════════════════════════════════════');
  
  const sessionId = 'test-scenario-2-' + Date.now();
  
  // 查出球阀 Q41F DN25
  const prod = await findProduct('球阀', 'DN25');
  if (!prod) { console.log('❌ 未找到球阀 Q41F DN25 测试数据'); return false; }
  const stockBefore = await getStock(prod.id);
  console.log(`\n📦 测试目标: ${prod.name} ${prod.spec} (id=${prod.id})，当前库存: ${stockBefore}`);
  
  // 尝试出100个 → 应该被拒绝
  const r1 = await processMessage(sessionId, '把球阀Q41F DN25出100个', '曹洁');
  printTurn(1, '把球阀Q41F DN25出100个', r1);
  
  const refused = r1.executed === false;
  console.log(`   → 期望拒绝(executed=false)，实际 executed=${r1.executed}: ${refused ? '✅' : '❌'}`);
  
  // 验证库存不变
  const stockAfter = await getStock(prod.id);
  const stockOk = stockBefore === stockAfter;
  console.log(`\n📊 库存验证: 之前=${stockBefore} → 之后=${stockAfter}`);
  console.log(`   期望不变: ${stockOk ? '✅' : '❌'}`);
  
  return refused && stockOk;
}

async function main() {
  console.log('🧪 对话式库存操作验收测试\n');
  
  let s1 = false, s2 = false;
  
  try { s1 = await scenario1(); }
  catch (e) { console.log(`❌ 场景1异常: ${e.message}`); }
  
  try { s2 = await scenario2(); }
  catch (e) { console.log(`❌ 场景2异常: ${e.message}`); }
  
  console.log('\n══════════════════════════════════════');
  console.log('  总结');
  console.log('══════════════════════════════════════');
  console.log(`场景1 (查询+指代+出库): ${s1 ? '✅ 通过' : '❌ 失败'}`);
  console.log(`场景2 (防呆拒绝):       ${s2 ? '✅ 通过' : '❌ 失败'}`);
  
  await pool.end();
  if (!s1 || !s2) process.exit(1);
  console.log('\n🎉 全部验收通过！');
}

main();
