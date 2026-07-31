/**
 * lib/inventory-service.js — 库存写入共享模块
 * 单笔/批量出入库的确定性逻辑，供 REST API 和 chat/ops 复用。
 * 所有写操作在同一事务内完成（outbound_records + change_log 原子性）。
 */

/**
 * 校验数量合法性
 * @returns {string|null} 错误消息，null 表示合法
 */
function validateQuantity(quantity) {
  const n = Number(quantity);
  if (!Number.isFinite(n)) return '数量必须为有效数字';
  if (n <= 0) return '数量必须大于0';
  return null;
}

/**
 * 校验产品属于当前船舶
 * @param {object} client - pg client (事务内)
 * @param {number} productId
 * @param {string} ship - currentShip
 * @returns {object|null} 产品行 {id, name, spec, unit, project_no}，不存在或跨船返回 null
 */
async function validateProductOwnership(client, productId, ship) {
  const r = await client.query(
    'SELECT id, name, spec, unit, project_no FROM products WHERE id=$1', [productId]
  );
  if (!r.rows.length) return null;
  if (r.rows[0].project_no !== ship) return null;
  return r.rows[0];
}

/**
 * 在事务内计算库存（使用 FOR UPDATE 锁）
 * @param {object} client - pg client (事务内，已 BEGIN)
 * @param {number} productId
 * @returns {number} 当前库存
 */
async function getStockForUpdate(client, productId) {
  // 锁定产品行防止并发
  await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [productId]);
  const r = await client.query(
    `SELECT COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE product_id=$1),0)
     - COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE product_id=$1),0) AS stock`,
    [productId]
  );
  return parseFloat(r.rows[0].stock) || 0;
}

/**
 * 在事务内写 change_log
 */
async function logChangeInTx(client, actionType, productId, productName, productSpec, quantity, qtyBefore, qtyAfter, operator, details, refTable, refId) {
  await client.query(
    `INSERT INTO change_log (action_type,product_id,product_name,product_spec,quantity,quantity_before,quantity_after,operator,details,ref_table,ref_record_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [actionType, productId, productName, productSpec, quantity, qtyBefore, qtyAfter, operator, details || '', refTable || '', refId || null]
  );
}

/**
 * 单笔出库（事务安全）
 * @param {object} pool - pg Pool
 * @param {object} opts - { productId, quantity, date, department, remark, ship, operator }
 * @returns {object} { success, data?, error? }
 */
async function outboundSingle(pool, opts) {
  const { productId, quantity, date, department, remark, ship, operator } = opts;
  // 输入校验
  const qErr = validateQuantity(quantity);
  if (qErr) return { success: false, error: qErr, code: 400 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 产品归属校验
    const prod = await validateProductOwnership(client, productId, ship);
    if (!prod) { await client.query('ROLLBACK'); return { success: false, error: '产品不存在或不属于当前船舶', code: 403 }; }
    // 锁内计算库存
    const stockBefore = await getStockForUpdate(client, productId);
    const qty = Number(quantity);
    if (stockBefore < qty) {
      await client.query('ROLLBACK');
      return { success: false, error: `库存不足：当前库存${Math.round(stockBefore)}，请求出库${qty}` };
    }
    // 写入出库记录
    const r = await client.query(
      `INSERT INTO outbound_records (product_id,quantity,date,department,remark,doc_type) VALUES ($1,$2,$3,$4,$5,'出库单') RETURNING *`,
      [productId, qty, date || new Date(), department || '', remark || '']
    );
    const stockAfter = stockBefore - qty;
    // 同事务写 change_log
    await logChangeInTx(client, 'outbound', productId, prod.name, prod.spec, qty, stockBefore, stockAfter, operator, remark || '', 'outbound_records', r.rows[0].id);
    await client.query('COMMIT');
    return { success: true, data: r.rows[0] };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { success: false, error: e.message };
  } finally {
    client.release();
  }
}

/**
 * 批量出库（全有或全无，按 productId 排序避免死锁）
 * @param {object} pool - pg Pool
 * @param {object} opts - { items: [{productId, quantity, remark}], date, department, ship, operator }
 * @returns {object} { success, data?, error?, failures? }
 */
async function outboundBatch(pool, opts) {
  const { items, date, department, ship, operator } = opts;
  if (!items || !items.length) return { success: false, error: '无出库项', code: 400 };

  // 先校验所有数量
  for (const item of items) {
    const qErr = validateQuantity(item.quantity);
    if (qErr) return { success: false, error: `产品${item.productId}: ${qErr}`, code: 400 };
  }

  // 按 productId 排序避免锁顺序不一致
  const sorted = [...items].sort((a, b) => Number(a.productId) - Number(b.productId));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    const failures = [];

    // 第一轮：全部校验
    for (const item of sorted) {
      const prod = await validateProductOwnership(client, item.productId, ship);
      if (!prod) {
        failures.push({ productId: item.productId, error: '产品不存在或不属于当前船舶' });
        continue;
      }
      const stock = await getStockForUpdate(client, item.productId);
      const qty = Number(item.quantity);
      if (stock < qty) {
        failures.push({ productId: item.productId, productName: prod.name, error: `库存不足(当前${Math.round(stock)})` });
        continue;
      }
      results.push({ item, prod, stockBefore: stock, qty });
    }

    // 任一项失败 → 整批回滚
    if (failures.length) {
      await client.query('ROLLBACK');
      return { success: false, error: '批量出库部分产品校验失败', failures };
    }

    // 第二轮：全部写入
    const outResults = [];
    for (const { item, prod, stockBefore, qty } of results) {
      const r = await client.query(
        `INSERT INTO outbound_records (product_id,quantity,date,department,remark,doc_type) VALUES ($1,$2,$3,$4,$5,'出库单') RETURNING *`,
        [item.productId, qty, date || new Date(), department || '', item.remark || '']
      );
      const stockAfter = stockBefore - qty;
      await logChangeInTx(client, 'outbound', item.productId, prod.name, prod.spec, qty, stockBefore, stockAfter, operator, `批量出库: ${item.remark || ''}`, 'outbound_records', r.rows[0].id);
      outResults.push({ productId: item.productId, productName: prod.name, quantity: qty });
    }

    await client.query('COMMIT');
    return { success: true, data: outResults };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { success: false, error: e.message };
  } finally {
    client.release();
  }
}

/**
 * 单笔入库（事务安全）
 */
async function inboundSingle(pool, opts) {
  const { productId, quantity, date, remark, ship, operator, docType, docRef, docImagePath } = opts;
  const qErr = validateQuantity(quantity);
  if (qErr) return { success: false, error: qErr, code: 400 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prod = await validateProductOwnership(client, productId, ship);
    if (!prod) { await client.query('ROLLBACK'); return { success: false, error: '产品不存在或不属于当前船舶', code: 403 }; }
    const stockBefore = await getStockForUpdate(client, productId);
    const qty = Number(quantity);
    const r = await client.query(
      `INSERT INTO inbound_records (product_id,quantity,date,operator,remark,doc_type,doc_ref,doc_image_path) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [productId, qty, date || new Date(), operator || '', remark || '', docType || '入库单', docRef || '', docImagePath || '']
    );
    const stockAfter = stockBefore + qty;
    await logChangeInTx(client, 'inbound', productId, prod.name, prod.spec, qty, stockBefore, stockAfter, operator, remark || '', 'inbound_records', r.rows[0].id);
    await client.query('COMMIT');
    return { success: true, data: r.rows[0] };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { success: false, error: e.message };
  } finally {
    client.release();
  }
}

