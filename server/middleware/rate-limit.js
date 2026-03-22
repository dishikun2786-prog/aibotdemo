/**
 * @file rate-limit.js
 * @module middleware/rate-limit
 * @description 频率限制中间件 - 防止API滥用和恶意攻击
 */

const rateLimit = require('express-rate-limit');

/**
 * 公开访问频率限制
 * 限制：同一IP每分钟最多10次访问
 * 用途：防止恶意刷访问量
 */
const publicAccessLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1分钟时间窗口
  max: 10,              // 最多10次请求
  message: { 
    success: false, 
    error: '访问过于频繁，请稍后再试' 
  },
  keyGenerator: (req) => {
    // 使用IP地址作为限制键
    return req.ip || req.connection.remoteAddress || 'unknown';
  },
  standardHeaders: true,  // 返回标准的 RateLimit-* 头部
  legacyHeaders: false    // 禁用 X-RateLimit-* 头部
});

/**
 * 保存操作频率限制
 * 限制：同一用户每分钟最多30次保存
 * 用途：防止频繁保存操作
 */
const saveLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1分钟时间窗口
  max: 30,              // 最多30次请求
  message: { 
    success: false, 
    error: '保存过于频繁，请稍后再试' 
  },
  keyGenerator: (req) => {
    // 使用用户ID作为限制键
    return req.user ? `user:${req.user.id}` : req.ip;
  },
  skip: (req) => {
    // 如果用户未登录，跳过限制（由认证中间件处理）
    return !req.user;
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * OSS令牌获取频率限制
 * 限制：同一用户每分钟最多10次获取
 * 用途：防止滥用OSS上传凭证
 */
const ossTokenLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1分钟时间窗口
  max: 10,              // 最多10次请求
  message: { 
    success: false, 
    error: '请求过于频繁，请稍后再试' 
  },
  keyGenerator: (req) => {
    return req.user ? `user:${req.user.id}` : req.ip;
  },
  skip: (req) => {
    return !req.user;
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * 布局更新频率限制
 * 限制：同一用户每分钟最多20次更新
 * 用途：防止频繁更新布局
 */
const layoutUpdateLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1分钟时间窗口
  max: 20,              // 最多20次请求
  message: { 
    success: false, 
    error: '更新过于频繁，请稍后再试' 
  },
  keyGenerator: (req) => {
    return req.user ? `user:${req.user.id}` : req.ip;
  },
  skip: (req) => {
    return !req.user;
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * 通用API频率限制
 * 限制：同一IP每分钟最多100次请求
 * 用途：防止API滥用
 */
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1分钟时间窗口
  max: 100,             // 最多100次请求
  message: { 
    success: false, 
    error: 'API请求过于频繁，请稍后再试' 
  },
  keyGenerator: (req) => {
    return req.ip || req.connection.remoteAddress || 'unknown';
  },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = {
  publicAccessLimiter,
  saveLimiter,
  ossTokenLimiter,
  layoutUpdateLimiter,
  generalLimiter
};
