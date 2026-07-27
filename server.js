const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = 8000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DOCS_DIR = path.join(__dirname, 'docs');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DOCS_DIR, { recursive: true });

const pool = new Pool({ host: '127.0.0.1', port: 5432, database: 'metabase_data', user: 'metabase', password: 'Metabase123!' });
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 10*1024*1024 } });

// MiniMax LLM 配置
const MINIMAX_KEY = (fs.readFileSync(path.join(__dirname, '.env'), 'utf8').match(/MINIMAX_API_KEY=(\S+)/) || [])[1] || process.env.MINIMAX_API_KEY;
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M3';
const MINIMAX_URL = 'https://api.minimaxi.com/v1/chat/completions';

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: 0 }));
app.use('/docs', express.static(DOCS_DIR, { maxAge: 0 }));
app.use(express.json({ limit: '10mb' }));

// 禁止缓存API响应
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// ====== 登录系统 ======
const tokens = {}; // token -> {username, displayName, role}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const r = await pool.query('SELECT * FROM users WHERE username=$1 AND password=$2', [username, password]);
    if (r.rows.length === 0) return res.json({ success: false, error: '用户名或密码错误' });
    const u = r.rows[0];
    const token = crypto.randomBytes(16).toString('hex');
    tokens[token] = { username: u.username, displayName: u.display_name, role: u.role };
    res.json({ success: true, data: { token, username: u.username, displayName: u.display_name, role: u.role } });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/logout', (req, res) => {
  delete tokens[req.body.token];
  res.json({ success: true });
});

// 注册
app.post('/api/register', async (req, res) => {
  try {
    const {username, password} = req.body;
    if (!username || !password) return res.json({success: false, error: '用户名和密码不能为空'});
    if (password.length < 4) return res.json({success: false, error: '密码至少4位'});
    await pool.query('INSERT INTO users (username,password,display_name,role) VALUES ($1,$2,$3,$4)', [username, password, username, 'user']);
    res.json({success: true});
  } catch (e) {
    if (e.code === '23505') return res.json({success: false, error: '用户名已存在'});
    res.json({success: false, error: e.message});
  }
});

function auth(req, res, next) {
  const token = req.headers.authorization;
  const user = tokens[token];
  if (!user) return res.status(401).json({ success: false, error: '未登录' });
  req.user = user;
  next();
}

// 船号白名单（SOM07/SOM08），默认 SOM07
function getShip(req) { return req.query.ship === 'SOM08' ? 'SOM08' : 'SOM07'; }

// ====== 记录变更日志 ======
async function logChange(actionType, productId, productName, productSpec, quantity, qtyBefore, qtyAfter, operator, details, refTable, refId) {
  await pool.query(
    `INSERT INTO change_log (action_type,product_id,product_name,product_spec,quantity,quantity_before,quantity_after,operator,details,ref_table,ref_record_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [actionType, productId, productName, productSpec, quantity, qtyBefore, qtyAfter, operator, details||'', refTable||'', refId||null]
  );
}

async function getStock(productId) {
  const r = await pool.query(
    `SELECT COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE product_id=$1),0) - COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE product_id=$1),0) AS stock`,
    [productId]
  );
  return parseFloat(r.rows[0].stock) || 0;
}

// ====== API（全部需要登录）======

// 库存总览
app.get('/api/inventory', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.id,p.name,p.spec,p.unit,p.project_no,p.supplier_id,
        COALESCE(s.name,'') AS supplier_name,
        COALESCE(inb.t,0) AS total_in, COALESCE(outb.t,0) AS total_out,
        COALESCE(inb.t,0)-COALESCE(outb.t,0) AS stock
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id=s.id
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM inbound_records GROUP BY product_id) inb ON p.id=inb.product_id
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM outbound_records GROUP BY product_id) outb ON p.id=outb.product_id
      WHERE p.project_no=$1
      ORDER BY p.id
    `, [getShip(req)]);
    res.json({ success: true, data: r.rows });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 产品列表
