/**
 * @file agent-chat-admin.js
 * @module routes/agent-chat-admin
 * @description 会员分身客服后台API：会话监控、人工介入、模式切换
 */
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');
const mongo = require('../utils/mongo');

/**
 * 验证分身所有权
 */
async function verifyAvatarOwnership(avatarId, userId) {
  const rows = await db.query(
    'SELECT id, name FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?',
    [avatarId, userId]
  );
  return rows[0] || null;
}

/**
 * 获取会员的所有分身列表
 * GET /api/agent-chat-admin/avatars
 */
router.get('/avatars', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const rows = await db.query(
      `SELECT avatar_id, name, description, avatar_url, status, chat_count, created_at
       FROM ai_agent_avatars WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );
    res.json({ success: true, avatars: rows });
  } catch (error) {
    console.error('[agent-chat-admin] 获取分身列表失败:', error);
    res.status(500).json({ error: '获取分身列表失败' });
  }
});

/**
 * 获取所有活跃会话（会员所有分身的）
 * GET /api/agent-chat-admin/rooms
 */
router.get('/rooms', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const sessions = await mongo.getActiveSessionsByUser(userId);

    // 获取每个会话对应的分身信息
    const avatarIds = [...new Set(sessions.map(s => s.avatarId))];
    const avatarMap = {};
    if (avatarIds.length > 0) {
      const placeholders = avatarIds.map(() => '?').join(',');
      const rows = await db.query(
        `SELECT avatar_id, name, status FROM ai_agent_avatars WHERE avatar_id IN (${placeholders})`,
        avatarIds
      );
      rows.forEach(r => { avatarMap[r.avatar_id] = r; });
    }

    const rooms = sessions.map(s => {
      const avatar = avatarMap[s.avatarId] || {};
      return {
        sessionId: s.sessionId,
        avatarId: s.avatarId,
        avatarName: avatar.name || '未知',
        avatarStatus: avatar.status,
        mode: s.mode || 'ai',
        humanOperatorId: s.humanOperatorId,
        pendingHuman: s.pendingHuman || false,
        status: s.status,
        messageCount: s.messages ? s.messages.length : 0,
        lastMessage: s.messages && s.messages.length > 0 ? s.messages[s.messages.length - 1].content.substring(0, 50) : '',
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
      };
    });

    res.json({ success: true, rooms });
  } catch (error) {
    console.error('[agent-chat-admin] 获取活跃会话失败:', error);
    res.status(500).json({ error: '获取活跃会话失败' });
  }
});

/**
 * 获取指定会话详情
 * GET /api/agent-chat-admin/room/:sessionId
 */
router.get('/room/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;

    // 验证会话属于该用户的分身
    const session = await mongo.getAgentSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    const avatar = await verifyAvatarOwnership(session.avatarId, userId);
    if (!avatar) {
      return res.status(403).json({ error: '无权访问此会话' });
    }

    // 获取分身信息
    const rows = await db.query(
      'SELECT avatar_id, name, avatar_url, status, prompt_template FROM ai_agent_avatars WHERE avatar_id = ?',
      [session.avatarId]
    );

    res.json({
      success: true,
      room: {
        sessionId: session.sessionId,
        avatarId: session.avatarId,
        avatarName: rows[0]?.name || '未知',
        avatarUrl: rows[0]?.avatar_url,
        mode: session.mode || 'ai',
        humanOperatorId: session.humanOperatorId,
        pendingHuman: session.pendingHuman || false,
        status: session.status,
        messages: session.messages || [],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      }
    });
  } catch (error) {
    console.error('[agent-chat-admin] 获取会话详情失败:', error);
    res.status(500).json({ error: '获取会话详情失败' });
  }
});

/**
 * 人工接入会话
 * POST /api/agent-chat-admin/join/:sessionId
 */
router.post('/join/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;

    const session = await mongo.getAgentSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    const avatar = await verifyAvatarOwnership(session.avatarId, userId);
    if (!avatar) {
      return res.status(403).json({ error: '无权接入此会话' });
    }

    // 更新会话模式为人工
    await mongo.updateSessionMode(sessionId, 'human', userId);

    // 添加系统消息
    await mongo.addSessionMessage(sessionId, 'system', '【人工客服已接入】');

    // 通过Socket广播模式变更
    try {
      const { getAgentChatIO } = require('../socket');
      const agentChatIO = getAgentChatIO();
      agentChatIO.to(`session:${sessionId}`).emit('operator_joined', {
        sessionId,
        operatorId: userId,
        operatorName: req.user.username,
        message: '人工客服已接入',
        timestamp: new Date()
      });
      agentChatIO.to(`session:${sessionId}`).emit('mode_changed', {
        mode: 'human',
        operatorId: userId,
        operatorName: req.user.username,
        timestamp: new Date()
      });
    } catch (e) {
      console.error('[agent-chat-admin] Socket广播失败:', e.message);
    }

    res.json({ success: true, message: '已成功接入会话' });
  } catch (error) {
    console.error('[agent-chat-admin] 接入会话失败:', error);
    res.status(500).json({ error: '接入会话失败' });
  }
});

/**
 * 人工离开会话
 * POST /api/agent-chat-admin/leave/:sessionId
 */
router.post('/leave/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;

    const session = await mongo.getAgentSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    const avatar = await verifyAvatarOwnership(session.avatarId, userId);
    if (!avatar) {
      return res.status(403).json({ error: '无权操作此会话' });
    }

    // 切换回AI模式
    await mongo.updateSessionMode(sessionId, 'ai', null);

    // 添加系统消息
    await mongo.addSessionMessage(sessionId, 'system', '【人工客服已离开，AI将继续为您服务】');

    res.json({ success: true, message: '已离开会话' });
  } catch (error) {
    console.error('[agent-chat-admin] 离开会话失败:', error);
    res.status(500).json({ error: '离开会话失败' });
  }
});

/**
 * 切换AI/人工模式
 * POST /api/agent-chat-admin/switch-mode/:sessionId
 */
router.post('/switch-mode/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { mode } = req.body; // 'ai' 或 'human'
    const userId = req.user.id;

    if (!mode || !['ai', 'human'].includes(mode)) {
      return res.status(400).json({ error: '无效的模式' });
    }

    const session = await mongo.getAgentSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    const avatar = await verifyAvatarOwnership(session.avatarId, userId);
    if (!avatar) {
      return res.status(403).json({ error: '无权操作此会话' });
    }

    await mongo.updateSessionMode(sessionId, mode, mode === 'human' ? userId : null);

    const msg = mode === 'human'
      ? '【人工客服已接入】'
      : '【人工客服已离开，AI将继续为您服务】';
    await mongo.addSessionMessage(sessionId, 'system', msg);

    // 通过Socket广播模式变更
    try {
      const { getAgentChatIO } = require('../socket');
      const agentChatIO = getAgentChatIO();
      agentChatIO.to(`session:${sessionId}`).emit('mode_changed', {
        mode,
        operatorId: mode === 'human' ? userId : null,
        operatorName: mode === 'human' ? req.user.username : null,
        timestamp: new Date()
      });
    } catch (e) {
      console.error('[agent-chat-admin] Socket广播失败:', e.message);
    }

    res.json({ success: true, mode });
  } catch (error) {
    console.error('[agent-chat-admin] 切换模式失败:', error);
    res.status(500).json({ error: '切换模式失败' });
  }
});

/**
 * 人工发送消息
 * POST /api/agent-chat-admin/send/:sessionId
 */
router.post('/send/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { message } = req.body;
    const userId = req.user.id;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: '消息不能为空' });
    }

    const session = await mongo.getAgentSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    const avatar = await verifyAvatarOwnership(session.avatarId, userId);
    if (!avatar) {
      return res.status(403).json({ error: '无权发送消息' });
    }

    // 强制切换到人工模式
    if (session.mode !== 'human') {
      await mongo.updateSessionMode(sessionId, 'human', userId);
      await mongo.addSessionMessage(sessionId, 'system', '【人工客服已接入】');

      // 广播模式变更
      try {
        const { getAgentChatIO } = require('../socket');
        const agentChatIO = getAgentChatIO();
        agentChatIO.to(`session:${sessionId}`).emit('mode_changed', {
          mode: 'human',
          operatorId: userId,
          operatorName: req.user.username,
          timestamp: new Date()
        });
      } catch (e) {
        console.error('[agent-chat-admin] Socket广播失败:', e.message);
      }
    }

    // 添加人工客服消息（role为'human_operator'）
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await mongo.addSessionMessage(sessionId, 'human_operator', message.trim());

    // 通过Socket广播消息给用户和所有相关客服
    try {
      const { getAgentChatIO } = require('../socket');
      const agentChatIO = getAgentChatIO();
      // 发送给用户
      agentChatIO.to(`session:${sessionId}`).emit('new_message', {
        messageId,
        role: 'human_operator',
        content: message.trim(),
        timestamp: new Date(),
        read: false,
        operatorName: req.user.username
      });
      // 发送给其他客服（当前分身的其他客服可以看到）
      if (session.avatarId) {
        agentChatIO.to(`avatar:${session.avatarId}`).emit('new_message', {
          messageId,
          role: 'human_operator',
          content: message.trim(),
          timestamp: new Date(),
          sessionId: sessionId,
          read: false,
          operatorName: req.user.username
        });
      }
    } catch (e) {
      console.error('[agent-chat-admin] Socket广播消息失败:', e.message);
    }

    res.json({ success: true, message: '消息发送成功' });
  } catch (error) {
    console.error('[agent-chat-admin] 发送消息失败:', error);
    res.status(500).json({ error: '发送消息失败' });
  }
});

/**
 * 关闭会话
 * POST /api/agent-chat-admin/close/:sessionId
 */
router.post('/close/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;

    const session = await mongo.getAgentSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    const avatar = await verifyAvatarOwnership(session.avatarId, userId);
    if (!avatar) {
      return res.status(403).json({ error: '无权关闭此会话' });
    }

    // 添加系统消息
    await mongo.addSessionMessage(sessionId, 'system', '【会话已结束】');

    // 标记会话为关闭
    await mongo.closeAgentSession(sessionId);

    // 通过Socket广播会话关闭
    try {
      const { getAgentChatIO } = require('../socket');
      const agentChatIO = getAgentChatIO();
      agentChatIO.to(`session:${sessionId}`).emit('session_closed', {
        sessionId,
        timestamp: new Date()
      });
    } catch (e) {
      console.error('[agent-chat-admin] Socket广播关闭失败:', e.message);
    }

    res.json({ success: true, message: '会话已关闭' });
  } catch (error) {
    console.error('[agent-chat-admin] 关闭会话失败:', error);
    res.status(500).json({ error: '关闭会话失败' });
  }
});

/**
 * 请求人工接入（用户端调用）
 * POST /api/agent-chat-admin/request-human/:sessionId
 */
router.post('/request-human/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await mongo.getAgentSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    // 设置等待人工接入标记
    await mongo.setSessionPendingHuman(sessionId, true);

    // 添加系统消息
    await mongo.addSessionMessage(sessionId, 'system', '【正在为您转接人工客服，请稍候...】');

    // 广播请求人工给客服
    try {
      const { getAgentChatIO } = require('../socket');
      const agentChatIO = getAgentChatIO();
      agentChatIO.emit('human_requested', {
        sessionId,
        avatarId: session.avatarId,
        message: '用户请求人工客服',
        timestamp: new Date()
      });
    } catch (e) {
      console.error('[agent-chat-admin] Socket广播失败:', e.message);
    }

    res.json({ success: true, message: '已发出人工接入请求' });
  } catch (error) {
    console.error('[agent-chat-admin] 请求人工接入失败:', error);
    res.status(500).json({ error: '请求人工接入失败' });
  }
});

module.exports = router;
