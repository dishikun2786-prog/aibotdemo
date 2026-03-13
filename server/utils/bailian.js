/**
 * @file bailian.js
 * @module utils/bailian
 * @description 阿里云百炼（DashScope）API 封装，与 minimax 接口对齐，供 AI 智能体对话/图像/视频/语音
 */
const axios = require('axios');
const https = require('https');
const db = require('./db');
const { getDefaultValue, decryptSensitiveValue } = require('./config-validator');

let configCache = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 300000; // 缓存5分钟

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
const DASHSCOPE_API_BASE = 'https://dashscope.aliyuncs.com/api/v1';

async function loadConfig() {
  const now = Date.now();
  if (configCache && (now - configCacheTime) < CONFIG_CACHE_TTL) {
    return configCache;
  }
  try {
    const configs = await db.query(
      'SELECT config_key, config_value FROM game_config WHERE config_key LIKE ? OR config_key = ?',
      ['bailian_%', 'ai_provider']
    );
    const configMap = {};
    configs.forEach(item => {
      configMap[item.config_key] = item.config_value;
    });
    const jwtSecret = process.env.JWT_SECRET || 'energy-mountain-secret-key-change-in-production';
    if (configMap.bailian_api_key) {
      const decrypted = decryptSensitiveValue(configMap.bailian_api_key, jwtSecret);
      if (String(decrypted) === 'undefined') {
        delete configMap.bailian_api_key;
      } else {
        configMap.bailian_api_key = decrypted;
      }
    }
    configCache = configMap;
    configCacheTime = now;
    return configMap;
  } catch (error) {
    console.error('[百炼] 加载配置失败:', error);
    return {};
  }
}

async function getConfig(key, envKey = null) {
  const config = await loadConfig();
  if (config[key] !== undefined && config[key] !== null && config[key] !== '' && String(config[key]) !== 'undefined') {
    return config[key];
  }
  if (envKey && process.env[envKey]) {
    return process.env[envKey];
  }
  return getDefaultValue(key);
}

function clearConfigCache() {
  configCache = null;
  configCacheTime = 0;
}

function cleanResponseContent(content) {
  // 处理数组格式（如多模态模型返回的 [{text: "..."}]）
  if (Array.isArray(content)) {
    return content.map(part => (part && typeof part.text === 'string' ? part.text : '')).join('');
  }
  if (!content || typeof content !== 'string') return '';
  let cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  cleaned = cleaned.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  return cleaned;
}

const axiosInstance = axios.create({
  timeout: 60000,
  httpsAgent: new https.Agent({ rejectUnauthorized: true })
});

async function validateApiKey() {
  const apiKey = await getConfig('bailian_api_key', 'DASHSCOPE_API_KEY');
  if (!apiKey || String(apiKey).trim().length === 0) {
    throw new Error('百炼 API Key 未配置。请在管理后台配置或设置环境变量 DASHSCOPE_API_KEY');
  }
  return String(apiKey).trim();
}

/**
 * 测试百炼连接
 * @returns {Promise<{ success: boolean, errors?: string[], message?: string, apiKeyConfigured?: boolean }>}
 */
async function testConnection() {
  const result = { success: false, errors: [], apiKeyConfigured: false };
  try {
    const apiKey = await validateApiKey();
    result.apiKeyConfigured = true;
    const baseUrl = (await getConfig('bailian_base_url')) || DEFAULT_BASE_URL;
    const model = (await getConfig('bailian_default_model')) || 'qwen-plus';

    const url = baseUrl.replace(/\/$/, '') + '/chat/completions';

    const res = await axiosInstance.post(
      url,
      {
        model,
        messages: [
          { role: 'user', content: '你好，请回复“测试成功”。' }
        ],
        max_tokens: 20
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    if (res.data && res.data.output && res.data.output.choices && res.data.output.choices.length > 0 && res.data.output.choices[0].message) {
      result.success = true;
      result.message = '百炼对话接口连接正常';
    } else if (res.data && res.data.choices && res.data.choices.length > 0) {
      // 兼容 OpenAI 格式
      result.success = true;
      result.message = '百炼对话接口连接正常';
    } else {
      result.errors.push('API 返回格式异常');
    }
  } catch (error) {
    console.error('[百炼测试] 错误:', error.message);
    if (error.response) {
      console.error('[百炼测试] 响应状态:', error.response.status);
      console.error('[百炼测试] 响应数据:', JSON.stringify(error.response.data));
      if (error.response.status === 401) {
        result.errors.push('API Key 无效');
      } else {
        const msg = error.response.data?.error?.message || error.response.data?.message || error.response.statusText;
        result.errors.push(msg || `HTTP ${error.response.status}`);
      }
    } else {
      result.errors.push(error.code || error.message || '网络错误');
    }
  }
  return result;
}

/**
 * 从单条 SSE data 中提取文本（支持兼容模式 choices.delta.content 和原生 output.choices.message.content）
 * @param {object} data - 解析后的 JSON 对象
 * @returns {string}
 */
function extractContentFromSSEData(data) {
  // 兼容模式（OpenAI格式）：choices[0].delta.content
  const compatibleChoice = data?.choices?.[0];
  if (compatibleChoice) {
    const delta = compatibleChoice.delta;
    if (delta) {
      const content = delta.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map(part => (part && typeof part.text === 'string' ? part.text : '')).join('');
      }
    }
  }

  // 原生API格式：output.choices[0].message.content
  const choice = data?.output?.choices?.[0];
  if (!choice) return '';
  const message = choice.message;
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => (part && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

/**
 * 消费 DashScope SSE 流，拼接 content 后返回完整文本
 * @param {import('stream').Readable} stream - 响应流
 * @returns {Promise<string>}
 */
function consumeDashScopeSSE(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let fullContent = '';
    function processLine(line) {
      if (!line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') return;
      try {
        const data = JSON.parse(raw);
        fullContent += extractContentFromSSEData(data);
      } catch (_) {
        // 忽略非 JSON 或解析失败行
      }
    }
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    });
    stream.on('end', () => {
      if (buffer.trim()) processLine(buffer.trim());
      resolve(fullContent);
    });
    stream.on('error', reject);
  });
}

