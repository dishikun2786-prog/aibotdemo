/**
 * @file cache.js
 * @module utils/cache
 * @description 分身客服缓存模块，提供分身配置、AI配置、会话上下文的缓存功能
 *              支持Redis降级，Redis不可用时回退到直接数据库查询
 */

const db = require('./db');
const mongo = require('./mongo');
const redis = require('./redis');

const CACHE_TTL = {
  AVATAR_CONFIG: 300,      // 分身配置缓存5分钟
  AI_CONFIG: 60,           // AI配置缓存1分钟
  SESSION_CONTEXT: 600,    // 会话上下文缓存10分钟
  KNOWLEDGE_BASE: 300,    // 知识库缓存5分钟
  KEYWORD_INDEX: 300       // 关键词索引缓存5分钟
};

const CACHE_KEYS = {
  AVATAR_CONFIG: (avatarId) => `avatar:config:${avatarId}`,
  AI_CONFIG: 'ai:config:global',
  SESSION_CONTEXT: (sessionId) => `session:context:${sessionId}`,
  KNOWLEDGE_BASE: (avatarId) => `avatar:knowledge:${avatarId}`,
  KEYWORD_INDEX: (avatarId) => `avatar:keyword:${avatarId}`  // 关键词索引缓存
};

/**
 * 获取分身配置（带缓存）
 * @param {string} avatarId - 分身ID
 * @returns {Promise<Object>} 分身配置对象
 */
async function getAvatarConfig(avatarId) {
  const cacheKey = CACHE_KEYS.AVATAR_CONFIG(avatarId);

  // 尝试从Redis获取缓存
  const cached = await redis.get(cacheKey);
  if (cached) {
    return cached;
  }

  // 缓存未命中，从数据库查询
  const avatars = await db.query(
    'SELECT * FROM ai_agent_avatars WHERE avatar_id = ?',
    [avatarId]
  );

  if (avatars.length === 0) {
    return null;
  }

  const config = avatars[0];

  // 存入Redis缓存
  await redis.set(cacheKey, config, CACHE_TTL.AVATAR_CONFIG);

  return config;
}

/**
 * 清除分身配置缓存
 * @param {string} avatarId - 分身ID
 */
async function clearAvatarConfig(avatarId) {
  await redis.del(CACHE_KEYS.AVATAR_CONFIG(avatarId));
}

/**
 * 获取AI服务配置（带缓存）
 * @returns {Promise<Object>} AI配置对象 { ai_provider, web_search_enabled }
 */
async function getAIConfig() {
  const cacheKey = CACHE_KEYS.AI_CONFIG;

  // 尝试从Redis获取缓存
  const cached = await redis.get(cacheKey);
  if (cached) {
    return cached;
  }

  // 缓存未命中，从数据库查询
  const configRows = await db.query(
    'SELECT config_key, config_value FROM game_config WHERE config_key IN (?, ?)',
    ['ai_provider', 'ai_agent_web_search_enabled']
  );

  const configMap = {};
  configRows.forEach(row => {
    configMap[row.config_key] = row.config_value;
  });

  const config = {
    ai_provider: configMap.ai_provider || 'bailian',
    web_search_enabled: configMap.ai_agent_web_search_enabled === 'true' || configMap.ai_agent_web_search_enabled === '1'
  };

  // 存入Redis缓存
  await redis.set(cacheKey, config, CACHE_TTL.AI_CONFIG);

  return config;
}

/**
 * 清除AI配置缓存
 */
async function clearAIConfig() {
  await redis.del(CACHE_KEYS.AI_CONFIG);
}

/**
 * 获取会话上下文（带缓存）
 * 包含会话信息、分身配置、知识库基础信息
 * @param {string} sessionId - 会话ID
 * @returns {Promise<Object>} 会话上下文
 */
