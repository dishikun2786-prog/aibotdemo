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

// ============================================================
// 营销视频缓存
// ============================================================

const MARKETING_CACHE_TTL = {
  VIDEO_DETAIL: 300,      // 视频详情缓存5分钟
  VIDEO_LIST: 60,         // 视频列表缓存1分钟
  VIDEO_HOT: 300,          // 热门视频缓存5分钟
  COMMENT_LIST: 30          // 评论列表缓存30秒
};

const MARKETING_CACHE_KEYS = {
  VIDEO_DETAIL: (videoId) => `marketing:video:detail:${videoId}`,
  VIDEO_LIST: (userId) => `marketing:video:list:${userId}`,
  VIDEO_HOT: 'marketing:video:hot',
  COMMENT_LIST: (videoId) => `marketing:video:comments:${videoId}`
};

/**
 * 获取视频详情（带缓存）
 * @param {string} videoId - 视频ID
 * @returns {Promise<Object|null>}
 */
async function getVideoDetail(videoId) {
  const cacheKey = MARKETING_CACHE_KEYS.VIDEO_DETAIL(videoId);

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      // 确保返回对象或null
      return typeof cached === 'object' ? cached : null;
    }
  } catch (err) {
    console.error('Redis获取视频详情失败:', err.message);
  }

  // 缓存未命中，从MongoDB查询
  const video = await mongo.getMarketingVideoById(videoId);
  if (!video) {
    return null;
  }

  // 转换为下划线命名
  const result = formatVideoForAPI(video);

  // 存入Redis缓存
  try {
    await redis.set(cacheKey, result, MARKETING_CACHE_TTL.VIDEO_DETAIL);
  } catch (err) {
    console.error('Redis缓存视频详情失败:', err.message);
  }

  return result;
}

/**
 * 获取用户视频列表（带缓存）
 * @param {number} userId - 用户ID
 * @param {Array<string>} likedVideoIds - 用户点赞的视频ID列表
 * @returns {Promise<Array>}
 */
async function getUserVideoList(userId, likedVideoIds = []) {
  const cacheKey = MARKETING_CACHE_KEYS.VIDEO_LIST(userId);

  try {
    const cached = await redis.get(cacheKey);
    if (cached && Array.isArray(cached)) {
      // 如果传入了点赞列表，添加 is_liked 字段
      if (likedVideoIds.length > 0) {
        return cached.map(v => ({
          ...v,
          is_liked: likedVideoIds.includes(v.video_id)
        }));
      }
      return cached;
    }
  } catch (err) {
    console.error('Redis获取视频列表失败:', err.message);
  }

  // 缓存未命中，从MongoDB查询
  const result = await mongo.getMarketingVideosByUser(userId, { limit: 50 });

  // 转换为下划线命名
  let videos = (result.videos || []).map(v => formatVideoForAPI(v, likedVideoIds));

  // 存入Redis缓存
  try {
    await redis.set(cacheKey, videos, MARKETING_CACHE_TTL.VIDEO_LIST);
  } catch (err) {
    console.error('Redis缓存视频列表失败:', err.message);
  }

  return videos;
}

/**
 * 获取热门视频（带缓存）
 * @returns {Promise<Array>}
 */
async function getHotVideos() {
  const cacheKey = MARKETING_CACHE_KEYS.VIDEO_HOT;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      // 确保返回数组
      return Array.isArray(cached) ? cached : [];
    }
  } catch (err) {
    console.error('Redis获取热门视频失败:', err.message);
  }

  // 缓存未命中，从MongoDB查询
  const videos = await mongo.getHotMarketingVideos(20);

  // 转换为下划线命名
  const result = (videos || []).map(formatVideoForAPI);

  // 存入Redis缓存
  try {
    await redis.set(cacheKey, result, MARKETING_CACHE_TTL.VIDEO_HOT);
  } catch (err) {
    console.error('Redis缓存热门视频失败:', err.message);
  }

  return result;
}

