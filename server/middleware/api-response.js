/**
 * @file api-response.js
 * @module middleware/api-response
 * @description API响应格式化中间件 - 统一响应格式和字段命名转换
 */

/**
 * 将驼峰命名转换为下划线命名（snake_case）
 * @param {any} obj - 要转换的对象
 * @returns {any} 转换后的对象
 */
function toSnakeCase(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => toSnakeCase(item));
  }

  if (typeof obj === 'object') {
    return Object.keys(obj).reduce((result, key) => {
      // 将驼峰转换为下划线：userId -> user_id, likesCount -> likes_count
      const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      result[snakeKey] = toSnakeCase(obj[key]);
      return result;
    }, {});
  }

  return obj;
}

/**
 * 将下划线命名转换为驼峰命名（camelCase）
 * @param {any} obj - 要转换的对象
 * @returns {any} 转换后的对象
 */
function toCamelCase(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => toCamelCase(item));
  }

  if (typeof obj === 'object') {
    return Object.keys(obj).reduce((result, key) => {
      // 将下划线转换为驼峰：user_id -> userId, likes_count -> likesCount
      const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      result[camelKey] = toCamelCase(obj[key]);
      return result;
    }, {});
  }

  return obj;
}

/**
 * 统一成功响应格式
 * @param {object} res - Express响应对象
 * @param {any} data - 响应数据
 * @param {string} [message='操作成功'] - 成功消息
 * @param {number} [statusCode=200] - HTTP状态码
 */
function success(res, data, message = '操作成功', statusCode = 200) {
  // 自动将数据转换为下划线命名
  const formattedData = toSnakeCase(data);
  res.status(statusCode).json({
    success: true,
    data: formattedData,
    message
  });
}

/**
 * 统一错误响应格式
 * @param {object} res - Express响应对象
 * @param {string} message - 错误消息
 * @param {number} [statusCode=400] - HTTP状态码
 */
function error(res, message, statusCode = 400) {
  res.status(statusCode).json({
    success: false,
    error: message
  });
}

/**
 * 统一分页响应格式
 * @param {object} res - Express响应对象
 * @param {any[]} items - 数据项数组
 * @param {number} page - 当前页码
 * @param {number} limit - 每页数量
 * @param {number} total - 总数量
 * @param {string} [message='获取成功']
 */
function paginated(res, items, page, limit, total, message = '获取成功') {
  res.json({
    success: true,
    data: toSnakeCase(items),
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit)
    },
    message
  });
}

/**
 * 中间件工厂 - 自动格式化响应数据
 * @param {object} options - 配置选项
 * @param {boolean} [options.autoFormat=true] - 是否自动格式化响应数据
 * @param {boolean} [options.toSnakeCase=true] - 是否转换为下划线命名
 */
function createResponseMiddleware(options = {}) {
  const {
    autoFormat = true,
    toSnakeCase: shouldConvert = true
  } = options;

  return (req, res, next) => {
    // 拦截res.json以格式化响应
    const originalJson = res.json.bind(res);

    res.json = (data) => {
      if (!autoFormat || !data) {
        return originalJson(data);
      }

      // 如果数据已经是标准格式（有success字段），直接返回
      if (data.success !== undefined) {
        return originalJson(data);
      }

      // 格式化响应数据
      const formattedData = shouldConvert ? toSnakeCase(data) : data;
      return originalJson(formattedData);
    };

    next();
  };
}

module.exports = {
  toSnakeCase,
  toCamelCase,
  success,
  error,
  paginated,
  createResponseMiddleware
};
