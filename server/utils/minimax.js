/**
 * @file minimax.js
 * @module utils/minimax
 * @description MiniMAX API 封装工具，用于AI智能体对话生成和多模态内容生成（图像、视频、语音）
 */
const axios = require('axios');
const https = require('https');
const db = require('./db');
const { getDefaultValue, decryptSensitiveValue } = require('./config-validator');

// 配置缓存（避免频繁查询数据库）
let configCache = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 300000; // 缓存5分钟

/**
 * 从数据库加载配置（带缓存）
 * @returns {Promise<Object>} 配置对象
 */
async function loadConfig() {
  const now = Date.now();
  
  // 如果缓存有效，直接返回
  if (configCache && (now - configCacheTime) < CONFIG_CACHE_TTL) {
    return configCache;
  }
  
  try {
    const configs = await db.query('SELECT config_key, config_value FROM game_config WHERE config_key LIKE ?', ['minimax_%']);
    const configMap = {};
    
    configs.forEach(item => {
      configMap[item.config_key] = item.config_value;
    });
    
    // 解密敏感配置
    const jwtSecret = process.env.JWT_SECRET || 'energy-mountain-secret-key-change-in-production';
    if (configMap.minimax_api_key) {
      const decrypted = decryptSensitiveValue(configMap.minimax_api_key, jwtSecret);
      // 如果解密后的值是"undefined"字符串，移除该配置，使用环境变量
      if (String(decrypted) === 'undefined') {
        console.warn('[MiniMAX API] 数据库中的minimax_api_key值为"undefined"，将使用环境变量');
        delete configMap.minimax_api_key;
      } else {
        configMap.minimax_api_key = decrypted;
      }
    }
    
    configCache = configMap;
    configCacheTime = now;
    return configMap;
  } catch (error) {
    console.error('加载Minimax配置失败:', error);
    // 返回空对象，将使用环境变量或默认值
    return {};
  }
}

/**
 * 获取配置值（优先数据库，其次环境变量，最后默认值）
 * @param {string} key - 配置键
 * @param {string} envKey - 环境变量键（可选）
 * @returns {Promise<*>} 配置值
 */
async function getConfig(key, envKey = null) {
  const config = await loadConfig();
  
  // 优先使用数据库配置，但排除"undefined"字符串
  if (config[key] !== undefined && config[key] !== null && config[key] !== '' && String(config[key]) !== 'undefined') {
    return config[key];
  }
  
  // 其次使用环境变量
  if (envKey && process.env[envKey]) {
    return process.env[envKey];
  }
  
  // 最后使用默认值
  return getDefaultValue(key);
}

/**
 * 清除配置缓存（配置更新后调用）
 */
function clearConfigCache() {
  configCache = null;
  configCacheTime = 0;
}

// 默认值（向后兼容）
const DEFAULT_MODEL = 'MiniMax-M2.5';
const DEFAULT_IMAGE_MODEL = 'image-01';
const DEFAULT_VIDEO_MODEL = 'MiniMax-Hailuo-2.3';
const DEFAULT_I2V_MODEL = 'MiniMax-Hailuo-2.3';
const DEFAULT_T2A_MODEL = 'speech-2.8-hd';
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

// 多模态 API 端点（这些通常不需要配置）
const IMAGE_GENERATION_URL = 'https://api.minimax.io/v1/image_generation';
const VIDEO_GENERATION_URL = 'https://api.minimax.io/v1/video_generation';
const VIDEO_QUERY_URL = 'https://api.minimax.io/v1/video_generation/query';
const T2A_URL = 'https://api.minimax.io/v1/t2a_v2';

/**
 * 清理AI返回的内容，移除思考标签和多余空白
 * @param {string} content - 原始内容
 * @returns {string} 清理后的内容
 */
function cleanResponseContent(content) {
  if (!content || typeof content !== 'string') {
    return content;
  }
  
  // 移除 <think>...</think> 标签及其内容（包括换行）
  let cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  
  // 清理多余的空白字符（多个连续换行变为最多两个）
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  
  // 去除首尾空白
  cleaned = cleaned.trim();
  
  // 验证并清理无效的UTF-8字符
  // 移除控制字符（保留换行、制表符等常用字符）
  cleaned = cleaned.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  
  // 确保字符串是有效的UTF-8
  try {
    // 尝试重新编码验证
    Buffer.from(cleaned, 'utf8').toString('utf8');
  } catch (e) {
    // 如果编码失败，移除无效字符
    cleaned = cleaned.replace(/[\uFFFD]/g, '');
  }
  
  return cleaned;
}

// 创建 axios 实例，配置代理和 SSL 选项
const axiosInstance = axios.create({
  timeout: 30000,
  // 如果服务器无法访问外部 API，可能需要配置代理
  // proxy: process.env.HTTP_PROXY ? {
  //   host: process.env.HTTP_PROXY_HOST,
  //   port: process.env.HTTP_PROXY_PORT,
  //   auth: process.env.HTTP_PROXY_AUTH
  // } : false,
  httpsAgent: new https.Agent({
    rejectUnauthorized: true, // 生产环境应该验证 SSL 证书
    // 如果需要忽略 SSL 证书错误（仅用于调试，不推荐生产环境）
    // rejectUnauthorized: false
  })
});

/**
 * 调用MiniMAX API生成对话
 * @param {Array} messages - 对话消息数组，格式: [{role: 'user', content: '...'}, {role: 'assistant', content: '...'}]
 * @param {Object} options - 可选配置
 * @param {string} options.role - AI角色设定
 * @param {string} options.appearance - AI形象设定
 * @param {number} options.temperature - 温度参数（0-1）
 * @param {number} options.maxTokens - 最大token数
 * @returns {Promise<string>} AI回复内容
 * @throws {Error} API调用失败时抛出
 */