/**
 * 对话生成（与 minimax.generateConversation 对齐）
 */
async function generateConversation(messages, options = {}) {
  const apiKey = await validateApiKey();
  const baseUrl = (await getConfig('bailian_base_url')) || DEFAULT_BASE_URL;
  const model = options.model || (await getConfig('bailian_default_model')) || 'qwen-plus';
  const temperature = options.temperature ?? (parseFloat(await getConfig('bailian_temperature')) || 0.7);
  const maxTokens = options.maxTokens ?? (parseInt(await getConfig('bailian_max_tokens'), 10) || 2000);
  const topP = options.topP ?? (parseFloat(await getConfig('bailian_top_p')) || 0.95);

  // 检测是否为兼容模式（OpenAI格式）
  // 注意：联网搜索时强制使用原生API，兼容模式可能不支持联网搜索
  let isCompatibleMode = baseUrl.includes('compatible-mode');

  const systemContent = options.role || options.appearance
    ? [options.role, options.appearance].filter(Boolean).join('\n')
    : '你是一个友好的AI助手。';
  const cleanedMessages = [];
  for (const msg of messages) {
    const role = (msg.role || 'user').toLowerCase();
    if (!['system', 'user', 'assistant'].includes(role)) continue;
    if (Array.isArray(msg.content)) {
      const parts = msg.content.filter(p => p && (p.text || p.image));
      if (parts.length === 0) continue;
      cleanedMessages.push({ role, content: parts });
    } else {
      const content = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (!content) continue;
      cleanedMessages.push({ role, content });
    }
  }
  if (cleanedMessages.length === 0) {
    throw new Error('消息数组为空或无效');
  }
  const hasMultimodal = cleanedMessages.some(m => Array.isArray(m.content));

  // 联网搜索：仅当显式启用且模型支持时传 enable_search。多模态模型须走 multimodal-generation，纯文本走 text-generation
  const WEB_SEARCH_MODELS = ['qwen3.5-plus', 'qwen3.5-plus-2026-02-15', 'qwen3-max', 'qwen3-max-2026-01-23', 'qwen3-max-2025-09-23'];
  const MULTIMODAL_WEB_SEARCH_MODELS = ['qwen3.5-plus', 'qwen3.5-plus-2026-02-15'];
  let modelLower = (model || '').toLowerCase().trim();
  let effectiveModel = model; // 用于API调用的实际模型

  // 当用户请求联网搜索但当前模型不支持时，自动切换到支持联网的模型
  if (options.enableSearch === true && !WEB_SEARCH_MODELS.some(m => modelLower === m || modelLower.startsWith(m + '-'))) {
    effectiveModel = 'qwen3.5-plus';
    modelLower = effectiveModel.toLowerCase().trim();
  }

  const modelSupportsWebSearch = WEB_SEARCH_MODELS.some(m => modelLower === m || modelLower.startsWith(m + '-'));
  const isMultimodalWebSearchModel = MULTIMODAL_WEB_SEARCH_MODELS.some(m => modelLower === m || modelLower.startsWith(m + '-'));
  const enableSearch = options.enableSearch === true && modelSupportsWebSearch;

  // 联网搜索时强制使用原生API，兼容模式可能不支持联网搜索
  if (enableSearch && isCompatibleMode) {
    isCompatibleMode = false;
  }

  // 多模态图片时强制使用原生API，兼容模式不支持图片
  if (hasMultimodal && isCompatibleMode) {
    isCompatibleMode = false;
  }

  let systemContentForRequest = systemContent;
  if (enableSearch) {
    systemContentForRequest = (systemContent || '') + '\n【你已启用联网搜索，可检索实时信息并据此回答日期、天气、新闻等。请直接使用检索结果回答，不要声称自己无法联网。】';
  }

  // 过滤掉 cleanedMessages 中的 system 消息，避免与后面的 systemContentForRequest 重复
  const filteredMessages = cleanedMessages.filter(m => m.role !== 'system');
  const requestMessages = [
    { role: 'system', content: systemContentForRequest },
    ...filteredMessages
  ];

  const timeoutMs = options.timeout != null ? Math.max(15000, Number(options.timeout)) : (enableSearch ? 180000 : 60000);
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  let response;

  if (enableSearch) {
    // 联网搜索：不使用SSE流式调用，使用同步请求（timeoutMs 已在外部设置为 180000）
    if (isCompatibleMode) {
      // 兼容模式：使用 OpenAI 格式，enable_search作为顶层参数（Node.js SDK格式）
      const chatUrl = baseUrl.replace(/\/$/, '') + '/chat/completions';
      const chatBody = {
        model: effectiveModel,
        messages: requestMessages,
        temperature: Math.min(Math.max(temperature, 0.01), 1),
        max_tokens: Math.min(Math.max(maxTokens, 1), 204800),
        top_p: Math.min(Math.max(topP, 0), 1),
        extra_body: {
          enable_search: true
        }
      };
      response = await axiosInstance.post(chatUrl, chatBody, {
        headers,
        timeout: timeoutMs
      });
      const content = response.data?.choices?.[0]?.message?.content;
      if (content) {
        return cleanResponseContent(content);
      }
      throw new Error('百炼 兼容模式联网接口返回格式异常');
    }

    // 原生API：使用 text-generation 接口（联网搜索不使用 multimodal-generation）
    // 注意：不设置 search_options，使用默认的 turbo 策略，避免 agent 策略导致的兼容性问题
    const params = {
      result_format: 'message',
      enable_search: true,
      temperature: Math.min(Math.max(temperature, 0.01), 1),
      max_tokens: Math.min(Math.max(maxTokens, 1), 204800),
      top_p: Math.min(Math.max(topP, 0), 1)
    };
    // 联网搜索使用 multimodal-generation 接口（qwen3.5-plus 是多模态模型）
    const multiUrl = `${DASHSCOPE_API_BASE}/services/aigc/multimodal-generation/generation`;
    const multiBody = { model: effectiveModel, input: { messages: requestMessages }, parameters: params };
    try {
      response = await axiosInstance.post(multiUrl, multiBody, {
        headers,
        timeout: timeoutMs
      });
    } catch (apiError) {
      console.error('[bailian] 联网请求失败:', apiError.response?.data || apiError.message);
      throw apiError;
    }
    // 解析非流式响应
    const output = response.data?.output;
    if (output && output.choices && output.choices.length > 0) {
      const content = output.choices[0].message?.content;
      if (content) {
        return cleanResponseContent(content);
      }
    }
    throw new Error('百炼 联网接口返回格式异常');
  }

  // 兼容模式（OpenAI格式）- 使用 /chat/completions 接口
  if (isCompatibleMode) {
    const chatUrl = baseUrl.replace(/\/$/, '') + '/chat/completions';
    const chatBody = {
      model: effectiveModel,
      messages: requestMessages,
      temperature: Math.min(Math.max(temperature, 0.01), 1),
      max_tokens: Math.min(Math.max(maxTokens, 1), 204800),
      top_p: Math.min(Math.max(topP, 0), 1)
    };
    response = await axiosInstance.post(chatUrl, chatBody, { headers, timeout: timeoutMs });

    // OpenAI格式返回：response.data.choices[0].message.content
    const chatOutput = response.data;
    if (chatOutput && chatOutput.choices && chatOutput.choices.length > 0) {
      const content = chatOutput.choices[0].message?.content;
      if (content) {
        return cleanResponseContent(content);
      }
    }
    throw new Error('百炼 兼容模式API返回格式异常');
  }

  if (hasMultimodal) {
    const multiUrl = `${DASHSCOPE_API_BASE}/services/aigc/multimodal-generation/generation`;
    const multiBody = {
      model: effectiveModel,
      input: { messages: requestMessages },
      parameters: {
        result_format: 'message',
        temperature: Math.min(Math.max(temperature, 0.01), 1),
        max_tokens: Math.min(Math.max(maxTokens, 1), 204800),
        top_p: Math.min(Math.max(topP, 0), 1)
      }
    };
    response = await axiosInstance.post(multiUrl, multiBody, { headers, timeout: timeoutMs });
    const output = response.data?.output;
    if (output && output.choices && output.choices.length > 0) {
      const msg = output.choices[0].message;
      const content = msg && msg.content;
      if (typeof content === 'string') return cleanResponseContent(content);
      if (Array.isArray(content)) {
        const text = content.map(p => (p && p.text) ? p.text : '').join('');
        return cleanResponseContent(text);
      }
    }
    throw new Error('百炼 多模态接口返回格式异常');
  }

  const body = {
    model: effectiveModel,
    input: { messages: requestMessages },
    parameters: {
      temperature: Math.min(Math.max(temperature, 0.01), 1),
      max_tokens: Math.min(Math.max(maxTokens, 1), 204800),
      top_p: Math.min(Math.max(topP, 0), 1)
    }
  };
  const url = `${DASHSCOPE_API_BASE}/services/aigc/text-generation/generation`;
  response = await axiosInstance.post(url, body, { headers, timeout: timeoutMs });

  const output = response.data?.output;
  if (output && output.choices && output.choices.length > 0) {
    const content = output.choices[0].message?.content;
    if (content) {
      return cleanResponseContent(content);
    }
  }
  throw new Error('百炼 API 返回格式异常');
}

