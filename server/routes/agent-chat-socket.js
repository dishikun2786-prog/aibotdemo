/**
 * @file agent-chat-socket.js
 * @module routes/agent-chat-socket
 * @description 客服聊天Socket相关HTTP API - 用于Socket连接验证和辅助功能
 */
const express = require('express');
const router = express.Router();
const mongo = require('../utils/mongo');
const db = require('../utils/db');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const crypto = require('crypto');

/**
 * 验证Socket连接
 * GET /api/agent-chat-socket/verify/:sessionId
 */
router.get('/verify/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { token, role } = req.query;

    // 验证会话
    const session = await mongo.getAgentSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    if (session.status !== 'active') {
      return res.status(400).json({ error: '会话已关闭' });
    }

    // 验证token
    if (role === 'operator') {
      // 客服验证 - 简化处理，实际应该验证JWT
      const operatorToken = req.headers['x-operator-token'] || token;
      if (!operatorToken) {
        return res.status(401).json({ error: '缺少客服令牌' });
      }
      // 验证客服是否有权限管理此分身
      const avatars = await db.query(
        'SELECT * FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?',
        [session.avatarId, req.user?.id]
      );
      if (avatars.length === 0) {
        // 检查是否是管理员
        const admins = await db.query(
          'SELECT id FROM admins WHERE username = ?',
          [req.user?.username]
        );
        if (admins.length === 0) {
          return res.status(403).json({ error: '无权限管理此分身' });
        }
      }
    } else {
      // 用户验证 - 验证链接token
      const links = await db.query(
        'SELECT * FROM ai_agent_links WHERE avatar_id = ? AND token = ?',
        [session.avatarId, token]
      );
      if (links.length === 0) {
        return res.status(401).json({ error: '令牌无效' });
      }
    }

    res.json({
      valid: true,
      sessionId: session.sessionId,
      avatarId: session.avatarId,
      mode: session.mode,
      humanOperatorId: session.humanOperatorId,
      pendingHuman: session.pendingHuman,
      status: session.status
    });
  } catch (error) {
    console.error('验证Socket连接失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取会话实时消息（用于初始加载和离线同步）
 * GET /api/agent-chat-socket/messages/:sessionId
 */
router.get('/messages/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { since, limit = 50 } = req.query;

    // 验证会话存在
    const session = await mongo.getAgentSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    // 获取消息
    let messages = await mongo.getSessionMessages(sessionId);

    // 如果指定了时间，过滤消息
    if (since) {
      const sinceDate = new Date(since);
      messages = messages.filter(m => new Date(m.timestamp) > sinceDate);
    }

    // 限制数量
    messages = messages.slice(-parseInt(limit));

    // 获取未读计数
    const unreadCount = await mongo.getUnreadCount(sessionId);

    res.json({
      messages,
      unreadCount,
      mode: session.mode
    });
  } catch (error) {
    console.error('获取消息失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取在线状态
 * GET /api/agent-chat-socket/online/:sessionId
 */
router.get('/online/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const redis = require('../utils/redis');

    const onlineKey = `agent:online:${sessionId}`;
    const onlineData = await redis.hGetAll(onlineKey);

    const isOnline = !!onlineData.socketId;

    res.json({
      sessionId,
      online: isOnline,
      socketId: onlineData.socketId || null,
      role: onlineData.role || null,
      lastHeartbeat: onlineData.lastHeartbeat ? parseInt(onlineData.lastHeartbeat) : null
    });
  } catch (error) {
    console.error('获取在线状态失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 切换会话模式 (AI/人工)
 * POST /api/agent-chat-socket/switch-mode/:sessionId
 */
router.post('/switch-mode/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { mode } = req.body;

    if (!mode || !['ai', 'human'].includes(mode)) {
      return res.status(400).json({ error: '无效的模式' });
    }

    // 验证会话
    const session = await mongo.getAgentSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    // 验证权限
    const avatars = await db.query(
      'SELECT * FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?',
      [session.avatarId, req.user.id]
    );

    const admins = await db.query('SELECT id FROM admins WHERE username = ?', [req.user.username]);

    if (avatars.length === 0 && admins.length === 0) {
      return res.status(403).json({ error: '无权限操作此会话' });
    }

    // 更新模式
    const operatorId = mode === 'human' ? req.user.id : null;
    const operatorName = mode === 'human' ? req.user.username : null;

    await mongo.updateSessionMode(sessionId, mode, operatorId);

    if (mode === 'human') {
      await mongo.assignSessionToOperator(sessionId, operatorId, operatorName);
    }

    // 广播模式变更给Socket
    const { getAgentChatIO } = require('../socket');
    const agentChatIO = getAgentChatIO();
    agentChatIO.to(`session:${sessionId}`).emit('mode_changed', {
      mode,
      operatorId,
      operatorName,
      timestamp: new Date()
    });

    res.json({
      success: true,
      mode,
      operatorId,
      operatorName
    });
  } catch (error) {
    console.error('切换模式失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 请求人工客服
 * POST /api/agent-chat-socket/request-human/:sessionId
 */
router.post('/request-human/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    // 验证会话
    const session = await mongo.getAgentSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    if (session.status !== 'active') {
      return res.status(400).json({ error: '会话已关闭' });
    }

    if (session.mode === 'human') {
      return res.status(400).json({ error: '会话已是人工模式' });
    }

    // 设置等待人工
    await mongo.setSessionPendingHuman(sessionId, true);

    // 添加系统消息
    const message = '用户正在请求人工客服...';
    await mongo.addSessionMessage(sessionId, 'system', message);

    // 广播给客服
    const { getAgentChatIO } = require('../socket');
    const agentChatIO = getAgentChatIO();

    // 通知所有订阅此分身会话的客服
    agentChatIO.emit('human_requested', {
      sessionId,
      avatarId: session.avatarId,
      message,
      timestamp: new Date()
    });

    res.json({
      success: true,
      message: '已请求人工客服'
    });
  } catch (error) {
    console.error('请求人工客服失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 客服接入会话
 * POST /api/agent-chat-socket/join/:sessionId
 */
router.post('/join/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;

    // 验证会话
    const session = await mongo.getAgentSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    if (session.status !== 'active') {
      return res.status(400).json({ error: '会话已关闭' });
    }

    // 验证权限
    const avatars = await db.query(
      'SELECT * FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?',
      [session.avatarId, req.user.id]
    );

    const admins = await db.query('SELECT id FROM admins WHERE username = ?', [req.user.username]);

    if (avatars.length === 0 && admins.length === 0) {
      return res.status(403).json({ error: '无权限接入此会话' });
    }

    // 切换到人工模式
    await mongo.updateSessionMode(sessionId, 'human', req.user.id);
    await mongo.setSessionPendingHuman(sessionId, false);
    await mongo.assignSessionToOperator(sessionId, req.user.id, req.user.username);

    // 添加系统消息
    const message = `人工客服 ${req.user.username} 已接入`;
    await mongo.addSessionMessage(sessionId, 'system', message);

    // 广播给Socket
    const { getAgentChatIO } = require('../socket');
    const agentChatIO = getAgentChatIO();
    agentChatIO.to(`session:${sessionId}`).emit('operator_joined', {
      sessionId,
      operatorId: req.user.id,
      operatorName: req.user.username,
      message,
      timestamp: new Date()
    });

    res.json({
      success: true,
      operatorId: req.user.id,
      operatorName: req.user.username
    });
  } catch (error) {
    console.error('接入会话失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 客服离开会话
 * POST /api/agent-chat-socket/leave/:sessionId
 */
router.post('/leave/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;

    // 验证会话
    const session = await mongo.getAgentSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    // 切换回AI模式
    await mongo.updateSessionMode(sessionId, 'ai', null);

    // 添加系统消息
    const message = `人工客服已离开，将切换回AI模式`;
    await mongo.addSessionMessage(sessionId, 'system', message);

    // 广播给Socket
    const { getAgentChatIO } = require('../socket');
    const agentChatIO = getAgentChatIO();
    agentChatIO.to(`session:${sessionId}`).emit('operator_left', {
      sessionId,
      message,
      timestamp: new Date()
    });

    res.json({
      success: true
    });
  } catch (error) {
    console.error('离开会话失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 发送人工消息（HTTP备用）
 * POST /api/agent-chat-socket/send/:sessionId
 */
router.post('/send/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: '消息内容不能为空' });
    }

    // 验证会话
    const session = await mongo.getAgentSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    if (session.status !== 'active') {
      return res.status(400).json({ error: '会话已关闭' });
    }

    // 验证权限
    const avatars = await db.query(
      'SELECT * FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?',
      [session.avatarId, req.user.id]
    );

    const admins = await db.query('SELECT id FROM admins WHERE username = ?', [req.user.username]);

    if (avatars.length === 0 && admins.length === 0) {
      return res.status(403).json({ error: '无权限发送消息' });
    }

    // 生成消息ID
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // 保存消息
    await mongo.addSessionMessage(sessionId, 'human_operator', content);
    await mongo.updateSessionLastMessage(sessionId);

    // 广播给Socket
    const { getAgentChatIO } = require('../socket');
    const agentChatIO = getAgentChatIO();
    agentChatIO.to(`session:${sessionId}`).emit('new_message', {
      messageId,
      role: 'human_operator',
      content,
      timestamp: new Date(),
      read: false,
      operatorName: req.user.username
    });

    res.json({
      success: true,
      messageId
    });
  } catch (error) {
    console.error('发送消息失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取客服在线列表
 * GET /api/agent-chat-socket/operators
 */
router.get('/operators', async (req, res) => {
  try {
    const redis = require('../utils/redis');

    // 获取所有在线的客服
    const keys = await redis.keys('agent:online:*');
    const operators = [];

    for (const key of keys) {
      const data = await redis.hGetAll(key);
      if (data.role === 'operator') {
        operators.push({
          socketId: data.socketId,
          lastHeartbeat: data.lastHeartbeat ? parseInt(data.lastHeartbeat) : null
        });
      }
    }

    res.json({ operators });
  } catch (error) {
    console.error('获取客服列表失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
