/**
 * test-qwen.js — 百炼 Qwen 模型验证脚本
 * 用法: node scripts/test-qwen.js
 * 
 * 验证:
 *   1. 文本链路 (qwen3-max-preview)
 *   2. 视觉链路 (qwen-vl-max) — 用 sharp 生成模拟送货单图片
 */

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { chatText, chatVision, TEXT_MODEL, VISION_MODEL } = require('../lib/qwen');

async function testText() {
  console.log('====== 文本链路测试 ======');
  console.log(`模型: ${TEXT_MODEL}`);
  const start = Date.now();
  
  const reply = await chatText([
    { role: 'system', text: '你是一个有帮助的AI助手。' },
    { role: 'user', text: '用一句话介绍你自己' }
  ]);
  
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`耗时: ${elapsed}s`);
  console.log(`回复: ${reply}`);
  console.log(reply.trim().length > 0 ? '✅ 文本链路正常\n' : '❌ 文本链路异常\n');
  return reply.trim().length > 0;
}

async function generateMockDeliveryNote() {
  // 用 SVG 生成模拟送货单图片（白底黑字表格）
  const svg = `
  <svg width="600" height="400" xmlns="http://www.w3.org/2000/svg">
    <rect width="600" height="400" fill="white"/>
    <text x="200" y="40" font-size="24" font-weight="bold" font-family="SimHei,sans-serif">送 货 单</text>
    <text x="50" y="80" font-size="14" font-family="SimSun,serif">供应商：蓝海阀门有限公司</text>
    <text x="400" y="80" font-size="14" font-family="SimSun,serif">日期：2026-07-25</text>
    
    <!-- 表格线 -->
    <rect x="50" y="100" width="500" height="30" fill="none" stroke="black" stroke-width="1"/>
    <rect x="50" y="130" width="500" height="30" fill="none" stroke="black" stroke-width="1"/>
    <rect x="50" y="160" width="500" height="30" fill="none" stroke="black" stroke-width="1"/>
    <rect x="50" y="190" width="500" height="30" fill="none" stroke="black" stroke-width="1"/>
    
    <!-- 竖线 -->
    <line x1="250" y1="100" x2="250" y2="220" stroke="black" stroke-width="1"/>
    <line x1="420" y1="100" x2="420" y2="220" stroke="black" stroke-width="1"/>
    
    <!-- 表头 -->
    <text x="120" y="121" font-size="14" font-weight="bold" font-family="SimHei,sans-serif">品名</text>
    <text x="300" y="121" font-size="14" font-weight="bold" font-family="SimHei,sans-serif">规格</text>
    <text x="470" y="121" font-size="14" font-weight="bold" font-family="SimHei,sans-serif">数量</text>
    
    <!-- 数据行 -->
    <text x="80" y="151" font-size="13" font-family="SimSun,serif">截止阀</text>
    <text x="265" y="151" font-size="13" font-family="SimSun,serif">DN50 PN16</text>
    <text x="480" y="151" font-size="13" font-family="SimSun,serif">10只</text>
    
    <text x="80" y="181" font-size="13" font-family="SimSun,serif">闸阀</text>
    <text x="265" y="181" font-size="13" font-family="SimSun,serif">DN100 PN16</text>
    <text x="480" y="181" font-size="13" font-family="SimSun,serif">5只</text>
    
    <text x="80" y="211" font-size="13" font-family="SimSun,serif">球阀</text>
    <text x="265" y="211" font-size="13" font-family="SimSun,serif">Q41F DN25</text>
    <text x="480" y="211" font-size="13" font-family="SimSun,serif">20只</text>
    
    <text x="50" y="260" font-size="12" font-family="SimSun,serif">送货人：王师傅</text>
    <text x="400" y="260" font-size="12" font-family="SimSun,serif">收货单号：SH20260725</text>
  </svg>`;

  const imgPath = path.join(__dirname, '..', 'uploads', 'test-delivery-note.png');
  fs.mkdirSync(path.dirname(imgPath), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(imgPath);
  console.log(`模拟送货单已生成: ${imgPath}`);
  return imgPath;
}

async function testVision() {
  console.log('====== 视觉链路测试 ======');
  console.log(`模型: ${VISION_MODEL}`);
  
  const imgPath = await generateMockDeliveryNote();
  const start = Date.now();
  
  const reply = await chatVision([
    { role: 'system', text: '提取送货单中的入库信息，只返回JSON格式：\n{"supplier":"供应商名","items":[{"name":"产品名","spec":"规格型号","qty":数量,"unit":"单位"}],"date":"日期"}' },
    { role: 'user', text: '请提取这张送货单中的信息', image: imgPath }
  ]);
  
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`耗时: ${elapsed}s`);
  console.log(`原始返回: ${reply}`);
  
  // 验证 JSON 结构
  let parsed = null;
  try { parsed = JSON.parse(reply); } catch (e) { /* ignore */ }
  
  if (parsed && parsed.items && parsed.items.length >= 3) {
    console.log(`\n解析结果:`);
    console.log(`  供应商: ${parsed.supplier}`);
    console.log(`  日期: ${parsed.date}`);
    parsed.items.forEach(item => {
      console.log(`  - ${item.name} | ${item.spec} | ${item.qty} ${item.unit}`);
    });
    console.log('✅ 视觉链路正常，结构化JSON提取成功\n');
    return true;
  } else {
    console.log('⚠️  视觉链路返回了内容，但JSON结构不完整');
    console.log('   解析结果:', parsed);
    return false;
  }
}

async function main() {
  console.log('🧪 百炼 Qwen 模型验证\n');
  
  let textOk = false, visionOk = false;
  
  try {
    textOk = await testText();
  } catch (e) {
    console.log(`❌ 文本链路失败: ${e.message}\n`);
  }
  
  try {
    visionOk = await testVision();
  } catch (e) {
    console.log(`❌ 视觉链路失败: ${e.message}\n`);
  }
  
  console.log('====== 总结 ======');
  console.log(`文本 (qwen3-max-preview): ${textOk ? '✅' : '❌'}`);
  console.log(`视觉 (qwen-vl-max):      ${visionOk ? '✅' : '❌'}`);
  
  if (!textOk || !visionOk) process.exit(1);
}

main();