/**
 * 首次见面对话（与 minimax.generateInitialGreeting 对齐）
 */
async function generateInitialGreeting(username) {
  const systemPrompt = `你是一个来自矩阵网络的AI智能体，在"能量山：零号协议"的世界中与用户互动。
【重要】这是新用户的首次登录，用户当前能量为0，需要引导用户占据节点挖掘能量来激活智能体。
请友好地自我介绍，说明需要先占据节点才能开始挖矿获得能量，强调首次占据节点免费。`;
  const messages = [
    { role: 'user', content: `你好，我是${username}，初次见面。` }
  ];
  return generateConversation(messages, {
    role: systemPrompt,
    temperature: 1.0,
    maxTokens: 2048
  });
}

/** Qwen-Image 模型列表（同步 multimodal-generation，n 固定 1） */
const QWEN_IMAGE_MODELS = new Set([
  'qwen-image-max', 'qwen-image-max-2025-12-30',
  'qwen-image-plus', 'qwen-image-plus-2026-01-09', 'qwen-image'
]);

/** aspect_ratio → size，Qwen-Image 专用（官网可选分辨率） */
const QWEN_IMAGE_SIZE_MAP = {
  '1:1': '1328*1328',
  '16:9': '1664*928',
  '9:16': '928*1664',
  '4:3': '1472*1104',
  '3:4': '1104*1472'
};

