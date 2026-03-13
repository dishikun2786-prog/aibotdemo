/**
 * @file agent-chat.js
 * @module routes/agent-chat
 * @description AI分身公开聊天路由：匿名会话、免登录对话
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../utils/db');
const mongo = require('../utils/mongo');
const cache = require('../utils/cache');
const redis = require('../utils/redis');
const minimax = require('../utils/minimax');
const bailian = require('../utils/bailian');
const messageQueue = require('../services/message-queue');
const { getAgentChatIO } = require('../socket');

// 图片上传配置
const CHAT_IMAGES_DIR = path.join(__dirname, '../../public/uploads/chat-images');
const CHAT_IMAGE_PATH_PREFIX = '/uploads/chat-images/';

// 确保上传目录存在
if (!fs.existsSync(CHAT_IMAGES_DIR)) {
  fs.mkdirSync(CHAT_IMAGES_DIR, { recursive: true });
}

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CHAT_IMAGES_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (!allowedExts.includes(ext)) {
      return cb(new Error('不支持的图片格式'), false);
    }
    const name = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + ext;
    cb(null, name);
  }
});

const uploadImage = multer({
  storage: imageStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('仅支持 JPG、PNG、GIF、WebP 格式图片'), false);
    }
    cb(null, true);
  }
});

// 配置缓存
let configCache = {
  aiProvider: null,
  energyCost: null,
  webSearchEnergyCost: null,
  webSearchEnabled: null,
  lastUpdate: 0
};
const CACHE_TTL = 300000; // 缓存5分钟

/**
 * 获取缓存的配置
 */
async function getCachedConfig() {
  const now = Date.now();
  if (configCache.lastUpdate && (now - configCache.lastUpdate) < CACHE_TTL) {
    return configCache;
  }

  // 缓存过期或未初始化，重新获取
  try {
    const rows = await db.query(
      'SELECT config_key, config_value FROM game_config WHERE config_key IN (?, ?, ?, ?, ?, ?)',
      ['ai_provider', 'agent_chat_energy_cost', 'agent_chat_web_search_energy_cost', 'ai_agent_web_search_enabled', 'ai_agent_energy_cost', 'ai_agent_web_search_energy_cost']
    );

    const configMap = {};
    rows.forEach(row => { configMap[row.config_key] = row.config_value; });

    // 分身客服优先使用专用配置，为空时回退到AI实验室通用配置
    const agentChatEnergyCost = configMap.agent_chat_energy_cost;
    const agentChatWebSearchEnergyCost = configMap.agent_chat_web_search_energy_cost;

    configCache = {
      aiProvider: (configMap.ai_provider || '').toLowerCase().trim() === 'bailian' ? 'bailian' : 'minimax',
      energyCost: parseInt(agentChatEnergyCost, 10) || parseInt(configMap.ai_agent_energy_cost, 10) || 5,
      webSearchEnergyCost: parseInt(agentChatWebSearchEnergyCost, 10) || parseInt(configMap.ai_agent_web_search_energy_cost, 10) || 5,
      webSearchEnabled: configMap.ai_agent_web_search_enabled === 'true' || configMap.ai_agent_web_search_enabled === '1',
      lastUpdate: now
    };
  } catch (e) {
    console.error('[agent-chat] 配置缓存获取失败:', e.message);
  }

  return configCache;
}

/**
 * 获取客户端IP
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    'unknown';
}

/**
 * 验证链接有效性
 */
async function verifyLink(avatarId, linkToken) {
  const rows = await db.query(
    `SELECT l.*, a.name as avatar_name, a.status as avatar_status, a.prompt_template, a.chat_style, a.user_id as creator_user_id
     FROM ai_agent_links l
     JOIN ai_agent_avatars a ON l.avatar_id = a.avatar_id
     WHERE l.avatar_id = ? AND l.link_token = ? AND l.is_active = 1`,
    [avatarId, linkToken]
  );

  if (rows.length === 0) {
    return null;
  }

  const link = rows[0];

  // 检查链接是否过期
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    return { error: '链接已过期' };
  }

  // 检查消息数限制
  if (link.max_messages !== null) {
    const messages = await mongo.getSessionMessages('s_' + linkToken);
    if (messages.length >= link.max_messages) {
      return { error: '已达到最大消息数限制' };
    }
  }

  // 检查分身是否启用
  if (link.avatar_status !== 1) {
    return { error: '该分身已禁用' };
  }

  return link;
}

/**
 * 获取AI服务模块
 */
async function getAiProviderModule() {
  const cached = await getCachedConfig();
  return cached.aiProvider === 'bailian' ? bailian : minimax;
}

/**
 * 获取客服对话能量消耗配置
 */
