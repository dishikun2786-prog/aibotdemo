/**
 * @file cache-keys.js
 * @module utils/cache-keys
 * @description Redis缓存键和TTL配置
 */

/**
 * 缓存键常量
 * 使用函数生成动态键，确保键名唯一性
 */
const CACHE_KEYS = {
  // 名片列表缓存 - 按用户ID
  CARD_LIST: (userId) => `card:list:${userId}`,

  // 名片详情缓存 - 按名片ID
  CARD_DETAIL: (cardId) => `card:detail:${cardId}`,

  // 公开名片缓存 - 按访问令牌
  CARD_PUBLIC: (token) => `card:public:${token}`,

  // 名片布局缓存 - 按名片ID
  CARD_LAYOUT: (cardId) => `card:layout:${cardId}`,

  // 名片统计缓存 - 按名片ID
  CARD_STATS: (cardId) => `card:stats:${cardId}`,

  // ========== 支付商户相关缓存 ==========
  // 商户信息缓存 - 按商户ID
  PAYMENT_MERCHANT_INFO: (merchantId) => `payment:merchant:${merchantId}`,

  // 商户信息缓存 - 按用户ID
  PAYMENT_MERCHANT_BY_USER: (userId) => `payment:merchant:user:${userId}`,

  // 收款名目缓存 - 按名目ID
  PAYMENT_ITEM_DETAIL: (itemId) => `payment:item:${itemId}`,

  // 收款名目列表缓存 - 按商户ID
  PAYMENT_ITEM_LIST: (merchantId) => `payment:items:${merchantId}`,

  // 订单详情缓存 - 按订单号
  PAYMENT_ORDER_DETAIL: (orderNo) => `payment:order:${orderNo}`,

  // 订单详情缓存 - 按订单ID
  PAYMENT_ORDER_BY_ID: (orderId) => `payment:order:id:${orderId}`,

  // 每日统计缓存 - 按商户ID和日期
  PAYMENT_DAILY_STATS: (merchantId, date) => `payment:stats:${merchantId}:${date}`,

  // 每月统计缓存 - 按商户ID和年月
  PAYMENT_MONTHLY_STATS: (merchantId, yearMonth) => `payment:stats:${merchantId}:m:${yearMonth}`,

  // 商户汇总缓存 - 按商户ID
  PAYMENT_MERCHANT_SUMMARY: (merchantId) => `payment:summary:${merchantId}`
};

/**
 * 缓存TTL配置（单位：秒）
 * 根据数据更新频率和重要性设置不同的过期时间
 */
const CACHE_TTL = {
  // 名片列表 - 60秒（1分钟）
  // 用户可能频繁创建/删除名片，需要较短的缓存时间
  CARD_LIST: 60,

  // 名片详情 - 300秒（5分钟）
  // 名片内容相对稳定，可以缓存较长时间
  CARD_DETAIL: 300,

  // 公开名片 - 600秒（10分钟）
  // 公开访问的名片内容更稳定，可以缓存更长时间
  CARD_PUBLIC: 600,

  // 名片布局 - 300秒（5分钟）
  // 布局数据可能较大，但修改频率不高
  CARD_LAYOUT: 300,

  // 名片统计 - 60秒（1分钟）
  // 访问次数等统计数据变化频繁，需要较短的缓存时间
  CARD_STATS: 60,

  // ========== 支付商户相关缓存TTL ==========
  // 商户信息 - 300秒（5分钟）
  PAYMENT_MERCHANT_INFO: 300,

  // 收款名目详情 - 300秒（5分钟）
  PAYMENT_ITEM_DETAIL: 300,

  // 收款名目列表 - 60秒（1分钟）
  PAYMENT_ITEM_LIST: 60,

  // 订单详情 - 60秒（1分钟）
  PAYMENT_ORDER_DETAIL: 60,

  // 每日统计 - 3600秒（1小时）
  PAYMENT_DAILY_STATS: 3600,

  // 每月统计 - 3600秒（1小时）
  PAYMENT_MONTHLY_STATS: 3600,

  // 商户汇总 - 1800秒（30分钟）
  PAYMENT_MERCHANT_SUMMARY: 1800
};

module.exports = {
  CACHE_KEYS,
  CACHE_TTL
};
