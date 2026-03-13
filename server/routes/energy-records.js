/**
 * @file energy-records.js
 * @description 能量消耗记录API
 */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const mongo = require('../utils/mongo');

/**
 * GET /api/energy-records - 获取能量消耗记录
 * query: type(studio/agent_chat), page, limit
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { type, page = 1, limit = 20 } = req.query;
    const userId = req.user.id;

    const query = { userId };
    if (type) {
      query.type = type;
    }

    const pageNum = parseInt(page, 10) || 1;
    const pageLimit = Math.min(parseInt(limit, 10) || 20, 100);

    const records = await mongo.getEnergyConsumptionList(query, pageNum, pageLimit);
    const total = await mongo.getEnergyConsumptionCount(query);

    // 格式化返回数据
    const formattedRecords = records.map(r => ({
      id: r._id,
      type: r.type,
      typeLabel: r.type === 'studio' ? 'AI工作室' : '分身客服',
      amount: r.amount,
      mode: r.mode,
      modeLabel: r.mode === 'text' ? '文字对话' : r.mode === 'image' ? '图像生成' : r.mode === 'web_search' ? '联网搜索' : '其他',
      avatarId: r.avatarId,
      threadId: r.threadId,
      sessionId: r.sessionId,
      createdAt: r.createdAt
    }));

    res.json({
      success: true,
      data: formattedRecords,
      total,
      page: pageNum,
      limit: pageLimit,
      totalPages: Math.ceil(total / pageLimit)
    });
  } catch (err) {
    console.error('[energy-records] 获取记录失败:', err);
    res.status(500).json({ error: '获取记录失败' });
  }
});

/**
 * GET /api/energy-records/summary - 获取能量消耗统计
 */
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const studioRecords = await mongo.getEnergyConsumptionList({ userId, type: 'studio' }, 1, 1000);
    const agentChatRecords = await mongo.getEnergyConsumptionList({ userId, type: 'agent_chat' }, 1, 1000);

    const studioTotal = studioRecords.reduce((sum, r) => sum + (r.amount || 0), 0);
    const agentChatTotal = agentChatRecords.reduce((sum, r) => sum + (r.amount || 0), 0);

    res.json({
      success: true,
      data: {
        studio: {
          count: studioRecords.length,
          total: studioTotal
        },
        agent_chat: {
          count: agentChatRecords.length,
          total: agentChatTotal
        },
        total: studioTotal + agentChatTotal
      }
    });
  } catch (err) {
    console.error('[energy-records] 获取统计失败:', err);
    res.status(500).json({ error: '获取统计失败' });
  }
});

module.exports = router;