async function getChatEnergyCost() {
  const cached = await getCachedConfig();
  return cached.energyCost || 0;
}

/**
 * 获取客服联网搜索额外能量消耗配置
 */
async function getWebSearchEnergyCost() {
  const cached = await getCachedConfig();
  return cached.webSearchEnergyCost || 0;
}

/**
 * 检查全局联网搜索是否启用
 */
async function isWebSearchEnabled() {
  const cached = await getCachedConfig();
  return cached.webSearchEnabled || false;
}

/**
 * 尝试关键词匹配知识库内容
 * @param {string} avatar_id - 分身ID
 * @param {string} userMessage - 用户消息
 * @param {Object} knowledgeBase - 知识库对象
 * @returns {Promise<Object|null>} 匹配结果或null
 */
/**
 * 尝试关键词匹配知识库内容（使用倒排索引优化）
 * @param {string} avatar_id - 分身ID
 * @param {string} userMessage - 用户消息
 * @param {Object} knowledgeBase - 知识库对象（用于备用）
 * @returns {Promise<Object|null>} 匹配结果或null
 */
async function tryKeywordMatch(avatar_id, userMessage, knowledgeBase) {
  try {
    if (!userMessage || userMessage.trim().length < 2) {
      return null;
    }

    console.log(`[agent-chat] 关键词匹配: 用户消息: "${userMessage}"`);

    // 使用缓存的关键词索引
    const { index, docCount } = await cache.getKeywordIndex(avatar_id);

    if (docCount === 0) {
      console.log(`[agent-chat] 关键词匹配: 知识库为空`);
      return null;
    }

    console.log(`[agent-chat] 关键词匹配: 索引中有${docCount}篇文档，共${Object.keys(index).length}个关键词`);

    const messageLower = userMessage.toLowerCase();
    const words = messageLower.split(/[\s,，。.!?:;]+/).filter(w => w.length >= 2);

    // 收集所有匹配结果
    const matches = [];

    for (const word of words) {
      // 精确匹配
      if (index[word]) {
        for (const match of index[word]) {
          matches.push(match);
        }
      }

      // 模糊匹配（包含关系）
      for (const [keyword, docs] of Object.entries(index)) {
        if (keyword.includes(word) || word.includes(keyword)) {
          for (const match of docs) {
            if (!matches.find(m => m.docId === match.docId)) {
              matches.push(match);
            }
          }
        }
      }
    }

    if (matches.length > 0) {
      // 优先返回关键词匹配，然后是标签匹配
      matches.sort((a, b) => {
        if (a.matchType === 'keyword' && b.matchType !== 'keyword') return -1;
        if (a.matchType !== 'keyword' && b.matchType === 'keyword') return 1;
        return 0;
      });

      const bestMatch = matches[0];
      console.log(`[agent-chat] 关键词匹配成功: ${bestMatch.title}, 匹配类型: ${bestMatch.matchType}`);
      return {
        content: bestMatch.content,
        title: bestMatch.title,
        matchType: bestMatch.matchType
      };
    }

    console.log(`[agent-chat] 关键词匹配: 未找到匹配`);
    return null;
  } catch (err) {
    console.error('[agent-chat] 关键词匹配失败:', err);
    return null;
  }
}

/**
 * 获取分身欢迎语（公开接口）
 * GET /api/agent-chat/welcome/:avatar_id
 */
router.get('/welcome/:avatar_id', async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const { session_secret } = req.query;

    if (!session_secret) {
      return res.status(400).json({ error: '缺少会话密钥' });
    }

    // 验证链接有效性
    const [link] = await db.query(
      'SELECT * FROM ai_agent_links WHERE avatar_id = ? AND link_token = ? AND is_active = 1',
      [avatar_id, session_secret]
    );

    if (!link) {
      return res.status(404).json({ error: '链接无效或已失效' });
    }

    // 获取分身欢迎语
    const [avatar] = await db.query(
      'SELECT welcome_message, name FROM ai_agent_avatars WHERE avatar_id = ?',
      [avatar_id]
    );

    // 默认欢迎语
    const defaultWelcome = avatar?.welcome_message || `你好！我是${avatar?.name || 'AI助手'}，有什么可以帮你的吗？`;

    res.json({
      success: true,
      data: {
        welcome_message: defaultWelcome,
        avatar_name: avatar?.name
      }
    });
  } catch (err) {
    console.error('[agent-chat] 获取欢迎语失败:', err);
    res.status(500).json({ error: '获取欢迎语失败' });
  }
});

/**
 * 验证链接并获取会话（公开接口）
 * GET /api/agent-chat/verify/:avatar_id
 */
