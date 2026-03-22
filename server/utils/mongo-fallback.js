/**
 * MongoDB降级处理工具
 * 当MongoDB操作失败时提供降级方案，确保系统可用性
 */

/**
 * MongoDB操作降级包装器
 * @param {Function} operation - MongoDB操作函数
 * @param {*} fallbackValue - 降级返回值
 * @param {string} operationName - 操作名称（用于日志）
 * @returns {Promise<*>} 操作结果或降级值
 */
async function withFallback(operation, fallbackValue, operationName) {
  try {
    const result = await operation();
    // 如果结果为null或undefined，返回降级值
    return result !== null && result !== undefined ? result : fallbackValue;
  } catch (error) {
    console.error(`[MongoDB降级] ${operationName}失败:`, error.message);
    console.error(`[MongoDB降级] 使用降级值:`, fallbackValue);
    return fallbackValue;
  }
}

/**
 * 批量MongoDB操作降级包装器
 * @param {Array<{operation: Function, fallbackValue: *, name: string}>} operations - 操作数组
 * @returns {Promise<Array>} 操作结果数组
 */
async function withFallbackBatch(operations) {
  const results = await Promise.allSettled(
    operations.map(({ operation, fallbackValue, name }) =>
      withFallback(operation, fallbackValue, name)
    )
  );

  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      console.error(`[MongoDB降级] 批量操作失败:`, operations[index].name);
      return operations[index].fallbackValue;
    }
  });
}

module.exports = {
  withFallback,
  withFallbackBatch
};