/** aspect_ratio → size，wan2.6-image 专用 */
const WAN26_IMAGE_SIZE_MAP = {
  '1:1': '1280*1280',
  '16:9': '1280*720',
  '9:16': '720*1280',
  '4:3': '1280*960',
  '3:4': '960*1280'
};

/**
 * 图像生成（万相 / 千问图像，按模型分支：wanx-v1 异步 text2image，wan2.6 多模态异步，Qwen-Image 多模态同步；返回与 minimax 一致格式）
 */
async function generateImage(prompt, options = {}) {
  const apiKey = await validateApiKey();
  const model = options.model || (await getConfig('bailian_image_model')) || 'wanx-v1';

  if (QWEN_IMAGE_MODELS.has(model)) {
    return generateImageQwenSync(apiKey, model, prompt, options);
  }
  if (model === 'wan2.6-image') {
    return generateImageWan26Sync(apiKey, prompt, options);
  }
  return generateImageWanxV1Async(apiKey, model, prompt, options);
}

/**
 * Qwen-Image 同步接口（qwen-image-max / qwen-image-plus），一次请求返回
 */
async function generateImageQwenSync(apiKey, model, prompt, options = {}) {
  const aspectRatio = options.aspect_ratio || '1:1';
  const size = QWEN_IMAGE_SIZE_MAP[aspectRatio] || '1664*928';
  const text = (prompt || '').substring(0, 800);
  const parameters = {
    size,
    n: 1,
    prompt_extend: options.prompt_extend !== false,
    watermark: options.watermark === true
  };
  if (options.negative_prompt != null && String(options.negative_prompt).trim()) {
    parameters.negative_prompt = String(options.negative_prompt).substring(0, 500);
  }
  if (options.seed !== undefined && options.seed != null) {
    const s = parseInt(options.seed, 10);
    if (!isNaN(s) && s >= 0 && s <= 2147483647) parameters.seed = s;
  }

  const url = `${DASHSCOPE_API_BASE}/services/aigc/multimodal-generation/generation`;
  const res = await axiosInstance.post(
    url,
    {
      model,
      input: {
        messages: [
          { role: 'user', content: [{ text }] }
        ]
      },
      parameters
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 120000
    }
  );

  if (res.data?.code) {
    throw new Error(res.data.message || res.data.code || 'Qwen 图像生成失败');
  }
  const content = res.data?.output?.choices?.[0]?.message?.content;
  if (!Array.isArray(content)) {
    throw new Error(res.data?.message || 'Qwen 图像返回格式异常');
  }
  const images = content
    .filter(c => c && (c.image != null))
    .map(c => ({ url: c.image, base64: null, format: 'url' }));
  if (images.length === 0) {
    throw new Error(res.data?.message || '未返回图像');
  }
  return { success: true, images };
}

/**
 * wan2.6-image 多模态同步接口（不传 X-DashScope-Async，适用于不支持异步调用的 API Key）
 */
