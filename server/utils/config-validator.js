/**
 * @file config-validator.js
 * @module utils/config-validator
 * @description 游戏配置验证工具，验证配置值的有效性并提供默认值
 */

const crypto = require('crypto');

// 配置验证规则
const CONFIG_RULES = {
  // Minimax API配置
  'minimax_api_key': {
    type: 'string',
    required: false,
    sensitive: true,
    minLength: 1,
    maxLength: 500
  },
  'minimax_api_url': {
    type: 'string',
    required: false,
    pattern: /^https?:\/\/.+/,
    default: 'https://api.minimaxi.com/v1/chat/completions'
  },
  'minimax_default_model': {
    type: 'string',
    required: false,
    enum: ['MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2'],
    default: 'MiniMax-M2.5'
  },
  'minimax_image_model': {
    type: 'string',
    required: false,
    enum: ['image-01', 'image-01-live'],
    default: 'image-01'
  },
  'minimax_image_model_t2i': {
    type: 'string',
    required: false,
    enum: ['', 'image-01', 'image-01-live'],
    default: ''
  },
  'minimax_image_model_i2i': {
    type: 'string',
    required: false,
    enum: ['', 'image-01', 'image-01-live'],
    default: ''
  },
  'minimax_video_model': {
    type: 'string',
    required: false,
    enum: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02', 'T2V-01-Director', 'T2V-01'],
    default: 'MiniMax-Hailuo-2.3'
  },
  'minimax_i2v_model': {
    type: 'string',
    required: false,
    enum: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast', 'MiniMax-Hailuo-02', 'I2V-01-Director', 'I2V-01-live', 'I2V-01'],
    default: 'MiniMax-Hailuo-2.3'
  },
  'minimax_t2a_model': {
    type: 'string',
    required: false,
    enum: ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo', 'speech-01-hd', 'speech-01-turbo'],
    default: 'speech-2.8-hd'
  },
  'minimax_max_retries': {
    type: 'number',
    required: false,
    min: 1,
    max: 10,
    default: 3
  },
  'minimax_retry_delay': {
    type: 'number',
    required: false,
    min: 100,
    max: 10000,
    default: 1000
  },
  'minimax_temperature': {
    type: 'number',
    required: false,
    min: 0.01,
    max: 1.0,
    default: 0.7
  },
  'minimax_max_tokens': {
    type: 'number',
    required: false,
    min: 1,
    max: 204800,
    default: 2000
  },
  'minimax_top_p': {
    type: 'number',
    required: false,
    min: 0.0,
    max: 1.0,
    default: 0.95
  },

  // AI 服务提供商与阿里云百炼（DashScope）配置
  'ai_provider': {
    type: 'string',
    required: false,
    enum: ['minimax', 'bailian'],
    default: 'minimax'
  },
  'bailian_api_key': {
    type: 'string',
    required: false,
    sensitive: true,
    minLength: 1,
    maxLength: 500
  },
  'bailian_base_url': {
    type: 'string',
    required: false,
    pattern: /^https:\/\/.+/,
    default: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  },
  'bailian_default_model': {
    type: 'string',
    required: false,
    enum: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long', 'qwen-max-longcontext', 'qwen3.5-plus', 'qwen3.5-plus-2026-02-15', 'qwen3-max', 'qwen3-max-2026-01-23', 'qwen3-max-2025-09-23'],
    default: 'qwen3.5-plus'
  },
  'bailian_image_model': {
    type: 'string',
    required: false,
    enum: ['wanx-v1', 'wan2.6-image', 'qwen-image-max', 'qwen-image-max-2025-12-30', 'qwen-image-plus', 'qwen-image-plus-2026-01-09', 'qwen-image'],
    default: 'wanx-v1'
  },
  'bailian_image_model_t2i': {
    type: 'string',
    required: false,
    enum: ['', 'wanx-v1', 'wan2.6-image', 'qwen-image-max', 'qwen-image-max-2025-12-30', 'qwen-image-plus', 'qwen-image-plus-2026-01-09', 'qwen-image'],
    default: ''
  },
  'bailian_image_model_i2i': {
    type: 'string',
    required: false,
    enum: ['', 'wanx-v1', 'wan2.6-image', 'qwen-image-max', 'qwen-image-max-2025-12-30', 'qwen-image-plus', 'qwen-image-plus-2026-01-09', 'qwen-image'],
    default: ''
  },
  'bailian_video_model': {
    type: 'string',
    required: false,
    enum: ['wanx2.1-t2v-plus', 'wanx2.1-t2v-turbo'],
    default: 'wanx2.1-t2v-turbo'
  },
  'bailian_i2v_model': {
    type: 'string',
    required: false,
    enum: ['wan2.6-i2v-flash', 'wan2.5-i2v-preview'],
    default: 'wan2.6-i2v-flash'
  },
  'bailian_speech_model': {
    type: 'string',
    required: false,
    enum: ['cosyvoice-v3-plus', 'cosyvoice-v3-flash', 'cosyvoice-v2', 'qwen-tts'],
    default: 'cosyvoice-v3-flash'
  },
  'bailian_temperature': {
    type: 'number',
    required: false,
    min: 0.01,
    max: 1.0,
    default: 0.7
  },
  'bailian_max_tokens': {
    type: 'number',
    required: false,
    min: 1,
    max: 204800,
    default: 2000
  },
  'bailian_top_p': {
    type: 'number',
    required: false,
    min: 0.0,
    max: 1.0,
    default: 0.95
  },

  'ai_agent_energy_cost': {
    type: 'number',
    required: false,
    min: 0,
    max: 100,
    default: 5,
    description: 'AI对话每次消耗能量（工作室/分身客服通用）'
  },
  'agent_chat_energy_cost': {
    type: 'number',
    required: false,
    min: 0,
    max: 100,
    default: 0,
    description: '客服对话每次消耗能量（0表示免费，为空时使用ai_agent_energy_cost）'
  },
  'agent_chat_web_search_energy_cost': {
    type: 'number',
    required: false,
    min: 0,
    max: 100,
    default: 0,
    description: '客服对话联网搜索额外消耗能量（为空时使用ai_agent_web_search_energy_cost）'
  },
  'ai_agent_image_energy_cost': {
    type: 'number',
    required: false,
    min: 0,
    max: 100,
    default: 5
  },
  'occupy_node_energy_cost': {
    type: 'number',
    required: false,
    min: 0,
    max: 1000,
    default: 50
  },
  
  // AI智能体功能开关
  'ai_agent_image_enabled': {
    type: 'boolean',
    required: false,
    default: true
  },
  'ai_agent_video_enabled': {
    type: 'boolean',
    required: false,
    default: true
  },
  'ai_agent_voice_enabled': {
    type: 'boolean',
    required: false,
    default: true
  },
  'ai_agent_web_search_enabled': {
    type: 'boolean',
    required: false,
    default: false
  },
  'ai_agent_web_search_studio_only': {
    type: 'boolean',
    required: false,
    default: false
  },
  'ai_agent_web_search_energy_cost': {
    type: 'number',
    required: false,
    min: 0,
    max: 100,
    default: 5,
    description: '联网搜索额外消耗能量（工作室/分身客服通用）'
  },

  // 客户端配置
  'client_api_base': {
    type: 'string',
    required: false,
    pattern: /^https?:\/\/.+/,
    default: 'https://aibotdemo.skym178.com/api'
  },
  'client_socket_url': {
    type: 'string',
    required: false,
    pattern: /^https?:\/\/.+/,
    default: 'https://aibotdemo.skym178.com'
  },
  'client_video_max_attempts': {
    type: 'number',
    required: false,
    min: 1,
    max: 300,
    default: 60
  },
  'client_video_poll_interval': {
    type: 'number',
    required: false,
    min: 1000,
    max: 60000,
    default: 3000
  },
  'client_max_reconnect_attempts': {
    type: 'number',
    required: false,
    min: 1,
    max: 20,
    default: 5
  },
  'client_reconnect_delay': {
    type: 'number',
    required: false,
    min: 100,
    max: 10000,
    default: 1000
  },
  
  // 游戏规则配置
  'game_rules_pk_min_value': {
    type: 'number',
    required: false,
    min: 1,
    max: 1000,
    default: 1
  },
  'game_rules_pk_max_value': {
    type: 'number',
    required: false,
    min: 1,
    max: 1000,
    default: 100
  },
  'pk_skin_defense_distance_threshold': {
    type: 'number',
    required: false,
    min: 1,
    max: 99,
    default: 30
  },

  // 虚拟智能体相关配置
  'virtual_agent_occupy_interval': {
    type: 'number',
    required: false,
    min: 1,
    max: 3600,
    default: 30
  },
  'virtual_agent_pk_interval': {
    type: 'number',
    required: false,
    min: 1,
    max: 3600,
    default: 60
  },
  'virtual_agent_pk_probability': {
    type: 'number',
    required: false,
    min: 0,
    max: 1,
    default: 0.3
  },
  'virtual_agent_accept_pk_probability': {
    type: 'number',
    required: false,
    min: 0,
    max: 1,
    default: 0.7
  },
  'virtual_agent_max_count': {
    type: 'number',
    required: false,
    min: 1,
    max: 500,
    default: 50
  },
  'virtual_agent_challenge_user_when_real_below': {
    type: 'number',
    required: false,
    min: 0,
    max: 100,
    default: 10
  },
  'virtual_agent_challenge_user_interval_min': {
    type: 'number',
    required: false,
    min: 60,
    max: 3600,
    default: 180
  },
  'virtual_agent_challenge_user_interval_max': {
    type: 'number',
    required: false,
    min: 60,
    max: 3600,
    default: 300
  },

  // 能量宝藏配置（已被移除，此处保留作为参考）

  // 阿里云 OSS 配置
  'oss_access_key_id': {
    type: 'string',
    required: false,
    sensitive: true,
    minLength: 1,
    maxLength: 100,
    default: ''
  },
  'oss_access_key_secret': {
    type: 'string',
    required: false,
    sensitive: true,
    minLength: 1,
    maxLength: 100,
    default: ''
  },
  'oss_bucket': {
    type: 'string',
    required: false,
    minLength: 1,
    maxLength: 100,
    default: 'aibotboke'
  },
  'oss_region': {
    type: 'string',
    required: false,
    enum: ['oss-cn-shenzhen', 'oss-cn-hangzhou', 'oss-cn-shanghai', 'oss-cn-beijing', 'oss-cn-guangzhou', 'oss-cn-hongkong'],
    default: 'oss-cn-shenzhen'
  },
  'oss_endpoint': {
    type: 'string',
    required: false,
    pattern: /^https?:\/\/.+/,
    default: 'oss-cn-shenzhen.aliyuncs.com'
  },
  'oss_accelerate_domain': {
    type: 'string',
    required: false,
    pattern: /^https:\/\/.+/,
    default: 'https://boke.skym178.com'
  },
  'oss_bucket_domain': {
    type: 'string',
    required: false,
    pattern: /^https:\/\/.+/,
    default: 'https://aibotboke.oss-cn-shenzhen.aliyuncs.com'
  },
  'oss_use_accelerate': {
    type: 'boolean',
    required: false,
    default: true,
    description: '是否使用传输加速域名'
  }
};