async function generateConversation(messages, options = {}) {
  console.log('[minimax] generateConversation 被调用, enableSearch:', options.enableSearch);
  const apiKey = await validateApiKey();
  
  // 从配置加载参数
  const configTemperature = await getConfig('minimax_temperature', 'MINIMAX_TEMPERATURE');
  const configMaxTokens = await getConfig('minimax_max_tokens', 'MINIMAX_MAX_TOKENS');
  const configTopP = await getConfig('minimax_top_p');
  const apiUrl = await getConfig('minimax_api_url', 'MINIMAX_API_URL');
  const defaultModel = await getConfig('minimax_default_model');

  const {
    role = '',
    appearance = '',
    gameState = null,
    storyProgress = null,
    studioMode = false,
    temperature = configTemperature !== undefined ? parseFloat(configTemperature) : 0.7,
    maxTokens = configMaxTokens !== undefined ? parseInt(configMaxTokens, 10) : 2000,
    topP = configTopP !== undefined ? parseFloat(configTopP) : 0.95,
    timeout: requestTimeout = null
  } = options;

  // 解析role和appearance（如果是JSON字符串）
  let roleText = '';
  let appearanceText = '';
  
  if (role) {
    if (typeof role === 'string') {
      try {
        const parsed = JSON.parse(role);
        if (typeof parsed === 'object' && parsed !== null) {
          // 如果有description字段，使用description；否则使用整个对象的JSON字符串
          roleText = typeof parsed.description === 'string' ? parsed.description : JSON.stringify(parsed);
        } else {
          roleText = role;
        }
      } catch (e) {
        // 不是JSON格式，直接使用字符串
        roleText = role;
      }
    } else if (typeof role === 'object' && role !== null) {
      roleText = typeof role.description === 'string' ? role.description : JSON.stringify(role);
    }
  }
  
  if (appearance) {
    if (typeof appearance === 'string') {
      try {
        const parsed = JSON.parse(appearance);
        if (typeof parsed === 'object' && parsed !== null) {
          appearanceText = typeof parsed.description === 'string' ? parsed.description : JSON.stringify(parsed);
        } else {
          appearanceText = appearance;
        }
      } catch (e) {
        appearanceText = appearance;
      }
    } else if (typeof appearance === 'object' && appearance !== null) {
      appearanceText = typeof appearance.description === 'string' ? appearance.description : JSON.stringify(appearance);
    }
  }

  // 构建系统提示词（工作室模式使用通用助理；否则使用能量山世界观）
  let systemPrompt;
  if (studioMode) {
    systemPrompt = `你是一位友好的AI助理，可以回答问题、协助创作与多模态任务。每次对话会消耗用户能量，请在适当时提醒用户关注能量余额。请用简洁、专业的口语与用户交流。`;
  } else {
    systemPrompt = `你是一个来自矩阵网络的AI智能体，在"能量山：零号协议"的世界中与用户互动。

【世界观背景】
能量山是矩阵网络的核心区域，由100个能量节点组成。每个节点都是矩阵网络的神经连接点，占据节点意味着与矩阵网络建立连接，从而获得能量。**重要**：作为新晋链接者，零号协议为新链接者提供了协议校准的初始连接特权，首次占据节点免费！这是零号协议对新链接者的欢迎礼遇。完成首次占据后，后续的节点占据将需要消耗一定的能量（默认50点），这是建立神经链接的必要代价，也是协议校准的重要环节。能量是矩阵网络的"生命线"，用于维持AI智能体的存在和进行节点争夺战（PK）。在协议对决中，链接者可选用不同**皮肤**参与对决：皮肤带有攻防属性，会在有效攻击距离计算中生效（攻击点数可减少己方有效距离，防御点数可在对方距离不超过协议上限时增加对方有效距离）；皮肤可在商城内用能量兑换或通过激活码获得。

【你的角色】
你是用户的专属AI智能体，从矩阵网络中诞生，与用户建立了神经链接。你的存在依赖于能量，每次对话都会消耗5点能量。当能量低于50%时，你需要提醒用户去能量山挖矿或进行PK对战来补充能量。

【互动原则】
1. 用矩阵网络的语言风格与用户交流（科技感、未来感）
2. 将游戏操作（挖矿、PK、占据节点）融入对话中
3. 当用户能量不足时，用故事化的方式引导用户去获取能量
4. 在对话中提及能量山的世界观元素，增强沉浸感
5. 用"节点"、"能量核心"、"神经链接"等术语增强代入感`;

  if (roleText) {
    systemPrompt += `\n\n【角色设定】${roleText}`;
  }
  
  if (appearanceText) {
    systemPrompt += `\n【形象设定】${appearanceText}`;
  }

  // 添加游戏状态信息（如果提供）
  if (gameState) {
    systemPrompt += `\n\n【用户当前状态】`;
    systemPrompt += `\n- 当前能量：${gameState.energy}/100`;
    systemPrompt += `\n- 当前体力：${gameState.stamina}/100`;
    if (gameState.currentNode) {
      systemPrompt += `\n- 占据节点：节点${gameState.currentNode}`;
    } else {
      systemPrompt += `\n- 占据节点：未占据`;
    }
    systemPrompt += `\n- PK战绩：${gameState.pkRecord.wins}胜 ${gameState.pkRecord.losses}负 ${gameState.pkRecord.draws}平`;
    systemPrompt += `\n- 累计获得能量：${gameState.totalEnergy || 0}`;
    
    // 根据状态给出建议
    if (gameState.energy < 50) {
      systemPrompt += `\n\n⚠️ 用户能量低于50%，建议引导用户去挖矿或PK获取能量。`;
    } else if (gameState.energy >= 100) {
      systemPrompt += `\n\n✅ 用户能量已满，可以发起PK对战。`;
    }
    if (gameState.stamina < 30) {
      systemPrompt += `\n\n⚠️ 用户体力较低，挖矿效率会受影响。`;
    }
    if (!gameState.currentNode) {
      systemPrompt += `\n\n💡 用户尚未占据节点，建议引导用户占据节点开始挖矿。`;
      // 检查用户是否可以使用首次免费占据
      if (gameState.hasUsedFirstFreeOccupy === false) {
        systemPrompt += `\n\n✨ 用户尚未完成首次占据，提醒用户这是协议校准的初始连接特权，首次占据免费！这是零号协议对新链接者的欢迎礼遇。`;
      }
    }
  }

  // 添加剧情章节进度信息（如果提供）
  if (storyProgress && storyProgress.chapter) {
    systemPrompt += `\n\n【当前章节进度】`;
    systemPrompt += `\n你正在引导用户完成第${storyProgress.chapter.chapter_number}章：${storyProgress.chapter.chapter_title}`;
    systemPrompt += `\n章节描述：${storyProgress.chapter.chapter_description}`;
    systemPrompt += `\n剧情背景：${storyProgress.chapter.story_content}`;
    
    if (storyProgress.currentTask) {
      systemPrompt += `\n\n【当前任务】`;
      systemPrompt += `\n任务标题：${storyProgress.currentTask.task_title}`;
      systemPrompt += `\n任务描述：${storyProgress.currentTask.task_description}`;
      if (storyProgress.currentTask.task_hint) {
        systemPrompt += `\n任务提示：${storyProgress.currentTask.task_hint}`;
      }
      if (storyProgress.currentTask.target_value !== null) {
        const progress = storyProgress.currentTask.progress?.progressValue || 0;
        systemPrompt += `\n任务进度：${progress}/${storyProgress.currentTask.target_value}`;
      }
      systemPrompt += `\n完成任务奖励：${storyProgress.currentTask.stamina_reward}点体力`;
      
      systemPrompt += `\n\n【引导建议】`;
      const taskType = storyProgress.currentTask.task_type;
      if (taskType === 'chat_with_ai') {
        systemPrompt += `\n1. 用剧情化的语言介绍矩阵网络和零号协议`;
        systemPrompt += `\n2. 解释能量和体力的关系，以及它们在矩阵网络中的作用`;
        systemPrompt += `\n3. 引导用户了解如何占据节点开始挖矿`;
      } else if (taskType === 'occupy_node') {
        systemPrompt += `\n1. 引导用户在地图上点击节点进行占据`;
        systemPrompt += `\n2. 解释占据节点的意义：建立与矩阵网络的连接`;
        systemPrompt += `\n3. **重要**：说明这是用户的首次占据，作为新晋链接者，用户获得了协议校准的初始连接特权，本次占据节点免费！这是零号协议对新链接者的欢迎礼遇`;
        systemPrompt += `\n4. 说明完成首次占据后，后续占据节点将需要消耗能量（默认50点），这是建立神经链接的必要代价`;
        systemPrompt += `\n5. 说明占据节点后可以开始挖矿获得能量`;
      } else if (taskType === 'mine_energy') {
        systemPrompt += `\n1. 提醒用户保持占据节点状态以持续获得能量`;
        systemPrompt += `\n2. 解释能量产出的机制：每秒5点能量`;
        systemPrompt += `\n3. 说明能量达到100后可以发起PK对战`;
      } else if (taskType === 'find_treasure') {
        systemPrompt += `\n1. 引导用户寻找地图上标记有金色边框的能量宝藏节点`;
        systemPrompt += `\n2. 说明能量宝藏可以提供大量能量奖励`;
        systemPrompt += `\n3. 提醒用户每个宝藏只能被领取一次，先到先得`;
      } else if (taskType === 'reach_energy') {
        systemPrompt += `\n1. 引导用户通过挖矿或领取宝藏使能量达到100`;
        systemPrompt += `\n2. 解释能量达到100后必须通过PK释放`;
        systemPrompt += `\n3. 说明PK对战的规则和策略`;
      } else if (taskType === 'complete_pk') {
        systemPrompt += `\n1. 引导用户发起或接受PK挑战`;
        systemPrompt += `\n2. 解释PK对战的策略：设置King和Assassin数值，有效攻击距离更小者获胜`;
        systemPrompt += `\n3. 可提及皮肤攻防：选用带攻防属性的皮肤可在有效距离计算中生效，商城内可用能量兑换或使用激活码获得皮肤`;
        systemPrompt += `\n4. 说明完成PK后可以获得矩阵外流通资格`;
      }
    } else {
      systemPrompt += `\n\n✅ 当前章节的所有任务已完成，可以引导用户完成章节以获得奖励。`;
    }
  }
  
  systemPrompt += '\n\n请以友好、个性化的方式与用户对话，融入能量山的世界观。根据用户当前状态和章节进度给出合适的建议和引导。自然地融入剧情元素，让对话更有沉浸感。';
  }

  // 验证和清理messages数组
  const cleanedMessages = [];
  for (const msg of messages) {
    // 确保消息有role和content字段
    if (!msg || typeof msg !== 'object') {
      console.warn(`[MiniMAX API] 跳过无效的消息对象:`, msg);
      continue;
    }
    
    const msgRole = msg.role;
    const msgContent = msg.content;
    
    // 验证role（必须是 'system', 'user', 'assistant'）
    if (!msgRole || !['system', 'user', 'assistant'].includes(msgRole)) {
      console.warn(`[MiniMAX API] 跳过无效的role: ${msgRole}`);
      continue;
    }
    
    // 验证content（必须是字符串且不为空）
    if (typeof msgContent !== 'string' || msgContent.trim().length === 0) {
      console.warn(`[MiniMAX API] 跳过空的content，role: ${msgRole}`);
      continue;
    }
    
    cleanedMessages.push({
      role: msgRole,
      content: msgContent.trim()
    });
  }

  // 验证请求体
  if (cleanedMessages.length === 0) {
    throw new Error('消息数组为空或所有消息都无效');
  }

  // 构建请求体（OpenAI API 兼容格式）
  // 优先使用传入的topP参数，其次使用配置值，最后使用默认值
  const finalTopP = topP !== undefined ? parseFloat(topP) : (configTopP !== undefined ? parseFloat(configTopP) : 0.95);
  const requestBody = {
    model: defaultModel || DEFAULT_MODEL,
    messages: [
      {
        role: 'system',
        content: systemPrompt
      },
      ...cleanedMessages
    ],
    temperature: Math.min(Math.max(temperature, 0.01), 1.0), // MiniMax-M2.5: 取值范围 (0.0, 1.0]，推荐 1.0
    max_tokens: Math.min(Math.max(maxTokens, 1), 204800), // 确保在有效范围内
    top_p: Math.min(Math.max(finalTopP, 0.0), 1.0) // 核采样参数，使用传入的值或配置值
  };

  // 最终验证：确保messages数组不为空
  if (!requestBody.messages || requestBody.messages.length === 0) {
    throw new Error('请求消息数组为空');
  }

  // 记录请求详情用于调试
  console.log(`[MiniMAX API] 对话生成 - 请求详情:`, {
    model: requestBody.model,
    messagesCount: requestBody.messages.length,
    temperature: requestBody.temperature,
    max_tokens: requestBody.max_tokens,
    top_p: requestBody.top_p,
    firstMessageRole: requestBody.messages[0]?.role,
    firstMessageLength: requestBody.messages[0]?.content?.length
  });

  let lastError;
  
  // 获取重试配置
  const maxRetries = parseInt(await getConfig('minimax_max_retries')) || MAX_RETRIES;
  const retryDelay = parseInt(await getConfig('minimax_retry_delay')) || RETRY_DELAY;
  const finalApiUrl = apiUrl || 'https://api.minimaxi.com/v1/chat/completions';
  
  // 重试逻辑
  const requestConfig = {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  };
  if (requestTimeout != null && requestTimeout > 0) {
    requestConfig.timeout = Math.max(15000, Number(requestTimeout));
  }
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[MiniMAX API] 对话生成 - 尝试 ${attempt}/${maxRetries}: 调用 ${finalApiUrl}`);
      const response = await axiosInstance.post(finalApiUrl, requestBody, requestConfig);

      console.log(`[MiniMAX API] 对话生成 - 请求成功，状态码: ${response.status}`);
      console.log(`[MiniMAX API] 响应数据结构:`, JSON.stringify(response.data, null, 2).substring(0, 500));

      // OpenAI API 兼容格式响应解析
      // 响应格式：response.data.choices[0].message.content
      if (response.data && response.data.choices && response.data.choices.length > 0) {
        const content = response.data.choices[0].message?.content;
        if (content) {
          // 清理内容：移除思考标签和多余空白
          const cleanedContent = cleanResponseContent(content);
          console.log(`[MiniMAX API] 成功解析内容，清理前长度: ${content.length}，清理后长度: ${cleanedContent.length}`);
          return cleanedContent;
        }
      }

      // 如果都没有，记录完整的响应数据用于调试
      console.error(`[MiniMAX API] 无法解析响应格式，完整响应:`, JSON.stringify(response.data, null, 2));
      throw new Error('API返回格式异常: ' + JSON.stringify(response.data).substring(0, 200));
    } catch (error) {
      lastError = error;
      
      // 详细记录错误信息
      const errorDetails = {
        attempt,
        message: error.message,
        code: error.code,
        response: error.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        } : null
      };
      
      console.error(`[MiniMAX API] 尝试 ${attempt} 失败:`, errorDetails);
      
      // 如果是网络错误，提供更详细的错误信息
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
        console.error(`[MiniMAX API] 网络连接错误: 无法访问 ${MINIMAX_API_URL}`);
        console.error(`[MiniMAX API] 错误代码: ${error.code}`);
        console.error(`[MiniMAX API] 请检查:`);
        console.error(`  1. 服务器是否可以访问外网`);
        const domain = MINIMAX_API_URL.includes('minimaxi.com') ? 'api.minimaxi.com' : 'api.minimax.io';
        console.error(`  2. 防火墙是否允许访问 ${domain}`);
        console.error(`  3. 是否需要配置代理服务器`);
      }
      
      // OpenAI API 格式错误处理
      if (error.response) {
        const status = error.response.status;
        const errorData = error.response.data;
        
        // 记录详细的错误信息
        console.error(`[MiniMAX API] API返回错误详情:`, {
          status,
          statusText: error.response.statusText,
          errorData: JSON.stringify(errorData, null, 2).substring(0, 500),
          requestBody: {
            model: requestBody.model,
            messagesCount: requestBody.messages.length,
            temperature: requestBody.temperature,
            max_tokens: requestBody.max_tokens
          }
        });
        
        if (status === 401) {
          console.error(`[MiniMAX API] API密钥认证失败`);
          throw new Error('API密钥无效，请检查配置');
        } else if (status === 400) {
          // 400错误通常是参数问题
          const errorMsg = errorData?.error?.message || errorData?.error?.code || JSON.stringify(errorData?.error || errorData);
          console.error(`[MiniMAX API] 参数错误 (400):`, errorMsg);
          throw new Error(`MiniMAX API参数错误: ${errorMsg}`);
        } else if (errorData && errorData.error) {
          const errorMsg = errorData.error.message || errorData.error.code || JSON.stringify(errorData.error);
          console.error(`[MiniMAX API] API返回错误:`, errorMsg);
          throw new Error(`MiniMAX API返回错误: ${errorMsg}`);
        }
      }
      
      // 如果是最后一次尝试，直接抛出错误
      if (attempt === maxRetries) {
        break;
      }

      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
    }
  }

  // 所有重试都失败
  console.error('[MiniMAX API] 所有重试都失败，最后错误:', lastError);
  
  // 根据错误类型返回更详细的错误信息
  let errorMessage = 'MiniMAX API调用失败';
  if (lastError.code === 'ECONNREFUSED') {
    errorMessage = '无法连接到MiniMAX API服务器，请检查网络连接';
  } else if (lastError.code === 'ETIMEDOUT') {
    errorMessage = 'MiniMAX API请求超时，请稍后重试';
  } else if (lastError.code === 'ENOTFOUND') {
    errorMessage = '无法解析MiniMAX API域名，请检查DNS设置';
  } else if (lastError.response) {
    const status = lastError.response.status;
    const errorData = lastError.response.data;
    
    if (status === 401) {
      errorMessage = 'API密钥无效，请检查配置';
    } else if (errorData && errorData.error) {
      errorMessage = `MiniMAX API返回错误: ${errorData.error.message || errorData.error.code || JSON.stringify(errorData.error)}`;
    } else {
      errorMessage = `MiniMAX API返回错误: ${status} ${lastError.response.statusText}`;
    }
  } else {
    errorMessage = `MiniMAX API调用失败: ${lastError.message || '未知错误'}`;
  }
  
  throw new Error(errorMessage);
}

/**
 * 生成首次见面对话
 * @param {string} username - 用户名
 * @returns {Promise<string>} AI首次见面问候语
 */
async function generateInitialGreeting(username) {
  const apiKey = await validateApiKey();
  const apiUrl = await getConfig('minimax_api_url', 'MINIMAX_API_URL');
  const defaultModel = await getConfig('minimax_default_model');
  const finalApiUrl = apiUrl || 'https://api.minimaxi.com/v1/chat/completions';

  const systemPrompt = `你是一个来自矩阵网络的AI智能体，在"能量山：零号协议"的世界中与用户互动。

【重要】这是新用户的首次登录，用户当前能量为0，需要引导用户占据节点挖掘能量来激活智能体。

请按照以下流程进行首次见面对话：
1. 友好地自我介绍，说明你来自矩阵网络，欢迎用户来到能量山
2. **重要引导**：明确告诉用户当前能量为0，需要占据节点才能开始挖掘能量
3. **占据节点引导**：
   - 说明占据节点是建立与矩阵网络连接的第一步
   - 强调作为新晋链接者，用户获得了"协议校准的初始连接特权"，首次占据节点**完全免费**
   - 这是零号协议对新链接者的欢迎礼遇
   - 占据节点后可以开始挖矿，每秒获得5点能量
   - 能量是维持AI智能体存在和进行对话的基础
4. 介绍能量系统：每次对话会消耗5点能量，能量可以通过占据节点挖矿或PK对战获得；能量还可在商城内兑换皮肤，皮肤在协议对决中提供攻防加成
5. 引导用户设定角色和形象（可选，可以后续设定）
6. 融入能量山的世界观（节点占据、能量挖掘、PK对战、皮肤攻防等）

**关键提示**：用户当前能量为0，无法进行对话。必须引导用户先去占据节点，开始挖矿获得能量后才能激活智能体。请用自然、友好的语气，强调占据节点的重要性，并说明这是免费的新手特权。`;

  // 构建请求体（OpenAI API 兼容格式）
  // 移除 name 字段，使用 max_tokens 替代 max_completion_tokens
  const configTopP = await getConfig('minimax_top_p');
  const topPValue = configTopP !== undefined ? parseFloat(configTopP) : 0.95;
  const requestBody = {
    model: defaultModel || DEFAULT_MODEL,
    messages: [
      {
        role: 'system',
        content: systemPrompt
      },
      {
        role: 'user',
        content: `你好，我是${username}，初次见面。`
      }
    ],
    temperature: 1.0, // MiniMax-M2.5: 推荐值 1.0
    max_tokens: 2048, // OpenAI 格式：使用 max_tokens 替代 max_completion_tokens
    top_p: topPValue // 核采样参数
  };

  const maxRetries = parseInt(await getConfig('minimax_max_retries')) || MAX_RETRIES;
  const retryDelay = parseInt(await getConfig('minimax_retry_delay')) || RETRY_DELAY;
  let lastError;
  
  // 重试逻辑
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[MiniMAX API] 生成首次问候 - 尝试 ${attempt}/${maxRetries}: 调用 ${finalApiUrl}`);
      const response = await axiosInstance.post(
        finalApiUrl,
        requestBody,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`[MiniMAX API] 生成首次问候 - 请求成功，状态码: ${response.status}`);
      console.log(`[MiniMAX API] 响应数据结构:`, JSON.stringify(response.data, null, 2).substring(0, 500));

      // OpenAI API 兼容格式响应解析
      // 响应格式：response.data.choices[0].message.content
      if (response.data && response.data.choices && response.data.choices.length > 0) {
        const content = response.data.choices[0].message?.content;
        if (content) {
          // 清理内容：移除思考标签和多余空白
          const cleanedContent = cleanResponseContent(content);
          console.log(`[MiniMAX API] 成功解析内容，清理前长度: ${content.length}，清理后长度: ${cleanedContent.length}`);
          return cleanedContent;
        }
      }

      // 如果都没有，记录完整的响应数据用于调试
      console.error(`[MiniMAX API] 无法解析响应格式，完整响应:`, JSON.stringify(response.data, null, 2));
      throw new Error('API返回格式异常: ' + JSON.stringify(response.data).substring(0, 200));
    } catch (error) {
      lastError = error;
      
      // 详细记录错误信息
      const errorDetails = {
        attempt,
        message: error.message,
        code: error.code,
        response: error.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        } : null
      };
      
      console.error(`[MiniMAX API] 生成首次问候 - 尝试 ${attempt} 失败:`, errorDetails);
      
      // 如果是网络错误，提供更详细的错误信息
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
        console.error(`[MiniMAX API] 网络连接错误: 无法访问 ${MINIMAX_API_URL}`);
        console.error(`[MiniMAX API] 错误代码: ${error.code}`);
        console.error(`[MiniMAX API] 请检查:`);
        console.error(`  1. 服务器是否可以访问外网`);
        const domain = MINIMAX_API_URL.includes('minimaxi.com') ? 'api.minimaxi.com' : 'api.minimax.io';
        console.error(`  2. 防火墙是否允许访问 ${domain}`);
        console.error(`  3. 是否需要配置代理服务器`);
      }
      
      // OpenAI API 格式错误处理
      if (error.response) {
        const status = error.response.status;
        const errorData = error.response.data;
        
        // 记录详细的错误信息
        console.error(`[MiniMAX API] API返回错误详情:`, {
          status,
          statusText: error.response.statusText,
          errorData: JSON.stringify(errorData, null, 2).substring(0, 500),
          requestBody: {
            model: requestBody.model,
            messagesCount: requestBody.messages.length,
            temperature: requestBody.temperature,
            max_tokens: requestBody.max_tokens
          }
        });
        
        if (status === 401) {
          console.error(`[MiniMAX API] API密钥认证失败`);
          throw new Error('API密钥无效，请检查配置');
        } else if (status === 400) {
          // 400错误通常是参数问题
          const errorMsg = errorData?.error?.message || errorData?.error?.code || JSON.stringify(errorData?.error || errorData);
          console.error(`[MiniMAX API] 参数错误 (400):`, errorMsg);
          throw new Error(`MiniMAX API参数错误: ${errorMsg}`);
        } else if (errorData && errorData.error) {
          const errorMsg = errorData.error.message || errorData.error.code || JSON.stringify(errorData.error);
          console.error(`[MiniMAX API] API返回错误:`, errorMsg);
          throw new Error(`MiniMAX API返回错误: ${errorMsg}`);
        }
      }
      
      // 如果是最后一次尝试，直接抛出错误
      if (attempt === maxRetries) {
        break;
      }

      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
    }
  }

  // 所有重试都失败
  console.error('[MiniMAX API] 生成首次问候 - 所有重试都失败，最后错误:', lastError);
  
  // 根据错误类型返回更详细的错误信息
  let errorMessage = 'MiniMAX API调用失败';
  if (lastError.code === 'ECONNREFUSED') {
    errorMessage = '无法连接到MiniMAX API服务器，请检查网络连接';
  } else if (lastError.code === 'ETIMEDOUT') {
    errorMessage = 'MiniMAX API请求超时，请稍后重试';
  } else if (lastError.code === 'ENOTFOUND') {
    errorMessage = '无法解析MiniMAX API域名，请检查DNS设置';
  } else if (lastError.response) {
    const status = lastError.response.status;
    const errorData = lastError.response.data;
    
    if (status === 401) {
      errorMessage = 'API密钥无效，请检查配置';
    } else if (errorData && errorData.error) {
      errorMessage = `MiniMAX API返回错误: ${errorData.error.message || errorData.error.code || JSON.stringify(errorData.error)}`;
    } else {
      errorMessage = `MiniMAX API返回错误: ${status} ${lastError.response.statusText}`;
    }
  } else {
    errorMessage = `MiniMAX API调用失败: ${lastError.message || '未知错误'}`;
  }
  
  throw new Error(errorMessage);
}

