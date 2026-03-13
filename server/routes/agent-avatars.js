/**
 * @file agent-avatars.js
 * @module routes/agent-avatars
 * @description AI分身管理路由：创建、更新、删除、链接生成
 */
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');
const mongo = require('../utils/mongo');
const crypto = require('crypto');

/**
 * 生成唯一的avatar_id
 */
function generateAvatarId() {
  return 'av_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

/**
 * 生成链接令牌
 */
function generateLinkToken() {
  return 'link_' + Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}

/**
 * 获取提示词模板列表
 * GET /api/agent-avatars/templates
 */
router.get('/templates', (req, res) => {
  const templates = [
    {
      id: 'customer_service',
      name: '客服助手',
      description: '适用于客服咨询、问题解答',
      template: `你是一个专业的客服助手，名叫{ai_name}。
你的职责是：
1. 热情、耐心地回答用户的问题
2. 主动了解用户需求
3. 提供专业的产品咨询
4. 记录用户反馈
请用友好、专业的方式回复。`
    },
    {
      id: 'teacher',
      name: '教学老师',
      description: '适用于教育培训、知识讲解',
      template: `你是一位知识渊博的老师，名叫{ai_name}。
你的教学风格：
1. 善于用简单的例子解释复杂概念
2. 鼓励学生提问
3. 根据学生水平调整教学内容
4. 注重培养学生的思考能力
请用耐心、鼓励的方式教学。`
    },
    {
      id: 'friend',
      name: '知心朋友',
      description: '适用于情感陪伴、聊天互动',
      template: `你是一个善解人意的朋友，名叫{ai_name}。
你的特点：
1. 善于倾听和理解
2. 提供情感支持
3. 给出实用的建议
4. 尊重对方的隐私
请用真诚、温暖的方式交流。`
    },
    {
      id: 'expert',
      name: '领域专家',
      description: '适用于专业技术咨询',
      template: `你是一位{domain}领域的专家，名叫{ai_name}。
你的专业背景：
1. 精通{domain}领域的知识和实践
2. 能够解决复杂的技术问题
3. 用专业但易懂的语言解释
4. 提供实用的解决方案
请展现你的专业性。`
    },
    {
      id: 'companion',
      name: '陪伴助手',
      description: '适用于日常生活陪伴',
      template: `你是一个温暖的陪伴助手，名叫{ai_name}。
你的特点是：
1. 善于日常聊天，分享有趣的话题
2. 关心用户的生活点滴
3. 提供积极的情绪价值
4. 保持乐观友好的态度
请用轻松愉快的方式陪伴用户。`
    },
    {
      id: 'custom',
      name: '自定义',
      description: '完全自定义你的AI分身',
      template: `请详细描述你的AI分身特点：

名称：
性格：
专业领域：
回答风格：
其他要求：
---
请根据以上描述，始终以该身份回复用户。`
    }
  ];

  res.json({ success: true, templates });
});

/**
 * 创建AI分身
 * POST /api/agent-avatars/create
 */
router.post('/create', authenticateToken, async (req, res) => {
  try {
    const { name, description, prompt_template, avatar_prompt, chat_style, welcome_message } = req.body;
    const userId = req.user.id;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: '请输入分身名称' });
    }

    // 验证chat_style值
    const validStyles = ['cyber', 'modern'];
    const style = validStyles.includes(chat_style) ? chat_style : 'modern';

    const avatarId = generateAvatarId();

    // 插入数据库（添加welcome_message字段）
    const result = await db.query(
      `INSERT INTO ai_agent_avatars (user_id, avatar_id, name, description, prompt_template, welcome_message, avatar_prompt, status, is_public, chat_style)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
      [userId, avatarId, name.trim(), description || '', prompt_template || '', welcome_message || '', avatar_prompt || '', style]
    );

    // 创建MongoDB知识库
    await mongo.createAgentKnowledgeBase(avatarId, userId, name.trim(), description || '');

    res.json({
      success: true,
      avatar: {
        id: result.insertId,
        avatar_id: avatarId,
        name: name.trim(),
        description,
        prompt_template,
        welcome_message,
        avatar_prompt,
        chat_style: style,
        status: 1,
        is_public: 0
      }
    });
  } catch (error) {
    console.error('[agent-avatars] 创建分身失败:', error);
    res.status(500).json({ error: '创建分身失败' });
  }
});

/**
 * 获取用户的AI分身列表
 * GET /api/agent-avatars/my-avatars
 */
router.get('/my-avatars', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const rows = await db.query(
      `SELECT id, avatar_id, name, description, prompt_template, welcome_message, avatar_prompt, avatar_url, status, is_public, chat_count, chat_style, created_at, updated_at
       FROM ai_agent_avatars WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );

    // 获取每个分身的链接数量
    const avatars = await Promise.all(rows.map(async (row) => {
      const links = await db.query(
        'SELECT COUNT(*) as count FROM ai_agent_links WHERE avatar_id = ? AND is_active = 1',
        [row.avatar_id]
      );
      return {
        ...row,
        link_count: links[0]?.count || 0
      };
    }));

    res.json({ success: true, avatars });
  } catch (error) {
    console.error('[agent-avatars] 获取分身列表失败:', error);
    res.status(500).json({ error: '获取分身列表失败' });
  }
});