async function getSessionContext(sessionId) {
  const cacheKey = CACHE_KEYS.SESSION_CONTEXT(sessionId);

  // 尝试从Redis获取缓存
  const cached = await redis.get(cacheKey);
  if (cached) {
    return cached;
  }

  // 缓存未命中，查询完整上下文
  const session = await mongo.getAgentSession(sessionId);
  if (!session) {
    return null;
  }

  // 并行查询关联数据
  const [avatarConfig, knowledgeBase] = await Promise.all([
    getAvatarConfig(session.avatarId),
    getKnowledgeBase(session.avatarId)
  ]);

  const context = {
    session,
    avatarConfig,
    knowledgeBase,
    createdAt: Date.now()
  };

  // 存入Redis缓存
  await redis.set(cacheKey, context, CACHE_TTL.SESSION_CONTEXT);

  return context;
}

/**
 * 清除会话上下文缓存
 * @param {string} sessionId - 会话ID
 */
async function clearSessionContext(sessionId) {
  await redis.del(CACHE_KEYS.SESSION_CONTEXT(sessionId));
}

/**
 * 获取知识库（带缓存）
 * @param {string} avatarId - 分身ID
 * @returns {Promise<Object>} 知识库对象
 */
async function getKnowledgeBase(avatarId) {
  const cacheKey = CACHE_KEYS.KNOWLEDGE_BASE(avatarId);

  // 尝试从Redis获取缓存
  const cached = await redis.get(cacheKey);
  if (cached) {
    return cached;
  }

  // 缓存未命中，从MongoDB查询
  const knowledgeBase = await mongo.getAgentKnowledgeBase(avatarId);

  if (!knowledgeBase) {
    return null;
  }

  // 只缓存精简版知识库（用于系统提示词构建）
  const minifiedKB = {
    avatarId: knowledgeBase.avatarId,
    documents: knowledgeBase.documents ? knowledgeBase.documents.slice(-5) : [],
    longTermMemory: knowledgeBase.longTermMemory || null,
    updatedAt: knowledgeBase.updatedAt
  };

  // 存入Redis缓存
  await redis.set(cacheKey, minifiedKB, CACHE_TTL.KNOWLEDGE_BASE);

  return minifiedKB;
}

/**
 * 获取关键词索引（带缓存）
 * 构建倒排索引: keyword -> [{docId, title, content, matchType}]
 * @param {string} avatarId - 分身ID
 * @returns {Promise<Object>} 关键词索引对象
 */
async function getKeywordIndex(avatarId) {
  const cacheKey = CACHE_KEYS.KEYWORD_INDEX(avatarId);

  // 尝试从Redis获取缓存
  const cached = await redis.get(cacheKey);
  if (cached) {
    return cached;
  }

  // 缓存未命中，从MongoDB查询完整知识库
  const knowledgeBase = await mongo.getAgentKnowledgeBase(avatarId);

  if (!knowledgeBase || !knowledgeBase.documents) {
    return { index: {}, docCount: 0 };
  }

  // 构建倒排索引
  const index = {};
  for (const doc of knowledgeBase.documents) {
    const keywords = doc.keywords || [];
    const tags = doc.tags || [];

    // 索引关键词
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (!index[kwLower]) {
        index[kwLower] = [];
      }
      index[kwLower].push({
        docId: doc.id,
        title: doc.title,
        content: doc.content,
        matchType: 'keyword'
      });
    }

    // 索引标签
    for (const tag of tags) {
      const tagLower = tag.toLowerCase();
      if (!index[tagLower]) {
        index[tagLower] = [];
      }
      index[tagLower].push({
        docId: doc.id,
        title: doc.title,
        content: doc.content,
        matchType: 'tag'
      });
    }
  }

  const result = { index, docCount: knowledgeBase.documents.length };

  // 存入Redis缓存
  await redis.set(cacheKey, result, CACHE_TTL.KEYWORD_INDEX);

  return result;
}

/**
 * 清除知识库缓存
 * @param {string} avatarId - 分身ID
 */