router.get('/verify/:avatar_id', async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ error: '缺少token参数' });
    }

    // 验证链接
    const link = await verifyLink(avatar_id, token);

    if (!link) {
      return res.status(404).json({ error: '链接无效' });
    }

    if (link.error) {
      return res.status(403).json({ error: link.error });
    }

    // 获取知识库（使用缓存）
    const knowledgeBase = await cache.getKnowledgeBase(avatar_id);

    // 预加载AI配置缓存（异步，不阻塞响应）
    cache.getAIConfig().catch(err => console.error('[agent-chat] 预加载AI配置失败:', err.message));

    res.json({
      success: true,
      avatar: {
        avatar_id: avatar_id,
        name: link.avatar_name,
        prompt_template: link.prompt_template,
        chat_style: link.chat_style || 'modern'
      },
      knowledge_base: knowledgeBase,
      session_info: {
        expires_at: link.expires_at,
        max_messages: link.max_messages
      }
    });
  } catch (error) {
    console.error('[agent-chat] 验证链接失败:', error);
    res.status(500).json({ error: '验证链接失败' });
  }
});

/**
 * 创建新的匿名会话（通过分享链接）
 * POST /api/agent-chat/create-session
 */
router.post('/create-session', async (req, res) => {
  try {
    const { avatar_id } = req.body;
    const { token } = req.query;
    const visitorIp = getClientIp(req);

    if (!avatar_id) {
      return res.status(400).json({ error: '缺少avatar_id参数' });
    }

    if (!token) {
      return res.status(400).json({ error: '缺少token参数' });
    }

    // 验证链接
    const link = await verifyLink(avatar_id, token);

    if (!link) {
      return res.status(404).json({ error: '链接无效' });
    }

    if (link.error) {
      return res.status(403).json({ error: link.error });
    }

    // 创建会话
    const sessionId = await mongo.createAgentSession(avatar_id, visitorIp, link.expires_at);

    res.json({
      success: true,
      session_id: sessionId,
      avatar: {
        avatar_id,
        name: link.avatar_name
      }
    });
  } catch (error) {
    console.error('[agent-chat] 创建会话失败:', error);
    res.status(500).json({ error: '创建会话失败' });
  }
});

/**
 * 匿名用户发送消息
 * POST /api/agent-chat/message
 */