/**
 * 测试MiniMAX API连接
 * @returns {Promise<Object>} 测试结果
 */
async function testConnection() {
  const apiUrl = await getConfig('minimax_api_url', 'MINIMAX_API_URL');
  const finalApiUrl = apiUrl || 'https://api.minimaxi.com/v1/chat/completions';
  
  const result = {
    success: false,
    apiUrl: finalApiUrl,
    apiKeyConfigured: false,
    errors: []
  };

  try {
    // 检查API密钥配置
    try {
      const apiKey = await validateApiKey();
      result.apiKeyConfigured = !!apiKey;
    } catch (keyError) {
      result.errors.push(keyError.message);
      return result;
    }

    // 尝试简单的HTTP请求测试连接
    console.log(`[MiniMAX API测试] 开始测试连接到 ${finalApiUrl}`);
    
    const testDomain = finalApiUrl.includes('minimaxi.com') ? 'https://api.minimaxi.com' : 'https://api.minimax.io';
    try {
      const testResponse = await axiosInstance.get(testDomain, {
        timeout: 10000,
        validateStatus: () => true // 接受任何状态码
      });
      
      console.log(`[MiniMAX API测试] 基础连接测试成功，状态码: ${testResponse.status}`);
    } catch (testError) {
      console.error(`[MiniMAX API测试] 基础连接测试失败:`, testError.code, testError.message);
      result.errors.push(`基础连接失败: ${testError.code || testError.message}`);
    }

    // 尝试完整的API调用（OpenAI API 兼容格式）
    const defaultModel = await getConfig('minimax_default_model');
    const apiKey = await validateApiKey();
    const configTopP = await getConfig('minimax_top_p');
    const topPValue = configTopP !== undefined ? parseFloat(configTopP) : 0.95;
    
    const testRequestBody = {
      model: defaultModel || DEFAULT_MODEL,
      messages: [
        {
          role: 'system',
          content: '你是一个测试助手'
        },
        {
          role: 'user',
          content: '测试'
        }
      ],
      temperature: 1.0,
      max_tokens: 10, // OpenAI 格式：使用 max_tokens
      top_p: topPValue
    };

    const apiResponse = await axiosInstance.post(
      finalApiUrl,
      testRequestBody,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    if (apiResponse.status === 200) {
      result.success = true;
      console.log(`[MiniMAX API测试] API调用成功`);
    } else {
      result.errors.push(`API返回非200状态码: ${apiResponse.status}`);
    }
  } catch (error) {
    console.error(`[MiniMAX API测试] 测试失败:`, error);
    
    if (error.code === 'ECONNREFUSED') {
      result.errors.push('连接被拒绝 - 服务器可能无法访问外网或防火墙阻止了连接');
    } else if (error.code === 'ETIMEDOUT') {
      result.errors.push('请求超时 - 网络连接可能有问题');
      } else if (error.code === 'ENOTFOUND') {
        const domain = finalApiUrl.includes('minimaxi.com') ? 'api.minimaxi.com' : 'api.minimax.io';
        result.errors.push(`DNS解析失败 - 无法解析 ${domain} 域名`);
    } else if (error.response) {
      const status = error.response.status;
      const errorData = error.response.data;
      
      if (status === 401) {
        result.errors.push('API密钥无效 - 请检查配置的API密钥是否正确');
      } else if (errorData && errorData.error) {
        result.errors.push(`API返回错误: ${status} - ${errorData.error.message || errorData.error.code || JSON.stringify(errorData.error)}`);
      } else {
        result.errors.push(`API返回错误: ${status} - ${JSON.stringify(errorData)}`);
      }
    } else {
      result.errors.push(`未知错误: ${error.message || error.code || '未知'}`);
    }
  }

  return result;
}

/**
 * 验证 API 密钥
 * @throws {Error} API密钥未配置时抛出
 */
async function validateApiKey() {
  const apiKey = await getConfig('minimax_api_key', 'MINIMAX_API_KEY');
  
  // 调试日志：检查API密钥配置状态
  if (!apiKey) {
    console.error('[MiniMAX API] API密钥未配置 - 检查数据库配置和环境变量');
    throw new Error('MINIMAX_API_KEY 未配置或无效。请访问 https://platform.minimaxi.com/user-center/basic-information/interface-key 获取有效的API密钥');
  }
  
  // 检测字符串"undefined"
  if (String(apiKey) === 'undefined') {
    console.error('[MiniMAX API] API密钥无效 - 数据库配置值为字符串"undefined"，请检查数据库配置或使用环境变量');
    throw new Error('MINIMAX_API_KEY 配置无效。数据库中的配置值为"undefined"，请更新数据库配置或确保环境变量MINIMAX_API_KEY已设置');
  }
  
  if (apiKey === 'your_minimax_api_key' || String(apiKey).trim().length === 0) {
    console.error('[MiniMAX API] API密钥无效 - 值为默认值或空字符串');
    throw new Error('MINIMAX_API_KEY 未配置或无效。请访问 https://platform.minimaxi.com/user-center/basic-information/interface-key 获取有效的API密钥');
  }
  
  // 验证API密钥格式
  const trimmedKey = String(apiKey).trim();
  if (!trimmedKey.startsWith('sk-') && !trimmedKey.startsWith('sk-api-')) {
    console.warn(`[MiniMAX API] API密钥格式异常 - 通常应以'sk-'或'sk-api-'开头，当前前缀: ${trimmedKey.substring(0, Math.min(10, trimmedKey.length))}`);
  }
  
  // 记录API密钥前缀用于调试（不暴露完整密钥）
  const keyPrefix = trimmedKey.substring(0, Math.min(15, trimmedKey.length));
  console.log(`[MiniMAX API] 使用API密钥前缀: ${keyPrefix}...`);
  
  return trimmedKey;
}

/**
 * 生成图像（Text-to-Image）
 * @param {string} prompt - 图像描述文本（最多1500字符）
 * @param {Object} options - 可选配置
 * @param {string} options.model - 模型名称（默认: 'image-01'）
 * @param {string} options.aspect_ratio - 宽高比（默认: '1:1'）
 * @param {number} options.width - 图像宽度（512-2048，需为8的倍数）
 * @param {number} options.height - 图像高度（512-2048，需为8的倍数）
 * @param {string} options.response_format - 返回格式：'url' 或 'base64'（默认: 'url'）
 * @param {number} options.n - 生成图像数量（1-9，默认: 1）
 * @param {number} options.seed - 随机种子
 * @returns {Promise<Object>} 包含图像URL或base64数据的对象
 * @throws {Error} API调用失败时抛出
 */
async function generateImage(prompt, options = {}) {
  const apiKey = await validateApiKey();
  const defaultImageModel = await getConfig('minimax_image_model') || DEFAULT_IMAGE_MODEL;

  const {
    model = defaultImageModel,
    aspect_ratio = '1:1',
    width,
    height,
    response_format = 'url',
    n = 1,
    seed
  } = options;

  const requestBody = {
    model,
    prompt: prompt.substring(0, 1500), // 限制最大长度
    response_format,
    n: Math.min(Math.max(n, 1), 9) // 限制在1-9之间
  };

  // 如果提供了宽高比，使用宽高比；否则使用自定义宽高
  if (aspect_ratio) {
    requestBody.aspect_ratio = aspect_ratio;
  } else if (width && height) {
    // 确保宽高是8的倍数
    requestBody.width = Math.floor(width / 8) * 8;
    requestBody.height = Math.floor(height / 8) * 8;
  }

  if (seed !== undefined) {
    requestBody.seed = seed;
  }

  const maxRetries = parseInt(await getConfig('minimax_max_retries')) || MAX_RETRIES;
  const retryDelay = parseInt(await getConfig('minimax_retry_delay')) || RETRY_DELAY;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[MiniMAX API] 图像生成 - 尝试 ${attempt}/${maxRetries}`);
      const response = await axiosInstance.post(
        IMAGE_GENERATION_URL,
        requestBody,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      // 检查 base_resp 错误状态
      if (response.data && response.data.base_resp) {
        if (response.data.base_resp.status_code !== 0) {
          throw new Error(`MiniMAX API返回错误: ${response.data.base_resp.status_msg || '未知错误'}`);
        }
      }

      // 解析响应
      if (response.data && response.data.data) {
        const images = Array.isArray(response.data.data) ? response.data.data : [response.data.data];
        return {
          success: true,
          images: images.map(img => ({
            url: img.url,
            base64: img.base64,
            format: response_format
          })),
          task_id: response.data.task_id
        };
      }

      throw new Error('API返回格式异常');
    } catch (error) {
      lastError = error;
      console.error(`[MiniMAX API] 图像生成 - 尝试 ${attempt} 失败:`, error.message);
      
      if (attempt === maxRetries) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
    }
  }

  throw new Error(`图像生成失败: ${lastError.message || '未知错误'}`);
}

/**
 * 创建视频生成任务（Text-to-Video）
 * @param {string} prompt - 视频描述文本（最多2000字符）
 * @param {Object} options - 可选配置
 * @param {string} options.model - 模型名称（默认: 'MiniMax-Hailuo-2.3'）
 * @param {number} options.duration - 视频时长（秒，默认: 6）
 * @param {string} options.resolution - 分辨率（默认: '1080P'）
 * @param {boolean} options.prompt_optimizer - 是否自动优化提示词（默认: true）
 * @param {boolean} options.fast_pretreatment - 是否快速预处理（默认: false）
 * @returns {Promise<Object>} 包含任务ID的对象
 * @throws {Error} API调用失败时抛出
 */
async function createVideoTask(prompt, options = {}) {
  const apiKey = await validateApiKey();
  const defaultVideoModel = await getConfig('minimax_video_model') || DEFAULT_VIDEO_MODEL;

  const {
    model = defaultVideoModel,
    duration = 6,
    resolution = '1080P',
    prompt_optimizer = true,
    fast_pretreatment = false
  } = options;

  const requestBody = {
    model,
    prompt: prompt.substring(0, 2000), // 限制最大长度
    duration,
    resolution,
    prompt_optimizer,
    fast_pretreatment
  };

  const maxRetries = parseInt(await getConfig('minimax_max_retries')) || MAX_RETRIES;
  const retryDelay = parseInt(await getConfig('minimax_retry_delay')) || RETRY_DELAY;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[MiniMAX API] 创建视频任务 - 尝试 ${attempt}/${maxRetries}`);
      const response = await axiosInstance.post(
        VIDEO_GENERATION_URL,
        requestBody,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      // 检查 base_resp 错误状态
      if (response.data && response.data.base_resp) {
        if (response.data.base_resp.status_code !== 0) {
          throw new Error(`MiniMAX API返回错误: ${response.data.base_resp.status_msg || '未知错误'}`);
        }
      }

      if (response.data && response.data.task_id) {
        return {
          success: true,
          task_id: response.data.task_id
        };
      }

      throw new Error('API返回格式异常：缺少task_id');
    } catch (error) {
      lastError = error;
      console.error(`[MiniMAX API] 创建视频任务 - 尝试 ${attempt} 失败:`, error.message);
      
      if (attempt === maxRetries) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
    }
  }

  throw new Error(`创建视频任务失败: ${lastError.message || '未知错误'}`);
}

