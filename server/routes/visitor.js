/**
 * @file visitor.js
 * @module routes/visitor
 * @description 访客记录API - 记录页面访问和离开
 */
const express = require('express');
const router = express.Router();
const mongo = require('../utils/mongo');

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
 * 获取当前请求的IP（公开接口）
 */
router.get('/my-ip', (req, res) => {
  const ip = getClientIp(req);
  res.json({ success: true, ip });
});

/**
 * 记录页面访问/离开
 */
router.post('/log', async (req, res) => {
  try {
    const { action, ip, userAgent, page, sessionId } = req.body;

    if (action === 'enter') {
      // 记录访问
      if (!ip || !page || !sessionId) {
        return res.status(400).json({ error: '缺少必要参数' });
      }

      await mongo.recordPageView(ip, userAgent || '', page, sessionId);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: '无效的操作类型' });
    }
  } catch (error) {
    console.error('记录页面访问失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 更新离开时间（PUT方法）
 */
router.put('/log', async (req, res) => {
  try {
    const { action, page, sessionId } = req.body;

    if (action === 'leave') {
      // 记录离开
      if (!page || !sessionId) {
        return res.status(400).json({ error: '缺少必要参数' });
      }

      await mongo.recordPageLeave(sessionId, page);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: '无效的操作类型' });
    }
  } catch (error) {
    console.error('记录页面离开失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