async function clearKnowledgeBase(avatarId) {
  await redis.del(CACHE_KEYS.KNOWLEDGE_BASE(avatarId));
  await redis.del(CACHE_KEYS.KEYWORD_INDEX(avatarId));  // 同时清除关键词索引
}

/**
 * 批量清除与分身相关的所有缓存
 * @param {string} avatarId - 分身ID
 */
async function clearAvatarCaches(avatarId) {
  await Promise.all([
    clearAvatarConfig(avatarId),
    clearKnowledgeBase(avatarId)
  ]);
}

/**
 * 预加载会话上下文到缓存
 * 在用户加入会话时调用
 * @param {string} sessionId - 会话ID
 */
async function preloadSessionContext(sessionId) {
  try {
    await getSessionContext(sessionId);
  } catch (err) {
    console.error('[Cache] 预加载会话上下文失败:', err.message);
    // 降级处理：不抛出错误，让后续请求直接查询数据库
  }
}

/**
 * 获取对话历史（带缓存）
 * @param {string} sessionId - 会话ID
 * @param {number} limit - 获取条数
 * @returns {Promise<Array>} 对话历史数组
 */
async function getConversationHistory(sessionId, limit = 10) {
  // 对话历史使用短时缓存（30秒），避免频繁查询但保证一定时效性
  const cacheKey = `chat:history:${sessionId}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      // 如果有缓存，直接返回并应用limit
      const allMessages = cached;
      return limit ? allMessages.slice(-limit) : allMessages;
    }
  } catch (err) {
    console.error('[Cache] 获取对话历史缓存失败:', err.message);
  }

  // 缓存未命中，从MongoDB查询
  const messages = await mongo.getSessionMessages(sessionId);

  // 缓存结果（短时缓存30秒）
  try {
    await redis.set(cacheKey, messages, 30);
  } catch (err) {
    console.error('[Cache] 设置对话历史缓存失败:', err.message);
  }

  return limit ? messages.slice(-limit) : messages;
}

/**
 * 获取精简的知识库内容用于系统提示词
 * @param {Object} knowledgeBase - 知识库对象
 * @returns {string} 构建好的系统提示词片段
 */
function buildKnowledgePrompt(knowledgeBase) {
  if (!knowledgeBase) {
    return '';
  }

  let prompt = '';

  // 添加知识文档
  if (knowledgeBase.documents && knowledgeBase.documents.length > 0) {
    const maxLen = 5000;
    let docsText = knowledgeBase.documents.map(d => `【文档：${d.title}】\n${d.content}`).join('\n\n');
    if (docsText.length > maxLen) {
      docsText = docsText.substring(0, maxLen) + '...(内容已截断)';
    }
    prompt += `\n\n以下是知识库内容：\n${docsText}`;
  }

  // 添加长期记忆
  if (knowledgeBase.longTermMemory) {
    const { roleDescription, personality, knowledge } = knowledgeBase.longTermMemory;
    let memoryText = '';
    if (roleDescription) memoryText += `\n角色设定：${roleDescription}`;
    if (personality) memoryText += `\n性格特点：${personality}`;
    if (knowledge) memoryText += `\n专业知识：${knowledge}`;
    if (memoryText) {
      prompt += `\n\n用户的长期记忆：${memoryText}`;
    }
  }

  return prompt;
}

module.exports = {
  // 配置缓存
  getAvatarConfig,
  clearAvatarConfig,
  getAIConfig,
  clearAIConfig,

  // 会话上下文缓存
  getSessionContext,
  clearSessionContext,
  preloadSessionContext,

  // 知识库缓存
  getKnowledgeBase,
  getKeywordIndex,  // 关键词索引
  clearKnowledgeBase,
  clearAvatarCaches,

  // 对话历史
  getConversationHistory,

  // 工具函数
  buildKnowledgePrompt,

  // 缓存配置
  CACHE_TTL
};