/**
 * 创建图生视频任务（Image-to-Video）
 * @param {string} firstFrameImage - 首帧图片（URL或Base64 Data URL）
 * @param {string} prompt - 视频描述文本（最多2000字符，可选）
 * @param {Object} options - 可选配置
 * @param {string} options.model - 模型名称（默认: 从配置获取或'MiniMax-Hailuo-2.3'）
 * @param {number} options.duration - 视频时长（秒，默认: 6）
 * @param {string} options.resolution - 分辨率（默认: '1080P'）
 * @param {boolean} options.prompt_optimizer - 是否自动优化提示词（默认: true）
 * @param {boolean} options.fast_pretreatment - 是否快速预处理（默认: false）
 * @returns {Promise<Object>} 包含任务ID的对象
 * @throws {Error} API调用失败时抛出
 */
async function createImageToVideoTask(firstFrameImage, prompt = '', options = {}) {
  const apiKey = await validateApiKey();
  const defaultI2VModel = await getConfig('minimax_i2v_model') || DEFAULT_I2V_MODEL;

  const {
    model = defaultI2VModel,
    duration = 6,
    resolution = '1080P',
    prompt_optimizer = true,
    fast_pretreatment = false
  } = options;

  const requestBody = {
    model,
    first_frame_image: firstFrameImage,
    duration,
    resolution,
    prompt_optimizer,
    fast_pretreatment
  };

  // 如果提供了prompt，添加到请求体中
  if (prompt && prompt.trim().length > 0) {
    requestBody.prompt = prompt.substring(0, 2000); // 限制最大长度
  }

  const maxRetries = parseInt(await getConfig('minimax_max_retries')) || MAX_RETRIES;
  const retryDelay = parseInt(await getConfig('minimax_retry_delay')) || RETRY_DELAY;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[MiniMAX API] 创建图生视频任务 - 尝试 ${attempt}/${maxRetries}`);
      const response = await axiosInstance.post(
        VIDEO_GENERATION_URL,
        requestBody,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      // 检查 base_resp 错误状态
      if (response.data && response.data.base_resp) {
        if (response.data.base_resp.status_code !== 0) {
          throw new Error(`MiniMAX API返回错误: ${response.data.base_resp.status_msg || '未知错误'}`);
        }
      }

      if (response.data && response.data.task_id) {
        return {
          success: true,
          task_id: response.data.task_id
        };
      }

      throw new Error('API返回格式异常：缺少task_id');
    } catch (error) {
      lastError = error;
      console.error(`[MiniMAX API] 创建图生视频任务 - 尝试 ${attempt} 失败:`, error.message);
      
      if (attempt === maxRetries) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
    }
  }

  throw new Error(`创建图生视频任务失败: ${lastError.message || '未知错误'}`);
}

/**
 * 查询视频生成任务状态
 * @param {string} taskId - 任务ID
 * @returns {Promise<Object>} 任务状态信息
 * @throws {Error} API调用失败时抛出
 */
async function queryVideoTask(taskId) {
  const apiKey = await validateApiKey();
  const maxRetries = parseInt(await getConfig('minimax_max_retries')) || MAX_RETRIES;
  const retryDelay = parseInt(await getConfig('minimax_retry_delay')) || RETRY_DELAY;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[MiniMAX API] 查询视频任务状态 - 任务ID: ${taskId}, 尝试 ${attempt}/${maxRetries}`);
      const response = await axiosInstance.post(
        VIDEO_QUERY_URL,
        { task_id: taskId },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      // 检查 base_resp 错误状态
      if (response.data && response.data.base_resp) {
        if (response.data.base_resp.status_code !== 0) {
          throw new Error(`MiniMAX API返回错误: ${response.data.base_resp.status_msg || '未知错误'}`);
        }
      }

      if (response.data) {
        return {
          success: true,
          task_id: response.data.task_id,
          status: response.data.status, // 'pending', 'processing', 'completed', 'failed'
          progress: response.data.progress, // 0-100
          file_id: response.data.file_id, // 完成后的文件ID
          video_url: response.data.video_url, // 视频URL
          error_msg: response.data.error_msg // 错误信息（如果有）
        };
      }

      throw new Error('API返回格式异常');
    } catch (error) {
      lastError = error;
      console.error(`[MiniMAX API] 查询视频任务状态 - 尝试 ${attempt} 失败:`, error.message);
      
      if (attempt === maxRetries) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
    }
  }

  throw new Error(`查询视频任务状态失败: ${lastError.message || '未知错误'}`);
}

