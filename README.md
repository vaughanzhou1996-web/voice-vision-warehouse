# 🚢 能听能看的仓库管家

**AI 驱动的船舶备件智能库存管理系统**

> 📖 体验导览：[使用手册 →](docs/USER_MANUAL.md)

## 背景故事

我是一名国外商学院毕业的留学生，完全不懂代码，到今天都不知道 json 是什么（总有一天我会慢慢知道的：）。我在上海一家船舶建造 EPC 公司协助处理船检文件，对 AI 的兴趣让我尝试把智能体嵌入日常重复工作。我观察到公司仓库管理系统十分老旧——仓库管理员曹姐还在填纸质表格、配合 Excel 统计数据；船舶配件数量繁多、型号复杂，她经常加班核对却依然容易出错。看到这些痛点，我使用 AI 编程工具（Qoder + 通义千问）手搓了这套智能库存管理系统，全部功能由 AI 编程完成，并已在公司真实上线使用。

## 七大 AI 能力

| # | 能力 | 一句话说明 | 模型 |
|---|------|-----------|------|
| 1 | 💬 对话式库存操作 | 自然语言查库存、出入库，多轮上下文+指代解析 | qwen3-max-preview |
| 2 | 📷 拍照识别入库 | 拍送货单→AI 提取品名规格数量→一键批量入库 | qwen-vl-max |
| 3 | 📊 项目×备件联动分析 | 项目节点×库存交叉推理，风险预警+AI 洞察 | qwen3-max-preview |
| 4 | 📈 库存趋势预测 | 建造周期驱动，预测未来60天库存水位，精确到“哪天断料” | qwen3-max-preview |
| 5 | 📧 AI 邮件助手 | 对话式起草/修改供应商邮件，沙箱真实收发 | qwen3-max-preview |
| 6 | 🧾 月末对账 | 对账单拍照→OCR→自动比对→差异报告→追问→生成邮件 | qwen-vl-max + qwen3-max-preview |
| 7 | 🎤 全语音链路 | 按住说话→ASR→对话引擎→AI回复→TTS播报 | qwen3-asr-flash |

## 🎛️ 多模态设计

系统把三种模态落到同一个对话引擎上——模态是入口和出口的选择，不是功能的堆砌：

| 模态 | 模型 | 承担的场景 | 设计考量 |
|------|------|-----------|---------|
| 视觉 | qwen-vl-max | 送货单拍照入库、对账单 OCR | 仓库里手是脏的、单据是纸的。视觉不是"代替 OCR"，而是理解版式（表格/手写/印章干扰）后直接输出结构化 JSON，附带语义纠错（"只/个/台"单位归一、规格型号标准化） |
| 语音 | qwen3-asr-flash + 浏览器 TTS | 全双工语音链路：按住说话→识别→对话引擎→语音播报 | 手里拿着零件时没法打字。ASR 转写后汇入**同一个**对话引擎，意图解析、多轮指代与文字输入完全同构，不维护两套逻辑 |
| 文本 | qwen3-max-preview | 对话操作、联动分析、趋势预测、邮件起草 | 所有模态的最终汇流层。结构化输出靠 JSON Schema 约束 + 业务校验双层把关，AI 说的每个数字都来自数据库真实查询，不允许模型凭记忆报价 |

**两条关键的工程原则**：

1. **统一意图层**：语音、文字、视觉确认后的指令，最终都归一为对 PostgreSQL 的结构化操作（查/入/出/撤销）。模态可以换，业务核心只有一份——这是"能听能看"不沦为炫技的前提。
2. **每条 AI 链路都有非 AI 退路**：视觉识别失败 → 手工录入；TTS 不可用 → 浏览器内置语音降级；AI 简报失败 → 纯数据卡片。多模态系统的可靠性不取决于模型多强，取决于最弱的那条链路断了之后系统还能不能用。

**数据只有一处，模态各取所需**：同一份库存+建造周期联动数据，文本模态用于对话查询和邮件起草，视觉模态用于对账差异比对，语音模态用于简报播报——预测引擎算出的"断料日"会同时出现在队长的简报里、催货邮件的措辞里和水位曲线图的红点上。

## 技术栈

- **后端**：Node.js + Express + PostgreSQL
- **前端**：原生 JS + ECharts（本地引用，零 CDN）
- **AI 模型**：通义千问（阿里云百炼）
  - `qwen3-max-preview` — 文本对话 / 分析 / 邮件
  - `qwen-vl-max` — 视觉识别（送货单 / 对账单）
  - `qwen3-asr-flash` — 语音识别
- **邮件**：nodemailer（SMTP）+ imapflow（IMAP），沙箱白名单硬编码
- **部署**：PUBLIC_URL（占位符，提交前替换）

## 快速开始

```bash
# 0. 前置依赖：Node.js 18+ 和 PostgreSQL 12+（macOS: brew install postgresql@16）

# 1. 克隆仓库
git clone https://github.com/vaughanzhou1996-web/voice-vision-warehouse.git && cd voice-vision-warehouse

# 2. 安装依赖
npm install

# 3. 创建数据库
createdb inventory_demo

# 4. 初始化演示数据（幂等，可重复执行）
node scripts/seed-demo.js

# 5. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 DASHSCOPE_API_KEY（必需）和邮箱凭据（可选）

# 6. 启动
npm start
# → http://localhost:8000
```

## 项目结构

```
├── lib/                  # 核心引擎
│   ├── qwen.js           # 通义千问统一调用层
│   ├── chat-ops.js       # 对话式库存操作引擎
│   ├── forecast.js       # 库存趋势预测引擎
│   ├── mail-assistant.js # AI 邮件起草引擎
│   ├── mail-transport.js # 真实 SMTP/IMAP 通道（白名单硬校验）
│   └── reconcile.js      # 月末对账引擎
├── public/               # 前端（原生 JS，无框架）
│   ├── index.html        # 主页面
│   ├── app.js            # 前端逻辑
│   ├── style.css         # 样式
│   └── lib/echarts.min.js
├── scripts/              # 数据初始化 + 验收测试
│   ├── seed-demo.js      # 幂等建库+种子数据
│   └── test-*.js         # 各功能验收脚本
├── data/                 # 配置文件
│   ├── ships.json        # 船名映射
│   ├── project-plan.json # 项目节点计划
│   ├── build-schedule.json # 建造周期表（预测用）
│   └── mailbox-seed.json # 虚构邮件线程
├── server.js             # Express 主服务
└── .env.example          # 环境变量模板
```

## 演示账号

| 用户名 | 密码 | 角色 | 视角差异 |
|--------|------|------|---------|
| caojie | demo1234 | 管理员 | 简报聚焦库存告急+近3天动态 |
| zhangwei | demo1234 | 队长 | 简报聚焦项目节点风险 |
| chenjun | demo1234 | 分析员 | 简报聚焦呆滞物料+月度对比 |

## 安全设计

- **沙箱邮箱白名单硬编码**：SMTP 发送函数内 `if (recipient !== 'yuanyangdemo@163.com') throw`，代码级拒绝任何其他收件人，不可通过配置绕过
- **全虚构脱敏数据宇宙**：船舶（远洋01/02）、供应商（蓝海阀门等）、人员均为虚构，详见 [DEMO_DATA.md](DEMO_DATA.md)
- **无真实客户信息**：邮件线程仅读取 `data/mailbox-seed.json` 虚构数据
- **API Key 仅从 .env 读取**：.env 已加入 .gitignore，绝不入库

---

📖 详细操作指南请阅读 [docs/USER_MANUAL.md](docs/USER_MANUAL.md)
