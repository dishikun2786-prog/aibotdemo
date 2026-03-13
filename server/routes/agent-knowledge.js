/**
 * @file agent-knowledge.js
 * @module routes/agent-knowledge
 * @description AI分身知识库管理路由：文档管理、记忆管理
 */
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');
const mongo = require('../utils/mongo');
const cache = require('../utils/cache');

/**
 * 验证分身所有权
 */
async function verifyAvatarOwnership(avatarId, userId) {
  const rows = await db.query(
    'SELECT id, name FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?',
    [avatarId, userId]
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * 获取分身的知识库
 * GET /api/agent-knowledge/:avatar_id
 */
router.get('/:avatar_id', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;

    // 验证所有权
    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    // 获取知识库
    const knowledgeBase = await mongo.getAgentKnowledgeBase(avatar_id);

    res.json({
      success: true,
      avatar: { avatar_id, name: avatar.name },
      knowledge_base: knowledgeBase || {
        documents: [],
        shortTermMemory: [],
        mediumTermMemory: [],
        longTermMemory: null
      }
    });
  } catch (error) {
    console.error('[agent-knowledge] 获取知识库失败:', error);
    res.status(500).json({ error: '获取知识库失败' });
  }
});

/**
 * 获取知识文档列表
 * GET /api/agent-knowledge/:avatar_id/documents
 */
router.get('/:avatar_id/documents', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;

    // 验证所有权
    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    const documents = await mongo.getKnowledgeDocuments(avatar_id);

    res.json({ success: true, documents });
  } catch (error) {
    console.error('[agent-knowledge] 获取文档列表失败:', error);
    res.status(500).json({ error: '获取文档列表失败' });
  }
});

/**
 * 添加知识文档
 * POST /api/agent-knowledge/:avatar_id/documents
 */
router.post('/:avatar_id/documents', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;
    const { title, content, tags, keywords } = req.body;

    // 验证所有权
    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    if (!title || !title.trim()) {
      return res.status(400).json({ error: '请输入文档标题' });
    }

    if (!content || !content.trim()) {
      return res.status(400).json({ error: '请输入文档内容' });
    }

    // 处理关键词和标签
    const tagArray = Array.isArray(tags) ? tags : [];
    const keywordArray = Array.isArray(keywords) ? keywords : (typeof keywords === 'string' ? keywords.split(',').map(k => k.trim()).filter(k => k) : []);

    await mongo.addKnowledgeDocument(avatar_id, title.trim(), content.trim(), null, tagArray, keywordArray);

    // 清除关键词索引缓存
    await cache.clearKnowledgeBase(avatar_id);

    const documents = await mongo.getKnowledgeDocuments(avatar_id);

    res.json({ success: true, documents });
  } catch (error) {
    console.error('[agent-knowledge] 添加文档失败:', error);
    res.status(500).json({ error: '添加文档失败' });
  }
});

/**
 * 更新知识文档
 * PUT /api/agent-knowledge/:avatar_id/documents/:doc_id
 */
router.put('/:avatar_id/documents/:doc_id', authenticateToken, async (req, res) => {
  try {
    const { avatar_id, doc_id } = req.params;
    const userId = req.user.id;
    const { title, content, tags, keywords } = req.body;

    // 验证所有权
    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    if (!title || !title.trim()) {
      return res.status(400).json({ error: '请输入文档标题' });
    }

    if (!content || !content.trim()) {
      return res.status(400).json({ error: '请输入文档内容' });
    }

    // 处理关键词和标签
    const tagArray = Array.isArray(tags) ? tags : (typeof tags === 'string' ? tags.split(',').map(t => t.trim()).filter(t => t) : null);
    const keywordArray = Array.isArray(keywords) ? keywords : (typeof keywords === 'string' ? keywords.split(',').map(k => k.trim()).filter(k => k) : null);

    await mongo.updateKnowledgeDocument(avatar_id, doc_id, title.trim(), content.trim(), null, tagArray, keywordArray);

    // 清除关键词索引缓存
    await cache.clearKnowledgeBase(avatar_id);

    const documents = await mongo.getKnowledgeDocuments(avatar_id);

    res.json({ success: true, documents });
  } catch (error) {
    console.error('[agent-knowledge] 更新文档失败:', error);
    res.status(500).json({ error: '更新文档失败' });
  }
});

