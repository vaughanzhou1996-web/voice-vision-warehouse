/**
 * lib/qwen.js — 阿里云百炼 Qwen 模型调用模块
 * OpenAI 兼容模式: https://dashscope.aliyuncs.com/compatible-mode/v1
 * 
 * 导出:
 *   chatText(messages, options)   → qwen3-max-preview (文本对话)
 *   chatVision(messages, options) → qwen-vl-max (图片识别)
 *   speechToText(audio, mimeType) → qwen3-asr-flash (语音识别)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ====== 配置 ======
const BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const TEXT_MODEL = 'qwen3-max-preview';
const VISION_MODEL = 'qwen-vl-max';
const ASR_MODEL = 'qwen3-asr-flash';
const TIMEOUT = 60000; // 60s

function getApiKey() {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/DASHSCOPE_API_KEY=(\S+)/);
    if (m) return m[1];
  }
  throw new Error('DASHSCOPE_API_KEY 未配置，请在 .env 或环境变量中设置');
}

// ====== JSON 提取（健壮性处理）======
function extractJson(text) {
  if (!text) return text;
  // 去除 markdown 代码块包裹
  text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  // 如果以 { 开头直接返回
  if (text.trim().startsWith('{')) return text.trim();
  // 全文找 JSON 对象
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s > -1 && e > s) return text.substring(s, e + 1);
  return text;
}

// ====== 中文 key 标准化（兼容模型返回中文 JSON key）======
function normalizeJsonKeys(content) {
  return content
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
}

// ====== 核心调用（含一次重试）======
async function callQwen(model, messages, options = {}) {
  const apiKey = getApiKey();
  const body = {
    model,
    messages,
    max_tokens: options.max_tokens || 8192,
    temperature: options.temperature ?? 0.1,
  };

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await axios.post(`${BASE_URL}/chat/completions`, body, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: options.timeout || TIMEOUT,
      });
      const content = resp.data.choices?.[0]?.message?.content || '';
      const finishReason = resp.data.choices?.[0]?.finish_reason;
      console.log(`[Qwen] model=${model} finish=${finishReason} len=${content.length} attempt=${attempt}`);
      if (!content.trim() && attempt === 0) { lastError = new Error('空响应'); continue; }
      return content;
    } catch (e) {
      lastError = e;
      console.log(`[Qwen] attempt ${attempt} failed: ${e.response?.data?.error?.message || e.message}`);
      if (attempt === 0) continue; // 重试一次
    }
  }
  throw new Error('Qwen调用失败: ' + (lastError?.response?.data?.error?.message || lastError?.message));
}

// ====== 文本对话 ======
/**
 * @param {Array} messages - [{role:'system'|'user', text:'...'}]
 * @param {Object} options - {temperature, max_tokens, timeout, jsonMode}
 * @returns {string}
 */
async function chatText(messages, options = {}) {
  const msgs = messages.map(m => ({ role: m.role, content: m.text }));
  let content = await callQwen(TEXT_MODEL, msgs, options);
  if (options.jsonMode) {
    content = extractJson(content);
    content = normalizeJsonKeys(content);
  }
  return content;
}

// ====== 视觉识别 ======
/**
 * @param {Array} messages - [{role, text, image?}] image 为文件路径或 /uploads/ 相对路径
 * @param {Object} options
 * @returns {string}
 */
async function chatVision(messages, options = {}) {
  const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
  const msgs = [];
  for (const m of messages) {
    if (m.image) {
      const absPath = m.image.startsWith('/uploads/')
        ? path.join(UPLOAD_DIR, path.basename(m.image))
        : m.image;
      if (!fs.existsSync(absPath)) throw new Error('图片不存在: ' + absPath);
      const b64 = fs.readFileSync(absPath, { encoding: 'base64' });
      msgs.push({
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
          { type: 'text', text: m.text }
        ]
      });
    } else {
      msgs.push({ role: m.role, content: m.text });
    }
  }
  let content = await callQwen(VISION_MODEL, msgs, options);
  content = extractJson(content);
  content = normalizeJsonKeys(content);
  return content;
}

// ====== 语音识别 ======
/**
 * @param {string} audio - base64 音频数据
 * @param {string} mimeType - 音频格式 e.g. 'audio/webm'
 * @returns {string} 识别文本
 */
async function speechToText(audio, mimeType = 'audio/webm') {
  const apiKey = getApiKey();
  // DashScope 原生多模态 API（qwen3-asr-flash）
  const asrUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  const format = mimeType.replace('audio/', '').split(';')[0];
  const dataUri = `data:audio/${format};base64,${audio}`;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await axios.post(asrUrl, {
        model: ASR_MODEL,
        input: {
          messages: [{
            role: 'user',
            content: [{ audio: dataUri }]
          }]
        }
      }, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      });
      const text = resp.data?.output?.choices?.[0]?.message?.content?.[0]?.text || '';
      console.log(`[Qwen ASR] model=${ASR_MODEL} len=${text.length}`);
      return text;
    } catch (e) {
      lastError = e;
      console.log(`[Qwen ASR] attempt ${attempt} failed: ${e.response?.data?.message || e.message}`);
      if (attempt === 0) continue;
    }
  }
  throw new Error('语音识别失败: ' + (lastError?.response?.data?.message || lastError?.message));
}

module.exports = { chatText, chatVision, speechToText, extractJson, TEXT_MODEL, VISION_MODEL, ASR_MODEL };