/**
 * 获取视频评论列表（带缓存）
 * @param {string} videoId - 视频ID
 * @returns {Promise<Array>}
 */
async function getVideoCommentList(videoId) {
  const cacheKey = MARKETING_CACHE_KEYS.COMMENT_LIST(videoId);

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      // 确保返回数组
      return Array.isArray(cached) ? cached : [];
    }
  } catch (err) {
    console.error('Redis获取评论列表失败:', err.message);
  }

  // 缓存未命中，从MongoDB查询
  const result = await mongo.getVideoComments(videoId, { limit: 50 });

  // 转换为下划线命名
  const comments = (result.comments || []).map(formatCommentForAPI);

  // 存入Redis缓存
  try {
    await redis.set(cacheKey, comments, MARKETING_CACHE_TTL.COMMENT_LIST);
  } catch (err) {
    console.error('Redis缓存评论列表失败:', err.message);
  }

  return comments;
}

/**
 * 清除视频缓存
 * @param {string} videoId - 视频ID
 * @param {number} userId - 用户ID
 */
async function clearVideoCache(videoId, userId) {
  try {
    if (videoId) {
      await redis.del(MARKETING_CACHE_KEYS.VIDEO_DETAIL(videoId));
      await redis.del(MARKETING_CACHE_KEYS.COMMENT_LIST(videoId));
    }
    if (userId) {
      await redis.del(MARKETING_CACHE_KEYS.VIDEO_LIST(userId));
    }
    // 热门视频列表也可能变化
    await redis.del(MARKETING_CACHE_KEYS.VIDEO_HOT);
  } catch (err) {
    console.error('清除视频缓存失败:', err.message);
  }
}

/**
 * 增加视频观看次数（Redis计数 + 消息队列异步持久化）
 * @param {string} videoId - 视频ID
 */
async function incrementVideoViewCount(videoId) {
  try {
    // Redis原子计数
    await redis.incr(`marketing:video:views:${videoId}`);

    // 加入消息队列，异步批量持久化
    await redis.lpush('marketing:video:views:queue', videoId);
  } catch (err) {
    console.error('增加观看次数失败:', err.message);
  }
}

/**
 * 处理视频观看次数队列（后台任务调用）
 */
async function processVideoViewsQueue() {
  const processed = new Set();

  while (true) {
    try {
      const videoId = await redis.rpop('marketing:video:views:queue');
      if (!videoId) break;

      // 避免重复处理同一个视频
      if (processed.has(videoId)) {
        continue;
      }
      processed.add(videoId);

      const views = await redis.get(`marketing:video:views:${videoId}`);
      if (views && parseInt(views) > 0) {
        // 批量更新到MongoDB
        await mongo.incrementVideoViews(videoId, parseInt(views));

        // 清除视频详情缓存
        await clearVideoCache(videoId, null);

        // 重置Redis计数
        await redis.set(`marketing:video:views:${videoId}`, 0);
      }
    } catch (err) {
      console.error('处理视频观看队列失败:', err.message);
    }
  }
}

// ============================================================
// 上传任务队列（用于图片/视频异步上传）
// ============================================================

/**
 * 添加上传任务到队列
 * @param {Object} task - 上传任务 { type, userId, fileName, fileType, buffer, taskId }
 * @returns {string} 任务ID
 */
async function addUploadTask(task) {
  const taskId = 'upload_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const uploadTask = {
    taskId,
    ...task,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  // 存储任务详情
  await redis.set(
    `marketing:upload:task:${taskId}`,
    JSON.stringify(uploadTask),
    3600 // 1小时过期
  );

  // 加入处理队列
  await redis.lPush('marketing:upload:queue', taskId);

  return taskId;
}

/**
 * 获取上传任务状态
 * @param {string} taskId - 任务ID
 * @returns {Object|null} 任务状态
 */