/**
 * 删除知识文档
 * DELETE /api/agent-knowledge/:avatar_id/documents/:doc_id
 */
router.delete('/:avatar_id/documents/:doc_id', authenticateToken, async (req, res) => {
  try {
    const { avatar_id, doc_id } = req.params;
    const userId = req.user.id;

    // 验证所有权
    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    await mongo.deleteKnowledgeDocument(avatar_id, doc_id);

    // 清除关键词索引缓存
    await cache.clearKnowledgeBase(avatar_id);

    const documents = await mongo.getKnowledgeDocuments(avatar_id);

    res.json({ success: true, documents });
  } catch (error) {
    console.error('[agent-knowledge] 删除文档失败:', error);
    res.status(500).json({ error: '删除文档失败' });
  }
});

/**
 * 获取记忆状态
 * GET /api/agent-knowledge/:avatar_id/memories
 */
router.get('/:avatar_id/memories', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;

    // 验证所有权
    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    const shortTerm = await mongo.getShortTermMemories(avatar_id);
    const mediumTerm = await mongo.getMediumTermMemories(avatar_id);
    const longTerm = await mongo.getLongTermMemory(avatar_id);

    res.json({
      success: true,
      memories: {
        short_term: {
          count: shortTerm.length,
          max: 20,
          data: shortTerm
        },
        medium_term: {
          count: mediumTerm.length,
          data: mediumTerm
        },
        long_term: longTerm
      }
    });
  } catch (error) {
    console.error('[agent-knowledge] 获取记忆失败:', error);
    res.status(500).json({ error: '获取记忆失败' });
  }
});

/**
 * 更新长期记忆
 * PUT /api/agent-knowledge/:avatar_id/memory/long-term
 */
router.put('/:avatar_id/memory/long-term', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;
    const { role_description, personality, knowledge } = req.body;

    // 验证所有权
    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    await mongo.setLongTermMemory(
      avatar_id,
      role_description || '',
      personality || '',
      knowledge || ''
    );

    const longTerm = await mongo.getLongTermMemory(avatar_id);

    res.json({ success: true, long_term: longTerm });
  } catch (error) {
    console.error('[agent-knowledge] 更新长期记忆失败:', error);
    res.status(500).json({ error: '更新长期记忆失败' });
  }
});

/**
 * 清空短期记忆
 * DELETE /api/agent-knowledge/:avatar_id/memories/short
 */
router.delete('/:avatar_id/memories/short', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;

    // 验证所有权
    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    await mongo.clearShortTermMemories(avatar_id);

    res.json({ success: true });
  } catch (error) {
    console.error('[agent-knowledge] 清空短期记忆失败:', error);
    res.status(500).json({ error: '清空短期记忆失败' });
  }
});

/**
 * 清空中期记忆
 * DELETE /api/agent-knowledge/:avatar_id/memories/medium
 */
router.delete('/:avatar_id/memories/medium', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;

    // 验证所有权
    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    await mongo.clearMediumTermMemories(avatar_id);

    res.json({ success: true });
  } catch (error) {
    console.error('[agent-knowledge] 清空中期记忆失败:', error);
    res.status(500).json({ error: '清空中期记忆失败' });
  }
});

/**
 * 获取分身的完整信息（用于对话）
 * GET /api/agent-knowledge/:avatar_id/info
 */
router.get('/:avatar_id/info', async (req, res) => {
  try {
    const { avatar_id } = req.params;

    // 验证分身是否存在（不验证所有权，公开信息）
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

    // 获取知识库
    const knowledgeBase = await mongo.getAgentKnowledgeBase(avatar_id);

    res.json({
      success: true,
      avatar: {
        avatar_id: avatar.avatar_id,
        name: avatar.name,
        description: avatar.description,
        avatar_url: avatar.avatar_url
      },
      knowledge_base: knowledgeBase
    });
  } catch (error) {
    console.error('[agent-knowledge] 获取分身信息失败:', error);
    res.status(500).json({ error: '获取分身信息失败' });
  }
});