/**
 * 批量入库（全有或全无）
 */
async function inboundBatch(pool, opts) {
  const { items, date, ship, operator } = opts;
  if (!items || !items.length) return { success: false, error: '无入库项', code: 400 };

  for (const item of items) {
    const qErr = validateQuantity(item.quantity);
    if (qErr) return { success: false, error: `产品${item.productId}: ${qErr}`, code: 400 };
  }

  const sorted = [...items].sort((a, b) => Number(a.productId) - Number(b.productId));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 校验全部
    for (const item of sorted) {
      const prod = await validateProductOwnership(client, item.productId, ship);
      if (!prod) { await client.query('ROLLBACK'); return { success: false, error: `产品${item.productId}不存在或不属于当前船舶`, code: 403 }; }
    }
    // 写入全部
    const results = [];
    for (const item of sorted) {
      const prod = (await client.query('SELECT name,spec FROM products WHERE id=$1', [item.productId])).rows[0];
      const stockBefore = await getStockForUpdate(client, item.productId);
      const qty = Number(item.quantity);
      const r = await client.query(
        `INSERT INTO inbound_records (product_id,quantity,date,operator,remark,doc_type,doc_ref) VALUES ($1,$2,$3,$4,$5,'入库单',$6) RETURNING *`,
        [item.productId, qty, date || new Date(), operator || '', item.remark || '', item.docRef || '']
      );
      const stockAfter = stockBefore + qty;
      await logChangeInTx(client, 'inbound', item.productId, prod.name, prod.spec, qty, stockBefore, stockAfter, operator, `批量入库: ${item.remark || ''}`, 'inbound_records', r.rows[0].id);
      results.push({ productId: item.productId, productName: prod.name, quantity: qty });
    }
    await client.query('COMMIT');
    return { success: true, data: results };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { success: false, error: e.message };
  } finally {
    client.release();
  }
}

module.exports = {
  validateQuantity,
  validateProductOwnership,
  getStockForUpdate,
  logChangeInTx,
  outboundSingle,
  outboundBatch,
  inboundSingle,
  inboundBatch
};