router.post('/message', async (req, res) => {
  try {
    const { avatar_id, session_id, message, image_url, enable_search } = req.body;
    const { token } = req.query;
    const visitorIp = getClientIp(req);

    if (!avatar_id) {
      return res.status(400).json({ error: '缺少avatar_id参数' });
    }

    if (!token) {
      return res.status(400).json({ error: '缺少token参数' });
    }

    if (!message && !image_url) {
      return res.status(400).json({ error: '请输入消息内容' });
    }

    // 验证链接
    const link = await verifyLink(avatar_id, token);

    if (!link) {
      return res.status(404).json({ error: '链接无效' });
    }

    if (link.error) {
      return res.status(403).json({ error: link.error });
    }

    // 获取能量消耗配置（并行获取）
    const [energyCost, webSearchExtraCost, globalWebSearchEnabled] = await Promise.all([
      getChatEnergyCost(),
      getWebSearchEnergyCost(),
      isWebSearchEnabled()
    ]);
    // 只有全局开关开启且用户选择了联网时才真正启用联网
    const isSearchEnabled = globalWebSearchEnabled && (enable_search === true);
    const totalEnergyCost = energyCost + (isSearchEnabled ? webSearchExtraCost : 0);

    // 获取分身创建者ID（用于能量扣减）
    const creatorUserId = link.creator_user_id;

    // 如果需要消耗能量且有创建者ID，进行能量前置检查和扣减
    if (totalEnergyCost > 0 && creatorUserId) {
      try {
        // 查询用户当前能量
        const [user] = await db.query('SELECT energy FROM users WHERE id = ?', [creatorUserId]);

        if (!user) {
          return res.status(404).json({ error: '用户不存在' });
        }

        // 前置检查：能量不足直接返回错误
        if (user.energy < totalEnergyCost) {
          return res.status(400).json({
            error: '能量不足',
            energy: user.energy,
            required: totalEnergyCost,
            web_search_enabled: isSearchEnabled
          });
        }

        // 通过消息队列异步扣减能量（不阻塞响应）
        await messageQueue.enqueueAgentChatTask({
          type: messageQueue.TASK_TYPES.DEDUCT_ENERGY,
          userId: creatorUserId,
          avatarId: avatar_id,
          sessionId: session_id || null,
          energyCost: totalEnergyCost,
          createdAt: new Date().toISOString()
        });
      } catch (err) {
        console.error('[agent-chat] 能量扣减失败:', err.message);
        // 能量扣减失败不阻断对话流程，记录日志继续执行
      }
    }

    // 获取或创建会话
    let sessionId = session_id;
    if (!sessionId) {
      sessionId = await mongo.createAgentSession(avatar_id, visitorIp, link.expires_at);
    }

    // 获取会话和知识库
    const session = await mongo.getAgentSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    // 构建用户消息显示用文字（区分纯文本和图片消息）
    const userMessageType = image_url ? 'image' : 'text';
    const userMessageText = image_url ? '[图片消息]' : (message || '');

    // 用于Socket广播的用户消息内容（非AI调用时）
    const userMessageContent = message || '';

    // 检查是否处于人工模式，如果是则不调用AI
    if (session.mode === 'human') {
      // 保存用户消息
      await mongo.addSessionMessage(sessionId, 'user', userMessageText, userMessageType, image_url);

      // 通过Socket广播给客服和用户 - 使用avatarId房间让所有相关人都能收到
      try {
        const agentChatIO = getAgentChatIO();
        const userMessageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const messageContent = {
          messageId: userMessageId,
          role: 'user',
          content: userMessageContent,
          messageType: userMessageType,
          imageUrl: image_url,
          timestamp: new Date(),
          read: false
        };
        // 发送给用户所在房间
        agentChatIO.to(`session:${sessionId}`).emit('new_message', messageContent);
        // 发送给该分身的所有客服
        agentChatIO.to(`avatar:${session.avatarId}`).emit('new_message', {
          ...messageContent,
          sessionId: sessionId
        });
      } catch (e) {
        console.error('Socket广播失败:', e.message);
      }

      return res.json({
        success: true,
        session_id: sessionId,
        message: {
          role: 'system',
          content: '【当前有人工客服为您服务，请稍候...】'
        },
        mode: 'human',
        waiting_human: false
      });
    }

    // 检查是否等待人工接入
    if (session.pendingHuman) {
      // 保存用户消息
      await mongo.addSessionMessage(sessionId, 'user', userMessageText, userMessageType, image_url);

      // 通过Socket广播给客服和用户
      try {
        const agentChatIO = getAgentChatIO();
        const userMessageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const messageContent = {
          messageId: userMessageId,
          role: 'user',
          content: userMessageContent,
          messageType: userMessageType,
          imageUrl: image_url,
          timestamp: new Date(),
          read: false
        };
        // 发送给用户
        agentChatIO.to(`session:${sessionId}`).emit('new_message', messageContent);
        // 发送给该分身的所有客服
        agentChatIO.to(`avatar:${session.avatarId}`).emit('new_message', {
          ...messageContent,
          sessionId: sessionId
        });
      } catch (e) {
        console.error('Socket广播失败:', e.message);
      }

      return res.json({
        success: true,
        session_id: sessionId,
        message: {
          role: 'system',
          content: '【正在为您转接人工客服，请稍候...】'
        },
        mode: 'ai',
        waiting_human: true
      });
    }

    // 获取知识库（使用缓存，但关键词匹配需要完整知识库）
    const knowledgeBase = await cache.getKnowledgeBase(avatar_id);

    // 尝试关键词匹配（使用缓存的倒排索引）
    const keywordMatchResult = await tryKeywordMatch(avatar_id, message);
    if (keywordMatchResult) {
      console.log(`[agent-chat] 关键词匹配成功: ${keywordMatchResult.title}`);

      // 保存用户消息
      await mongo.addSessionMessage(sessionId, 'user', userMessageText, userMessageType, image_url);

      // 广播用户消息
      try {
        const agentChatIO = getAgentChatIO();
        agentChatIO.to(`session:${sessionId}`).emit('new_message', userBroadcastContent);
        agentChatIO.to(`avatar:${session.avatarId}`).emit('new_message', {
          ...userBroadcastContent,
          sessionId: sessionId
        });

        // 广播关键词匹配结果（像AI响应一样）
        const aiContent = keywordMatchResult.content;

        agentChatIO.to(`session:${sessionId}`).emit('ai_stream_start', {
          messageId: aiMessageId,
          role: 'assistant'
        });

        // 一次性发送完整内容
        agentChatIO.to(`session:${sessionId}`).emit('ai_stream_end', {
          messageId: aiMessageId,
          content: aiContent,
          role: 'assistant',
          is_keyword_match: true,
          match_type: keywordMatchResult.matchType
        });

        // 客服端也发送
        agentChatIO.to(`avatar:${session.avatarId}`).emit('ai_stream_start', {
          messageId: aiMessageId,
          role: 'assistant',
          sessionId: sessionId
        });

        agentChatIO.to(`avatar:${session.avatarId}`).emit('ai_stream_end', {
          messageId: aiMessageId,
          content: aiContent,
          role: 'assistant',
          sessionId: sessionId,
          is_keyword_match: true,
          match_type: keywordMatchResult.matchType
        });
      } catch (e) {
        console.error('Socket广播关键词匹配结果失败:', e.message);
      }

      // 直接返回匹配结果
      return res.json({
        success: true,
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: keywordMatchResult.content,
          messageId: aiMessageId,
          is_keyword_match: true,
          match_type: keywordMatchResult.matchType,
          match_title: keywordMatchResult.title
        },
        is_keyword_match: true,
        match_type: keywordMatchResult.matchType
      });
    }

    // 获取AI服务
    const aiModule = await getAiProviderModule();

    // 构建系统提示词
    let systemPrompt = link.prompt_template || '';
    if (knowledgeBase) {
        // 只引用最近2条知识文档，避免请求体过大
        if (knowledgeBase.documents && knowledgeBase.documents.length > 0) {
        const recentDocs = knowledgeBase.documents.slice(-2);
        const maxLen = 2000;
        let docsText = recentDocs.map(d => `【文档：${d.title}】\n${d.content}`).join('\n\n');
        if (docsText.length > maxLen) {
          docsText = docsText.substring(0, maxLen) + '...(内容已截断)';
        }
        systemPrompt += `\n\n以下是知识库内容：\n${docsText}`;
      }
      // 添加长期记忆
      if (knowledgeBase.longTermMemory) {
        const { roleDescription, personality, knowledge } = knowledgeBase.longTermMemory;
        if (roleDescription) systemPrompt += `\n\n角色设定：${roleDescription}`;
        if (personality) systemPrompt += `\n性格特点：${personality}`;
        if (knowledge) systemPrompt += `\n专业知识：${knowledge}`;
      }
    }

    // 获取对话历史（使用缓存，最多3条减少AI处理时间）
    const history = await cache.getConversationHistory(sessionId, 3);

    // 构建消息列表
    const messages = [
      { role: 'system', content: systemPrompt || `你是一个名叫${link.avatar_name}的AI助手，请友好地回答用户的问题。` }
    ];

    // 添加历史消息（最多10条）
    history.slice(-10).forEach(msg => {
      messages.push({ role: msg.role, content: msg.content });
    });

    // 添加当前消息（如果是图片消息，使用多模态格式）
    let userMessageContentForAI;
    if (image_url) {
      // 完整图片URL（需要添加域名，确保AI服务可以访问）
      const fullImageUrl = image_url.startsWith('http') ? image_url : (req.protocol + '://' + req.get('host') + image_url);
      userMessageContentForAI = [
        {
          text: message || '请分析这张图片'
        },
        {
          image: fullImageUrl
        }
      ];
    } else {
      userMessageContentForAI = message || '';
    }
    messages.push({ role: 'user', content: userMessageContentForAI });

    // 构建用户消息广播内容（用于用户端和客服端）
    const userMessageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const aiMessageId = `msg_${Date.now() + 1}_${Math.random().toString(36).substr(2, 9)}`;

    const userBroadcastContent = {
      messageId: userMessageId,
      role: 'user',
      content: userMessageContent,
      messageType: userMessageType,
      imageUrl: image_url,
      timestamp: new Date(),
      read: false
    };

    // 立即通过Socket广播用户消息（不等待异步任务）
    try {
      const agentChatIO = getAgentChatIO();
      // 广播typing开始（用户）
      agentChatIO.to(`session:${sessionId}`).emit('typing', {
        role: 'user',
        isTyping: true
      });
      // 广播用户消息给用户
      agentChatIO.to(`session:${sessionId}`).emit('new_message', userBroadcastContent);
      // 广播用户消息给该分身的所有客服
      agentChatIO.to(`avatar:${session.avatarId}`).emit('new_message', {
        ...userBroadcastContent,
        sessionId: sessionId
      });
      // 广播typing结束（用户）
      agentChatIO.to(`session:${sessionId}`).emit('typing', {
        role: 'user',
        isTyping: false
      });
    } catch (e) {
      console.error('Socket广播用户消息失败:', e.message);
    }

    // 流式AI响应处理
    let fullAiText = '';
    let streamError = null;

    // 发送流式开始事件
    try {
      const agentChatIO = getAgentChatIO();
      agentChatIO.to(`session:${sessionId}`).emit('ai_stream_start', {
        messageId: aiMessageId,
        role: 'assistant'
      });
      // 客服端也发送
      agentChatIO.to(`avatar:${session.avatarId}`).emit('ai_stream_start', {
        messageId: aiMessageId,
        role: 'assistant',
        sessionId: sessionId
      });
    } catch (e) {
      console.error('Socket广播ai_stream_start失败:', e.message);
    }

    // 使用流式回调处理AI响应
    if (aiModule.generateConversationWithCallback) {
      // 使用流式回调
      await aiModule.generateConversationWithCallback(messages, {
        temperature: 0.7,
        enableSearch: isSearchEnabled,
        studioMode: true,
        maxTokens: 800
      }, {
        onChunk: (chunk) => {
          fullAiText += chunk;
          // 实时推送chunk给用户
          try {
            const agentChatIO = getAgentChatIO();
            agentChatIO.to(`session:${sessionId}`).emit('ai_stream_chunk', {
              messageId: aiMessageId,
              chunk: chunk,
              role: 'assistant'
            });
            // 实时推送chunk给客服
            agentChatIO.to(`avatar:${session.avatarId}`).emit('ai_stream_chunk', {
              messageId: aiMessageId,
              chunk: chunk,
              role: 'assistant',
              sessionId: sessionId
            });
          } catch (e) {
            console.error('Socket广播ai_stream_chunk失败:', e.message);
          }
        },
        onDone: async (fullContent) => {
          // 清理内容
          fullAiText = cleanResponseContent(fullContent);

          // 发送流式结束事件
          try {
            const agentChatIO = getAgentChatIO();
            agentChatIO.to(`session:${sessionId}`).emit('ai_stream_end', {
              messageId: aiMessageId,
              content: fullAiText,
              role: 'assistant'
            });
            agentChatIO.to(`avatar:${session.avatarId}`).emit('ai_stream_end', {
              messageId: aiMessageId,
              content: fullAiText,
              role: 'assistant',
              sessionId: sessionId
            });
          } catch (e) {
            console.error('Socket广播ai_stream_end失败:', e.message);
          }

          // 异步保存消息、记忆、知识库、计数（不阻塞响应）
          await saveAsyncTasks(sessionId, session.avatarId, userMessageContent, fullAiText, userMessageType, image_url, aiMessageId);

          // 每10次对话触发AI总结（异步，不阻塞响应）
          triggerAISummary(session.avatarId, sessionId);
        },
        onError: (err) => {
          console.error('[agent-chat] AI流式响应出错:', err.message);
          streamError = err;

          // 发送错误事件
          try {
            const agentChatIO = getAgentChatIO();
            agentChatIO.to(`session:${sessionId}`).emit('ai_stream_error', {
              messageId: aiMessageId,
              error: err.message,
              role: 'assistant'
            });
          } catch (e) {
            console.error('Socket广播ai_stream_error失败:', e.message);
          }
        }
      });
    } else {
      // 如果AI模块不支持流式回调，回退到原有方式
      const aiResponse = await aiModule.generateConversation(messages, {
        temperature: 0.7,
        enableSearch: isSearchEnabled,
        studioMode: true,
        maxTokens: 800
      });

      const aiText = typeof aiResponse === 'string' ? aiResponse : (aiResponse?.text || '');

      // 发送流式结束事件（一次性发送完整内容）
      try {
        const agentChatIO = getAgentChatIO();
        agentChatIO.to(`session:${sessionId}`).emit('ai_stream_end', {
          messageId: aiMessageId,
          content: aiText,
          role: 'assistant'
        });
        agentChatIO.to(`avatar:${session.avatarId}`).emit('ai_stream_end', {
          messageId: aiMessageId,
          content: aiText,
          role: 'assistant',
          sessionId: sessionId
        });
      } catch (e) {
        console.error('Socket广播ai_stream_end失败:', e.message);
      }

      fullAiText = aiText;

      // 异步保存
      await saveAsyncTasks(sessionId, session.avatarId, userMessageContent, aiText, userMessageType, image_url, aiMessageId);

      // 每10次对话触发AI总结（异步，不阻塞响应）
      triggerAISummary(session.avatarId, sessionId);
    }

    // 立即返回响应给HTTP客户端
    res.json({
      success: true,
      session_id: sessionId,
      message: {
        role: 'assistant',
        content: fullAiText,
        messageId: aiMessageId
      },
      energy_cost: totalEnergyCost,
      web_search_enabled: isSearchEnabled,
      mode: session.mode || 'ai'
    });

  } catch (error) {
    console.error('[agent-chat] 发送消息失败:', error.message);
    console.error('[agent-chat] 错误详情:', error.stack);

    // 发送错误事件
    try {
      const agentChatIO = getAgentChatIO();
      agentChatIO.to(`session:${sessionId}`).emit('ai_stream_error', {
        error: error.message
      });
    } catch (e) {
      // ignore
    }

    res.status(500).json({ error: '发送消息失败: ' + error.message });
  }
});