// ============================================
// 知识库分类管理API
// ============================================

/**
 * 获取分类列表
 * GET /api/agent-knowledge/:avatar_id/categories
 */
router.get('/:avatar_id/categories', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;

    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    const categories = await mongo.getCategories(avatar_id);
    res.json({ success: true, categories });
  } catch (error) {
    console.error('[agent-knowledge] 获取分类失败:', error);
    res.status(500).json({ error: '获取分类失败' });
  }
});

/**
 * 创建分类
 * POST /api/agent-knowledge/:avatar_id/categories
 */
router.post('/:avatar_id/categories', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;
    const { name, color } = req.body;

    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ error: '请输入分类名称' });
    }

    await mongo.addCategory(avatar_id, name.trim(), color || '#00f3ff');
    const categories = await mongo.getCategories(avatar_id);

    res.json({ success: true, categories });
  } catch (error) {
    console.error('[agent-knowledge] 创建分类失败:', error);
    res.status(500).json({ error: '创建分类失败' });
  }
});

/**
 * 更新分类
 * PUT /api/agent-knowledge/:avatar_id/categories/:category_id
 */
router.put('/:avatar_id/categories/:category_id', authenticateToken, async (req, res) => {
  try {
    const { avatar_id, category_id } = req.params;
    const userId = req.user.id;
    const { name, color } = req.body;

    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ error: '请输入分类名称' });
    }

    await mongo.updateCategory(avatar_id, category_id, name.trim(), color || '#00f3ff');
    const categories = await mongo.getCategories(avatar_id);

    res.json({ success: true, categories });
  } catch (error) {
    console.error('[agent-knowledge] 更新分类失败:', error);
    res.status(500).json({ error: '更新分类失败' });
  }
});

/**
 * 删除分类
 * DELETE /api/agent-knowledge/:avatar_id/categories/:category_id
 */
router.delete('/:avatar_id/categories/:category_id', authenticateToken, async (req, res) => {
  try {
    const { avatar_id, category_id } = req.params;
    const userId = req.user.id;

    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    await mongo.deleteCategory(avatar_id, category_id);
    const categories = await mongo.getCategories(avatar_id);

    res.json({ success: true, categories });
  } catch (error) {
    console.error('[agent-knowledge] 删除分类失败:', error);
    res.status(500).json({ error: '删除分类失败' });
  }
});

// ============================================
// CSV导入和对话转知识库
// ============================================

/**
 * 批量导入CSV
 * POST /api/agent-knowledge/:avatar_id/documents/import-csv
 */
router.post('/:avatar_id/documents/import-csv', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;
    const { csv_content, category_id } = req.body;

    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    if (!csv_content || !csv_content.trim()) {
      return res.status(400).json({ error: '请提供CSV内容' });
    }

    // 解析CSV
    const lines = csv_content.trim().split('\n');
    const documents = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // 简单解析CSV（处理引号内的逗号）
      const parts = [];
      let current = '';
      let inQuotes = false;
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          parts.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      parts.push(current.trim());

      // 跳过标题行
      if (i === 0 && (parts[0] === '标题' || parts[0] === 'title' || parts[0] === '标题,内容,分类,标签')) {
        continue;
      }

      if (parts.length >= 2 && parts[0] && parts[1]) {
        // 解析标签
        let tags = [];
        if (parts[3]) {
          tags = parts[3].split(/[,，]/).map(t => t.trim()).filter(t => t);
        }

        documents.push({
          title: parts[0],
          content: parts[1],
          categoryId: parts[2] ? await findCategoryByName(avatar_id, parts[2]) : category_id,
          tags
        });
      }
    }

    if (documents.length === 0) {
      return res.status(400).json({ error: 'CSV格式无效或没有有效数据' });
    }

    await mongo.addDocuments(avatar_id, documents);
    const docs = await mongo.getKnowledgeDocuments(avatar_id);

    res.json({ success: true, documents: docs, count: documents.length });
  } catch (error) {
    console.error('[agent-knowledge] CSV导入失败:', error);
    res.status(500).json({ error: 'CSV导入失败: ' + error.message });
  }
});