app.get('/api/products', auth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT p.*,COALESCE(s.name,'') AS supplier_name FROM products p LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.project_no=$1 ORDER BY p.name`, [getShip(req)]);
    res.json({ success: true, data: r.rows });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 按批次查AI单据图片
app.get('/api/batch-docs/:batchKey', auth, async (req, res) => {
  try {
    const key = '%' + req.params.batchKey + '%';
    const r = await pool.query(`
      SELECT i.doc_image_path, p.name AS product_name, p.spec, i.quantity
      FROM inbound_records i JOIN products p ON i.product_id = p.id
      WHERE i.remark LIKE $1 AND i.doc_image_path IS NOT NULL AND i.doc_image_path != ''
      ORDER BY i.created_at DESC LIMIT 50`, [key]);
    const data = r.rows.map(row => ({
      product_name: row.product_name,
      spec: row.spec,
      quantity: row.quantity,
      url: row.doc_image_path.startsWith('/docs/') ? '/inventory' + row.doc_image_path : row.doc_image_path
    }));
    res.json({ success: true, data });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 关联单据
app.get('/api/documents/:pid', auth, async (req, res) => {
  try {
    const i = await pool.query(`SELECT id,quantity,date,operator,remark,doc_type,doc_ref,doc_image_path,created_at FROM inbound_records WHERE product_id=$1 ORDER BY date DESC`,[req.params.pid]);
    const o = await pool.query(`SELECT id,quantity,date,department,doc_type,doc_ref,created_at FROM outbound_records WHERE product_id=$1 ORDER BY date DESC`,[req.params.pid]);
    res.json({ success: true, data: { inbound: i.rows, outbound: o.rows } });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 入库
app.post('/api/inbound', auth, async (req, res) => {
  try {
    const { productId, quantity, date, remark, docRef, docImagePath } = req.body;
    const prod = (await pool.query('SELECT name,spec,unit FROM products WHERE id=$1', [productId])).rows[0];
    const stockBefore = await getStock(productId);
    const r = await pool.query(
      `INSERT INTO inbound_records (product_id,quantity,date,operator,remark,doc_type,doc_ref,doc_image_path) VALUES ($1,$2,$3,$4,$5,'入库单',$6,$7) RETURNING *`,
      [productId, quantity, date||new Date(), req.user.displayName, remark||'', docRef||'', docImagePath||'']
    );
    const stockAfter = await getStock(productId);
    const details = remark||'';
    const aiTag = docRef && docRef.includes('AI') ? '🤖AI识别' : '';
    await logChange('inbound', productId, prod.name, prod.spec, quantity, stockBefore, stockAfter, req.user.displayName, aiTag+(aiTag?': ':'')+details, 'inbound_records', r.rows[0].id);
    res.json({ success: true, data: r.rows[0] });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 批量入库
app.post('/api/inbound/batch', auth, async (req, res) => {
  try {
    const { items, date, docRef } = req.body;
    const results = [];
    for (const item of items) {
      const prod = (await pool.query('SELECT name,spec,unit FROM products WHERE id=$1', [item.productId])).rows[0];
      if (!prod) continue;
      const stockBefore = await getStock(item.productId);
      const r = await pool.query(
        `INSERT INTO inbound_records (product_id,quantity,date,operator,remark,doc_type,doc_ref) VALUES ($1,$2,$3,$4,$5,'入库单',$6) RETURNING *`,
        [item.productId, item.quantity, date||new Date(), req.user.displayName, item.remark||'', docRef||'']
      );
      const stockAfter = await getStock(item.productId);
      await logChange('inbound', item.productId, prod.name, prod.spec, item.quantity, stockBefore, stockAfter, req.user.displayName, `批量入库: ${item.remark||''}`, 'inbound_records', r.rows[0].id);
      results.push({ productId: item.productId, productName: prod.name, quantity: item.quantity });
    }
    res.json({ success: true, data: results });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 出库
app.post('/api/outbound', auth, async (req, res) => {
  try {
    const { productId, quantity, date, department, remark } = req.body;
    const prod = (await pool.query('SELECT name,spec,unit FROM products WHERE id=$1', [productId])).rows[0];
    const stockBefore = await getStock(productId);
    const r = await pool.query(
      `INSERT INTO outbound_records (product_id,quantity,date,department,remark,doc_type) VALUES ($1,$2,$3,$4,$5,'出库单') RETURNING *`,
      [productId, quantity, date||new Date(), department||'', remark||'']
    );
    const stockAfter = await getStock(productId);
    await logChange('outbound', productId, prod.name, prod.spec, quantity, stockBefore, stockAfter, req.user.displayName, remark||'', 'outbound_records', r.rows[0].id);
    res.json({ success: true, data: r.rows[0] });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 批量出库
app.post('/api/outbound/batch', auth, async (req, res) => {
  try {
    const { items, date, department } = req.body;
    const results = [];
    for (const item of items) {
      const prod = (await pool.query('SELECT name,spec,unit FROM products WHERE id=$1', [item.productId])).rows[0];
      if (!prod) continue;
      const stockBefore = await getStock(item.productId);
      const r = await pool.query(
        `INSERT INTO outbound_records (product_id,quantity,date,department,remark,doc_type) VALUES ($1,$2,$3,$4,$5,'出库单') RETURNING *`,
        [item.productId, item.quantity, date||new Date(), department||'', item.remark||'']
      );
      const stockAfter = await getStock(item.productId);
      await logChange('outbound', item.productId, prod.name, prod.spec, item.quantity, stockBefore, stockAfter, req.user.displayName, `批量出库: ${item.remark||''}`, 'outbound_records', r.rows[0].id);
      results.push({ productId: item.productId, productName: prod.name, quantity: item.quantity });
    }
    res.json({ success: true, data: results });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 上传图片
app.post('/api/upload', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, error: '未上传文件' });
    res.json({ success: true, data: { filename: req.file.filename, path: '/uploads/'+req.file.filename } });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 识别图片
app.post('/api/recognize', auth, async (req, res) => {
  try {
    const { path: imgPath } = req.body;
    if (!imgPath) return res.json({ success: false, error: '缺少图片路径' });
    
    // 校验：排除假数据
    function isValidResult(info) {
      if (!info || !info.items || !info.items.length) return false;
      if (info.items.length > 50) return false;
      const genericPatterns = [/项目\d/, /产品\d/, /Item\d/i, /product\d/i];
      const validItems = info.items.filter(item => {
        const name = (item.name || '').trim();
        if (!name || name.length < 2) return false;
        if (genericPatterns.some(p => p.test(name))) return false;
        return true;
      });
      return validItems.length > 0;
    }
    
    // MiniMax-M3重试（最多3次）
    let reply = '';
    let info = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      reply = await callMinimax([
        {role: 'system', text: '提取送货单中的入库信息，只返回JSON格式：\n{"supplier":"供应商名","items":[{"name":"产品名","spec":"规格型号","qty":数量,"unit":"单位"}],"date":"日期"}'},
        {role: 'user', text: '提取信息', image: imgPath}
      ]);
      
      if (!reply || !reply.trim()) continue;
      
      try { info = JSON.parse(reply); } catch(e) { info = null; }
      if (!info) {
        try { info = JSON.parse(reply.replace(/,\s*}/g,'}').replace(/,\s*\]/g,']').replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g,'"$2":').replace(/\\'/g,"'")); } catch(e) { info = null; }
      }
      if (!info) {
        const m = reply.match(/\{[^{}]*"items"\s*:\s*\[/);
        if (m) {
          let depth=0, end=m.index;
          for (let i=m.index; i<reply.length; i++) {
            if (reply[i]==='{') depth++;
            else if (reply[i]==='}') { depth--; if (depth===0) { end=i+1; break; } }
          }
          try { info = JSON.parse(reply.substring(m.index, end)); } catch(e) { info = null; }
        }
      }
      
      if (info && isValidResult(info)) break;
      info = null;
    }
    
    // 验证结果真实性——尝试匹配供应商但不强制
    if (info && isValidResult(info)) {
      const match = await pool.query('SELECT id,name FROM suppliers');
      let matchedSupplier = info.supplier || '';
      for (const supplier of match.rows) {
        if (matchedSupplier.includes(supplier.name) || supplier.name.includes(matchedSupplier)) {
          matchedSupplier = supplier.name;
          info.supplierId = supplier.id;
          break;
        }
      }
      info.supplier = matchedSupplier;
      
      // 保存历史单据（压缩版）
      try {
        const sharp = require('sharp');
        const docId = Date.now().toString(36);
        const docPath = path.join(DOCS_DIR, docId + '.jpg');
        const imgBuffer = fs.readFileSync(imgPath.startsWith('/') ? path.join(__dirname, imgPath) : imgPath);
        await sharp(imgBuffer)
          .resize(800, null, { withoutEnlargement: true })
          .jpeg({ quality: 70 })
          .toFile(docPath);
        info.docId = docId;
        info.docPath = '/docs/' + docId + '.jpg';
        info.docPathPublic = '/inventory/docs/' + docId + '.jpg';
      } catch (e) { console.log('save doc failed:', e.message); }
      
      res.json({ success: true, data: info });
    } else {
      res.json({ success: false, error: '未能识别出货品信息，请尝试手工录入' });
    }
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 历史单据列表
app.get('/api/documents', auth, async (req, res) => {
  try {
    const files = fs.readdirSync(DOCS_DIR)
      .filter(f => f.endsWith('.jpg'))
      .map(f => {
        const stat = fs.statSync(path.join(DOCS_DIR, f));
        return {
          id: f.replace('.jpg', ''),
          path: '/inventory/docs/' + f,
          created: stat.mtime,
          size: stat.size
        };
      })
      .sort((a, b) => b.created - a.created)
      .slice(0, 50);
    res.json({ success: true, data: files });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 新增产品
app.get('/api/suppliers', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM suppliers ORDER BY name');
    res.json({ success: true, data: r.rows });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/products', auth, async (req, res) => {
  try {
    const {name, spec, unit, supplier_id} = req.body;
    const projectNo = req.body.project_no === 'SOM08' ? 'SOM08' : 'SOM07';
    const r = await pool.query('INSERT INTO products (name,spec,unit,supplier_id,project_no) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, spec||'', unit||'个', supplier_id||null, projectNo]);
    res.json({ success: true, data: r.rows[0] });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/inventory/supplier/:sid', auth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT p.id,p.name,p.spec,p.unit,p.supplier_id,COALESCE(s.name,'') AS supplier_name,
      COALESCE(inb.t,0) AS total_in, COALESCE(outb.t,0) AS total_out,
      COALESCE(inb.t,0)-COALESCE(outb.t,0) AS stock
      FROM products p LEFT JOIN suppliers s ON p.supplier_id=s.id
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM inbound_records GROUP BY product_id) inb ON p.id=inb.product_id
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM outbound_records GROUP BY product_id) outb ON p.id=outb.product_id
      WHERE p.supplier_id=$1 AND p.project_no=$2 ORDER BY p.id`,[req.params.sid, getShip(req)]);
    res.json({ success: true, data: r.rows });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 更新产品供应商
