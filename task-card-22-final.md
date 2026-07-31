# 任务卡 22：编辑模式 + 删除类目 移植（比赛收尾最终版）

> **目标仓库**：`/Users/vaughan/Desktop/inventory-hackathon-contest`（contest-p0-0731 分支）
> **参考源**：`/Users/vaughan/Desktop/inventory-hackathon`（旧仓库，commit 52e084e，卡 18 之后）
> **基线**：3 commit `1bd7365/ef79266/065f3d4`，server.js md5=4425a2e1
> **验收**：Hermes 重跑 52/52 + 26/26 + 14/14 + 5/5 + 7/7 全绿

## 任务 1：后端移植 - 编辑模式（曹姐 7/29 核心需求）

**从旧仓库 server.js 复制以下函数和端点，逐字搬迁（变量名也照搬）**：

1. `planEdits(allProducts, changes)` 工具函数（带 originals 修复，防止合并日志里规格被改写成新值）
2. `POST /api/products/edit-preview`：模拟应用，返回 `{ applied, merges }`
3. `POST /api/products/edit-apply`：事务执行 + UPDATE products + 转移 inbound/outbound/change_log/product_notes + DELETE 被合并产品 + 写 change_log 'edit' 两条（修改+合并）
   - **关键**：DELETE products 之前必须转移全部关联表（inbound_records / outbound_records / change_log / product_notes），缺一张就留孤儿

## 任务 2：后端移植 - 删除类目（曹姐 7/30 需求）

**从旧仓库 server.js 复制**：

1. `products` 表加列：`ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;`
2. **修改所有 SELECT products 的 SQL**，加上 `AND p.deleted_at IS NULL`（包括 /api/inventory、/api/products、/api/inventory/supplier 等）
3. `POST /api/products/delete`：参数 `{productId}`，置 `deleted_at=NOW()`，**仅当原库存=0** 才允许（避免误删有货产品）
4. `POST /api/products/restore`：参数 `{productId}`，置 `deleted_at=NULL`，写 change_log
5. 改 `/api/ships/stats` SQL 写死的 `('SOM07','SOM08')` 为通用查询（用 `SELECT DISTINCT project_no FROM products WHERE deleted_at IS NULL`），这是当前**生产 demo 选船卡片空白的根因**

## 任务 3：前端移植 - 编辑模式 UI

**从旧仓库 public/app.js 复制**：

1. `window._editMode = false; window._editData = []` 状态变量
2. `escAttr()` 函数
3. `editModal(html, buttons)` 弹窗组件
4. `enterEditMode()` / `renderEditTable()` / `applyEditMode()` / `exitEditMode()` 完整流程
5. `loadInventory()` 函数开头加一行 `if(window._editMode){renderEditTable();return;}`

**从旧仓库 public/index.html 复制**：
- `<button class="btn btn-sm" id="editModeBtn" onclick="enterEditMode()">✏️ 编辑模式</button>`
- `<button class="btn btn-sm" id="editCancelBtn" onclick="exitEditMode(true)" style="display:none">✖ 取消</button>`
- 放在 📂 全部展开 按钮后面

## 任务 4：前端移植 - 删除类目 UI

**从旧仓库 public/app.js 复制**：

1. `deleteProduct(id)` 函数：调用 `/api/products/delete`
2. 库存总览每行"操作"列加：📤出库按钮旁边加 ⬇️删除按钮（条件渲染：仅当库存=0 时显示，避免误删）
3. 删除成功 toast 后刷新库存表

**从旧仓库 public/index.html 复制**：
- 在出库按钮旁加 `<button class="btn btn-sm btn-outline-danger" onclick="deleteProduct(${r.id})" title="仅库存为0时可删除" ${s>0?'disabled style="opacity:0.4"':''}>🗑</button>`

## 任务 5：E2E 新增断言（test-e2e.js）

按以下顺序测试：

1. **编辑模式 - 普通改规格**：`POST /api/products/edit-preview` 返回 `{applied:[...], merges:[]}`，`edit-apply` 成功，change_log 出现 'edit' 记录
2. **编辑模式 - 撞车合并**：两个 product 同 name+spec，edit-preview 返回 merges，edit-apply with allowMerge=true 后只剩 1 个 product，原产品的 inbound_records 全部转移到目标产品
3. **删除类目 - 库存=0 成功**：创建空库存 product，POST /api/products/delete，返回 success，SELECT 时 `deleted_at IS NOT NULL`
4. **删除类目 - 库存>0 拒绝**：创建非空库存 product，POST /api/products/delete，返回 error，product 仍在
5. **删除类目 - 恢复**：POST /api/products/restore，product 重新出现在 /api/inventory
6. **选船卡片修复**：登录后 GET /api/ships/stats 返回非空数组（不再是 `[]`）

## 验收

- `node scripts/test-e2e.js` **52/52 + 新增 6 项 = 58/58 全绿**
- `node scripts/test-card12.js` **26/26**
- `node scripts/test-safety.js` **14/14**（已有）
- `node scripts/test-forecast.js` **5/5**
- 浏览器实测：登录 → 选船卡片可见 → 进入库存 → ✏️ 编辑模式按钮可见 → 改规格触发合并弹窗 → 空库存产品可🗑删除 → 删除后从列表消失

## 禁区（不变）

- 邮件沙箱 yuanyangdemo@163.com 唯一
- reset 钉值（DN50=4/球阀=2/阳极=21）
- 聊天链 chat/ops 逻辑
- voice 语音按钮——本卡不动（新仓库已有完整语音UI，不重复实现）

## commit 信息

`feat: 移植编辑模式+删除类目（曹姐核心需求）+ 选船卡片SQL修复（比赛收尾最终版）`

提交后告诉 Hermes 验收，**不要自行部署服务器**——Hermes 负责部署。