/**
 * 根据分类名称查找或创建分类
 */
async function findCategoryByName(avatarId, name) {
  const categories = await mongo.getCategories(avatarId);
  const found = categories.find(c => c.name === name);
  if (found) return found.id;

  // 如果不存在，创建新分类
  const colors = ['#00f3ff', '#bc13fe', '#ff003c', '#ffd700', '#0aff00', '#ff6b6b', '#4ecdc4'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  await mongo.addCategory(avatarId, name, color);

  const newCategories = await mongo.getCategories(avatarId);
  const newCat = newCategories.find(c => c.name === name);
  return newCat ? newCat.id : null;
}

/**
 * 更新文档分类
 * PUT /api/agent-knowledge/:avatar_id/documents/:doc_id/category
 */
router.put('/:avatar_id/documents/:doc_id/category', authenticateToken, async (req, res) => {
  try {
    const { avatar_id, doc_id } = req.params;
    const userId = req.user.id;
    const { category_id } = req.body;

    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    await mongo.updateKnowledgeDocument(avatar_id, doc_id, null, null, category_id, null, null);

    // 清除关键词索引缓存
    await cache.clearKnowledgeBase(avatar_id);

    const docs = await mongo.getKnowledgeDocuments(avatar_id);

    res.json({ success: true, documents: docs });
  } catch (error) {
    console.error('[agent-knowledge] 更新文档分类失败:', error);
    res.status(500).json({ error: '更新文档分类失败' });
  }
});

/**
 * 对话转知识库
 * POST /api/agent-knowledge/:avatar_id/documents/from-conversation
 */
router.post('/:avatar_id/documents/from-conversation', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;
    const { messages, title, category_id, tags } = req.body;

    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: '请提供对话内容' });
    }

    // 合并对话内容
    const content = messages.map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n\n');

    if (!title) {
      title = '对话 ' + new Date().toLocaleString('zh-CN');
    }

    await mongo.addKnowledgeDocument(avatar_id, title, content, category_id || null, tags || []);
    const docs = await mongo.getKnowledgeDocuments(avatar_id);

    res.json({ success: true, documents: docs });
  } catch (error) {
    console.error('[agent-knowledge] 对话转知识库失败:', error);
    res.status(500).json({ error: '对话转知识库失败' });
  }
});

/**
 * 获取公开的分类和标签（免登录）
 * GET /api/agent-knowledge/:avatar_id/public/categories
 */
router.get('/:avatar_id/public/categories', async (req, res) => {
  try {
    const { avatar_id } = req.params;

    const categories = await mongo.getCategories(avatar_id);
    const documents = await mongo.getKnowledgeDocuments(avatar_id);

    // 提取所有标签
    const allTags = new Set();
    documents.forEach(doc => {
      if (doc.tags && Array.isArray(doc.tags)) {
        doc.tags.forEach(tag => allTags.add(tag));
      }
    });

    res.json({
      success: true,
      categories,
      tags: Array.from(allTags)
    });
  } catch (error) {
    console.error('[agent-knowledge] 获取公开分类失败:', error);
    res.status(500).json({ error: '获取公开分类失败' });
  }
});

/**
 * 获取公开的文档列表（免登录）
 * GET /api/agent-knowledge/:avatar_id/public/documents
 */
router.get('/:avatar_id/public/documents', async (req, res) => {
  try {
    const { avatar_id } = req.params;

    // 验证分身是否存在
    const rows = await db.query(
      'SELECT status FROM ai_agent_avatars WHERE avatar_id = ?',
      [avatar_id]
    );

    if (rows.length === 0 || rows[0].status !== 1) {
      return res.status(404).json({ error: '分身不存在或已禁用' });
    }

    const documents = await mongo.getKnowledgeDocuments(avatar_id);

    // 返回文档基本信息（不含敏感内容）
    const publicDocs = documents.map(doc => ({
      id: doc.id,
      title: doc.title,
      content: doc.content,
      categoryId: doc.categoryId,
      tags: doc.tags,
      createdAt: doc.createdAt
    }));

    res.json({ success: true, documents: publicDocs });
  } catch (error) {
    console.error('[agent-knowledge] 获取公开文档失败:', error);
    res.status(500).json({ error: '获取公开文档失败' });
  }
});

