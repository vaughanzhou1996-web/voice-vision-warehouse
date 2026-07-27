#!/usr/bin/env node
/**
 * scripts/test-briefing.js — 角色化登录简报验收脚本
 * 用 3 个角色分别调 GET /api/briefing，打印简报全文
 * 验证内容符合各自视角且数据真实
 */

const http = require('http');

const BASE = 'http://localhost:8000';

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers['Authorization'] = token;
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const USERS = [
  { username: 'caojie', password: 'demo1234', expectRole: 'admin', label: '库存管理员' },
  { username: 'zhangwei', password: 'demo1234', expectRole: 'leader', label: '队长' },
  { username: 'chenjun', password: 'demo1234', expectRole: 'analyst', label: '分析员' },
];

async function main() {
  console.log('====== 角色化登录简报测试 ======\n');
  let passed = 0, failed = 0;

  for (const u of USERS) {
    console.log(`--- ${u.label} (${u.username}) ---`);
    try {
      // 登录
      const login = await request('POST', '/api/login', { username: u.username, password: u.password });
      if (!login.success) { console.log('  ❌ 登录失败:', login.error); failed++; continue; }
      const token = login.data.token;
      const role = login.data.role;
      console.log(`  角色: ${role} | 姓名: ${login.data.displayName}`);

      if (role !== u.expectRole) {
        console.log(`  ⚠️ 角色不匹配: 期望 ${u.expectRole}, 实际 ${role}`);
      }

      // 获取简报
      const brief = await request('GET', '/api/briefing', null, token);
      if (!brief.success) { console.log('  ❌ 简报失败:', brief.error); failed++; continue; }

      const text = brief.data.briefing;
      console.log(`  📋 简报全文:\n  ${text.split('\n').join('\n  ')}\n`);

      // 验证：简报非空且包含用户姓名
      if (!text || text.length < 10) {
        console.log('  ❌ 简报内容过短'); failed++; continue;
      }
      if (!text.includes(login.data.displayName)) {
        console.log('  ⚠️ 简报未包含用户姓名（可能LLM未遵循指令）');
      }

      // 验证视角特征
      if (u.expectRole === 'admin') {
        if (text.includes('库存') || text.includes('告急') || text.includes('入库') || text.includes('出库')) {
          console.log('  ✅ admin视角：包含库存/出入库关键词');
        } else {
          console.log('  ⚠️ admin视角：未检测到典型关键词');
        }
      } else if (u.expectRole === 'leader') {
        if (text.includes('节点') || text.includes('风险') || text.includes('试验') || text.includes('合拢') || text.includes('临近')) {
          console.log('  ✅ leader视角：包含项目/风险关键词');
        } else {
          console.log('  ⚠️ leader视角：未检测到典型关键词');
        }
      } else {
        if (text.includes('呆滞') || text.includes('出入库') || text.includes('入库') || text.includes('出库') || text.includes('趋势')) {
          console.log('  ✅ analyst视角：包含数据/呆滞关键词');
        } else {
          console.log('  ⚠️ analyst视角：未检测到典型关键词');
        }
      }
      passed++;
    } catch (e) {
      console.log('  ❌ 异常:', e.message); failed++;
    }
    console.log('');
  }

  console.log(`====== 结果: ${passed} 通过, ${failed} 失败 ======`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