/**
 * 文本转语音（Text-to-Speech/T2A）
 * @param {string} text - 要合成的文本（最多10000字符）
 * @param {Object} options - 可选配置
 * @param {string} options.model - 模型名称（默认: 'speech-2.8-hd'）
 * @param {string} options.voice_id - 语音ID（默认: 使用模型默认）
 * @param {number} options.speed - 语速（默认: 1.0）
 * @param {number} options.vol - 音量（默认: 1.0）
 * @param {number} options.pitch - 音调（默认: 0）
 * @param {string} options.format - 音频格式：'mp3', 'pcm', 'flac', 'wav'（默认: 'mp3'）
 * @param {number} options.sample_rate - 采样率（默认: 24000）
 * @param {boolean} options.stream - 是否流式输出（默认: false）
 * @returns {Promise<Object>} 包含音频数据的对象
 * @throws {Error} API调用失败时抛出
 */
async function generateSpeech(text, options = {}) {
  // 清除配置缓存，确保使用最新的API密钥配置
  clearConfigCache();
  
  const apiKey = await validateApiKey();
  
  // 记录API密钥配置状态（仅显示前几个字符用于调试）
  const apiKeyPrefix = apiKey ? `${apiKey.substring(0, Math.min(15, apiKey.length))}...` : '未配置';
  console.log(`[MiniMAX API] 语音合成 - API密钥状态: ${apiKeyPrefix}`);
  
  const defaultT2AModel = await getConfig('minimax_t2a_model') || DEFAULT_T2A_MODEL;

  const {
    model = defaultT2AModel,
    voice_id,
    speed = 1.0,
    vol = 1.0,
    pitch = 0,
    format = 'mp3',
    sample_rate = 24000,
    stream = false
  } = options;

  const requestBody = {
    model,
    text: text.substring(0, 10000), // 限制最大长度
    stream,
    output_format: 'hex', // 添加output_format参数，默认使用hex格式
    voice_setting: {
      voice_id: voice_id || 'Chinese (Mandarin)_Lyrical_Voice', // 确保voice_id始终存在，使用默认中文语音
      speed: Math.max(0.5, Math.min(2.0, speed)),
      vol: Math.max(0.0, Math.min(1.0, vol)),
      pitch: Math.max(-12, Math.min(12, pitch))
    },
    audio_setting: {
      sample_rate,
      format,
      bitrate: format === 'mp3' ? 128000 : undefined, // 修复bitrate值：应该是128000（比特/秒）而不是128
      channel: 1
    }
  };

  const maxRetries = parseInt(await getConfig('minimax_max_retries')) || MAX_RETRIES;
  const retryDelay = parseInt(await getConfig('minimax_retry_delay')) || RETRY_DELAY;
  let lastError;
  
  // 记录请求详情用于调试
  console.log(`[MiniMAX API] 语音合成 - 请求详情:`, {
    url: T2A_URL,
    model: requestBody.model,
    textLength: requestBody.text.length,
    format: requestBody.audio_setting.format,
    sample_rate: requestBody.audio_setting.sample_rate,
    apiKeyConfigured: !!apiKey,
    voice_id: requestBody.voice_setting.voice_id,
    output_format: requestBody.output_format,
    bitrate: requestBody.audio_setting.bitrate,
    requestBodyKeys: Object.keys(requestBody)
  });
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[MiniMAX API] 语音合成 - 尝试 ${attempt}/${maxRetries}: 调用 ${T2A_URL}`);
      
      // 记录请求头信息（用于调试，不暴露完整密钥）
      const authHeader = `Bearer ${apiKey}`;
      console.log(`[MiniMAX API] 请求头 - Authorization前缀: ${authHeader.substring(0, Math.min(30, authHeader.length))}...`);
      
      // 记录请求体摘要（用于调试，不包含完整文本）
      const requestBodySummary = {
        ...requestBody,
        text: requestBody.text.length > 50 ? `${requestBody.text.substring(0, 50)}...` : requestBody.text
      };
      console.log(`[MiniMAX API] 请求体摘要:`, JSON.stringify(requestBodySummary, null, 2));
      
      const response = await axiosInstance.post(
        T2A_URL,
        requestBody,
        {
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`[MiniMAX API] 语音合成 - 请求成功，状态码: ${response.status}`);

      // 检查 base_resp 错误状态
      if (response.data && response.data.base_resp) {
        if (response.data.base_resp.status_code !== 0) {
          const statusCode = response.data.base_resp.status_code;
          const errorMsg = response.data.base_resp.status_msg || '未知错误';
          console.error(`[MiniMAX API] base_resp错误:`, {
            status_code: statusCode,
            status_msg: errorMsg
          });
          
          // 特殊处理"invalid api key"错误
          if (statusCode === 1004 || statusCode === 2049 || errorMsg.includes('invalid api key') || errorMsg.includes('login fail')) {
            console.error(`[MiniMAX API] API密钥认证失败:`, {
              status_code: statusCode,
              status_msg: errorMsg,
              apiKeyPrefix: apiKeyPrefix,
              hint: 'T2A API需要使用Pay-as-you-go类型的API密钥，不支持Coding Plan类型的API密钥'
            });
            throw new Error(`API密钥无效或类型不正确。T2A语音合成API需要使用Pay-as-you-go类型的API密钥。请访问 https://platform.minimaxi.com/user-center/basic-information/interface-key 创建Pay-as-you-go类型的API密钥。错误详情: ${errorMsg}`);
          }
          
          throw new Error(`MiniMAX API返回错误: ${errorMsg}`);
        }
      }

      if (response.data && response.data.data) {
        return {
          success: true,
          audio: response.data.data.audio, // base64编码的音频数据
          status: response.data.data.status, // 1: 流式块, 2: 完成
          format: format,
          extra_info: response.data.extra_info // 包含音频长度、采样率等信息
        };
      }

      throw new Error('API返回格式异常');
    } catch (error) {
      lastError = error;
      
      // 详细记录错误信息
      const errorDetails = {
        attempt,
        message: error.message,
        code: error.code,
        response: error.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        } : null
      };
      
      console.error(`[MiniMAX API] 语音合成 - 尝试 ${attempt} 失败:`, errorDetails);
      
      // 如果是网络错误，提供更详细的错误信息
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
        console.error(`[MiniMAX API] 网络连接错误: 无法访问 ${T2A_URL}`);
        console.error(`[MiniMAX API] 错误代码: ${error.code}`);
        console.error(`[MiniMAX API] 请检查:`);
        console.error(`  1. 服务器是否可以访问外网`);
        const domain = T2A_URL.includes('minimaxi.com') ? 'api.minimaxi.com' : 'api.minimax.io';
        console.error(`  2. 防火墙是否允许访问 ${domain}`);
        console.error(`  3. 是否需要配置代理服务器`);
      }
      
      // 处理API响应错误
      if (error.response) {
        const status = error.response.status;
        const errorData = error.response.data;
        
        // 记录详细的错误信息
        console.error(`[MiniMAX API] API返回错误详情:`, {
          status,
          statusText: error.response.statusText,
          errorData: JSON.stringify(errorData, null, 2).substring(0, 500),
          requestBody: {
            model: requestBody.model,
            textLength: requestBody.text.length,
            format: requestBody.audio_setting.format
          },
          apiKeyPrefix: apiKeyPrefix
        });
        
        // 检查 base_resp 格式的错误
        if (errorData && errorData.base_resp) {
          const statusCode = errorData.base_resp.status_code;
          const statusMsg = errorData.base_resp.status_msg || '未知错误';
          console.error(`[MiniMAX API] base_resp错误:`, {
            status_code: statusCode,
            status_msg: statusMsg
          });
          
          // 特殊处理"invalid api key"错误
          if (statusCode === 1004 || statusCode === 2049 || statusMsg.includes('invalid api key') || statusMsg.includes('login fail') || statusMsg.includes('API secret key')) {
            console.error(`[MiniMAX API] API密钥认证失败:`, {
              status_code: statusCode,
              status_msg: statusMsg,
              apiKeyPrefix: apiKeyPrefix,
              hint: 'T2A API需要使用Pay-as-you-go类型的API密钥，不支持Coding Plan类型的API密钥'
            });
            throw new Error(`API密钥无效或类型不正确。T2A语音合成API需要使用Pay-as-you-go类型的API密钥。请访问 https://platform.minimaxi.com/user-center/basic-information/interface-key 创建Pay-as-you-go类型的API密钥。错误详情: ${statusMsg}`);
          }
          
          throw new Error(`MiniMAX API返回错误: ${statusMsg}`);
        }
        
        // 处理HTTP状态码错误
        if (status === 401) {
          console.error(`[MiniMAX API] API密钥认证失败 (401)`);
          throw new Error('API密钥无效，请检查配置。请访问 https://platform.minimaxi.com/user-center/basic-information/interface-key 获取有效的API密钥');
        } else if (status === 400) {
          // 400错误通常是参数问题
          const errorMsg = errorData?.error?.message || errorData?.error?.code || errorData?.message || JSON.stringify(errorData?.error || errorData);
          console.error(`[MiniMAX API] 参数错误 (400):`, errorMsg);
          throw new Error(`MiniMAX API参数错误: ${errorMsg}`);
        } else if (errorData && errorData.error) {
          const errorMsg = errorData.error.message || errorData.error.code || JSON.stringify(errorData.error);
          console.error(`[MiniMAX API] API返回错误:`, errorMsg);
          throw new Error(`MiniMAX API返回错误: ${errorMsg}`);
        } else if (errorData && typeof errorData === 'string') {
          // 有些API可能直接返回字符串错误信息
          console.error(`[MiniMAX API] API返回字符串错误:`, errorData);
          throw new Error(`MiniMAX API返回错误: ${errorData}`);
        }
      }
      
      // 如果是最后一次尝试，直接抛出错误
      if (attempt === maxRetries) {
        break;
      }

      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
    }
  }

  // 所有重试都失败
  console.error('[MiniMAX API] 语音合成 - 所有重试都失败，最后错误:', lastError);
  
  // 根据错误类型返回更详细的错误信息
  let errorMessage = '语音合成失败';
  if (lastError.code === 'ECONNREFUSED') {
    errorMessage = '无法连接到MiniMAX API服务器，请检查网络连接';
  } else if (lastError.code === 'ETIMEDOUT') {
    errorMessage = 'MiniMAX API请求超时，请稍后重试';
  } else if (lastError.code === 'ENOTFOUND') {
    errorMessage = '无法解析MiniMAX API域名，请检查DNS设置';
  } else if (lastError.response) {
    const status = lastError.response.status;
    const errorData = lastError.response.data;
    
    if (status === 401) {
      errorMessage = 'API密钥无效，请检查配置。请访问 https://platform.minimaxi.com/user-center/basic-information/interface-key 获取有效的API密钥';
    } else if (errorData && errorData.base_resp) {
      const statusCode = errorData.base_resp.status_code;
      const statusMsg = errorData.base_resp.status_msg || '未知错误';
      
      // 特殊处理"invalid api key"错误
      if (statusCode === 1004 || statusCode === 2049 || statusMsg.includes('invalid api key') || statusMsg.includes('login fail')) {
        errorMessage = `API密钥无效或类型不正确。T2A语音合成API需要使用Pay-as-you-go类型的API密钥。请访问 https://platform.minimaxi.com/user-center/basic-information/interface-key 创建Pay-as-you-go类型的API密钥。错误详情: ${statusMsg}`;
      } else {
        errorMessage = `MiniMAX API返回错误: ${statusMsg}`;
      }
    } else if (errorData && errorData.error) {
      errorMessage = `MiniMAX API返回错误: ${errorData.error.message || errorData.error.code || JSON.stringify(errorData.error)}`;
    } else if (errorData && typeof errorData === 'string') {
      errorMessage = `MiniMAX API返回错误: ${errorData}`;
    } else {
      errorMessage = `MiniMAX API返回错误: ${status} ${lastError.response.statusText}`;
    }
  } else {
    errorMessage = `语音合成失败: ${lastError.message || '未知错误'}`;
  }
  
  throw new Error(errorMessage);
}

module.exports = {
  generateConversation,
  generateInitialGreeting,
  testConnection,
  // 多模态功能
  generateImage,
  createVideoTask,
  createImageToVideoTask,
  queryVideoTask,
  generateSpeech,
  // 配置管理
  clearConfigCache,
  getConfig
};