/**
 * 保存文档到知识库（免登录，使用link token验证）
 * POST /api/agent-knowledge/:avatar_id/public/documents
 */
router.post('/:avatar_id/public/documents', async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const { token, title, content, tags } = req.body;

    if (!token) {
      return res.status(400).json({ error: '缺少token参数' });
    }

    if (!title || !content) {
      return res.status(400).json({ error: '缺少标题或内容' });
    }

    // 验证链接token
    const linkRows = await db.query(
      `SELECT l.*, a.name as avatar_name, a.status as avatar_status
       FROM ai_agent_links l
       JOIN ai_agent_avatars a ON l.avatar_id = a.avatar_id
       WHERE l.avatar_id = ? AND l.link_token = ? AND (l.expires_at IS NULL OR l.expires_at > NOW())`,
      [avatar_id, token]
    );

    if (linkRows.length === 0) {
      return res.status(403).json({ error: '链接无效或已过期' });
    }

    const link = linkRows[0];

    if (link.avatar_status !== 1) {
      return res.status(403).json({ error: '分身已禁用' });
    }

    // 保存到知识库
    await mongo.addKnowledgeDocument(
      avatar_id,
      title,
      content,
      null,
      tags || ['客服对话', '手动保存']
    );

    console.log('[agent-knowledge] 文档已保存到知识库, avatar_id:', avatar_id);

    res.json({ success: true });
  } catch (error) {
    console.error('[agent-knowledge] 保存文档失败:', error);
    res.status(500).json({ error: '保存文档失败' });
  }
});

// ============================================
// 会话记录管理
// ============================================

/**
 * 获取所有会话列表
 * GET /api/agent-knowledge/:avatar_id/sessions
 */
router.get('/:avatar_id/sessions', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;

    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    // 获取所有会话
    const sessions = await mongo.getAgentSessionsByAvatar(avatar_id);

    // 返回简要信息（不含消息内容）
    const sessionList = sessions.map(s => ({
      sessionId: s.sessionId,
      avatarId: s.avatarId,
      messageCount: s.messages ? s.messages.length : 0,
      firstMessage: s.messages && s.messages.length > 0 && s.messages[0].content
        ? s.messages[0].content.substring(0, 50) : '',
      lastMessage: s.messages && s.messages.length > 0 && s.messages[s.messages.length - 1].content
        ? s.messages[s.messages.length - 1].content.substring(0, 50) : '',
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    }));

    res.json({ success: true, sessions: sessionList });
  } catch (error) {
    console.error('[agent-knowledge] 获取会话列表失败:', error);
    res.status(500).json({ error: '获取会话列表失败' });
  }
});

/**
 * 获取指定会话的对话详情
 * GET /api/agent-knowledge/:avatar_id/sessions/:session_id
 */
router.get('/:avatar_id/sessions/:session_id', authenticateToken, async (req, res) => {
  try {
    const { avatar_id, session_id } = req.params;
    const userId = req.user.id;

    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    const session = await mongo.getAgentSession(session_id);

    if (!session || session.avatarId !== avatar_id) {
      return res.status(404).json({ error: '会话不存在' });
    }

    res.json({ success: true, session });
  } catch (error) {
    console.error('[agent-knowledge] 获取会话详情失败:', error);
    res.status(500).json({ error: '获取会话详情失败' });
  }
});

/**
 * 批量将对话转为知识库文档
 * POST /api/agent-knowledge/:avatar_id/sessions/convert-to-knowledge
 */