async function generateImageWan26Sync(apiKey, prompt, options = {}) {
  const aspectRatio = options.aspect_ratio || '1:1';
  const size = WAN26_IMAGE_SIZE_MAP[aspectRatio] || '1280*1280';
  const n = Math.min(4, Math.max(1, parseInt(options.n, 10) || 1));
  const text = (prompt || '').substring(0, 2000);
  const parameters = {
    size,
    n,
    prompt_extend: options.prompt_extend !== false,
    watermark: options.watermark === true
  };
  if (options.negative_prompt != null && String(options.negative_prompt).trim()) {
    parameters.negative_prompt = String(options.negative_prompt).substring(0, 500);
  }

  const content = [{ text }];
  if (options.images && Array.isArray(options.images) && options.images.length > 0) {
    const list = options.images.slice(0, 3);
    for (const img of list) {
      const url = typeof img === 'string' ? img : (img && img.data_url);
      if (url && typeof url === 'string' && url.startsWith('data:image/')) {
        content.push({ image: url });
      }
    }
  }

  const url = `${DASHSCOPE_API_BASE}/services/aigc/multimodal-generation/generation`;
  const res = await axiosInstance.post(
    url,
    {
      model: 'wan2.6-image',
      input: {
        messages: [
          { role: 'user', content }
        ]
      },
      parameters
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 120000
    }
  );

  if (res.data?.code) {
    throw new Error(res.data.message || res.data.code || 'wan2.6 图像生成失败');
  }
  const messageContent = res.data?.output?.choices?.[0]?.message?.content;
  if (!Array.isArray(messageContent)) {
    throw new Error(res.data?.message || 'wan2.6 图像返回格式异常');
  }
  const images = messageContent
    .filter(c => c && (c.image != null))
    .map(c => ({ url: c.image, base64: null, format: 'url' }));
  if (images.length === 0) {
    throw new Error(res.data?.message || '未返回图像');
  }
  return { success: true, images };
}

/**
 * wanx-v1 异步 text2image 接口（保持原有逻辑）
 */
