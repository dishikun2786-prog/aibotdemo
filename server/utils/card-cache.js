/**
 * @file card-cache.js
 * @module utils/card-cache
 * @description 名片缓存管理函数 - 统一处理名片相关的缓存操作
 */

const redis = require('./redis');
const { CACHE_KEYS, CACHE_TTL } = require('./cache-keys');

/**
 * 从缓存获取数据（带降级处理）
 * @param {string} key - 缓存键
 * @returns {Promise<any|null>} 缓存数据或null
 */
async function getCardFromCache(key) {
  try {
    const cached = await redis.get(key);
    if (cached) {
      console.log(`[缓存命中] ${key}`);
      return cached;
    }
    console.log(`[缓存未命中] ${key}`);
    return null;
  } catch (error) {
    console.error(`[缓存读取失败] ${key}:`, error.message);
    // Redis故障时返回null，不影响业务逻辑
    return null;
  }
}

/**
 * 设置缓存数据
 * @param {string} key - 缓存键
 * @param {any} value - 缓存值
 * @param {number} ttl - 过期时间（秒）
 * @returns {Promise<boolean>} 是否设置成功
 */
async function setCardToCache(key, value, ttl) {
  try {
    const result = await redis.set(key, value, ttl);
    if (result) {
      console.log(`[缓存写入成功] ${key}, TTL: ${ttl}秒`);
      return true;
    }
    return false;
  } catch (error) {
    console.error(`[缓存写入失败] ${key}:`, error.message);
    // Redis故障时不影响业务逻辑
    return false;
  }
}

/**
 * 清除指定名片的所有相关缓存
 * @param {number} cardId - 名片ID
 * @param {number} userId - 用户ID
 * @param {string|null} cardToken - 名片访问令牌（可选）
 * @returns {Promise<void>}
 */
async function clearCardCaches(cardId, userId, cardToken = null) {
  try {
    const keysToDelete = [];

    // 1. 清除名片详情缓存
    if (cardId) {
      keysToDelete.push(CACHE_KEYS.CARD_DETAIL(cardId));
      keysToDelete.push(CACHE_KEYS.CARD_LAYOUT(cardId));
      keysToDelete.push(CACHE_KEYS.CARD_STATS(cardId));
    }

    // 2. 清除公开访问缓存
    if (cardToken) {
      keysToDelete.push(CACHE_KEYS.CARD_PUBLIC(cardToken));
    }

    // 3. 清除用户名片列表缓存
    if (userId) {
      keysToDelete.push(CACHE_KEYS.CARD_LIST(userId));
    }

    // 批量删除缓存
    for (const key of keysToDelete) {
      await redis.del(key);
      console.log(`[缓存清除] ${key}`);
    }

    console.log(`[缓存清除完成] 共清除 ${keysToDelete.length} 个缓存键`);
  } catch (error) {
    console.error('[缓存清除失败]:', error.message);
    // Redis故障时不影响业务逻辑，只记录日志
  }
}

/**
 * 清除用户的所有名片列表缓存
 * @param {number} userId - 用户ID
 * @returns {Promise<void>}
 */
async function clearUserCardListCache(userId) {
  try {
    const key = CACHE_KEYS.CARD_LIST(userId);
    await redis.del(key);
    console.log(`[缓存清除] 用户名片列表: ${key}`);
  } catch (error) {
    console.error('[缓存清除失败]:', error.message);
  }
}

/**
 * 批量清除多个名片的缓存
 * @param {Array<{cardId: number, userId: number, cardToken: string}>} cards - 名片信息数组
 * @returns {Promise<void>}
 */
async function clearMultipleCardCaches(cards) {
  try {
    for (const card of cards) {
      await clearCardCaches(card.cardId, card.userId, card.cardToken);
    }
    console.log(`[批量缓存清除完成] 共处理 ${cards.length} 个名片`);
  } catch (error) {
    console.error('[批量缓存清除失败]:', error.message);
  }
}

/**
 * 预热缓存 - 提前加载热门名片到缓存
 * @param {Array<Object>} cards - 名片数据数组
 * @returns {Promise<void>}
 */
async function warmupCache(cards) {
  try {
    for (const card of cards) {
      // 缓存名片详情
      if (card.id) {
        await setCardToCache(
          CACHE_KEYS.CARD_DETAIL(card.id),
          card,
          CACHE_TTL.CARD_DETAIL
        );
      }

      // 缓存公开访问
      if (card.card_token && card.is_published) {
        await setCardToCache(
          CACHE_KEYS.CARD_PUBLIC(card.card_token),
          card,
          CACHE_TTL.CARD_PUBLIC
        );
      }
    }
    console.log(`[缓存预热完成] 共预热 ${cards.length} 个名片`);
  } catch (error) {
    console.error('[缓存预热失败]:', error.message);
  }
}

module.exports = {
  getCardFromCache,
  setCardToCache,
  clearCardCaches,
  clearUserCardListCache,
  clearMultipleCardCaches,
  warmupCache
};