router.post('/:avatar_id/sessions/convert-to-knowledge', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;
    const { session_ids, title_prefix } = req.body;

    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    if (!session_ids || !Array.isArray(session_ids) || session_ids.length === 0) {
      return res.status(400).json({ error: '请选择要转换的会话' });
    }

    let convertedCount = 0;

    for (const sessionId of session_ids) {
      const session = await mongo.getAgentSession(sessionId);
      if (!session || session.avatarId !== avatar_id) continue;

      // 合并对话内容
      const content = session.messages.map(m =>
        `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`
      ).join('\n\n');

      // 生成标题
      const firstUserMsg = session.messages.find(m => m.role === 'user');
      const title = title_prefix ?
        `${title_prefix} - ${(firstUserMsg?.content || '对话').substring(0, 30)}` :
        `对话 - ${(firstUserMsg?.content || new Date().toLocaleString('zh-CN')).substring(0, 30)}`;

      await mongo.addKnowledgeDocument(avatar_id, title, content);
      convertedCount++;
    }

    const docs = await mongo.getKnowledgeDocuments(avatar_id);

    res.json({ success: true, converted_count: convertedCount, documents: docs });
  } catch (error) {
    console.error('[agent-knowledge] 转换会话失败:', error);
    res.status(500).json({ error: '转换会话失败' });
  }
});

/**
 * 批量删除会话
 * DELETE /api/agent-knowledge/:avatar_id/sessions
 */
router.delete('/:avatar_id/sessions', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;
    const { session_ids } = req.body;

    const avatar = await verifyAvatarOwnership(avatar_id, userId);
    if (!avatar) {
      return res.status(404).json({ error: '分身不存在' });
    }

    if (!session_ids || !Array.isArray(session_ids) || session_ids.length === 0) {
      return res.status(400).json({ error: '请选择要删除的会话' });
    }

    let deletedCount = 0;

    for (const sessionId of session_ids) {
      const session = await mongo.getAgentSession(sessionId);
      if (!session || session.avatarId !== avatar_id) continue;

      await mongo.closeSession(sessionId);
      deletedCount++;
    }

    res.json({ success: true, deleted_count: deletedCount });
  } catch (error) {
    console.error('[agent-knowledge] 删除会话失败:', error);
    res.status(500).json({ error: '删除会话失败' });
  }
});

/**
 * 知识库关键词搜索
 * GET /api/agent-knowledge/:avatar_id/search?keyword=xxx
 */
router.get('/:avatar_id/search', authenticateToken, async (req, res) => {
  const { avatar_id } = req.params;
  const { keyword } = req.query;
  const userId = req.user.id;

  if (!keyword) {
    return res.status(400).json({ error: '请提供搜索关键词' });
  }

  try {
    // 验证分身归属
    const [avatar] = await db.query(
      'SELECT id FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?',
      [avatar_id, userId]
    );

    if (!avatar) {
      return res.status(404).json({ error: '知识库不存在' });
    }

    const knowledgeBase = await mongo.getAgentKnowledgeBase(avatar_id);
    if (!knowledgeBase || !knowledgeBase.documents) {
      return res.json({ success: true, data: { results: [] } });
    }

    const keywordLower = keyword.toLowerCase();
    const results = knowledgeBase.documents
      .filter(doc => {
        const matchTitle = doc.title?.toLowerCase().includes(keywordLower);
        const matchTags = doc.tags?.some(tag => tag.toLowerCase().includes(keywordLower));
        const matchKeywords = doc.keywords?.some(k => k.toLowerCase().includes(keywordLower));
        return matchTitle || matchTags || matchKeywords;
      })
      .map(doc => ({
        doc_id: doc.id,
        title: doc.title,
        content: doc.content?.substring(0, 500),
        tags: doc.tags,
        keywords: doc.keywords,
        match_type: doc.keywords?.some(k => k.toLowerCase().includes(keywordLower)) ? 'keyword' : 'tag'
      }));

    res.json({ success: true, data: { results } });
  } catch (err) {
    console.error('[agent-knowledge] 关键词搜索失败:', err);
    res.status(500).json({ error: '搜索失败' });
  }
});

module.exports = router;
