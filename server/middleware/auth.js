/**
 * @file auth.js
 * @module middleware/auth
 * @description JWT 认证、管理员校验、操作日志
 */
const jwt = require('jsonwebtoken');
const config = require('../config/database');
const db = require('../utils/db');

/**
 * 验证 JWT Token，将用户信息挂到 req.user
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  console.log('[Debug authenticateToken] Received token:', token ? token.substring(0, 30) + '...' : 'null');

  if (!token) {
    return res.status(401).json({ error: '未提供认证令牌' });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    console.log('[Debug authenticateToken] Decoded JWT:', decoded);

    // 验证用户是否存在且状态正常
    const users = await db.query(
      'SELECT id, username, is_admin, status FROM users WHERE id = ?',
      [decoded.userId]
    );

    console.log('[Debug authenticateToken] Query result:', users);
    
    if (users.length === 0) {
      return res.status(401).json({ error: '用户不存在' });
    }

    if (users[0].status !== 'active') {
      return res.status(403).json({ error: '账户已被封禁' });
    }

    console.log('[Debug authenticateToken] User is_admin:', users[0].is_admin);
    req.user = users[0];
    next();
  } catch (error) {
    console.error('[Debug authenticateToken] JWT verify error:', error);
    return res.status(403).json({ error: '无效的认证令牌' });
  }
}

/**
 * 校验 req.user.is_admin，非管理员返回 403
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

/**
 * 记录管理员操作到 admin_logs 表
 * @param {number} adminId - 管理员 ID
 * @param {string} action - 操作类型
 * @param {number|null} [targetId=null] - 目标用户 ID
 * @param {Object|null} [details=null] - 详情 JSON
 */
async function logAdminAction(adminId, action, targetId = null, details = null) {
  try {
    await db.query(
      'INSERT INTO admin_logs (admin_id, action, target_id, details) VALUES (?, ?, ?, ?)',
      [adminId, action, targetId, details ? JSON.stringify(details) : null]
    );
  } catch (error) {
    console.error('记录管理员操作日志失败:', error);
  }
}

/**
 * 可选认证中间件 - 如果有token则验证，没有则跳过
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    // 没有token，继续但不设置req.user
    return next();
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    const users = await db.query(
      'SELECT id, username, is_admin, status FROM users WHERE id = ?',
      [decoded.userId]
    );

    if (users.length > 0 && users[0].status === 'active') {
      req.user = users[0];
    }
  } catch (error) {
    // token无效，继续但不设置req.user
  }

  next();
}

module.exports = {
  authenticateToken,
  optionalAuth,
  requireAdmin,
  logAdminAction
};