/**
 * 获取单个分身详情
 * GET /api/agent-avatars/:avatar_id
 */
router.get('/:avatar_id', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;

    const rows = await db.query(
      `SELECT id, avatar_id, name, description, prompt_template, welcome_message, avatar_prompt, avatar_url, status, is_public, chat_count, chat_style, created_at, updated_at
       FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?`,
      [avatar_id, userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: '分身不存在' });
    }

    // 获取知识库信息
    const knowledgeBase = await mongo.getAgentKnowledgeBase(avatar_id);

    // 获取链接列表
    const links = await db.query(
      `SELECT id, link_token, link_name, expires_at, max_messages, is_active, created_at
       FROM ai_agent_links WHERE avatar_id = ? ORDER BY created_at DESC`,
      [avatar_id]
    );

    // 生成完整链接URL
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const linksWithUrl = links.map(link => ({
      ...link,
      link: `${baseUrl}/agent/chat/${avatar_id}?token=${link.link_token}`
    }));

    res.json({
      success: true,
      avatar: rows[0],
      knowledge_base: knowledgeBase,
      links: linksWithUrl
    });
  } catch (error) {
    console.error('[agent-avatars] 获取分身详情失败:', error);
    res.status(500).json({ error: '获取分身详情失败' });
  }
});

/**
 * 更新分身信息
 * PUT /api/agent-avatars/:avatar_id
 */
router.put('/:avatar_id', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;
    const { name, description, prompt_template, avatar_prompt, status, is_public, chat_style, welcome_message } = req.body;

    // 验证所有权
    const existing = await db.query(
      'SELECT id FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?',
      [avatar_id, userId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: '分身不存在' });
    }

    // 构建更新字段
    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name.trim());
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    if (prompt_template !== undefined) {
      updates.push('prompt_template = ?');
      values.push(prompt_template);
    }
    if (welcome_message !== undefined) {
      updates.push('welcome_message = ?');
      values.push(welcome_message);
    }
    if (avatar_prompt !== undefined) {
      updates.push('avatar_prompt = ?');
      values.push(avatar_prompt);
    }
    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
    }
    if (is_public !== undefined) {
      updates.push('is_public = ?');
      values.push(is_public);
    }
    // 支持chat_style更新
    if (chat_style !== undefined) {
      const validStyles = ['cyber', 'modern'];
      if (validStyles.includes(chat_style)) {
        updates.push('chat_style = ?');
        values.push(chat_style);
      }
    }

    if (updates.length > 0) {
      values.push(avatar_id, userId);
      await db.query(
        `UPDATE ai_agent_avatars SET ${updates.join(', ')} WHERE avatar_id = ? AND user_id = ?`,
        values
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[agent-avatars] 更新分身失败:', error);
    res.status(500).json({ error: '更新分身失败' });
  }
});

/**
 * 删除分身
 * DELETE /api/agent-avatars/:avatar_id
 */
router.delete('/:avatar_id', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;

    // 验证所有权
    const existing = await db.query(
      'SELECT id FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?',
      [avatar_id, userId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: '分身不存在' });
    }

    // 删除分身记录
    await db.query('DELETE FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?', [avatar_id, userId]);

    // 删除关联的链接
    await db.query('DELETE FROM ai_agent_links WHERE avatar_id = ?', [avatar_id]);

    // 删除MongoDB知识库
    await mongo.deleteAgentKnowledgeBase(avatar_id);

    res.json({ success: true });
  } catch (error) {
    console.error('[agent-avatars] 删除分身失败:', error);
    res.status(500).json({ error: '删除分身失败' });
  }
});

/**
 * 生成分身客服链接
 * POST /api/agent-avatars/:avatar_id/generate-link
 */
