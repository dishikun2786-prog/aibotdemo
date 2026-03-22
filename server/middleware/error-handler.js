/**
 * @file error-handler.js
 * @module middleware/error-handler
 * @description 统一错误处理中间件
 */

/**
 * 统一错误处理中间件
 * @param {Error} err - 错误对象
 * @param {Object} req - Express请求对象
 * @param {Object} res - Express响应对象
 * @param {Function} next - Express next函数
 */
function errorHandler(err, req, res, next) {
  // 记录详细错误日志
  console.error('[错误处理]', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    url: req.url,
    method: req.method,
    userId: req.user?.id,
    timestamp: new Date().toISOString()
  });

  // 根据错误类型返回不同响应
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: err.message || '输入验证失败'
    });
  }

  if (err.name === 'UnauthorizedError' || err.message === '未授权') {
    return res.status(401).json({
      success: false,
      error: '未授权，请登录'
    });
  }

  if (err.name === 'ForbiddenError' || err.message === '禁止访问') {
    return res.status(403).json({
      success: false,
      error: '无权访问此资源'
    });
  }

  if (err.name === 'NotFoundError' || err.message.includes('不存在')) {
    return res.status(404).json({
      success: false,
      error: err.message || '资源不存在'
    });
  }

  if (err.name === 'TooManyRequestsError' || err.message.includes('频繁')) {
    return res.status(429).json({
      success: false,
      error: err.message || '请求过于频繁，请稍后再试'
    });
  }

  // 默认服务器错误
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? '服务器内部错误' 
      : err.message
  });
}

/**
 * 异步路由包装器 - 自动捕获异步错误
 * @param {Function} fn - 异步路由处理函数
 * @returns {Function} 包装后的函数
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 创建自定义错误类
 * @param {string} name - 错误名称
 * @param {number} statusCode - HTTP状态码
 * @returns {Class} 自定义错误类
 */
function createError(name, statusCode) {
  class CustomError extends Error {
    constructor(message) {
      super(message);
      this.name = name;
      this.status = statusCode;
    }
  }
  return CustomError;
}

// 导出常用错误类
const ValidationError = createError('ValidationError', 400);
const UnauthorizedError = createError('UnauthorizedError', 401);
const ForbiddenError = createError('ForbiddenError', 403);
const NotFoundError = createError('NotFoundError', 404);
const TooManyRequestsError = createError('TooManyRequestsError', 429);

module.exports = {
  errorHandler,
  asyncHandler,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError
};
