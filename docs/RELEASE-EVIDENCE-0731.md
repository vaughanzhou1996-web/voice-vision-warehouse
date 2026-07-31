# 发布证据 · a0c77d0 · 2026-07-31

## 1. 线上代码版本证据
- 服务器 server.js md5: 797c5a6101036c9c7a20146bf3dedc34
- 服务器 public/app.js md5: 30b5b4cee9bf8dc904ad8649166926c8
- /api/version 返回: v1.0-demo (commit a0c77d0, deployed_at 2026-08-01T01:00:17+08:00)
- 部署时间: 2026-08-01 01:00
- 部署 commit: a0c77d0 (contest-p0-0731)
- 部署位置: /home/admin/inventory-demo (端口 8001)

## 2. 数据库备份位置
- 数据库: inventory_demo (PostgreSQL 15.18 @ 127.0.0.1:5432)
- pg_dump 13 与 server 15 版本不兼容，备份方式：
  dblink 跨库 COPY（详见 scripts/backup-demo.sql）
- 最新备份: 2026-07-31（克隆 inventory DB 时已建表+复制）

## 3. 服务重启命令
```bash
ssh admin@139.224.228.185 "kill -9 \$(ss -tlnp | grep :8001 | grep -oP 'pid=\d+'); cd /home/admin/inventory-demo && PORT=8001 nohup node server.js > /tmp/inventory8001.log 2>&1 &"
```

## 4. 回滚命令
```bash
# 回滚到 52e084e (上一个稳定版本):
ssh admin@139.224.228.185 "cd /home/admin/inventory-demo && git checkout 52e084e -- server.js public/app.js public/index.html && kill -9 \$(ss -tlnp | grep :8001 | grep -oP 'pid=\d+') && PORT=8001 nohup node server.js > /tmp/inventory8001.log 2>&1 &"
```

## 5. 上线前/后 Smoke 对比
- 上线前（无 a0c77d0）: ships/stats 返回 []，顾问标"待修复"
- 上线后（a0c77d0 + 卡 23 鉴权修复）: ships/stats 返回 2 张船卡片，YY01=56/YY02=41，1039+673 库存
- /api/version 返回 {commit, deployed_at, db_summary}
- 未选船访问 ?ship= → 400 "请先选择船舶"（鉴权漏洞已修复）
- 浏览器路径测试: 登录→选船→库存 0 JS 错

## 6. 测试分层说明

| 类别 | 范围 | 测试套件 | 环境 |
|------|------|----------|------|
| 线上只读 Smoke | 公网 demo 8001 | scripts/smoke-demo.js（13 项只读） | demo.uniocean.ltd |
| 隔离环境全量测试 | 本地 + 隔离 DB | test-e2e.js（58）+ test-card12.js（26）+ test-safety.js（15）+ test-forecast.js（5）= 104 项 | 本地 localhost:8000 + inventory_demo |

**严禁在公网 demo 跑 test-e2e.js / test-safety.js / test-card12.js**——它们会执行入库/出库/删除/重置写操作。

最终报告文案：
- "线上 smoke 13/13"
- "隔离环境全量 104/104"
- 不要混称为"线上全绿"

## 7. 已知性能点（不修）
- `/api/forecast` 平均 5.2 秒，超出 3 秒目标
- 原因：依赖 AI 模型思考时间（断料预测需要 AI 推理）
- 计划：赛后做缓存 + 后台预生成
- 本次发布可接受：演示时提前进入该页面，5 秒等待期间可同步介绍场景

## 8. 已知安全点（不修）
- `/api/register` 公开注册（参赛 demo 必需）
- 4 个账号统一密码 demo1234（评审可任意登录体验）
- `/api/demo/reset` 多角色可调（管理员角色 caojie/hezong）
- 限制：本次发布为参赛 demo，不作为生产系统运行
- 赛后必须做：限制重置权限 + 关闭公开注册 + bcrypt 哈希 + Token 过期
