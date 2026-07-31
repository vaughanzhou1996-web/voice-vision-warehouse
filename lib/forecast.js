/**
 * lib/forecast.js — 建造周期×预期出库×库存趋势预测引擎
 * 
 * 核心逻辑：
 * - 每备件：当前库存 - 按日期累计计划出库 = 库存水位曲线（未来60天阶梯下降）
 * - 断料日 = 水位首次 < 安全线(3) 的日期
 * - AI 洞察：chatText 基于预测结果生成决策语言
 */

const fs = require('fs');
const path = require('path');
const { chatText } = require('./qwen');

const SAFETY_LINE = 3; // 安全库存线

/**
 * 加载建造周期表
 */
function loadBuildSchedule() {
  const fp = path.join(__dirname, '..', 'data', 'build-schedule.json');
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

/**
 * 计算预测结果
 * @param {object} pool - pg Pool
 * @param {string} ship - 'YY01' | 'YY02' | null(全部)
 * @returns {Array} 预测结果数组
 */
async function computeForecast(pool, ship) {
  const schedule = loadBuildSchedule();
  const now = new Date();
  const horizon = new Date(now.getTime() + 60 * 86400000);

  // 过滤时间范围内的计划
  const entries = schedule.filter(e => {
    const d = new Date(e.date + 'T00:00:00');
    if (d < now || d > horizon) return false;
    if (ship && e.ship !== ship) return false;
    return true;
  });

  // 按 name+spec 聚合计划出库
  const partMap = {}; // key: "name|spec" → { name, spec, scheduled: [{date,qty,milestone,equipment,ship}] }
  for (const entry of entries) {
    for (const part of entry.required_parts) {
      const key = `${part.name}|${part.spec || ''}`;
      if (!partMap[key]) {
        partMap[key] = { name: part.name, spec: part.spec || '', scheduled: [] };
      }
      partMap[key].scheduled.push({
        date: entry.date,
        qty: part.qty,
        milestone: entry.milestone,
        equipment: entry.equipment,
        ship: entry.ship
      });
    }
  }

  // 查询当前库存
  const keys = Object.keys(partMap);
  if (!keys.length) return [];

  const results = [];
  for (const key of keys) {
    const { name, spec, scheduled } = partMap[key];
    // 按日期排序
    scheduled.sort((a, b) => a.date.localeCompare(b.date));

    // 查当前库存（必须按 project_no 过滤，防止串船）
    let currentStock = 0;
    try {
      const r = await pool.query(`
        SELECT COALESCE(inb.t,0)-COALESCE(outb.t,0) AS stock
        FROM products p
        LEFT JOIN (SELECT product_id,SUM(quantity) t FROM inbound_records GROUP BY product_id) inb ON p.id=inb.product_id
        LEFT JOIN (SELECT product_id,SUM(quantity) t FROM outbound_records GROUP BY product_id) outb ON p.id=outb.product_id
        WHERE p.name=$1 AND p.spec=$2 AND p.project_no=$3
        LIMIT 1`, [name, spec, ship || 'YY01']);
      currentStock = r.rows.length ? parseFloat(r.rows[0].stock) || 0 : 0;
    } catch (e) { /* 查不到则0 */ }

    // 计算水位曲线（阶梯下降）
    let level = currentStock;
    let projectedMin = currentStock;
    let stockoutDate = null; // 真断料日（水位 < 0）
    const waterline = [{ date: formatDate(now), level: currentStock }];

    for (const s of scheduled) {
      level -= s.qty;
      waterline.push({ date: s.date, level });
      if (level < projectedMin) projectedMin = level;
      if (stockoutDate === null && level < 0) {
        stockoutDate = s.date;
      }
    }

    // 状态判定：red=预测最低<0（真断料）；yellow=预测最低∈[0,3)（破安全线但未断料）；green=全程≥3
    let status = 'green';
    if (projectedMin < 0) status = 'red';
    else if (projectedMin < SAFETY_LINE) status = 'yellow';

    const totalPlanned = scheduled.reduce((s, x) => s + x.qty, 0);

    results.push({
      product: name,
      spec,
      current_stock: currentStock,
      total_planned: totalPlanned,
      scheduled,
      waterline,
      projected_min: projectedMin,
      stockout_date: stockoutDate,
      status
    });
  }

  // 排序：red > yellow > green，同状态按断料日升序
  const order = { red: 0, yellow: 1, green: 2 };
  results.sort((a, b) => {
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    if (a.stockout_date && b.stockout_date) return a.stockout_date.localeCompare(b.stockout_date);
    if (a.stockout_date) return -1;
    if (b.stockout_date) return 1;
    return a.projected_min - b.projected_min;
  });

  return results;
}

/**
 * 生成 AI 预测洞察
 */
async function generateForecastInsight(forecastData, ship) {
  const redItems = forecastData.filter(f => f.status === 'red');
  const yellowItems = forecastData.filter(f => f.status === 'yellow');

  if (!redItems.length && !yellowItems.length) {
    return '未来60天所有备件库存水位安全，无需紧急采购。';
  }

  const snapshot = `【库存趋势预测】船号:${ship || '全部'}\n` +
    `【断料风险(红)】${redItems.length}项\n` +
    redItems.map(f => `${f.product}(${f.spec}) 当前${f.current_stock} → 计划出库${f.total_planned} → 断料日${f.stockout_date}\n  明细: ${f.scheduled.map(s => `${s.date} ${s.milestone}用${s.qty}`).join(', ')}`).join('\n') +
    `\n【低于安全线(黄)】${yellowItems.length}项\n` +
    yellowItems.map(f => `${f.product}(${f.spec}) 当前${f.current_stock} → 预测最低${f.projected_min}`).join('\n');

  try {
    const insight = await chatText([
      { role: 'system', text: '你是船舶建造项目AI分析师。根据库存趋势预测数据，生成200字以内的决策建议。要具体到"哪天+哪个节点+缺什么+最晚到货日"。不要客套话，直接给结论和动作。' },
      { role: 'user', text: snapshot }
    ], { temperature: 0.5, max_tokens: 500 });
    return insight;
  } catch (e) {
    console.log('[Forecast] LLM失败，降级:', e.message);
    return `预测发现${redItems.length}项备件将断料：` +
      redItems.map(f => `${f.product}(${f.stockout_date}断料)`).join('、') +
      '。建议立即启动紧急采购。';
  }
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

module.exports = { computeForecast, generateForecastInsight, SAFETY_LINE };
