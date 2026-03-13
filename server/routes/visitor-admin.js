/**
 * @file visitor-admin.js
 * @module routes/visitor-admin
 * @description 管理后台访客统计API
 */
const express = require('express');
const router = express.Router();
const mongo = require('../utils/mongo');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// 所有路由需要管理员权限
router.use(authenticateToken);
router.use(requireAdmin);

/**
 * 获取访客概览统计
 */
router.get('/overview', async (req, res) => {
  try {
    const { date } = req.query;
    const overview = await mongo.getVisitorOverview(date);
    res.json({ success: true, data: overview });
  } catch (error) {
    console.error('获取访客概览失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取IP列表（按IP分组）
 */
router.get('/ip-list', async (req, res) => {
  try {
    const { page = 1, limit = 20, startDate, endDate } = req.query;
    const filters = {};
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    const result = await mongo.getIPList(filters, parseInt(page), parseInt(limit));
    res.json({ success: true, data: result.data, total: result.total });
  } catch (error) {
    console.error('获取IP列表失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取IP访问详情
 */
router.get('/ip-detail', async (req, res) => {
  try {
    const { ip, page = 1, limit = 20 } = req.query;

    if (!ip) {
      return res.status(400).json({ error: '缺少IP参数' });
    }

    // 获取该IP的访问历史
    const history = await mongo.getIPVisitHistory(ip, parseInt(limit));
    const stats = await mongo.getVisitorStats({ ip }, parseInt(page), parseInt(limit));

    res.json({
      success: true,
      data: {
        ip,
        history: history,
        stats: stats.data,
        total: stats.total
      }
    });
  } catch (error) {
    console.error('获取IP详情失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取页面访问统计
 */
router.get('/page-stats', async (req, res) => {
  try {
    const { limit = 10, startDate, endDate } = req.query;
    const filters = {};
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    const stats = await mongo.getPageStats(filters, parseInt(limit));
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('获取页面统计失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取访客详细记录
 */
router.get('/logs', async (req, res) => {
  try {
    const { page = 1, limit = 20, ip, page: pageFilter, startDate, endDate } = req.query;
    const filters = {};
    if (ip) filters.ip = ip;
    if (pageFilter) filters.page = pageFilter;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    const result = await mongo.getVisitorStats(filters, parseInt(page), parseInt(limit));

    // 格式化返回数据
    const formattedData = result.data.map(item => ({
      ip: item.ip,
      userAgent: item.userAgent,
      page: item.page,
      enter_time: item.enterTime,
      leave_time: item.leaveTime,
      duration: item.duration,
      session_id: item.sessionId,
      created_at: item.createdAt
    }));

    res.json({
      success: true,
      data: formattedData,
      total: result.total
    });
  } catch (error) {
    console.error('获取访客记录失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