/**
 * 验证单个配置值
 * @param {string} key - 配置键
 * @param {*} value - 配置值
 * @returns {{valid: boolean, error?: string, normalized?: *}} 验证结果
 */
function validateConfig(key, value) {
  const rule = CONFIG_RULES[key];
  
  if (!rule) {
    // 未知的配置键，允许通过但给出警告
    return { valid: true, normalized: value };
  }
  
  // 如果值为空且不是必需的，返回默认值
  if ((value === null || value === undefined || value === '') && !rule.required) {
    return { valid: true, normalized: rule.default };
  }
  
  // 如果值为空且是必需的，返回错误
  if ((value === null || value === undefined || value === '') && rule.required) {
    return { valid: false, error: `配置项 ${key} 是必需的` };
  }
  
  // 类型验证
  if (rule.type === 'number') {
    const numValue = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(numValue)) {
      return { valid: false, error: `配置项 ${key} 必须是数字` };
    }
    
    // 范围验证
    if (rule.min !== undefined && numValue < rule.min) {
      return { valid: false, error: `配置项 ${key} 不能小于 ${rule.min}` };
    }
    if (rule.max !== undefined && numValue > rule.max) {
      return { valid: false, error: `配置项 ${key} 不能大于 ${rule.max}` };
    }
    
    return { valid: true, normalized: numValue };
  }
  
  if (rule.type === 'string') {
    const strValue = String(value);
    
    // 长度验证
    if (rule.minLength !== undefined && strValue.length < rule.minLength) {
      return { valid: false, error: `配置项 ${key} 长度不能小于 ${rule.minLength}` };
    }
    if (rule.maxLength !== undefined && strValue.length > rule.maxLength) {
      return { valid: false, error: `配置项 ${key} 长度不能大于 ${rule.maxLength}` };
    }
    
    // 模式验证
    if (rule.pattern && !rule.pattern.test(strValue)) {
      return { valid: false, error: `配置项 ${key} 格式不正确` };
    }
    
    // 枚举验证
    if (rule.enum && !rule.enum.includes(strValue)) {
      return { valid: false, error: `配置项 ${key} 必须是以下值之一: ${rule.enum.join(', ')}` };
    }
    
    return { valid: true, normalized: strValue };
  }
  
  if (rule.type === 'boolean') {
    // 处理字符串形式的boolean值
    if (typeof value === 'string') {
      const lowerValue = value.toLowerCase().trim();
      if (lowerValue === 'true' || lowerValue === '1' || lowerValue === 'yes' || lowerValue === 'on') {
        return { valid: true, normalized: true };
      }
      if (lowerValue === 'false' || lowerValue === '0' || lowerValue === 'no' || lowerValue === 'off' || lowerValue === '') {
        return { valid: true, normalized: false };
      }
      return { valid: false, error: `配置项 ${key} 必须是布尔值` };
    }
    
    // 处理数字形式的boolean值
    if (typeof value === 'number') {
      return { valid: true, normalized: value !== 0 };
    }
    
    // 处理boolean值
    if (typeof value === 'boolean') {
      return { valid: true, normalized: value };
    }
    
    return { valid: false, error: `配置项 ${key} 必须是布尔值` };
  }
  
  return { valid: true, normalized: value };
}

