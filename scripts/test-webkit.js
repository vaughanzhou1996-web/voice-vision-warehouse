#!/usr/bin/env node
/**
 * 任务卡18 - WebKit兼容性测试
 * 用 Playwright WebKit 验证桌面+手机端渲染无异常
 */
const { webkit } = require('playwright');

const BASE = 'http://localhost:8000';
let pass = 0, fail = 0;
function ok(msg) { console.log(`  ✅ ${msg}`); pass++; }
function ng(msg) { console.log(`  ❌ ${msg}`); fail++; }

(async () => {
  console.log('═══ WebKit 兼容性测试 ═══\n');
  const browser = await webkit.launch();

  // 1. 桌面端
  console.log('--- 1. 桌面端 WebKit ---');
  const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const deskPage = await deskCtx.newPage();
  await deskPage.goto(BASE, { waitUntil: 'networkidle' });
  // 登录
  await deskPage.fill('#loginUser', 'caojie');
  await deskPage.fill('#loginPass', 'demo1234');
  await deskPage.click('button:has-text("登 录")');
  await deskPage.waitForTimeout(1500);
  // 选择船舶
  const shipCard = deskPage.locator('.ship-card').first();
  if (await shipCard.isVisible()) { await shipCard.click(); await deskPage.waitForTimeout(1000); }
  // 检查库存表格渲染
  const tableVisible = await deskPage.locator('#inventoryTable').isVisible();
  if (tableVisible) ok('桌面库存表格正常渲染');
  else ng('桌面库存表格不可见');
  // 检查无溢出
  const bodyOverflow = await deskPage.evaluate(() => document.body.scrollWidth <= window.innerWidth + 5);
  if (bodyOverflow) ok('桌面无水平溢出');
  else ng('桌面存在水平溢出');
  // 打开更新日志
  await deskPage.click('text=📋 更新日志');
  await deskPage.waitForTimeout(800);
  const iterVisible = await deskPage.locator('#iterLogOverlay').isVisible();
  if (iterVisible) ok('桌面更新日志弹窗WebKit正常');
  else ng('桌面更新日志弹窗WebKit异常');
  const iterCards = await deskPage.locator('#iterLogList div[style*="border-left"]').count();
  if (iterCards >= 20) ok(`更新日志${iterCards}条(≥20)`);
  else ng(`更新日志仅${iterCards}条`);
  await deskPage.locator('#iterLogOverlay button').first().click();
  await deskCtx.close();

  // 2. 手机端 390px
  console.log('\n--- 2. 手机端 WebKit 390px ---');
  const mobCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
  });
  const mobPage = await mobCtx.newPage();
  await mobPage.goto(BASE, { waitUntil: 'networkidle' });
  // 应该跳转到 mobile.html
  const url = mobPage.url();
  if (url.includes('mobile')) ok('手机UA正确跳转mobile.html');
  else ng(`未跳转: ${url}`);
  // 登录
  await mobPage.fill('#loginUser', 'caojie');
  await mobPage.fill('#loginPass', 'demo1234');
  await mobPage.click('button:has-text("登 录")');
  await mobPage.waitForTimeout(1500);
  // 检查库存列表
  const stockVisible = await mobPage.locator('#stockList').isVisible();
  if (stockVisible) ok('手机库存列表正常渲染');
  else ng('手机库存列表不可见');
  // 检查无溢出
  const mobOverflow = await mobPage.evaluate(() => document.body.scrollWidth <= window.innerWidth + 5);
  if (mobOverflow) ok('手机无水平溢出');
  else ng('手机存在水平溢出');
  // 底部导航5个按钮
  const navBtns = await mobPage.locator('.bottom-nav button').count();
  if (navBtns === 5) ok('底部导航5个Tab');
  else ng(`底部导航${navBtns}个(应5)`);
  // 切换到日志Tab
  await mobPage.locator('.bottom-nav button').nth(4).click();
  await mobPage.waitForTimeout(1500);
  const iterContent = await mobPage.locator('#stockList').innerHTML();
  if (iterContent.includes('曹姐反馈迭代记录') || iterContent.includes('border-left')) ok('手机迭代日志正常显示');
  else ng('手机迭代日志异常');
  await mobCtx.close();

  await browser.close();
  console.log(`\n═══ WebKit结果: ${pass} 通过 / ${fail} 失败 ═══`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
