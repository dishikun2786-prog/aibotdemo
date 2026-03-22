/**
 * @file sanitizer.js
 * @module utils/sanitizer
 * @description XSS防护工具 - 清理用户输入，防止跨站脚本攻击
 */

const xss = require('xss');

/**
 * XSS过滤配置
 * 定义允许的HTML标签和属性白名单
 */
const xssOptions = {
  whiteList: {
    // 文本标签
    p: ['class', 'style'],
    span: ['class', 'style'],
    div: ['class', 'style'],
    h1: ['class', 'style'],
    h2: ['class', 'style'],
    h3: ['class', 'style'],
    h4: ['class', 'style'],
    h5: ['class', 'style'],
    h6: ['class', 'style'],
    
    // 格式化标签
    strong: ['class', 'style'],
    b: ['class', 'style'],
    em: ['class', 'style'],
    i: ['class', 'style'],
    u: ['class', 'style'],
    br: [],
    
    // 列表标签
    ul: ['class', 'style'],
    ol: ['class', 'style'],
    li: ['class', 'style'],
    
    // 链接和图片
    a: ['href', 'target', 'class', 'style', 'rel'],
    img: ['src', 'alt', 'class', 'style', 'width', 'height'],
    
    // 表格标签
    table: ['class', 'style'],
    thead: ['class', 'style'],
    tbody: ['class', 'style'],
    tr: ['class', 'style'],
    th: ['class', 'style'],
    td: ['class', 'style']
  },
  
  // 移除不在白名单中的标签
  stripIgnoreTag: true,
  
  // 移除script和style标签及其内容
  stripIgnoreTagBody: ['script', 'style'],
  
  // CSS过滤
  css: {
    whiteList: {
      // 允许的CSS属性
      'color': true,
      'background-color': true,
      'font-size': true,
      'font-weight': true,
      'text-align': true,
      'padding': true,
      'margin': true,
      'border': true,
      'border-radius': true,
      'width': true,
      'height': true,
      'display': true,
      'flex': true,
      'justify-content': true,
      'align-items': true
    }
  }
};

/**
 * 清理用户输入，防止XSS攻击
 * @param {string} input - 用户输入的字符串
 * @returns {string} 清理后的安全字符串
 * @example
 * sanitizeInput('<script>alert("xss")</script>Hello')
 * // 返回: 'Hello'
 */
function sanitizeInput(input) {
  if (typeof input !== 'string') {
    return input;
  }
  
  // 使用xss库进行过滤
  return xss(input, xssOptions);
}

/**
 * 清理对象中的所有字符串字段
 * @param {Object} obj - 包含用户输入的对象
 * @returns {Object} 清理后的对象
 * @example
 * sanitizeObject({ name: '<script>alert("xss")</script>John', age: 25 })
 * // 返回: { name: 'John', age: 25 }
 */
function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }
  
  // 处理数组
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }
  
  // 处理普通对象
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = sanitizeInput(value);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeObject(value);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

/**
 * 清理HTML内容，保留基本格式
 * @param {string} html - HTML内容
 * @returns {string} 清理后的HTML
 */
function sanitizeHTML(html) {
  if (typeof html !== 'string') {
    return html;
  }
  
  return xss(html, xssOptions);
}

/**
 * 严格清理，移除所有HTML标签
 * @param {string} input - 用户输入
 * @returns {string} 纯文本内容
 * @example
 * sanitizeStrict('<p>Hello <b>World</b></p>')
 * // 返回: 'Hello World'
 */
function sanitizeStrict(input) {
  if (typeof input !== 'string') {
    return input;
  }
  
  // 移除所有HTML标签
  return xss(input, {
    whiteList: {},
    stripIgnoreTag: true,
    stripIgnoreTagBody: ['script', 'style']
  });
}

/**
 * 验证URL是否安全
 * @param {string} url - URL地址
 * @returns {boolean} 是否为安全URL
 */
function isSafeURL(url) {
  if (typeof url !== 'string') {
    return false;
  }
  
  // 允许的协议
  const allowedProtocols = ['http:', 'https:', 'mailto:', 'tel:'];
  
  try {
    const urlObj = new URL(url);
    return allowedProtocols.includes(urlObj.protocol);
  } catch (error) {
    // 相对URL也认为是安全的
    return url.startsWith('/') || url.startsWith('./') || url.startsWith('../');
  }
}

/**
 * 清理URL，确保安全
 * @param {string} url - URL地址
 * @returns {string|null} 安全的URL或null
 */
function sanitizeURL(url) {
  if (!isSafeURL(url)) {
    return null;
  }
  
  // 移除潜在的XSS payload
  return url.replace(/javascript:/gi, '')
            .replace(/data:/gi, '')
            .replace(/vbscript:/gi, '');
}

module.exports = {
  sanitizeInput,
  sanitizeObject,
  sanitizeHTML,
  sanitizeStrict,
  isSafeURL,
  sanitizeURL
};