/**
 * 验证多个配置值
 * @param {Object} configs - 配置对象
 * @returns {{valid: boolean, errors?: Object, normalized?: Object}} 验证结果
 */
function validateConfigs(configs) {
  const errors = {};
  const normalized = {};
  
  for (const [key, value] of Object.entries(configs)) {
    const result = validateConfig(key, value);
    if (!result.valid) {
      errors[key] = result.error;
    } else {
      normalized[key] = result.normalized;
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
    normalized: normalized
  };
}

/**
 * 获取配置的默认值
 * @param {string} key - 配置键
 * @returns {*} 默认值
 */
function getDefaultValue(key) {
  const rule = CONFIG_RULES[key];
  return rule ? rule.default : undefined;
}

/**
 * 检查配置是否为敏感信息
 * @param {string} key - 配置键
 * @returns {boolean} 是否为敏感信息
 */
function isSensitive(key) {
  const rule = CONFIG_RULES[key];
  return rule ? !!rule.sensitive : false;
}

/**
 * 加密敏感配置值（简单加密，实际生产环境应使用更强的加密）
 * @param {string} value - 原始值
 * @param {string} secret - 加密密钥（从环境变量获取）
 * @returns {string} 加密后的值
 */
function encryptSensitiveValue(value, secret) {
  if (!value || !secret) return value;
  
  try {
    const algorithm = 'aes-256-cbc';
    const key = crypto.createHash('sha256').update(secret).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return iv.toString('hex') + ':' + encrypted;
  } catch (error) {
    console.error('加密配置值失败:', error);
    return value;
  }
}

/**
 * 解密敏感配置值
 * @param {string} encryptedValue - 加密后的值
 * @param {string} secret - 解密密钥（从环境变量获取）
 * @returns {string} 解密后的值
 */
function decryptSensitiveValue(encryptedValue, secret) {
  if (!encryptedValue || !secret) return encryptedValue;
  
  try {
    const parts = encryptedValue.split(':');
    if (parts.length !== 2) return encryptedValue; // 未加密的值
    
    const algorithm = 'aes-256-cbc';
    const key = crypto.createHash('sha256').update(secret).digest();
    const iv = Buffer.from(parts[0], 'hex');
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('解密配置值失败:', error);
    return encryptedValue;
  }
}

module.exports = {
  validateConfig,
  validateConfigs,
  getDefaultValue,
  isSensitive,
  encryptSensitiveValue,
  decryptSensitiveValue,
  CONFIG_RULES
};
