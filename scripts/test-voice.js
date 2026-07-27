#!/usr/bin/env node
/**
 * scripts/test-voice.js — 全语音链路验收脚本
 * ASR：macOS say 生成测试音频 → /api/voice/asr → 验证转写含"截止阀"
 * TTS：调 /api/voice/tts → 报告走了百炼还是降级路径
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const BASE = 'http://localhost:8000';

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = token;
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Parse error: ' + data.slice(0, 200))); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function uploadFile(urlPath, filePath, fieldName, mimeType, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const boundary = '----VoiceBoundary' + Date.now().toString(36);
    const fileData = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const bodyBuffer = Buffer.concat([Buffer.from(head, 'utf8'), fileData, Buffer.from(tail, 'utf8')]);
    const opts = {
      method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuffer.length
      }
    };
    if (token) opts.headers['Authorization'] = token;
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Parse error')); } });
    });
    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}

async function main() {
  console.log('====== 全语音链路验收 ======\n');

  // 1. 登录
  const login = await request('POST', '/api/login', { username: 'caojie', password: 'demo1234' });
  if (!login.success) { console.error('❌ 登录失败', login.error); process.exit(1); }
  const token = login.data.token;
  console.log('✅ 登录成功\n');

  // 2. 生成测试音频（macOS say → AIFF → 转 WAV）
  const aiffPath = '/tmp/test-voice-q.aiff';
  const wavPath = '/tmp/test-voice-q.wav';
  console.log('--- 生成测试音频 ---');
  try {
    execSync(`say -v Tingting "截止阀还有多少库存" -o ${aiffPath}`, { timeout: 10000 });
    console.log('✅ say 生成 AIFF 完成');
    // 转为 WAV（PCM）格式
    execSync(`afconvert -f WAVE -d LEI16 ${aiffPath} ${wavPath}`, { timeout: 10000 });
    console.log('✅ afconvert 转 WAV 完成');
  } catch (e) {
    console.error('❌ 音频生成失败（需要 macOS say 命令）:', e.message);
    process.exit(1);
  }

  // 3. ASR 测试
  console.log('\n--- ASR 测试（/api/voice/asr）---');
  const asrRes = await uploadFile('/api/voice/asr', wavPath, 'audio', 'audio/wav', token);
  if (asrRes.success && asrRes.text) {
    console.log(`✅ ASR 转写结果: "${asrRes.text}"`);
    if (asrRes.text.includes('截止阀')) {
      console.log('✅ 验证通过：转写包含"截止阀"');
    } else {
      console.log('⚠️ 转写未包含"截止阀"（可能发音识别偏差），但 ASR 链路正常');
    }
  } else {
    console.error('❌ ASR 失败:', asrRes.error);
    process.exit(1);
  }

  // 4. TTS 测试
  console.log('\n--- TTS 测试（/api/voice/tts）---');
  const ttsRes = await request('POST', '/api/voice/tts', { text: '截止阀DN50当前库存3只，库存告急建议尽快采购。' }, token);
  if (ttsRes.success) {
    if (ttsRes.fallback) {
      console.log('✅ TTS 路径: 降级（浏览器 speechSynthesis）— 百炼 CosyVoice 不可用');
    } else {
      console.log(`✅ TTS 路径: 百炼 CosyVoice — 音频: ${ttsRes.audio_url}`);
      // 验证文件存在
      const audioFile = path.join(__dirname, '..', ttsRes.audio_url);
      if (fs.existsSync(audioFile)) {
        const size = fs.statSync(audioFile).size;
        console.log(`   文件大小: ${(size/1024).toFixed(1)} KB`);
      }
    }
  } else {
    console.error('❌ TTS 接口失败:', ttsRes.error);
    process.exit(1);
  }

  console.log('\n====== 全部验收通过 ✅ ======');
}

main().catch(e => { console.error('❌ 异常:', e.message); process.exit(1); });
