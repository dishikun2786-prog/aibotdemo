/**
 * @file field-converter.js
 * @module utils/field-converter
 * @description 字段命名转换工具 - 驼峰命名转下划线命名
 */

/**
 * 将对象字段从驼峰命名转换为下划线命名
 * @param {*} obj - 源对象、数组或基本类型
 * @returns {*} 转换后的对象、数组或基本类型
 * @example
 * toSnakeCase({ userId: 1, userName: 'test' })
 * // 返回: { user_id: 1, user_name: 'test' }
 */
function toSnakeCase(obj) {
  // 处理null、undefined和基本类型
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  
  // 处理数组
  if (Array.isArray(obj)) {
    return obj.map(item => toSnakeCase(item));
  }
  
  // 处理Date对象
  if (obj instanceof Date) {
    return obj;
  }
  
  // 处理普通对象
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    // 将驼峰命名转换为下划线命名
    const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    
    // 递归处理嵌套对象
    result[snakeKey] = typeof value === 'object' && value !== null
      ? toSnakeCase(value)
      : value;
  }
  
  return result;
}

/**
 * 将对象字段从下划线命名转换为驼峰命名
 * @param {*} obj - 源对象、数组或基本类型
 * @returns {*} 转换后的对象、数组或基本类型
 * @example
 * toCamelCase({ user_id: 1, user_name: 'test' })
 * // 返回: { userId: 1, userName: 'test' }
 */
function toCamelCase(obj) {
  // 处理null、undefined和基本类型
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  
  // 处理数组
  if (Array.isArray(obj)) {
    return obj.map(item => toCamelCase(item));
  }
  
  // 处理Date对象
  if (obj instanceof Date) {
    return obj;
  }
  
  // 处理普通对象
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    // 将下划线命名转换为驼峰命名
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    
    // 递归处理嵌套对象
    result[camelKey] = typeof value === 'object' && value !== null
      ? toCamelCase(value)
      : value;
  }
  
  return result;
}

module.exports = {
  toSnakeCase,
  toCamelCase
};