async function getUploadTaskStatus(taskId) {
  const task = await redis.get(`marketing:upload:task:${taskId}`);
  return task ? JSON.parse(task) : null;
}

/**
 * 处理上传任务队列
 */
async function processUploadQueue() {
  const oss = require('./oss');
  // 直接使用环境变量或默认值
  const accelerateDomain = process.env.OSS_ACCELERATE_DOMAIN || 'https://boke.skym178.com';

  while (true) {
    const taskId = await redis.lPop('marketing:upload:queue');
    if (!taskId) break;

    try {
      const taskData = await redis.get(`marketing:upload:task:${taskId}`);
      if (!taskData) continue;

      const task = JSON.parse(taskData);
      if (task.status !== 'pending') continue;

      // 更新状态为处理中
      task.status = 'processing';
      task.startedAt = new Date().toISOString();
      await redis.set(`marketing:upload:task:${taskId}`, JSON.stringify(task), 3600);

      try {
        // 执行上传
        const ext = task.fileName.substring(task.fileName.lastIndexOf('.'));
        const objectName = `marketing/${task.type === 'image' ? 'media-images' : 'media-videos'}/${task.userId}_${Date.now()}${ext}`;

        const result = await oss.uploadBuffer(objectName, Buffer.from(task.buffer), {
          contentType: task.fileType
        });

        const fileUrl = accelerateDomain + '/' + objectName;

        // 更新任务状态为完成
        task.status = 'completed';
        task.fileUrl = fileUrl;
        task.completedAt = new Date().toISOString();
        await redis.set(`marketing:upload:task:${taskId}`, JSON.stringify(task), 3600);

        console.log(`上传任务完成: ${taskId}, URL: ${fileUrl}`);
      } catch (uploadErr) {
        console.error(`上传任务失败: ${taskId}`, uploadErr);
        task.status = 'failed';
        task.error = uploadErr.message;
        await redis.set(`marketing:upload:task:${taskId}`, JSON.stringify(task), 3600);
      }
    } catch (err) {
      console.error('处理上传任务出错:', err);
    }
  }
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 格式化视频数据为API响应格式（下划线命名）
 * @param {Object} video - MongoDB视频文档
 * @param {Array<string>} likedVideoIds - 用户点赞的视频ID列表
 * @returns {Object}
 */
function formatVideoForAPI(video, likedVideoIds = []) {
  if (!video) return null;
  const result = {
    video_id: video.video_id,
    user_id: video.user_id,
    username: video.username || '',
    title: video.title,
    description: video.description,
    cover_image: video.cover_image,
    video_url: video.video_url,
    duration: video.duration || 0,
    custom_menu: video.custom_menu || [],
    views_count: video.views_count || 0,
    likes_count: video.likes_count || 0,
    comments_count: video.comments_count || 0,
    created_at: video.created_at,
    updated_at: video.updated_at
  };
  // 添加点赞状态
  if (likedVideoIds.length > 0) {
    result.is_liked = likedVideoIds.includes(video.video_id);
  }
  return result;
}

/**
 * 格式化评论数据为API响应格式（下划线命名）
 * @param {Object} comment - MongoDB评论文档
 * @returns {Object}
 */
function formatCommentForAPI(comment) {
  if (!comment) return null;
  return {
    comment_id: comment.comment_id,
    video_id: comment.video_id,
    user_id: comment.user_id,
    username: comment.username,
    avatar_url: comment.avatar_url,
    content: comment.content,
    created_at: comment.created_at
  };
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

  // 营销视频缓存
  getVideoDetail,
  getUserVideoList,
  getHotVideos,
  getVideoCommentList,
  clearVideoCache,
  // incrementVideoViewCount, // 已移除，使用直接写入MongoDB
  // processVideoViewsQueue, // 已移除

  // 上传任务队列
  addUploadTask,
  getUploadTaskStatus,
  processUploadQueue,

  // 缓存配置
  CACHE_TTL,
  MARKETING_CACHE_TTL
};