/**
 * 清理AI响应内容
 */
function cleanResponseContent(content) {
  if (!content || typeof content !== 'string') return '';
  let cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  cleaned = cleaned.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  return cleaned;
}

/**
 * 判断内容是否为有价值的对话（用于决定是否保存到知识库）
 * @param {string} userMsg - 用户消息
 * @param {string} aiMsg - AI回复
 * @returns {boolean} true表示有价值，应保存到知识库
 */
function isValuableConversation(userMsg, aiMsg) {
  if (!aiMsg || aiMsg.length < 20) return false;

  const content = (userMsg || '') + (aiMsg || '');
  // 包含重要关键词的认为是重要对话
  const importantKeywords = ['记住', '重要', '以后', '下次', '我的名字', '我是谁', '电话', '地址', '邮箱', '银行卡', '密码', '账号'];
  const hasImportantKeyword = importantKeywords.some(kw => content.includes(kw));

  // AI回复超过100字 或者 包含重要关键词
  return aiMsg.length > 100 || hasImportantKeyword;
}

/**
 * 判断内容是否应该被记忆（去重过滤）
 * @param {string} content - 待检查的内容
 * @param {Array} existingMessages - 现有消息列表
 * @returns {boolean} true表示应该记忆，false表示跳过
 */
function shouldRememberContent(content, existingMessages = []) {
  if (!content || typeof content !== 'string') return false;

  const cleanContent = content.replace(/\s/g, '').trim();
  // 内容太短不记忆
  if (cleanContent.length < 10) return false;

  // 检查是否与现有消息高度相似（重复内容）
  for (const msg of existingMessages) {
    const msgContent = (msg.content || '').replace(/\s/g, '');
    if (msgContent.length > 0) {
      const similarity = calculateSimilarity(cleanContent, msgContent);
      if (similarity > 0.8) return false; // 80%以上相似度视为重复
    }
  }

  // 检查是否为无意义内容（纯符号、纯数字等）
  const meaningfulChars = cleanContent.replace(/[^a-zA-Z\u4e00-\u9fa5]/g, '').length;
  if (meaningfulChars / cleanContent.length < 0.3) return false;

  return true;
}

