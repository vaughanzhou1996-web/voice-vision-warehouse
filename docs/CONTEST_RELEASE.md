# 竞赛版本发布说明 (Contest Release)

## 基线信息

| 项目 | 值 |
|------|-----|
| 基线 commit | `52e084e` (tag: v1.0-demo) |
| 分支 | `contest-p0-0731` |
| 版本号 | v1.0-demo |
| 竞赛船舶 | YY01 (远洋01) / YY02 (远洋02) |

---

## 核心 API 清单

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/inventory` | GET | 库存总览 |
| `/api/products/:pid/history` | GET | 产品出入库历史 |
| `/api/inbound` | POST | 单条入库 |
| `/api/inbound/batch` | POST | 批量入库 |
| `/api/outbound` | POST | 单条出库 |
| `/api/outbound/batch` | POST | 批量出库 |
| `/api/documents` | GET | 历史单据 |
| `/api/notes/:productId` | GET/POST | 产品备注 |
| `/api/changelog` | GET | 操作日志 |
| `/api/dashboard/report` | GET | AI 报告 |
| `/api/forecast` | GET | 断料预测 |
| `/api/milestones` | GET | 项目节点 |
| `/api/analysis` | GET | 联动分析 |
| `/api/analysis/forecast` | GET | 分析预测 |
| `/api/select-ship` | POST | 切换船舶 |
| `/api/ships/stats` | GET | 船舶统计 |
| `/api/version` | GET | 版本信息 |
| `/api/inbound/list` | GET | 入库记录列表 |
| `/api/outbound/list` | GET | 出库记录列表 |
| `/api/rollback` | POST | 操作回滚 |
| `/api/demo/reset` | POST | 演示数据重置 |
| `/api/briefing` | GET | 每日简报 |

---

## 演示数据不变量

来源: `DEMO_DATA.md` + `scripts/seed-demo.js`

- 船舶: YY01 / YY02
- 用户: caojie(admin) / zhangwei(leader) / chenjun(analyst) / hezong(boss)
- 密码: `demo1234`
- YY01 备件品种 ≥ 40 种
- YY01 项目节点 = 8 个（含"试航" planned_date=2026-09-15）
- 历史单据 ≥ 7 条（含 SVG 图片）
- 入库/出库记录 ≥ 100 条（近 90 天）
- 库存告急 (< 3) ≥ 5 种
- 呆滞物料 (30天未出库) ≥ 5 种
- 供应商: 5 家虚构

---

## AI vs 确定性逻辑边界

| 功能 | 类型 | 说明 |
|------|------|------|
| 断料预测 (`/api/forecast`) | 确定性 | 基于消耗速率 + 库存计算，不调用 LLM |
| AI 报告 (`/api/dashboard/report`) | AI (Qwen) | 调用大模型生成，有缓存 |
| 单据识别 (`/api/recognize`) | AI (Qwen VL) | 图片→结构化，有缓存 |
| 联动分析 (`/api/analysis`) | 确定性 | 节点 + 库存 + 预测组合 |
| 搜索/过滤 | 确定性 | 前端 + SQL |
| 出入库/回滚 | 确定性 | 事务性 SQL |

---

## 禁止操作（竞赛期间）

- ❌ 修改 `data/` 目录下的种子数据文件
- ❌ 直接操作生产数据库（必须通过 API）
- ❌ 调用 `/api/demo/reset` 后不验证数据完整性
- ❌ 修改 `.env` 中的数据库连接串
- ❌ 在演示期间执行 `DROP` / `TRUNCATE` / `DELETE` SQL
- ❌ 更改船舶编号 (YY01/YY02) 或用户角色

---

## 恢复点

| 场景 | 恢复方式 |
|------|----------|
| 数据被测试污染 | `POST /api/demo/reset` 或 `node scripts/reset-demo.js` |
| 服务崩溃 | `npm start` (自动重连 PG) |
| 数据库丢失 | `node scripts/seed-demo.js` 重建全部种子数据 |
| 代码回退 | `git checkout 52e084e` |

---

## 验收标准

### 本地验收

```bash
# 1. 启动服务
npm start

# 2. 全功能 E2E
npm run test:api

# 3. 安全回归
npm run test:safety

# 4. 只读 Smoke
npm run smoke
```

全部通过 (exit 0) 即为本地验收通过。

### 线上验收

```bash
# 只读 Smoke（不写数据）
node scripts/smoke-demo.js https://<线上地址>
```

- 所有 ✅，exit 0
- 响应时间 < 3000ms（单项）
- 版本号返回 `v1.0-demo`
