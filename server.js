const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DOCS_DIR = path.join(__dirname, 'docs');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DOCS_DIR, { recursive: true });

// 数据库连接：优先读 .env 的 DATABASE_URL，默认本地演示库
let DATABASE_URL = 'postgres://localhost:5432/inventory_demo';
try {
  const _env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  const _m = _env.match(/DATABASE_URL=(\S+)/);
  if (_m) DATABASE_URL = _m[1];
} catch (e) {}
if (process.env.DATABASE_URL) DATABASE_URL = process.env.DATABASE_URL;
const pool = new Pool({ connectionString: DATABASE_URL });
// 幂等迁移：确保 deleted_at 列存在
pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP').catch(()=>{});
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 10*1024*1024 } });

// 百炼 Qwen 模型（lib/qwen.js）
const { chatText, chatVision, speechToText } = require('./lib/qwen');
const invService = require('./lib/inventory-service');

const app = express();
// 移动端UA检测→302跳转mobile.html
app.get('/', (req, res, next) => {
  const ua = req.headers['user-agent'] || '';
  if (/Mobile|Android|iPhone|iPad|iPod/i.test(ua) && !req.query.desktop) {
    return res.redirect('/mobile.html');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.use('/data', express.static(path.join(__dirname, 'data'), { maxAge: 0 }));
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
    // 兼容明文与 SHA-256 哈希密码
    const hash = crypto.createHash('sha256').update(password || '').digest('hex');
    const r = await pool.query('SELECT * FROM users WHERE username=$1 AND (password=$2 OR password=$3)', [username, password, hash]);
    if (r.rows.length === 0) return res.json({ success: false, error: '用户名或密码错误' });
    const u = r.rows[0];
    const token = crypto.randomBytes(16).toString('hex');
    tokens[token] = { username: u.username, displayName: u.display_name, role: u.role };
    res.json({ success: true, data: { token, username: u.username, displayName: u.display_name, role: u.role } });
    // 登录后异步预生成AI报告缓存
    setImmediate(() => {
      const http = require('http');
      const opts = { hostname: '127.0.0.1', port: PORT || 8000, path: '/api/dashboard/report?ship=YY01', headers: { 'Authorization': token } };
      http.get(opts, r => { r.resume(); }).on('error', () => {});
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/logout', (req, res) => {
  delete tokens[req.body.token];
  res.json({ success: true });
});

// 演示数据一键重置（限指定角色）
app.post('/api/demo/reset', auth, async (req, res) => {
  const allowedRoles = ['caojie', 'hezong', 'zhangwei', 'chenjun'];
  if (!allowedRoles.includes(req.user.username)) return res.status(403).json({ success: false, error: '无权重置' });
  try {
    const { execSync } = require('child_process');
    execSync('node scripts/reset-demo.js', { cwd: __dirname, timeout: 30000, stdio: 'pipe' });
    res.json({ success: true, message: '演示数据已重置' });
  } catch (e) {
    res.json({ success: false, error: '重置失败: ' + e.message });
  }
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

// 多租户鉴权：校验 token 绑定的 currentShip 与请求 ?ship= 一致
function authShip(req, res, next) {
  const ship = req.query.ship;
  if (!ship) return next(); // 无 ship 参数的路由不检查
  if (!req.user.currentShip) return next(); // 尚未绑定船舶（select-ship 之前）
  if (req.user.currentShip !== ship) return res.status(403).json({ success: false, error: '无权访问该船舶数据' });
  next();
}

// 绑定船舶到 token
app.post('/api/select-ship', auth, (req, res) => {
  const { ship } = req.body;
  if (!SHIPS.some(s => s.project_no === ship)) return res.json({ success: false, error: '无效船舶' });
  const token = req.headers.authorization;
  tokens[token].currentShip = ship;
  res.json({ success: true });
});

// 船舶配置（数据驱动）
const SHIPS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'ships.json'), 'utf8'));

// 船号白名单（中间件已确保 req.query.ship 有效）
function getShip(req) {
  return req.query.ship;
}
function fmtInt(v){const n=parseFloat(v);return isNaN(n)?v:Math.round(n);}

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
// 全局 auth + authShip 中间件（排除 login/logout/select-ship/ships/register_supplier/register）
const _noAuthPaths = ['/login', '/logout', '/select-ship', '/ships', '/register_supplier', '/register', '/version'];
app.use('/api', (req, res, next) => {
  if (_noAuthPaths.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
  // 内联 auth
  const token = req.headers.authorization;
  const user = tokens[token];
  if (!user) return res.status(401).json({ success: false, error: '未登录' });
  req.user = user;
  // 内联 authShip：跨船资源隔离
  const ship = req.query.ship;
  if (ship) {
    // 显式传了 ?ship=，必须与 currentShip 匹配
    if (user.currentShip && user.currentShip !== ship) {
      return res.status(403).json({ success: false, error: '无权访问该船舶数据' });
    }
  } else {
    // 未传 ?ship=，自动注入 currentShip
    if (!user.currentShip) {
      return res.status(400).json({ success: false, error: '请先选择船舶' });
    }
    req.query.ship = user.currentShip;
  }
  next();
});

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
      WHERE p.project_no=$1 AND p.deleted_at IS NULL
      ORDER BY p.id
    `, [getShip(req)]);
    res.json({ success: true, data: r.rows });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 产品列表
app.get('/api/products', auth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT p.*,COALESCE(s.name,'') AS supplier_name FROM products p LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.project_no=$1 AND p.deleted_at IS NULL ORDER BY p.name`, [getShip(req)]);
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
    // 产品归属校验
    const prodCheck = await pool.query('SELECT project_no FROM products WHERE id=$1', [req.params.pid]);
    if (!prodCheck.rows.length) return res.status(404).json({ success: false, error: '产品不存在' });
    if (prodCheck.rows[0].project_no !== getShip(req)) return res.status(403).json({ success: false, error: '无权访问该船舶数据' });
    const i = await pool.query(`SELECT id,quantity,date,operator,remark,doc_type,doc_ref,doc_image_path,created_at FROM inbound_records WHERE product_id=$1 ORDER BY date DESC`,[req.params.pid]);
    const o = await pool.query(`SELECT id,quantity,date,department,doc_type,doc_ref,created_at FROM outbound_records WHERE product_id=$1 ORDER BY date DESC`,[req.params.pid]);
    res.json({ success: true, data: { inbound: i.rows, outbound: o.rows } });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 入库
app.post('/api/inbound', auth, async (req, res) => {
  try {
    const { productId, quantity, date, remark, docRef, docImagePath } = req.body;
    const result = await invService.inboundSingle(pool, {
      productId, quantity, date, remark,
      docType: '入库单', docRef: docRef || '', docImagePath: docImagePath || '',
      ship: getShip(req), operator: req.user.displayName
    });
    if (result.code === 400) return res.status(400).json({ success: false, error: result.error });
    if (result.code === 403) return res.status(403).json({ success: false, error: result.error });
    res.json(result);
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 批量入库
app.post('/api/inbound/batch', auth, async (req, res) => {
  try {
    const { items, date, docRef } = req.body;
    const mappedItems = (items || []).map(item => ({ ...item, docRef: item.docRef || docRef || '' }));
    const result = await invService.inboundBatch(pool, {
      items: mappedItems, date,
      ship: getShip(req), operator: req.user.displayName
    });
    if (result.code === 400) return res.status(400).json({ success: false, error: result.error });
    if (result.code === 403) return res.status(403).json({ success: false, error: result.error });
    res.json(result);
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 出库
app.post('/api/outbound', auth, async (req, res) => {
  const { productId, quantity, date, department, remark } = req.body;
  const result = await invService.outboundSingle(pool, {
    productId, quantity, date, department, remark,
    ship: getShip(req), operator: req.user.displayName
  });
  if (result.code === 400) return res.status(400).json({ success: false, error: result.error });
  if (result.code === 403) return res.status(403).json({ success: false, error: result.error });
  res.json(result);
});

// 批量出库
app.post('/api/outbound/batch', auth, async (req, res) => {
  const { items, date, department } = req.body;
  const result = await invService.outboundBatch(pool, {
    items, date, department,
    ship: getShip(req), operator: req.user.displayName
  });
  if (result.code === 400) return res.status(400).json({ success: false, error: result.error });
  res.json(result);
});

// 上传图片
app.post('/api/upload', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, error: '未上传文件' });
    res.json({ success: true, data: { filename: req.file.filename, path: '/uploads/'+req.file.filename } });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 识别图片
// ====== 识别结果缓存（MD5(image) → result, TTL 24h）======
const _recogCache = new Map();
function getRecogCache(imgPath) {
  try {
    const absPath = imgPath.startsWith('/uploads/') ? path.join(__dirname, imgPath) : imgPath;
    const buf = fs.readFileSync(absPath);
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    const entry = _recogCache.get(md5);
    if (entry && Date.now() - entry.ts < 86400000) return entry.result;
  } catch(e) {}
  return null;
}
function setRecogCache(imgPath, result) {
  try {
    const absPath = imgPath.startsWith('/uploads/') ? path.join(__dirname, imgPath) : imgPath;
    const buf = fs.readFileSync(absPath);
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    _recogCache.set(md5, { result, ts: Date.now() });
  } catch(e) {}
}

app.post('/api/recognize', auth, async (req, res) => {
  try {
    const { path: imgPath } = req.body;
    if (!imgPath) return res.json({ success: false, error: '缺少图片路径' });
    // 缓存命中直接返回
    const cached = getRecogCache(imgPath);
    if (cached) return res.json({ success: true, data: cached, cached: true });
    
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

    // 生产最新识别 prompt（6条规则防黏连）
    const RECOGNIZE_PROMPT = `提取送货单中的入库信息，只返回JSON格式：
{"supplier":"供应商名","items":[{"name":"产品名","spec":"规格型号","qty":数量,"unit":"单位"}],"date":"日期"}

严格规则：
① 品名+规格都相同才合并数量，其他情况严禁合并
② 同名不同规格必须分行，严禁合并（如吸入口 AS100Y 和 AS125S 必须分两行）
③ 拿不准是否同一产品就分行，宁可多分不可合并
④ 品名干净，去除多余空格和特殊字符
⑤ 每一行必须独立读取规格列，严禁复制上一行的规格
⑥ 送货单表格有几行就输出几个item，逐行照抄不做合并，即使品名和规格都相同也分行输出`;

    // normSpec: 去空格+大写+全角逗号→半角
    function normSpec(s) { return (s||'').replace(/\s+/g,'').toUpperCase().replace(/，/g,','); }

    // 识图模型链: qwen-vl-max 主，MiniMax-M3 兜底
    const VISION_CHAIN = ['qwen-vl-max'];
    const minimaxKey = process.env.MINIMAX_API_KEY || (() => {
      try { const m = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').match(/MINIMAX_API_KEY=(\S+)/); return m ? m[1] : ''; } catch(e) { return ''; }
    })();
    if (minimaxKey) VISION_CHAIN.push('MiniMax-M3');

    let reply = '';
    let info = null;
    let usedModel = '';

    for (const modelName of VISION_CHAIN) {
      if (info && isValidResult(info)) break;
      const maxTokens = modelName === 'qwen-vl-max' ? 32768 : 65536;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (modelName === 'qwen-vl-max') {
            reply = await chatVision([
              {role: 'system', text: RECOGNIZE_PROMPT},
              {role: 'user', text: '提取信息', image: imgPath}
            ], { max_tokens: maxTokens });
          } else {
            // MiniMax-M3 兜底（OpenAI兼容）
            const absPath = imgPath.startsWith('/uploads/') ? path.join(__dirname, imgPath) : imgPath;
            const b64 = fs.readFileSync(absPath, { encoding: 'base64' });
            const resp = await axios.post('https://api.minimax.chat/v1/text/chatcompletion_v2', {
              model: 'MiniMax-M3',
              messages: [
                { role: 'system', content: RECOGNIZE_PROMPT },
                { role: 'user', content: [
                  { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
                  { type: 'text', text: '提取信息' }
                ]}
              ],
              max_tokens: maxTokens
            }, { headers: { 'Authorization': `Bearer ${minimaxKey}`, 'Content-Type': 'application/json' }, timeout: 60000 });
            reply = resp.data.choices?.[0]?.message?.content || '';
          }
          usedModel = modelName;
          console.log(`[Recognize] model=${modelName} attempt=${attempt} len=${(reply||'').length}`);
          console.log(`[Recognize] raw=${(reply||'').substring(0, 500)}`);
        } catch (e) {
          const status = e.response?.status || 'N/A';
          const body = JSON.stringify(e.response?.data || '').substring(0, 150);
          console.error(`[Recognize] model=${modelName} attempt=${attempt} HTTP ${status}: ${body}`);
          if (attempt === 0) continue;
          break; // 该模型失败，尝试下一个
        }
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
    }
    
    // 验证结果真实性——尝试匹配供应商但不强制
    if (info && isValidResult(info)) {
      // 不做自动合并——模型已逐行输出，合并由用户确认入库时前端处理
      // 仅清理 name/spec 空白
      info.items = info.items.map(item => ({
        ...item,
        name: (item.name||'').trim(),
        spec: (item.spec||'').trim()
      }));
      info.model = usedModel;

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
      setRecogCache(imgPath, info);
      res.json({ success: true, data: info });
    } else {
      res.json({ success: false, error: '未能识别出货品信息，请尝试手工录入' });
    }
  } catch (e) {
    console.error('[Recognize] 未捕获异常:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// 历史单据列表
app.get('/api/documents', auth, async (req, res) => {
  try {
    const ship = getShip(req);
    const r = await pool.query(`
      SELECT r.id, r.doc_image_path, r.created_at, r.date, p.name AS product_name, p.spec AS product_spec
      FROM inbound_records r
      LEFT JOIN products p ON p.id = r.product_id
      WHERE r.doc_image_path IS NOT NULL AND r.doc_image_path != ''
        AND p.project_no = $1
      ORDER BY r.created_at DESC LIMIT 50`, [ship]);
    res.json({ success: true, data: r.rows });
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
    const projectNo = req.body.project_no === 'YY02' ? 'YY02' : 'YY01';
    const r = await pool.query('INSERT INTO products (name,spec,unit,supplier_id,project_no) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, spec||'', unit||'个', supplier_id||null, projectNo]);
    res.json({ success: true, data: r.rows[0] });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ====== 编辑模式（planEdits 工具函数）======
function planEdits(allProducts, changes) {
  const byId = {}; allProducts.forEach(p => byId[p.id] = { ...p });
  const originals = {};
  const applied = [];
  for (const c of changes) {
    const p = byId[c.id]; if (!p) continue;
    const nn = String(c.name || '').trim(), ns = String(c.spec || '').trim();
    if (!nn) return { error: '品名不能为空' };
    if (nn === p.name && ns === (p.spec || '')) continue;
    applied.push({ id: p.id, oldName: p.name, oldSpec: p.spec || '', newName: nn, newSpec: ns });
    originals[p.id] = { name: p.name, spec: p.spec || '' };
    p.name = nn; p.spec = ns;
  }
  const key = p => `${p.name}|${p.spec || ''}|${p.unit || ''}`;
  const groups = {};
  Object.values(byId).forEach(p => { (groups[key(p)] = groups[key(p)] || []).push(p); });
  const merges = [];
  for (const list of Object.values(groups)) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.id - b.id);
    const target = list[0];
    for (let i = 1; i < list.length; i++) {
      const o = originals[list[i].id];
      merges.push({ fromId: list[i].id, fromName: o ? o.name : list[i].name, fromSpec: o ? o.spec : (list[i].spec || ''), toId: target.id, toName: target.name, toSpec: target.spec || '' });
    }
  }
  return { applied, merges };
}

app.post('/api/products/edit-preview', auth, async (req, res) => {
  try {
    const all = (await pool.query('SELECT * FROM products WHERE project_no=$1 AND deleted_at IS NULL', [getShip(req)])).rows;
    const plan = planEdits(all, req.body.changes || []);
    if (plan.error) return res.json({ success: false, error: plan.error });
    res.json({ success: true, data: plan });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/products/edit-apply', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { changes = [], allowMerge = false } = req.body;
    const all = (await client.query('SELECT * FROM products WHERE project_no=$1 AND deleted_at IS NULL', [getShip(req)])).rows;
    const plan = planEdits(all, changes);
    if (plan.error) return res.json({ success: false, error: plan.error });
    if (plan.merges.length && !allowMerge) return res.status(409).json({ success: false, merges: plan.merges });
    await client.query('BEGIN');
    for (const a of plan.applied) {
      await client.query('UPDATE products SET name=$1, spec=$2 WHERE id=$3', [a.newName, a.newSpec, a.id]);
      await client.query(
        `INSERT INTO change_log (action_type, product_id, product_name, quantity, quantity_before, quantity_after, operator, details)
         VALUES ('edit', $1, $2, 0, 0, 0, $3, $4)`,
        [a.id, a.newName, req.user.displayName, `编辑模式修改: 品名'${a.oldName}'→'${a.newName}' 规格'${a.oldSpec}'→'${a.newSpec}'`]);
    }
    for (const m of plan.merges) {
      await client.query('UPDATE inbound_records SET product_id=$1 WHERE product_id=$2', [m.toId, m.fromId]);
      await client.query('UPDATE outbound_records SET product_id=$1 WHERE product_id=$2', [m.toId, m.fromId]);
      await client.query('UPDATE change_log SET product_id=$1 WHERE product_id=$2', [m.toId, m.fromId]);
      await client.query('UPDATE product_notes SET product_id=$1 WHERE product_id=$2', [m.toId, m.fromId]).catch(() => {});
      await client.query('DELETE FROM products WHERE id=$1', [m.fromId]);
      await client.query(
        `INSERT INTO change_log (action_type, product_id, product_name, quantity, quantity_before, quantity_after, operator, details)
         VALUES ('edit', $1, $2, 0, 0, 0, $3, $4)`,
        [m.toId, m.toName, req.user.displayName, `编辑模式合并: '${m.fromName}(${m.fromSpec})' 并入 '${m.toName}(${m.toSpec})'，入出库记录已转移`]);
    }
    await client.query('COMMIT');
    res.json({ success: true, data: { changed: plan.applied.length, merged: plan.merges.length } });
  } catch (e) {
    await client.query('ROLLBACK');
    res.json({ success: false, error: e.message });
  } finally { client.release(); }
});

app.get('/api/inventory/supplier/:sid', auth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT p.id,p.name,p.spec,p.unit,p.supplier_id,COALESCE(s.name,'') AS supplier_name,
      COALESCE(inb.t,0) AS total_in, COALESCE(outb.t,0) AS total_out,
      COALESCE(inb.t,0)-COALESCE(outb.t,0) AS stock
      FROM products p LEFT JOIN suppliers s ON p.supplier_id=s.id
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM inbound_records GROUP BY product_id) inb ON p.id=inb.product_id
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM outbound_records GROUP BY product_id) outb ON p.id=outb.product_id
      WHERE p.supplier_id=$1 AND p.project_no=$2 AND p.deleted_at IS NULL ORDER BY p.id`,[req.params.sid, getShip(req)]);
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
        COUNT(p.id)::int AS products,
        COALESCE(SUM(inb.t),0)::int AS total_in,
        COALESCE(SUM(outb.t),0)::int AS total_out,
        (COALESCE(SUM(inb.t),0)-COALESCE(SUM(outb.t),0))::int AS stock
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id=s.id
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM inbound_records GROUP BY product_id) inb ON p.id=inb.product_id
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM outbound_records GROUP BY product_id) outb ON p.id=outb.product_id
      WHERE p.project_no=$1 AND p.deleted_at IS NULL
      GROUP BY COALESCE(s.name,'未分类')
      ORDER BY stock DESC, total_in DESC`, [getShip(req)]);
    res.json({ success: true, data: r.rows });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 角色化 AI 分析报告（看板用）
// AI报告缓存（key=role+ship，60秒TTL）
const _reportCache = new Map();
function getReportCacheKey(role, ship) { return `${role}:${ship}`; }
function getCachedReport(role, ship) {
  const entry = _reportCache.get(getReportCacheKey(role, ship));
  if (entry && Date.now() - entry.ts < 60000) return entry.report;
  return null;
}
function setReportCache(role, ship, report) {
  _reportCache.set(getReportCacheKey(role, ship), { report, ts: Date.now() });
}

app.get('/api/dashboard/report', auth, async (req, res) => {
  try {
    const role = req.user.role;
    const name = req.user.displayName;
    const ship = getShip(req);
    // 缓存命中
    const cached = getCachedReport(role, ship);
    if (cached) { res.json({ success: true, data: { report: cached, role, cached: true } }); return; }
    // 收集真实数据
    const stock = await pool.query(`SELECT COUNT(*) AS total, SUM(CASE WHEN COALESCE(inb.t,0)-COALESCE(outb.t,0)<3 THEN 1 ELSE 0 END) AS low FROM products p LEFT JOIN (SELECT product_id,SUM(quantity) t FROM inbound_records GROUP BY product_id) inb ON p.id=inb.product_id LEFT JOIN (SELECT product_id,SUM(quantity) t FROM outbound_records GROUP BY product_id) outb ON p.id=outb.product_id WHERE p.project_no=$1 AND p.deleted_at IS NULL`, [ship]);
    const today = await pool.query(`SELECT COUNT(*) AS c FROM inbound_records WHERE date=CURRENT_DATE AND product_id IN (SELECT id FROM products WHERE project_no=$1 AND deleted_at IS NULL)`, [ship]);
    const todayOut = await pool.query(`SELECT COUNT(*) AS c FROM outbound_records WHERE date=CURRENT_DATE AND product_id IN (SELECT id FROM products WHERE project_no=$1 AND deleted_at IS NULL)`, [ship]);
    // 预测数据
    let forecastSummary = '';
    try {
      const { computeForecast } = require('./lib/forecast');
      const fc = await computeForecast(pool, ship);
      const reds = fc.filter(f => f.status === 'red');
      const yellows = fc.filter(f => f.status === 'yellow');
      forecastSummary = `断料风险${reds.length}项` + (reds.length ? '(' + reds.slice(0, 3).map(f => f.product).join('/') + ')' : '') + `，黄灯${yellows.length}项`;
    } catch (e) { forecastSummary = '预测模块不可用'; }
    // 节点数据
    let milestoneSummary = '';
    try {
      const ms = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'project-milestones.json'), 'utf8'));
      const list = ms[ship] || [];
      const active = list.filter(m => m.status === 'active');
      const pending = list.filter(m => m.status === 'pending');
      milestoneSummary = `当前阶段:${active.map(m => m.milestone).join('/')||'无'}，待完成:${pending.map(m => m.milestone).join('/')||'无'}`;
    } catch (e) { milestoneSummary = '';
    }
    const snapshot = `角色:${role} 用户:${name} 船号:${ship}\n库存:${stock.rows[0].total}种/告急${stock.rows[0].low}种\n今日入库${today.rows[0].c}笔/出库${todayOut.rows[0].c}笔\n预测:${forecastSummary}\n节点:${milestoneSummary}`;
    const prompts = {
      executive: `你是船舶建造项目AI分析师。请为何总生成200字战略级报告：两船建造节点风险、断料对交期的影响、供应链健康度、库存资金占用。开头用"何总，您好"。`,
      admin: `你是仓库管理AI助手。请为曹姐生成200字库存管理报告：今日出入库动态、低库存/断料预警清单、待办事项。开头用"曹姐，您好"。`,
      leader: `你是船舶建造AI助手。请为张威队长生成200字报告：本船建造节点的备件保障风险、哪些节点可能因缺料延期。开头用"张队，您好"。`,
      analyst: `你是成本分析AI助手。请为陈俊生成200字报告：库存资金占用、呆滞物料分析、采购节奏建议。开头用"陈俊，您好"。`
    };
    let report;
    try {
      report = await chatText([
        { role: 'system', text: prompts[role] || prompts.admin },
        { role: 'user', text: snapshot }
      ], { temperature: 0.5, max_tokens: 500 });
    } catch (e) {
      report = `${name}，您好。当前${ship}库存${stock.rows[0].total}种，告急${stock.rows[0].low}种。${forecastSummary}。${milestoneSummary}。`;
    }
    setReportCache(role, ship, report);
    res.json({ success: true, data: { report, role } });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 总项目节点表
app.get('/api/milestones', auth, (req, res) => {
  try {
    const ms = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'project-milestones.json'), 'utf8'));
    const ship = getShip(req);
    res.json({ success: true, data: ms[ship] || [] });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 产品备注 CRUD
app.get('/api/notes/:productId', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM product_notes WHERE product_id=$1 ORDER BY created_at DESC', [req.params.productId]);
    const totalQty = r.rows.reduce((s, n) => s + (parseFloat(n.qty) || 0), 0);
    res.json({ success: true, data: r.rows, total_qty: totalQty });
  } catch (e) { res.json({ success: false, error: e.message }); }
});
app.post('/api/notes/:productId', auth, async (req, res) => {
  try {
    const { content, qty } = req.body;
    if (!content) return res.json({ success: false, error: '备注内容不能为空' });
    // 产品归属校验
    const prodCheck = await pool.query('SELECT project_no FROM products WHERE id=$1', [req.params.productId]);
    if (!prodCheck.rows.length) return res.status(404).json({ success: false, error: '产品不存在' });
    if (prodCheck.rows[0].project_no !== getShip(req)) return res.status(403).json({ success: false, error: '无权访问该船舶数据' });
    const r = await pool.query(
      'INSERT INTO product_notes (product_id, content, qty, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.productId, content, qty || 0, req.user.displayName]);
    res.json({ success: true, data: r.rows[0] });
  } catch (e) { res.json({ success: false, error: e.message }); }
});
app.delete('/api/notes/:id', auth, async (req, res) => {
  try {
    const note = (await pool.query('SELECT * FROM product_notes WHERE id=$1', [req.params.id])).rows[0];
    if (!note) return res.json({ success: false, error: '备注不存在' });
    if (note.created_by !== req.user.displayName && req.user.role !== 'admin') {
      return res.json({ success: false, error: '只能删除自己的备注' });
    }
    await pool.query('DELETE FROM product_notes WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 各船统计（选船页卡片用，数据驱动）
app.get('/api/ships/stats', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.project_no, COUNT(*) AS products,
        COALESCE(SUM(COALESCE(inb.t,0)-COALESCE(outb.t,0)),0) AS stock
      FROM products p
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM inbound_records GROUP BY product_id) inb ON p.id=inb.product_id
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM outbound_records GROUP BY product_id) outb ON p.id=outb.product_id
      WHERE p.deleted_at IS NULL
      GROUP BY p.project_no`);
    const statsMap = {};
    r.rows.forEach(row => statsMap[row.project_no] = row);
    const data = SHIPS.map(sh => ({
      project_no: sh.project_no,
      name: sh.name,
      products: statsMap[sh.project_no] ? +statsMap[sh.project_no].products : 0,
      stock: statsMap[sh.project_no] ? +statsMap[sh.project_no].stock : 0
    }));
    res.json({ success: true, data });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ====== 变更日志 & 回滚 ======
app.get('/api/changelog', auth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT c.*,COALESCE(s.name,'') AS supplier_name,COALESCE(o.department,'') AS department FROM change_log c LEFT JOIN products p ON c.product_id=p.id LEFT JOIN suppliers s ON p.supplier_id=s.id LEFT JOIN outbound_records o ON c.ref_table='outbound_records' AND c.ref_record_id=o.id WHERE p.project_no=$1 ORDER BY c.created_at DESC LIMIT 200`, [getShip(req)]);
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

// ====== 删除产品类目（软删除，可回滚）======
app.post('/api/products/delete', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { productId } = req.body;
    if (!productId) return res.json({ success: false, error: '缺少产品ID' });
    const prod = (await client.query('SELECT name,spec,unit,project_no FROM products WHERE id=$1', [productId])).rows[0];
    if (!prod) return res.json({ success: false, error: '产品不存在' });
    if (prod.project_no !== getShip(req)) return res.status(403).json({ success: false, error: '无权操作该船舶数据' });
    const stockBefore = await getStock(productId);
    if (stockBefore > 0) return res.json({ success: false, error: '该产品库存为' + stockBefore + '，仅允许删除库存为0的产品' });
    await client.query('BEGIN');
    await client.query('UPDATE products SET deleted_at=NOW() WHERE id=$1', [productId]);
    await logChange('delete', productId, prod.name, prod.spec, 0, stockBefore, 0, req.user.displayName,
      '删除类目: ' + prod.name + (prod.spec ? ' (' + prod.spec + ')' : '') + ' 原库存:' + stockBefore, 'products', productId);
    await client.query('COMMIT');
    res.json({ success: true, data: { deleted: true, product: prod.name } });
  } catch (e) {
    await client.query('ROLLBACK').catch(()=>{});
    res.json({ success: false, error: e.message });
  } finally { client.release(); }
});

// ====== 恢复删除类目 ======
app.post('/api/products/restore', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { productId } = req.body;
    if (!productId) return res.json({ success: false, error: '缺少产品ID' });
    const prod = (await client.query('SELECT name,spec,unit,project_no FROM products WHERE id=$1', [productId])).rows[0];
    if (!prod) return res.json({ success: false, error: '产品不存在' });
    if (prod.project_no !== getShip(req)) return res.status(403).json({ success: false, error: '无权操作该船舶数据' });
    const stockAfter = await getStock(productId);
    await client.query('BEGIN');
    await client.query('UPDATE products SET deleted_at=NULL WHERE id=$1', [productId]);
    await logChange('restore', productId, prod.name, prod.spec, 0, 0, stockAfter, req.user.displayName,
      '恢复类目: ' + prod.name, 'products', productId);
    await client.query('COMMIT');
    res.json({ success: true, data: { restored: true, product: prod.name } });
  } catch (e) {
    await client.query('ROLLBACK').catch(()=>{});
    res.json({ success: false, error: e.message });
  } finally { client.release(); }
});

// 语音识别（百炼 qwen3-asr-flash）
app.post('/api/speech/recognize', auth, async (req, res) => {
  try {
    const { audio, mimeType } = req.body;
    if (!audio) return res.json({ success: false, error: '缺少音频数据' });
    const text = await speechToText(audio, mimeType || 'audio/webm');
    res.json({ success: true, text });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ====== 全语音链路 ======
// ASR：multer 收音频文件 → qwen3-asr-flash
app.post('/api/voice/asr', auth, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, error: '未上传音频文件' });
    const audioBuffer = fs.readFileSync(req.file.path);
    const base64 = audioBuffer.toString('base64');
    // 从 mimetype 推断格式
    const mime = req.file.mimetype || 'audio/webm';
    const text = await speechToText(base64, mime);
    // 清理临时文件
    fs.unlink(req.file.path, () => {});
    res.json({ success: true, text });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// TTS：尝试百炼 CosyVoice，失败则返回 fallback
app.post('/api/voice/tts', auth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.json({ success: false, error: '缺少 text' });
    // 尝试 DashScope OpenAI兼容 TTS
    const apiKey = process.env.DASHSCOPE_API_KEY || (() => {
      const m = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').match(/DASHSCOPE_API_KEY=(\S+)/);
      return m ? m[1] : '';
    })();
    const resp = await axios.post('https://dashscope.aliyuncs.com/compatible-mode/v1/audio/speech', {
      model: 'cosyvoice-v1',
      input: text.substring(0, 500),
      voice: 'longxiaochun'
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15000,
      responseType: 'arraybuffer'
    });
    // 保存音频文件
    const filename = 'tts-' + Date.now() + '.mp3';
    const outPath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(outPath, Buffer.from(resp.data));
    res.json({ success: true, audio_url: '/uploads/' + filename, fallback: false });
  } catch (e) {
    console.log('[TTS] 百炼 CosyVoice 不可用，降级浏览器 speechSynthesis:', e.response?.status || e.message);
    res.json({ success: true, fallback: true });
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

// ====== 对话式库存操作（多轮上下文+指代解析+真实执行）======
const { processMessage } = require('./lib/chat-ops');
app.post('/api/chat/ops', auth, async (req, res) => {
  try {
    const { session_id, message } = req.body;
    if (!message) return res.json({ success: false, error: '请输入消息' });
    const sid = session_id || req.user.username;
    const result = await processMessage(sid, message, req.user.displayName);
    res.json({ success: true, ...result });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ====== 角色化登录简报 ======
app.get('/api/briefing', auth, async (req, res) => {
  try {
    const user = req.user;
    const ship = getShip(req);
    let snapshot = '';
    let prompt = '';

    if (user.role === 'admin') {
      // 库存管理员：库存告急 + 近3天动态（按当前船舶过滤）
      const low = await pool.query(`
        SELECT p.name,p.spec,COALESCE(inb.t,0)-COALESCE(outb.t,0) AS stock
        FROM products p
        LEFT JOIN (SELECT product_id,SUM(quantity) t FROM inbound_records GROUP BY product_id) inb ON p.id=inb.product_id
        LEFT JOIN (SELECT product_id,SUM(quantity) t FROM outbound_records GROUP BY product_id) outb ON p.id=outb.product_id
        WHERE p.project_no=$1 AND COALESCE(inb.t,0)-COALESCE(outb.t,0) < 3 ORDER BY stock ASC LIMIT 10`, [ship]);
      const recent = await pool.query(`
        SELECT c.action_type,c.product_name,c.quantity,c.operator,c.created_at FROM change_log c
        JOIN products p ON c.product_id=p.id
        WHERE c.action_type IN ('inbound','outbound') AND p.project_no=$1 AND c.created_at >= NOW() - INTERVAL '3 days'
        ORDER BY c.created_at DESC LIMIT 15`, [ship]);
      snapshot = `【库存告急（库存<3）】共${low.rows.length}项：\n` + low.rows.map(r => `${r.name}(${r.spec||'无规格'}) 库存${r.stock}`).join('；') +
        `\n【近3天出入库动态】共${recent.rows.length}条：\n` + recent.rows.map(r => `${r.action_type==='inbound'?'入库':'出库'} ${r.product_name}×${r.quantity} 操作人:${r.operator}`).join('；');
      prompt = `你是库存管理AI助手。请根据以下数据为库存管理员「${user.displayName}」生成今日工作简报，150字以内，口语化，开头用"${user.displayName}，"。重点提醒告急物料和近期动态。`;

    } else if (user.role === 'leader') {
      // 队长：项目风险视角
      const msAll = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'project-milestones.json'), 'utf8'));
      const statusMap = {done:'已完成',active:'进行中',pending:'未开始'};
      const planData = Object.entries(msAll).flatMap(([ship, arr]) => arr.map(m => ({...m, project_no: ship, ship: ship==='YY01'?'远洋01':'远洋02', status: statusMap[m.status]||m.status})));
      const now = new Date();
      const upcoming = planData.filter(m => {
        const d = new Date(m.planned_date);
        const diff = (d - now) / 86400000;
        return diff >= 0 && diff <= 30;
      });
      let riskInfo = '';
      for (const m of upcoming) {
        const cats = m.related_categories || [];
        if (!cats.length) continue;
        const catFilter = cats.map((c, i) => `p.name ILIKE $${i + 1} OR p.spec ILIKE $${i + 1}`).join(' OR ');
        const params = cats.map(c => '%' + c.replace('类', '') + '%');
        const items = await pool.query(`
          SELECT p.name,p.spec,COALESCE(inb.t,0)-COALESCE(outb.t,0) AS stock
          FROM products p
          LEFT JOIN (SELECT product_id,SUM(quantity) t FROM inbound_records GROUP BY product_id) inb ON p.id=inb.product_id
          LEFT JOIN (SELECT product_id,SUM(quantity) t FROM outbound_records GROUP BY product_id) outb ON p.id=outb.product_id
          WHERE (${catFilter}) AND COALESCE(inb.t,0)-COALESCE(outb.t,0) < 5 ORDER BY stock ASC LIMIT 5`, params);
        if (items.rows.length) {
          riskInfo += `\n「${m.milestone}」(${m.planned_date},${m.ship})关联类别[${cats.join('/')}]低库存：` +
            items.rows.map(r => `${r.name}(${r.spec||''})库存${r.stock}`).join('、');
        }
      }
      snapshot = `【30天内项目节点】\n` + upcoming.map(m => `${m.ship}-${m.milestone} ${m.planned_date} [${m.status}] 关联:${(m.related_categories||[]).join('/')}`).join('\n') +
        (riskInfo ? `\n【风险项】${riskInfo}` : '\n【风险项】暂无明显风险');
      prompt = `你是项目管理AI助手。请根据以下数据为队长「${user.displayName}」生成项目风险简报，150字以内，口语化，开头用"${user.displayName}，"。重点指出哪些节点临近但相关备件库存不足。`;

    } else {
      // 分析员（analyst 及其他角色）：呆滞TOP5 + 本月出入库对比（按当前船舶）
      const stagnant = await pool.query(`
        SELECT p.name,p.spec,COALESCE(inb.t,0)-COALESCE(outb.t,0) AS stock,
          MAX(o.created_at) AS last_out
        FROM products p
        LEFT JOIN (SELECT product_id,SUM(quantity) t FROM inbound_records GROUP BY product_id) inb ON p.id=inb.product_id
        LEFT JOIN (SELECT product_id,SUM(quantity) t FROM outbound_records GROUP BY product_id) outb ON p.id=outb.product_id
        LEFT JOIN outbound_records o ON o.product_id=p.id
        WHERE p.project_no=$1 AND COALESCE(inb.t,0)-COALESCE(outb.t,0) > 0
        GROUP BY p.id,p.name,p.spec,inb.t,outb.t
        HAVING MAX(o.created_at) < NOW() - INTERVAL '30 days' OR MAX(o.created_at) IS NULL
        ORDER BY stock DESC LIMIT 5`, [ship]);
      const monthly = await pool.query(`
        SELECT
          COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE created_at >= date_trunc('month',NOW()) AND product_id IN (SELECT id FROM products WHERE project_no=$1)),0) AS month_in,
          COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE created_at >= date_trunc('month',NOW()) AND product_id IN (SELECT id FROM products WHERE project_no=$1)),0) AS month_out`, [ship]);
      const mi = monthly.rows[0];
      snapshot = `【呆滞物料TOP5（30天未出库）】\n` + stagnant.rows.map((r, i) => `${i + 1}.${r.name}(${r.spec||''}) 库存${r.stock} 最后出库:${r.last_out ? new Date(r.last_out).toLocaleDateString('zh-CN') : '从未'}`).join('\n') +
        `\n【本月出入库对比】入库${mi.month_in}件 / 出库${mi.month_out}件`;
      prompt = `你是数据分析AI助手。请根据以下数据为分析员「${user.displayName}」生成数据简报，150字以内，口语化，开头用"${user.displayName}，"。点评呆滞情况和出入库趋势。`;
    }

    // 调用 LLM 生成自然语言简报，失败则降级
    let briefing;
    try {
      briefing = await chatText([
        { role: 'system', text: prompt + '\n数据如下：\n' + snapshot },
        { role: 'user', text: '请生成简报' }
      ], { temperature: 0.7, max_tokens: 300 });
    } catch (e) {
      console.log('[Briefing] LLM失败，降级为纯数据:', e.message);
      briefing = snapshot;
    }
    res.json({ success: true, data: { briefing, role: user.role, displayName: user.displayName } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ====== 项目×备件联动分析 ======
const CATEGORY_SQL = `
  CASE
    WHEN p.name LIKE '%阀%' THEN '阀门类'
    WHEN p.name LIKE '%阳极%' THEN '牺牲阳极'
    WHEN p.name LIKE '%泵%' OR p.name LIKE '%叶轮%' OR p.name LIKE '%机封%' THEN '泵配件'
    WHEN p.name LIKE '%密封%' OR p.name LIKE '%垫片%' OR p.name LIKE '%O型圈%' OR p.name LIKE '%油封%' OR p.name LIKE '%填料%' THEN '密封件'
    ELSE '电气件'
  END`;

app.get('/api/analysis', auth, async (req, res) => {
  try {
    // 1. 读取节点数据（单一数据源 project-milestones.json）
    const msAll = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'project-milestones.json'), 'utf8'));
    const statusMap = {done:'已完成',active:'进行中',pending:'未开始'};
    const planData = Object.entries(msAll).flatMap(([ship, arr]) => arr.map(m => ({...m, project_no: ship, ship: ship==='YY01'?'远洋01':'远洋02', status: statusMap[m.status]||m.status})));
    const ship = getShip(req);
    const now = new Date();
    const milestones = planData.filter(m => m.project_no === ship).filter(m => {
      const d = new Date(m.planned_date + 'T00:00:00');
      const diff = (d - now) / 86400000;
      return diff >= 0 && diff <= 60;
    }).map(m => ({
      ...m,
      days_left: Math.ceil((new Date(m.planned_date + 'T00:00:00') - now) / 86400000)
    }));

    // 2. 按类别聚合库存
    const catStats = await pool.query(`
      SELECT ${CATEGORY_SQL} AS category,
        COUNT(*) AS product_count,
        SUM(COALESCE(inb.t,0)-COALESCE(outb.t,0)) AS total_stock,
        SUM(CASE WHEN COALESCE(inb.t,0)-COALESCE(outb.t,0) < 3 THEN 1 ELSE 0 END) AS low_count
      FROM products p
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM inbound_records GROUP BY product_id) inb ON p.id=inb.product_id
      LEFT JOIN (SELECT product_id,SUM(quantity) t FROM outbound_records GROUP BY product_id) outb ON p.id=outb.product_id
      GROUP BY category ORDER BY category`);
    const category_stats = catStats.rows.map(r => ({
      category: r.category,
      product_count: +r.product_count,
      total_stock: +r.total_stock,
      low_count: +r.low_count
    }));

    // 3. 风险明细：节点关联类别中库存<3的备件
    const risks = [];
    for (const m of milestones) {
      const cats = m.related_categories || [];
      if (!cats.length) continue;
      const catConditions = cats.map((c, i) => `${CATEGORY_SQL} = $${i + 1}`).join(' OR ');
      const items = await pool.query(`
        SELECT p.name,p.spec,${CATEGORY_SQL} AS category,
          COALESCE(inb.t,0)-COALESCE(outb.t,0) AS stock
        FROM products p
        LEFT JOIN (SELECT product_id,SUM(quantity) t FROM inbound_records GROUP BY product_id) inb ON p.id=inb.product_id
        LEFT JOIN (SELECT product_id,SUM(quantity) t FROM outbound_records GROUP BY product_id) outb ON p.id=outb.product_id
        WHERE (${catConditions}) AND COALESCE(inb.t,0)-COALESCE(outb.t,0) < 3
        ORDER BY stock ASC`, cats);
      for (const r of items.rows) {
        risks.push({
          milestone: m.milestone,
          ship: m.ship,
          planned_date: m.planned_date,
          days_left: m.days_left,
          name: r.name,
          spec: r.spec || '',
          category: r.category,
          stock: +r.stock
        });
      }
    }

    // 4. 组装快照调 chatText 生成AI洞察
    const snapshot = `【未杧60天项目节点】\n` + milestones.map(m => `${m.ship}-${m.milestone} ${m.planned_date}(剩${m.days_left}天) 关联:${(m.related_categories||[]).join('/')}`).join('\n') +
      `\n【各类别库存】\n` + category_stats.map(c => `${c.category}: ${c.product_count}种/库存${c.total_stock}/告急${c.low_count}种`).join('\n') +
      `\n【风险明细(库存<3)】共${risks.length}项\n` + risks.slice(0, 15).map(r => `${r.milestone}关联: ${r.name}(${r.spec})库存${r.stock}`).join('\n');
    let ai_insight;
    try {
      ai_insight = await chatText([
        { role: 'system', text: `你是船舶建造项目AI分析师。请根据以下数据生成项目×备件联动分析洞察，300字以内，给管理者看的决策语言。要具体到“哪个节点+缺什么+建议动作”。不要客套话，直接给结论。` },
        { role: 'user', text: snapshot }
      ], { temperature: 0.5, max_tokens: 600 });
    } catch (e) {
      console.log('[Analysis] LLM失败，降级:', e.message);
      ai_insight = `当前${milestones.length}个节点临近，${risks.length}项备件库存告急。` + category_stats.filter(c => c.low_count > 0).map(c => `${c.category}告急${c.low_count}种`).join('、') + '。建议立即采购补货。';
    }

    // 为节点添加风险状态灯
    const milestonesWithStatus = milestones.map(m => {
      const mRisks = risks.filter(r => r.milestone === m.milestone && r.ship === m.ship);
      const hasRisk = mRisks.length > 0;
      const status = !hasRisk ? 'green' : (m.days_left <= 14 ? 'red' : 'yellow');
      return { ...m, risk_status: status, risk_count: mRisks.length };
    });

    // 5. 库存趋势预测
    const { computeForecast, generateForecastInsight } = require('./lib/forecast');
    let forecast = [];
    let forecast_insight = '';
    try {
      forecast = await computeForecast(pool, null);
      forecast_insight = await generateForecastInsight(forecast, null);
    } catch (fe) { console.log('[Analysis] 预测失败降级:', fe.message); }

    // AI洞察合并预测语言
    const fullInsight = ai_insight + (forecast_insight ? '\n\n【库存趋势预测】\n' + forecast_insight : '');

    res.json({ success: true, data: { milestones: milestonesWithStatus, category_stats, risks, ai_insight: fullInsight, forecast } });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 库存趋势预测独立接口
app.get('/api/forecast', auth, async (req, res) => {
  try {
    const { computeForecast, generateForecastInsight } = require('./lib/forecast');
    const ship = req.query.ship || null;
    const forecast = await computeForecast(pool, ship);
    const insight = await generateForecastInsight(forecast, ship);
    res.json({ success: true, data: { forecast, insight } });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ====== 月末对账 ======
const { reconcile, reconcileChat } = require('./lib/reconcile');

app.post('/api/reconcile/upload', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, error: '未上传文件' });
    const { supplier, month } = req.body;
    if (!supplier || !month) return res.json({ success: false, error: '缺少 supplier 或 month 参数' });
    const imgPath = req.file.path;
    const result = await reconcile(imgPath, supplier, month);
    if (!result.success) return res.json(result);
    // 存入 session 供后续追问
    const sessionId = req.body.session_id || ('recon-' + Date.now());
    result.data.session_id = sessionId;
    // 将数据存入 reconcileChat 的会话
    await reconcileChat(sessionId, '__init__', result.data);
    res.json({ success: true, data: result.data });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/reconcile/chat', auth, async (req, res) => {
  try {
    const { session_id, message } = req.body;
    if (!session_id || !message) return res.json({ success: false, error: '缺少 session_id 或 message' });
    const result = await reconcileChat(session_id, message, null);
    res.json(result);
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ====== AI 邮件助手 ======
const { getThreads, draftMail, sendMail } = require('./lib/mail-assistant');
const { sendRealMail, fetchInbox } = require('./lib/mail-transport');

app.get('/api/mail/threads', auth, (req, res) => {
  try {
    const threads = getThreads();
    res.json({ success: true, data: threads });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/mail/draft', auth, async (req, res) => {
  try {
    const { session_id, message } = req.body;
    if (!session_id || !message) return res.json({ success: false, error: '缺少 session_id 或 message' });
    const result = await draftMail(session_id, message);
    res.json(result);
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/mail/send', auth, async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    if (!to || !subject || !body) return res.json({ success: false, error: '缺少 to/subject/body' });
    // 尝试真实 SMTP 发送（白名单硬校验在 sendRealMail 内部）
    try {
      const result = await sendRealMail({ subject, body, displayTo: to });
      // 同时写 sent-box.json 备份
      sendMail(to, subject, body);
      res.json({ success: true, data: result, reply: '✅ 已真实发送至沙箱邮箱，请查收' });
    } catch (smtpErr) {
      // SMTP 失败降级写 sent-box.json
      console.log('[SMTP] 发送失败，降级写 sent-box:', smtpErr.message);
      const record = sendMail(to, subject, body);
      res.json({ success: true, data: record, reply: '⚠️ SMTP不可用，已写入本地发件箱（' + smtpErr.message + '）' });
    }
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 沙箱真实收件箱
app.get('/api/mail/inbox', auth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const emails = await fetchInbox(limit);
    res.json({ success: true, data: emails });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ====== 启动 ======
// 版本信息（只读，不执行 shell）
const APP_VERSION = 'v1.0-demo';
app.get('/api/version', (req, res) => { res.json({ version: APP_VERSION }); });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 远洋01/远洋02 进出库管理系统运行在 http://0.0.0.0:${PORT} [${APP_VERSION}]`);
});