/**
 * 计算两个字符串的相似度（Levenshtein距离算法）
 * @param {string} str1 - 字符串1
 * @param {string} str2 - 字符串2
 * @returns {number} 相似度（0-1）
 */
function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  if (longer.length === 0) return 1.0;

  const costs = [];
  for (let i = 0; i <= shorter.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= longer.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (shorter.charAt(i - 1) !== longer.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[longer.length] = lastValue;
  }

  return (longer.length - costs[longer.length]) / longer.length;
}

/**
 * 触发AI总结任务（每10次对话执行一次）
 * @param {string} avatarId - 分身ID
 * @param {string} sessionId - 会话ID
 */
function triggerAISummary(avatarId, sessionId) {
  // 使用setTimeout异步执行，不阻塞主流程
  setTimeout(async () => {
    try {
      const chatCountKey = `avatar:summary_count:${avatarId}:${sessionId}`;
      const count = await redis.incr(chatCountKey);

      // 每10次对话触发一次AI总结
      if (count % 10 === 0) {
        console.log(`[AgentChat] 触发AI总结，当前计数: ${count}`);
        await messageQueue.enqueueAgentChatTask({
          type: messageQueue.TASK_TYPES.AI_SUMMARY,
          avatarId: avatarId,
          sessionId: sessionId
        });
      }
    } catch (err) {
      console.error('[AgentChat] 触发AI总结失败:', err.message);
    }
  }, 100);
}