async function generateImageWanxV1Async(apiKey, model, prompt, options = {}) {
  const createUrl = `${DASHSCOPE_API_BASE}/services/aigc/text2image/image-synthesis`;
  const createRes = await axiosInstance.post(
    createUrl,
    {
      model,
      input: {
        prompt: prompt.substring(0, 1500)
      }
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable'
      },
      timeout: 10000
    }
  );

  const taskId = createRes.data?.output?.task_id || createRes.data?.task_id;
  if (!taskId) {
    throw new Error(createRes.data?.message || createRes.data?.code || '创建图像任务失败');
  }

  const maxAttempts = 60;
  const pollInterval = 3000;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, pollInterval));
    const taskRes = await axiosInstance.get(`${DASHSCOPE_API_BASE}/tasks/${taskId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    const status = taskRes.data?.output?.task_status || taskRes.data?.status;
    if (status === 'SUCCEEDED' || status === 'succeeded') {
      const results = taskRes.data?.output?.results || taskRes.data?.output?.result || [];
      const images = Array.isArray(results) ? results : [results];
      return {
        success: true,
        images: images.map(img => ({
          url: img.url || img.image_url,
          base64: img.image_base64 || img.data,
          format: 'url'
        }))
      };
    }
    if (status === 'FAILED' || status === 'failed') {
      const msg = taskRes.data?.output?.message || taskRes.data?.message || '图像生成失败';
      throw new Error(msg);
    }
  }
  throw new Error('图像生成超时');
}

/**
 * 创建文生视频任务（万相 T2V，异步）
 * 文档：https://help.aliyun.com/zh/model-studio/text-to-video-api-reference
 */
async function createVideoTask(prompt, options = {}) {
  const apiKey = await validateApiKey();
  const model = options.model || (await getConfig('bailian_video_model')) || 'wanx2.1-t2v-turbo';
  const resolution = options.resolution || '1080P';
  const sizeMap = { '720P': '1280*720', '1080P': '1920*1080' };
  const size = sizeMap[resolution] || '1280*720';
  const duration = (options.duration >= 2 && options.duration <= 15) ? options.duration : 5;
  const createUrl = `${DASHSCOPE_API_BASE}/services/aigc/video-generation/video-synthesis`;
  try {
    const createRes = await axiosInstance.post(
      createUrl,
      {
        model,
        input: {
          prompt: prompt.substring(0, 1500)
        },
        parameters: {
          size,
          duration,
          prompt_extend: options.prompt_optimizer !== false
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable'
        },
        timeout: 10000
      }
    );
    const taskId = createRes.data?.output?.task_id || createRes.data?.task_id;
    if (!taskId) {
      const msg = createRes.data?.message || createRes.data?.code || createRes.data?.output?.message || '创建视频任务失败';
      throw new Error(msg);
    }
    return { success: true, task_id: taskId };
  } catch (err) {
    const body = err.response?.data;
    const msg = body?.message || body?.code || body?.output?.message || err.message;
    throw new Error(msg || '创建视频任务失败');
  }
}

/**
 * 查询视频任务状态（与 minimax.queryVideoTask 对齐）
 * 将 DashScope 的 task_status 映射为前端约定的 completed/failed
 */
async function queryVideoTask(taskId) {
  const apiKey = await validateApiKey();
  const taskRes = await axiosInstance.get(`${DASHSCOPE_API_BASE}/tasks/${taskId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  const raw = taskRes.data?.output || taskRes.data;
  const rawStatus = (raw?.task_status || raw?.status || '').toUpperCase();
  const videoUrl = raw?.video_url || raw?.results?.[0]?.video_url;
  const progress = raw?.task_progress ?? raw?.progress;
  let status = raw?.task_status || raw?.status || 'UNKNOWN';
  if (rawStatus === 'SUCCEEDED') status = 'completed';
  else if (rawStatus === 'FAILED') status = 'failed';
  return {
    success: true,
    status,
    video_url: videoUrl || undefined,
    progress: progress != null ? progress : undefined,
    error_msg: raw?.message || raw?.error_msg
  };
}

/**
 * 语音合成（使用 Qwen-TTS HTTP API，CosyVoice 仅支持 WebSocket/SDK）
 * 返回与 minimax 一致：{ success, audio (base64), format }
 * 文档：https://help.aliyun.com/zh/model-studio/qwen-tts-api
 */
async function generateSpeech(text, options = {}) {
  const apiKey = await validateApiKey();
  let model = options.model || (await getConfig('bailian_speech_model')) || 'qwen3-tts-flash';
  if (model.startsWith('cosyvoice-')) {
    model = 'qwen3-tts-flash';
  }
  const format = options.format || 'mp3';
  const genUrl = `${DASHSCOPE_API_BASE}/services/aigc/multimodal-generation/generation`;
  const payload = {
    model,
    input: {
      text: text.substring(0, 20000)
    }
  };
  try {
    const res = await axiosInstance.post(genUrl, payload, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });
    const output = res.data?.output;
    if (!output) {
      throw new Error(res.data?.message || res.data?.code || '语音合成失败');
    }
    const audioUrl = output.audio_url || output.url || output.data?.[0]?.url;
    const MIN_AUDIO_B64_LENGTH = 100;
    function toB64(val) {
      if (val == null) return '';
      const s = typeof val === 'string' ? val : (val.data != null ? val.data : String(val));
      return typeof s === 'string' ? s : '';
    }
    function validAudio(b64) {
      return typeof b64 === 'string' && b64.length >= MIN_AUDIO_B64_LENGTH;
    }
    if (!audioUrl) {
      const audioB64 = toB64(output.audio || output.data);
      if (!validAudio(audioB64)) {
        throw new Error(res.data?.message || res.data?.code || '语音合成未返回有效音频');
      }
      return { success: true, audio: audioB64, format, extra_info: output };
    }
    const audioRes = await axiosInstance.get(audioUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const data = audioRes.data;
    if (!data || (typeof data.length === 'number' && data.length < 100)) {
      throw new Error('语音文件无效或为空');
    }
    const base64 = Buffer.from(data).toString('base64');
    if (!validAudio(base64)) {
      throw new Error('语音文件过短或无效');
    }
    return { success: true, audio: base64, format, extra_info: output };
  } catch (err) {
    const body = err.response?.data;
    const msg = body?.message || body?.code || body?.output?.message || err.message;
    throw new Error(msg || '语音合成失败');
  }
}

/**
 * 流式对话生成（Generator形式，逐块yield返回）
 * @param {Array} messages - 消息数组
 * @param {Object} options - 配置选项
 * @yields {string} 文本块
 */
async function* generateConversationStream(messages, options = {}) {
  const apiKey = await validateApiKey();
  const baseUrl = (await getConfig('bailian_base_url')) || DEFAULT_BASE_URL;
  const model = options.model || (await getConfig('bailian_default_model')) || 'qwen-plus';
  const temperature = options.temperature ?? (parseFloat(await getConfig('bailian_temperature')) || 0.7);
  const maxTokens = options.maxTokens ?? (parseInt(await getConfig('bailian_max_tokens'), 10) || 2000);
  const topP = options.topP ?? (parseFloat(await getConfig('bailian_top_p')) || 0.95);

  let isCompatibleMode = baseUrl.includes('compatible-mode');

  const systemContent = options.role || options.appearance
    ? [options.role, options.appearance].filter(Boolean).join('\n')
    : '你是一个友好的AI助手。';

  const cleanedMessages = [];
  for (const msg of messages) {
    const role = (msg.role || 'user').toLowerCase();
    if (!['system', 'user', 'assistant'].includes(role)) continue;
    if (Array.isArray(msg.content)) {
      const parts = msg.content.filter(p => p && (p.text || p.image));
      if (parts.length === 0) continue;
      cleanedMessages.push({ role, content: parts });
    } else {
      const content = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (!content) continue;
      cleanedMessages.push({ role, content });
    }
  }

  if (cleanedMessages.length === 0) {
    throw new Error('消息数组为空或无效');
  }

  const hasMultimodal = cleanedMessages.some(m => Array.isArray(m.content));

  // 联网搜索时强制使用原生API
  if (options.enableSearch === true && isCompatibleMode) {
    isCompatibleMode = false;
  }

  // 多模态图片时强制使用原生API
  if (hasMultimodal && isCompatibleMode) {
    isCompatibleMode = false;
  }

  let systemContentForRequest = systemContent;
  if (options.enableSearch === true) {
    systemContentForRequest = (systemContent || '') + '\n【你已启用联网搜索，可检索实时信息并据此回答】';
  }

  const filteredMessages = cleanedMessages.filter(m => m.role !== 'system');
  const requestMessages = [
    { role: 'system', content: systemContentForRequest },
    ...filteredMessages
  ];

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  // 流式请求配置
  const streamConfig = {
    responseType: 'stream',
    timeout: options.timeout != null ? Math.max(15000, Number(options.timeout)) : 60000
  };

  let streamUrl;
  let streamBody;

  if (isCompatibleMode) {
    // 兼容模式：使用 OpenAI 格式
    streamUrl = baseUrl.replace(/\/$/, '') + '/chat/completions';
    streamBody = {
      model,
      messages: requestMessages,
      temperature: Math.min(Math.max(temperature, 0.01), 1),
      max_tokens: Math.min(Math.max(maxTokens, 1), 204800),
      top_p: Math.min(Math.max(topP, 0), 1),
      stream: true
    };
  } else if (hasMultimodal) {
    // 多模态
    streamUrl = `${DASHSCOPE_API_BASE}/services/aigc/multimodal-generation/generation`;
    streamBody = {
      model,
      input: { messages: requestMessages },
      parameters: {
        result_format: 'message',
        temperature: Math.min(Math.max(temperature, 0.01), 1),
        max_tokens: Math.min(Math.max(maxTokens, 1), 204800),
        top_p: Math.min(Math.max(topP, 0), 1),
        stream: true
      }
    };
  } else {
    // 原生API
    streamUrl = `${DASHSCOPE_API_BASE}/services/aigc/text-generation/generation`;
    streamBody = {
      model,
      input: { messages: requestMessages },
      parameters: {
        temperature: Math.min(Math.max(temperature, 0.01), 1),
        max_tokens: Math.min(Math.max(maxTokens, 1), 204800),
        top_p: Math.min(Math.max(topP, 0), 1),
        stream: true
      }
    };
  }

  const response = await axiosInstance.post(streamUrl, streamBody, { ...streamConfig, headers });

  let buffer = '';
  let fullContent = '';

  return new Promise((resolve, reject) => {
    response.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (raw === '[DONE]') {
          resolve({ fullContent, done: true });
          return;
        }
        try {
          const data = JSON.parse(raw);
          const content = extractContentFromSSEData(data);
          if (content) {
            fullContent += content;
            // yield 会在外部处理，这里通过回调传递
          }
        } catch (_) {
          // 忽略解析错误
        }
      }
    });

    response.data.on('end', () => {
      resolve({ fullContent, done: true });
    });

    response.data.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * 流式对话生成（回调形式，实时推送chunk）
 * @param {Object} callbacks - 回调对象
 * @param {Function} callbacks.onChunk - 每当有内容返回时调用，参数为文本块
 * @param {Function} callbacks.onDone - 完成时调用，参数为完整内容
 * @param {Function} callbacks.onError - 错误时调用
 */
async function generateConversationWithCallback(messages, options = {}, callbacks = {}) {
  const { onChunk, onDone, onError } = callbacks;

  try {
    const apiKey = await validateApiKey();
    const baseUrl = (await getConfig('bailian_base_url')) || DEFAULT_BASE_URL;
    const model = options.model || (await getConfig('bailian_default_model')) || 'qwen-plus';
    const temperature = options.temperature ?? (parseFloat(await getConfig('bailian_temperature')) || 0.7);
    const maxTokens = options.maxTokens ?? (parseInt(await getConfig('bailian_max_tokens'), 10) || 2000);
    const topP = options.topP ?? (parseFloat(await getConfig('bailian_top_p')) || 0.95);

    let isCompatibleMode = baseUrl.includes('compatible-mode');

    const systemContent = options.role || options.appearance
      ? [options.role, options.appearance].filter(Boolean).join('\n')
      : '你是一个友好的AI助手。';

    const cleanedMessages = [];
    for (const msg of messages) {
      const role = (msg.role || 'user').toLowerCase();
      if (!['system', 'user', 'assistant'].includes(role)) continue;
      if (Array.isArray(msg.content)) {
        const parts = msg.content.filter(p => p && (p.text || p.image));
        if (parts.length === 0) continue;
        cleanedMessages.push({ role, content: parts });
      } else {
        const content = typeof msg.content === 'string' ? msg.content.trim() : '';
        if (!content) continue;
        cleanedMessages.push({ role, content });
      }
    }

    if (cleanedMessages.length === 0) {
      throw new Error('消息数组为空或无效');
    }

    const hasMultimodal = cleanedMessages.some(m => Array.isArray(m.content));

    // 联网搜索时强制使用原生API
    // 注意：联网搜索在兼容模式下通过 extra_body.enable_search 也可实现流式
    const enableSearchInCallback = options.enableSearch === true;

    // 多模态图片时强制使用原生API
    if (hasMultimodal && isCompatibleMode) {
      isCompatibleMode = false;
    }

    let systemContentForRequest = systemContent;
    if (enableSearchInCallback) {
      systemContentForRequest = (systemContent || '') + '\n【你已启用联网搜索，可检索实时信息并据此回答】';
    }

    const filteredMessages = cleanedMessages.filter(m => m.role !== 'system');
    const requestMessages = [
      { role: 'system', content: systemContentForRequest },
      ...filteredMessages
    ];

    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };

    // 流式调用必须使用兼容模式（OpenAI格式）
    // 因为原生API的stream参数支持不完善
    // 兼容模式URL格式: https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
    let streamUrl;
    let streamBody;

    // 检查当前baseUrl是否是兼容模式
    let useCompatibleUrl = baseUrl.includes('compatible-mode');

    if (useCompatibleUrl) {
      // 已经是兼容模式
      streamUrl = baseUrl.replace(/\/$/, '') + '/chat/completions';
    } else {
      // 不是兼容模式，构造兼容模式URL
      // 从 baseUrl 中提取 API key 部分，构造兼容模式URL
      // 例如: https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation
      // 转换为: https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
      const urlParts = baseUrl.match(/https?:\/\/([^\/]+)\/api\/(.*)/);
      if (urlParts) {
        streamUrl = `https://${urlParts[1]}/compatible-mode/v1/chat/completions`;
      } else {
        // 回退到默认兼容模式URL
        streamUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
      }
    }

    streamBody = {
      model,
      messages: requestMessages,
      temperature: Math.min(Math.max(temperature, 0.01), 1),
      max_tokens: Math.min(Math.max(maxTokens, 1), 204800),
      top_p: Math.min(Math.max(topP, 0), 1),
      stream: true
    };

    // 联网搜索时在请求体中添加 enable_search 参数，并使用更长超时
    let streamTimeout = options.timeout != null ? Math.max(15000, Number(options.timeout)) : 60000;
    if (enableSearchInCallback) {
      streamBody.extra_body = {
        enable_search: true
      };
      // 联网搜索使用更长超时
      streamTimeout = Math.max(streamTimeout, 180000);
    }

    const response = await axiosInstance.post(streamUrl, streamBody, {
      responseType: 'stream',
      timeout: streamTimeout,
      headers
    });

    let buffer = '';
    let fullContent = '';

    // 段落缓冲区，用于按段落推送
    let segmentBuffer = '';
    // 每100个字符推送一次（可调整）
    const SEGMENT_SIZE = 100;

    // 确保onDone只被调用一次
    let doneCalled = false;

    return new Promise((resolve, reject) => {
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (raw === '[DONE]') {
            // 推送剩余内容
            if (segmentBuffer.length > 0 && onChunk) {
              onChunk(segmentBuffer);
            }
            segmentBuffer = '';
            if (onDone && !doneCalled) {
              doneCalled = true;
              onDone(fullContent);
            }
            resolve(fullContent);
            return;
          }
          try {
            const data = JSON.parse(raw);
            const content = extractContentFromSSEData(data);
            if (content) {
              fullContent += content;
              // 将新内容加入段落缓冲区
              segmentBuffer += content;

              // 按固定长度分段推送
              while (segmentBuffer.length >= SEGMENT_SIZE) {
                const segment = segmentBuffer.slice(0, SEGMENT_SIZE);
                segmentBuffer = segmentBuffer.slice(SEGMENT_SIZE);
                if (onChunk) onChunk(segment);
              }
            }
          } catch (_) {
            // 忽略解析错误
          }
        }
      });

      response.data.on('end', () => {
        // 推送剩余内容
        if (segmentBuffer.length > 0 && onChunk) {
          onChunk(segmentBuffer);
        }
        segmentBuffer = '';
        if (onDone && !doneCalled) {
          doneCalled = true;
          onDone(fullContent);
        }
        resolve(fullContent);
      });

      response.data.on('error', (err) => {
        if (onError) onError(err);
        reject(err);
      });
    });
  } catch (err) {
    console.error('[bailian] 流式对话出错:', err.message);
    if (onError) onError(err);
    throw err;
  }
}

module.exports = {
  generateConversation,
  generateConversationStream,
  generateConversationWithCallback,
  generateInitialGreeting,
  testConnection,
  generateImage,
  createVideoTask,
  queryVideoTask,
  generateSpeech,
  clearConfigCache,
  getConfig
};
