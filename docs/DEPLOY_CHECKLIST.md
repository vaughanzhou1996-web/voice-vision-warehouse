# 部署检查清单 (Deploy Checklist)

> 面向运维/操作人员的逐步部署指南。每一步完成后打 ✓。

---

## 前置条件

- [ ] Node.js ≥ 18 已安装
- [ ] PostgreSQL 14+ 运行中
- [ ] `.env` 文件已配置（参考 `.env.example`）
- [ ] 数据库 `inventory_demo` 已创建
- [ ] 端口 8001 未被占用（线上 demo 端口）

---

## 部署步骤

### 1. 代码准备

- [ ] `git checkout contest-p0-0731`
- [ ] `git log --oneline -1` 确认 HEAD 正确
- [ ] `npm ci` 安装依赖（干净安装）

### 2. 数据库初始化

- [ ] 确认 `.env` 中 `DATABASE_URL` 指向正确数据库
- [ ] 首次部署: `node scripts/seed-demo.js`
- [ ] 验证: `psql $DATABASE_URL -c "SELECT count(*) FROM products;"` ≥ 40

### 3. 启动服务

- [ ] `npm start`
- [ ] 控制台输出 `listening on 0.0.0.0:8001`
- [ ] 无报错堆栈

> **线上部署信息（2026-07-31 20:43）**
> - 服务器：139.224.228.185（admin）
> - 路径：/home/admin/inventory-demo
> - 端口：8001
> - 数据库：inventory_demo (PostgreSQL 15.18 @ 127.0.0.1:5432)
> - commit：a0c77d0 (contest-p0-0731)

### 4. 冒烟验证（只读）

- [ ] `npm run smoke`
- [ ] 全部 ✅，exit 0
- [ ] 首页 http://localhost:8000 可访问
- [ ] 手机 UA 访问跳转 mobile.html

### 5. 功能验证（可选，会写数据）

- [ ] `npm run test:api`
- [ ] `npm run test:safety`
- [ ] 测试后执行 `node scripts/reset-demo.js` 恢复数据

### 6. 数据完整性确认

- [ ] 登录 caojie / demo1234 成功
- [ ] YY01 库存 ≥ 40 种
- [ ] YY01 节点 = 8 个
- [ ] 历史单据 ≥ 7 条
- [ ] `/api/version` 返回 `v1.0-demo`

---

## 回滚方案

| 情况 | 操作 |
|------|------|
| 数据异常 | `node scripts/reset-demo.js` |
| 代码问题 | `git checkout a0c77d0 && npm start` |
| 数据库损坏 | `dropdb inventory_demo && createdb inventory_demo && node scripts/seed-demo.js` |

---

## 演示前最终检查

- [ ] 浏览器打开首页，桌面版正常渲染
- [ ] 手机模拟器打开，移动版正常渲染
- [ ] 切换 YY01/YY02 均正常
- [ ] AI 报告可生成（需 Qwen API Key 有效）
- [ ] 断料预测有红灯项
- [ ] 出库防呆：超额出库被拒绝
- [ ] 跨船隔离：YY01 token 无法访问 YY02 数据

---

## 注意事项

1. **演示期间禁止** 执行 `reset-demo.js`（除非数据已损坏）
2. **AI 功能** 依赖外网 Qwen API，确保网络通畅
3. **并发** 演示时避免多人同时出库同一产品
4. **备份** 演示前执行 `pg_dump inventory_demo > backup_$(date +%Y%m%d).sql`