/**
 * 异步保存任务（仅保存消息，不保存记忆和知识库）
 * @param {string} sessionId - 会话ID
 * @param {string} avatarId - 分身ID
 * @param {string} userMessage - 用户消息
 * @param {string} aiText - AI回复
 * @param {string} userMessageType - 用户消息类型
 * @param {string} image_url - 图片URL
 * @param {string} aiMessageId - AI消息ID
 * @param {boolean} skipUserMessage - 是否跳过用户消息保存（主流程已保存时为true）
 */
async function saveAsyncTasks(sessionId, avatarId, userMessage, aiText, userMessageType, image_url, aiMessageId, skipUserMessage = false) {
  try {
    // 只保存AI回复（用户消息在主流程已保存，避免重复）
    if (!skipUserMessage && userMessage) {
      await messageQueue.enqueueAgentChatTask({
        type: messageQueue.TASK_TYPES.SAVE_MESSAGE,
        sessionId: sessionId,
        role: 'user',
        content: userMessage,
        messageType: userMessageType,
        imageUrl: image_url
      });
    }

    // 保存AI回复
    if (aiText) {
      await messageQueue.enqueueAgentChatTask({
        type: messageQueue.TASK_TYPES.SAVE_MESSAGE,
        sessionId: sessionId,
        role: 'assistant',
        content: aiText
      });
    }

    // 清除对话历史缓存（确保下次获取最新数据）
    try {
      await redis.del(`chat:history:${sessionId}`);
    } catch (redisErr) {
      console.error('[agent-chat] 清除对话历史缓存失败:', redisErr.message);
    }

    // 注意：记忆和知识库不再每次保存，改为由AI总结任务统一处理（每10次对话）
    // 消息保存仍然保留
    if (avatarId) {
      await messageQueue.enqueueAgentChatTask({
        type: messageQueue.TASK_TYPES.UPDATE_CHAT_COUNT,
        avatarId: avatarId
      });
    }
  } catch (queueErr) {
    console.error('[agent-chat] 异步任务入队失败:', queueErr.message);
  }
}