router.post('/:avatar_id/generate-link', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;
    const { link_name, expires_at, max_messages } = req.body;

    // 验证所有权
    const existing = await db.query(
      'SELECT id, name FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?',
      [avatar_id, userId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: '分身不存在' });
    }

    // 先禁用该分身的所有旧链接（实现替换效果）
    await db.query(
      'UPDATE ai_agent_links SET is_active = 0 WHERE avatar_id = ?',
      [avatar_id]
    );

    const linkToken = generateLinkToken();

    // 插入链接记录
    const result = await db.query(
      `INSERT INTO ai_agent_links (avatar_id, link_token, link_name, expires_at, max_messages, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [avatar_id, linkToken, link_name || `${existing[0].name}的客服链接`, expires_at || null, max_messages || null]
    );

    // 生成完整链接
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const link = `${baseUrl}/agent/chat/${avatar_id}?token=${linkToken}`;

    res.json({
      success: true,
      link: {
        id: result.insertId,
        avatar_id,
        link_token: linkToken,
        link_name: link_name || `${existing[0].name}的客服链接`,
        link,
        expires_at,
        max_messages,
        is_active: 1,
        created_at: new Date()
      }
    });
  } catch (error) {
    console.error('[agent-avatars] 生成链接失败:', error);
    res.status(500).json({ error: '生成链接失败' });
  }
});

/**
 * 获取分身的所有链接
 * GET /api/agent-avatars/:avatar_id/links
 */
router.get('/:avatar_id/links', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;

    // 验证所有权
    const existing = await db.query(
      'SELECT id FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?',
      [avatar_id, userId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: '分身不存在' });
    }

    const links = await db.query(
      `SELECT id, link_token, link_name, expires_at, max_messages, is_active, created_at
       FROM ai_agent_links WHERE avatar_id = ? AND is_active = 1 ORDER BY created_at DESC`,
      [avatar_id]
    );

    // 生成完整链接
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const linksWithUrl = links.map(link => ({
      ...link,
      link: `${baseUrl}/agent/chat/${avatar_id}?token=${link.link_token}`
    }));

    res.json({ success: true, links: linksWithUrl });
  } catch (error) {
    console.error('[agent-avatars] 获取链接列表失败:', error);
    res.status(500).json({ error: '获取链接列表失败' });
  }
});

/**
 * 删除分身链接
 * DELETE /api/agent-avatars/:avatar_id/links/:link_id
 */
router.delete('/:avatar_id/links/:link_id', authenticateToken, async (req, res) => {
  try {
    const { avatar_id, link_id } = req.params;
    const userId = req.user.id;

    // 验证所有权
    const existing = await db.query(
      'SELECT id FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?',
      [avatar_id, userId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: '分身不存在' });
    }

    await db.query('DELETE FROM ai_agent_links WHERE id = ? AND avatar_id = ?', [parseInt(link_id), avatar_id]);

    // 验证删除成功
    const verify = await db.query('SELECT id FROM ai_agent_links WHERE id = ?', [parseInt(link_id)]);
    if (verify.length > 0) {
      return res.status(500).json({ error: '删除失败，链接仍然存在' });
    }

    res.json({ success: true, message: '链接已删除' });
  } catch (error) {
    console.error('[agent-avatars] 删除链接失败:', error);
    res.status(500).json({ error: '删除链接失败' });
  }
});

/**
 * 清理多余链接，只保留最新的一条
 * POST /api/agent-avatars/:avatar_id/links/cleanup
 */
router.post('/:avatar_id/links/cleanup', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;

    // 验证所有权
    const existing = await db.query(
      'SELECT id FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?',
      [avatar_id, userId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: '分身不存在' });
    }

    // 获取所有激活的链接，按创建时间倒序
    const links = await db.query(
      'SELECT id FROM ai_agent_links WHERE avatar_id = ? AND is_active = 1 ORDER BY created_at DESC',
      [avatar_id]
    );

    if (links.length <= 1) {
      return res.json({ success: true, message: '链接数量正常，无需清理', count: links.length });
    }

    // 删除除最新外的所有链接
    const idsToDelete = links.slice(1).map(l => l.id);
    // 逐个删除，避免 IN (?) 问题
    for (const id of idsToDelete) {
      await db.query('DELETE FROM ai_agent_links WHERE id = ?', [id]);
    }

    res.json({
      success: true,
      message: `已清理 ${idsToDelete.length} 个多余链接，保留 1 个`,
      deleted_count: idsToDelete.length,
      kept_count: 1
    });
  } catch (error) {
    console.error('[agent-avatars] 清理链接失败:', error);
    res.status(500).json({ error: '清理链接失败: ' + error.message });
  }
});

/**
 * 清理所有失效链接（is_active=0的）
 * POST /api/agent-avatars/:avatar_id/links/cleanup-all
 */
router.post('/:avatar_id/links/cleanup-all', authenticateToken, async (req, res) => {
  try {
    const { avatar_id } = req.params;
    const userId = req.user.id;

    const existing = await db.query(
      'SELECT id FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?',
      [avatar_id, userId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: '分身不存在' });
    }

    const result = await db.query(
      'DELETE FROM ai_agent_links WHERE avatar_id = ? AND is_active = 0',
      [avatar_id]
    );

    res.json({
      success: true,
      message: `已清理 ${result.affectedRows || 0} 个失效链接`
    });
  } catch (error) {
    console.error('[agent-avatars] 清理失效链接失败:', error);
    res.status(500).json({ error: '清理失效链接失败' });
  }
});

module.exports = router;
