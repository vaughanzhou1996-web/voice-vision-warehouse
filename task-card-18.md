# 任务卡 18：录屏前安全加固 + 迭代记录页面 + 录制准备

**背景**：外部评审第二轮 42/50，指出 3 条 P0 必修（多租户鉴权/识别样本缓存/数据重置）。用户决定 Demo 内加入"曹姐反馈迭代记录"页面，让评委自然感受到真实用户的存在。卡 14/15/16/17 全部已完成部署，git tag 锁定前完成本卡。

---

## 任务 1：多租户鉴权加固（P0，server.js）

**现状（严重泄露）：** YY01 的 token 可读粤 YY02 库存 14 条、写入出库/入库/编辑——完全无隔离。server.js 当前依赖 `getShip(req)` 从 URL `?ship=` 取值，不验证 token 所属权限。

**改法：**
1. 登录时 JWT payload 存 `project_no`（用户发起登录时所在 ship）
2. 新增中间件 `authShip`：从 token 读 `project_no`，与请求 `?ship=` 对比
3. 不匹配 → `return res.status(403).json({ success: false, error: '无权访问该船舶数据' })`
4. hezong 用户不做例外（演示一律按单船隔离）
5. 作用范围：所有带 `?ship=` 的 GET/POST——inventory/products/inbound/outbound/edit-preview/edit-apply/changes/documents/notes/analysis/forecast/chat/batch-outbound/milestones/log
6. 原有 `getShip(req)` 改位：先调 `authShip`，再从 URL 正常取

**验证（必须 playwright 390px 双视口）：**
- caojie(YY01) 登录 → 搜 YY02 数据 → 弹「无权访问」
- caojie(YY01) 登录 → 点出库传 YY02 → 403
- hezong(caojie 一样单船)同上
- 正常 YY01 操作不受影响

---

## 任务 2：演示专用识别样本 + 缓存（P0）

**现状：** AI 识别每次调用 qwen-vl-max，6-8 秒，录制时网络抖动可能翻车。

**改法：**
1. 用真实样本 `送货单样本/微信图片_20260708145340_312_20.jpg`（吸入口 3 行 3 规格那张）跑 5 次，确认稳定
2. 将稳定版样本图存入 `docs/sample_312.jpg`
3. server.js 加内存 Map `recogCache`：key=MD5(image_file), value=识别结果 JSON。**TTL = 24 小时**
4. uploadForRecog（桌面 + 手机）在上传图片后先查缓存，命中直接返回（< 1 秒）
5. 缓存 miss → 正常调用 → 写缓存

**验证：** 同一张照片第二遍识别，API 响应时间 < 1 秒，结果与第一次一致

---

## 任务 3：demo 数据一键重置接口（P0）

**现状：** 评委或观众登录 demo 后可能乱改数据，录屏时数据对不上。

**改法：**
1. 新增 `POST /api/demo/reset`（限 caojie/hezong/zhangwei/chenjun 角色，走现有 auth 中间件）
2. 执行逻辑 = `node scripts/reset-demo.js` 同等：TRUNCATE inbound_records/outbound_records/change_log/product_notes/products → 重新运行 seed
3. 种子数据必须稳定（YY01 库存 60 项，截止阀 DN50=4.00，YY02 库存 54 项）

**验证：** 调用后查 YY01 库存数=60，钉值=4.00，YY02 数=54

---

## 任务 4：迭代记录页面（曹姐反馈时间线——评委看到的"真实感"）

**现状：** 外部评审反复强调"评委要自己感受到这是真业务"。本项目从上线至今 30 项曹姐反馈驱动的改进已记录在 `data/iteration-log.json`，但这个数据文件不在 UI 里。

**改法（纯前端，不动后端）：**
1. **桌面版**（index.html + app.js）：
   - 顶部导航栏加一个按钮：`📋 更新日志`（在刷新按钮旁边）
   - 点击后打开一个 modal/overlay，从 `data/iteration-log.json` fetch 数据
   - 渲染为纵向时间线卡片：
     - 按日期倒序排列
     - 每张卡片显示：日期+图标（🐞/🔧/✅）→ 问题（用户原话风格）→ 做了什么（技术修复摘要）
     - 时长显示在卡片右下角小字（< 1h / 3h / 当场修）
     - 示例：
       ```
       7/29 🔧 曹姐反馈："一批入库30项，1-2项规格错了，只能整批回滚重来"
       → 编辑模式上线：品名/规格可改+撞车自动合并
         3h
       ```
   - 简洁样式：字体灰色 #666，卡片 8px 圆角 + 左边框 2px 蓝色
   
2. **手机版**（mobile.html）：
   - 底部导航第 5 个 Tab：`📋` 更新日志（复用同一 json 文件）
   - 列表式卡片布局，自动适配 390px 视口

3. **E2E：** 新增 2 项断言：更新日志弹窗可打开、至少显示 20 条记录

4. **禁区：** 不碰 JSON 数据内容（它是 git 可追踪的事实文档，不是代码）

---

## 任务 5：Edge/Safari 兼容修补

**现状：** 评审指出 Safari `word-break` / `overflow` 可能不兼容。Playwright 全套目前在 Chrome 跑。

**改法：**
1. 用 Playwright 在 WebKit 模式下跑全量 e2e（`test-e2e.js`）
2. 修复发现的任何渲染差异（通常是 `-webkit-` 前缀缺失或 flex-box 差异）
3. 已知高风险区：mobile.html 语音弹窗、编辑模式输入框撑满

---

## 任务 6：E2E 新增（37+8=45 项）

| 断言 | 覆盖 |
|------|------|
| YY01 token 查 YY02 数据 → 403 | 任务1 |
| 缓存命中 → 第二次识别 < 1s | 任务2 |
| demo/reset → 库存恢复 60 项 | 任务3 |
| 更新日志弹窗打开 | 任务4 |
| 更新日志 ≥ 20 条 | 任务4 |
| Safari WebKit 无渲染差异 | 任务5 |
| test-card12 + test-forecast 不回潮 | 整体 |

---

## 禁区（绝不改动）

- 邮件（仅限 yuanyangdemo@163.com 沙箱）
- 钉值/聊天链/.env
- chat ops 功能
- voice 语音按钮（不删除但不动文案/逻辑）

**赛前不做（都是赛后）：** Service 层拆分 / Sentry / 模型微调 / PWA / 行业白皮书

## 验收

1. **鉴权 403：** curl 截图（YY01 token 请求 YY02 → 403 JSON）
2. **缓存加速：** 同一照片两次识别时间对比截图
3. **重置接口：** 调完接口后的库存统计截图（60 项 / 钉值 4.00）
4. **更新日志：** 桌面+手机各一张时间线截图（至少 20 条可见）
5. **Safari：** WebKit playwright 全绿
6. **全量测试：** 自我验收结果 45/45 + 26/26 + 7/7
7. **全部通过后**切换到 `v1.0-demo` git tag——录屏当天不再 merge 新代码