/**
 * 获取会话历史
 * GET /api/agent-chat/history
 */
router.get('/history', async (req, res) => {
  try {
    const { avatar_id, session_id } = req.query;
    const { token } = req.query;

    if (!avatar_id || !session_id) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    if (!token) {
      return res.status(400).json({ error: '缺少token参数' });
    }

    // 验证链接
    const link = await verifyLink(avatar_id, token);

    if (!link) {
      return res.status(404).json({ error: '链接无效' });
    }

    if (link.error) {
      return res.status(403).json({ error: link.error });
    }

    // 获取会话
    const session = await mongo.getAgentSession(session_id);

    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    const messages = await mongo.getSessionMessages(session_id);

    res.json({
      success: true,
      messages
    });
  } catch (error) {
    console.error('[agent-chat] 获取历史失败:', error);
    res.status(500).json({ error: '获取历史失败' });
  }
});

/**
 * 语音合成（TTS）
 * POST /api/agent-chat/tts
 */
router.post('/tts', async (req, res) => {
  try {
    const { text } = req.body;
    const { avatar_id } = req.query;
    const { token } = req.query;

    if (!text) {
      return res.status(400).json({ error: '缺少text参数' });
    }

    if (!avatar_id || !token) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    // 验证链接
    const link = await verifyLink(avatar_id, token);

    if (!link || link.error) {
      return res.status(403).json({ error: '链接无效' });
    }

    // 获取AI服务
    const aiModule = await getAiProviderModule();

    // 生成语音
    const result = await aiModule.generateSpeech(text, {
      voice: 'female_1',
      speed: 1.0,
      volume: 1.0
    });

    res.json({
      success: true,
      audio_url: result.audio_url
    });
  } catch (error) {
    console.error('[agent-chat] 语音合成失败:', error);
    res.status(500).json({ error: '语音合成失败' });
  }
});

/**
 * 获取分身信息（公开）
 * GET /api/agent-chat/avatar/:avatar_id
 */
router.get('/avatar/:avatar_id', async (req, res) => {
  try {
    const { avatar_id } = req.params;

    const rows = await db.query(
      'SELECT avatar_id, name, description, avatar_url, status FROM ai_agent_avatars WHERE avatar_id = ?',
      [avatar_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: '分身不存在' });
    }

    const avatar = rows[0];

    if (avatar.status !== 1) {
      return res.status(403).json({ error: '该分身已禁用' });
    }

    res.json({
      success: true,
      avatar: {
        avatar_id: avatar.avatar_id,
        name: avatar.name,
        description: avatar.description,
        avatar_url: avatar.avatar_url
      }
    });
  } catch (error) {
    console.error('[agent-chat] 获取分身信息失败:', error);
    res.status(500).json({ error: '获取分身信息失败' });
  }
});

/**
 * 上传图片
 * POST /api/agent-chat/upload-image
 */
router.post('/upload-image', uploadImage.single('image'), async (req, res) => {
  try {
    const { token } = req.query;
    const { avatar_id } = req.query;

    if (!token || !avatar_id) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    if (!req.file) {
      return res.status(400).json({ error: '请选择图片文件' });
    }

    // 验证链接
    const link = await verifyLink(avatar_id, token);

    if (!link || link.error) {
      // 删除已上传的文件
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: '链接无效' });
    }

    // 返回图片URL
    const imageUrl = CHAT_IMAGE_PATH_PREFIX + req.file.filename;

    res.json({
      success: true,
      image_url: imageUrl
    });
  } catch (error) {
    console.error('[agent-chat] 图片上传失败:', error);
    // 如果有上传文件，删除它
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }
    res.status(500).json({ error: '图片上传失败' });
  }
});

module.exports = router;