app.patch('/api/products/:id/supplier', auth, async (req, res) => {
  try {
    await pool.query('UPDATE products SET supplier_id=$1 WHERE id=$2', [req.body.supplier_id, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 注册新供应商
app.post('/api/register_supplier', auth, async (req, res) => {
  try {
    const r = await pool.query('INSERT INTO suppliers (name) VALUES ($1) RETURNING id', [req.body.name]);
    res.json({ success: true, data: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      const r = await pool.query('SELECT id FROM suppliers WHERE name=$1', [req.body.name]);
      return res.json({ success: true, data: r.rows[0] });
    }
    res.json({ success: false, error: e.message });
  }
});

// 删除供应商
app.delete('/api/delete_supplier/:id', auth, async (req, res) => {
  try {
    // 先解除该供应商下所有产品的关联
    await pool.query('UPDATE products SET supplier_id=NULL WHERE supplier_id=$1', [req.params.id]);
    await pool.query('DELETE FROM suppliers WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 入库记录列表
app.get('/api/inbound/list', auth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT i.*,p.name,p.spec,p.unit,COALESCE(s.name,'') AS supplier_name
      FROM inbound_records i JOIN products p ON i.product_id=p.id LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.project_no=$1 ORDER BY i.created_at DESC LIMIT 200`, [getShip(req)]);
    res.json({ success: true, data: r.rows });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 出库记录列表
app.get('/api/outbound/list', auth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT o.*,p.name,p.spec,p.unit
      FROM outbound_records o JOIN products p ON o.product_id=p.id WHERE p.project_no=$1 ORDER BY o.created_at DESC LIMIT 200`, [getShip(req)]);
    res.json({ success: true, data: r.rows });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 库存看板：按供应商聚合 进/出/存
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT COALESCE(s.name,'未分类') AS supplier_name,
        COUNT(p.id) AS products,
        COALESCE(SUM(inb.t),0) AS total_in,
        COALESCE(SUM(outb.t),0) AS total_out,
        COALESCE(SUM(inb.t),0)-COALESCE(SUM(outb.t),0) AS stock
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id=s.id
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM inbound_records GROUP BY product_id) inb ON p.id=inb.product_id
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM outbound_records GROUP BY product_id) outb ON p.id=outb.product_id
      WHERE p.project_no=$1
      GROUP BY COALESCE(s.name,'未分类')
      ORDER BY stock DESC, total_in DESC`, [getShip(req)]);
    res.json({ success: true, data: r.rows });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 各船统计（选船页卡片用）
app.get('/api/ships/stats', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.project_no, COUNT(*) AS products,
        COALESCE(SUM(COALESCE(inb.t,0)-COALESCE(outb.t,0)),0) AS stock
      FROM products p
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM inbound_records GROUP BY product_id) inb ON p.id=inb.product_id
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM outbound_records GROUP BY product_id) outb ON p.id=outb.product_id
      WHERE p.project_no IN ('SOM07','SOM08')
      GROUP BY p.project_no`);
    res.json({ success: true, data: r.rows });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ====== 变更日志 & 回滚 ======
app.get('/api/changelog', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT c.*,COALESCE(s.name,\'\') AS supplier_name FROM change_log c LEFT JOIN products p ON c.product_id=p.id LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.project_no=$1 ORDER BY c.created_at DESC LIMIT 200', [getShip(req)]);
    res.json({ success: true, data: r.rows });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/rollback', auth, async (req, res) => {
  try {
    const last = (await pool.query(`SELECT c.* FROM change_log c JOIN products p ON c.product_id=p.id WHERE c.action_type IN ('inbound','outbound') AND p.project_no=$1 ORDER BY c.created_at DESC LIMIT 1`, [getShip(req)])).rows[0];
    if (!last) return res.json({ success: false, error: '没有可回滚的操作' });
    if (last.action_type === 'inbound' && last.ref_record_id) {
      await pool.query('DELETE FROM inbound_records WHERE id=$1', [last.ref_record_id]);
    } else if (last.action_type === 'outbound' && last.ref_record_id) {
      await pool.query('DELETE FROM outbound_records WHERE id=$1', [last.ref_record_id]);
    }
    await logChange('rollback', last.product_id, last.product_name, last.product_spec, last.quantity,
      last.quantity_after, last.quantity_before, req.user.displayName,
      '回滚: 撤销'+(last.action_type==='inbound'?'入库':'出库')+' '+last.product_name+' ×'+last.quantity, null, null);
    res.json({ success: true, data: { rolledBack: true, action: last.action_type, product: last.product_name } });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 语音识别（用 MiniMax ASR 接口）
app.post('/api/speech/recognize', auth, async (req, res) => {
  try {
    const { audio, mimeType } = req.body;
    if (!audio) return res.json({ success: false, error: '缺少音频数据' });
    const MINIMAX_KEY = (fs.readFileSync(path.join(__dirname, '.env'), 'utf8').match(/MINIMAX_API_KEY=(\S+)/) || [])[1];
    // 优先尝试 MiniMax speech-02 模型
    const asrUrl = 'https://api.minimaxi.com/v1/audio/generations';
    const r = await axios.post(asrUrl, {
      model: 'speech-02',
      audio: { data: audio, format: mimeType || 'audio/webm' },
      language: 'zh'
    }, {
      headers: { 'Authorization': 'Bearer ' + MINIMAX_KEY, 'Content-Type': 'application/json' },
      timeout: 30000
    });
    const text = r.data?.text || r.data?.data?.text || '';
    res.json({ success: true, text });
  } catch (e) {
    res.json({ success: false, error: e.response?.data?.error?.message || e.message });
  }
});

// 批次撤销（AI整批入库）
app.post('/api/rollback/batch', auth, async (req, res) => {
  try {
    const { batchKey } = req.body;
    if (!batchKey) return res.json({ success: false, error: '缺少批次标记' });
    // 找到这批所有入库记录和对应的产品
    const records = await pool.query(
      `SELECT ir.id as record_id, ir.product_id, ir.quantity
       FROM inbound_records ir WHERE ir.remark = $1`,
      [batchKey]
    );
    if (!records.rows.length) return res.json({ success: false, error: '未找到该批次的入库记录' });
    // 删除入库记录 & 写变更日志
    for (const rec of records.rows) {
      const prod = await pool.query('SELECT name,spec,unit FROM products WHERE id=$1', [rec.product_id]);
      if (!prod.rows.length) continue;
      await pool.query('DELETE FROM inbound_records WHERE id=$1', [rec.record_id]);
      await logChange('rollback', rec.product_id, prod.rows[0].name, prod.rows[0].spec, rec.quantity,
        null, null, req.user.displayName,
        '整批回滚: 撤销AI入库 '+prod.rows[0].name+' ×'+rec.quantity, null, null);
    }
    res.json({ success: true, data: { count: records.rows.length } });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ====== LLM聊天（HTTP版）======
app.post('/api/chat', auth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.json({ success: false, reply: '请输入消息' });
    const reply = await callMinimax([
      {role: 'system', text: '你是库存管理AI助手。回答简洁专业。说出入库请说"入库 产品名 数量单位"或"出库 产品名 数量单位"。'},
      {role: 'user', text: message}
    ]);
    res.json({ success: true, reply });
  } catch (e) { res.json({ success: false, reply: '❌ '+e.message }); }
});

async function callMinimax(messages, imageMode) {
  // 识图只用MiniMax-M3，不用abab6.5s-chat（它会编假数据）
  // 聊天用MiniMax-M3为主，abab6.5s-chat备用
  const hasImage = messages.some(m => m.image);
  const models = hasImage ? [MINIMAX_MODEL, MINIMAX_MODEL, 'qwen3.5-plus'] : [MINIMAX_MODEL, 'abab6.5s-chat'];
  for (const modelName of models) {
    try {
      const msgs = [];
      for (const m of messages) {
        if (m.image) {
          const absPath = m.image.startsWith('/uploads/') ? path.join(UPLOAD_DIR, path.basename(m.image)) : m.image;
          if (!fs.existsSync(absPath)) throw new Error('图片不存在: '+absPath);
          const b64 = fs.readFileSync(absPath, {encoding: 'base64'});
          msgs.push({role:'user', content:[{type:'image_url',image_url:{url:'data:image/jpeg;base64,'+b64}},{type:'text',text:m.text}]});
        } else {
          msgs.push({role:m.role, content:m.text});
        }
      }
      const GO_KEY = process.env.OPENCODE_GO_API_KEY || (fs.existsSync(path.join(__dirname, '.env')) ? (fs.readFileSync(path.join(__dirname, '.env'), 'utf8').match(/OPENCODE_GO_API_KEY=(\S+)/)||[])[1] : null);
      const goUrl = 'https://opencode.ai/zen/go/v1/chat/completions';
      const url = modelName === 'qwen3.5-plus' ? goUrl : MINIMAX_URL;
      const key = modelName === 'qwen3.5-plus' ? GO_KEY : MINIMAX_KEY;
      const resp = await axios.post(url, {model:modelName, messages:msgs, max_tokens:65536, temperature:0.1}, {
        headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'}, timeout:300000
      });
      let content = resp.data.choices?.[0]?.message?.content || '';
      const finishReason = resp.data.choices?.[0]?.finish_reason;
      console.log(`[LLM] model=${modelName} finish=${finishReason} len=${content.length} hasImage=${hasImage}`);
      // 如果MiniMax-M3 abort（token不够），直接跳过换模型
      if (finishReason === 'abort' && modelName !== models[models.length-1]) { console.log(`[LLM] ${modelName} abort, try next`); continue; }
      content = content.replace(/<th[\s\S]*?<\/think>/g, '');
      // 如果think没闭合或内容不以{开头，全文找JSON
      if (!content.startsWith('{')) {
        const raw = resp.data.choices?.[0]?.message?.content || '';
        const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
        if (s > -1 && e > s) content = raw.substring(s, e+1);
      }
      if (!content.trim() && modelName !== models[models.length-1]) { console.log(`[LLM] ${modelName} empty, try next`); continue; }
      console.log(`[LLM] ✅ ${modelName} success`);
      content = content
        .replace(/"供应商"/g, '"supplier"')
        .replace(/"发货单位"/g, '"supplier"')
        .replace(/"明细"/g, '"items"')
        .replace(/"产品"/g, '"items"')
        .replace(/"产品名称"/g, '"name"')
        .replace(/"名称"/g, '"name"')
        .replace(/"规格型号"/g, '"spec"')
        .replace(/"规格"/g, '"spec"')
        .replace(/"数量"/g, '"qty"')
        .replace(/"单位"/g, '"unit"')
        .replace(/"日期"/g, '"date"');
      return content;
    } catch (e) {
      if (modelName === models[models.length-1]) throw new Error('LLM调用失败: '+(e.response?.data?.error?.message || e.message));
    }
  }
  return '(无回复)';
}

// ====== 启动 ======
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SOM07/SOM08 进出库管理系统运行在 http://0.0.0.0:${PORT}`);
});
