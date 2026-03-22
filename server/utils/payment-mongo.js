/**
 * @file payment-mongo.js
 * @description 支付订单MongoDB辅助函数
 * 用于记录支付订单操作日志和访问日志
 * 注意：使用延迟加载mongo模块，避免MongoDB连接失败时导致整个应用无法启动
 */

// 访问日志集合名称
const PAYMENT_VISITS_COLLECTION = 'payment_visits';

/**
 * 获取支付访问日志集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getPaymentVisitsCollection() {
  const mongo = require('./mongo');
  const database = await mongo.getDb();
  const coll = database.collection(PAYMENT_VISITS_COLLECTION);
  await coll.createIndex({ merchantId: 1, createdAt: -1 });
  await coll.createIndex({ itemId: 1, createdAt: -1 });
  await coll.createIndex({ ipAddress: 1, createdAt: -1 });
  return coll;
}

/**
 * 记录支付页面访问日志
 * @param {Object} visitData - 访问数据
 * @param {number} visitData.merchantId - 商户ID
 * @param {number} visitData.itemId - 名目ID
 * @param {string} visitData.ipAddress - IP地址
 * @param {string} visitData.userAgent - 用户代理
 * @param {string} visitData.referer - 来源页面
 * @returns {Promise<string>} 插入的文档ID
 */
async function logPaymentVisit(visitData) {
  const coll = await getPaymentVisitsCollection();
  const doc = {
    merchantId: visitData.merchantId,
    itemId: visitData.itemId || null,
    ipAddress: visitData.ipAddress || '',
    userAgent: visitData.userAgent || '',
    referer: visitData.referer || '',
    createdAt: visitData.createdAt || new Date()
  };
  const result = await coll.insertOne(doc);
  return result.insertedId.toString();
}

/**
 * 获取访问统计
 * @param {number} merchantId - 商户ID
 * @param {Object} options - 查询选项
 * @param {Date} options.startDate - 开始日期
 * @param {Date} options.endDate - 结束日期
 * @returns {Promise<Object>} 统计数据
 */
async function getVisitStats(merchantId, options = {}) {
  const coll = await getPaymentVisitsCollection();
  const match = { merchantId };

  if (options.startDate || options.endDate) {
    match.createdAt = {};
    if (options.startDate) match.createdAt.$gte = options.startDate;
    if (options.endDate) match.createdAt.$lte = options.endDate;
  }

  // 总访问量
  const totalVisits = await coll.countDocuments(match);

  // 今日访问量
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMatch = { ...match, createdAt: { $gte: today } };
  const todayVisits = await coll.countDocuments(todayMatch);

  // 按日期统计（最近7天）
  const weeklyStats = await coll.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
        },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: -1 } },
    { $limit: 7 }
  ]).toArray();

  // 最近访问记录
  const recentVisits = await coll.find(match)
    .sort({ createdAt: -1 })
    .limit(20)
    .project({ ipAddress: 1, userAgent: 1, createdAt: 1, _id: 0 })
    .toArray();

  return {
    total_visits: totalVisits,
    today_visits: todayVisits,
    weekly_visits: weeklyStats.map(w => ({
      date: w._id,
      count: w.count
    })),
    recent_visits: recentVisits.map(v => ({
      ip: v.ipAddress,
      user_agent: v.userAgent,
      created_at: v.createdAt
    }))
  };
}

/**
 * 获取支付订单日志集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getPaymentOrderLogsCollection() {
  const mongo = require('./mongo');
  const database = await mongo.getDb();
  const coll = database.collection('payment_order_logs');
  await coll.createIndex({ orderId: 1, createdAt: -1 });
  await coll.createIndex({ orderNo: 1 });
  return coll;
}

/**
 * 记录支付订单操作日志
 * @param {number} orderId - 订单ID
 * @param {string} orderNo - 订单号
 * @param {string} action - 操作类型: created, paid, confirmed, rejected, cancelled
 * @param {Object} options - 选项
 * @returns {Promise<string>} 日志ID
 */
async function logPaymentOrderAction(orderId, orderNo, action, options = {}) {
  try {
    const coll = await getPaymentOrderLogsCollection();
    const result = await coll.insertOne({
      orderId,
      orderNo,
      action,
      amount: options.amount || null,
      paymentMethod: options.paymentMethod || null,
      note: options.note || '',
      ipAddress: options.ipAddress || '',
      userAgent: options.userAgent || '',
      createdAt: new Date()
    });
    return result.insertedId.toString();
  } catch (err) {
    console.error('记录订单日志失败:', err);
    return null;
  }
}

/**
 * 获取订单操作日志
 * @param {number} orderId - 订单ID
 * @returns {Promise<Array>} 日志列表
 */
async function getPaymentOrderLogs(orderId) {
  try {
    const coll = await getPaymentOrderLogsCollection();
    const logs = await coll.find({ orderId }).sort({ createdAt: -1 }).limit(50).toArray();
    return logs;
  } catch (err) {
    console.error('获取订单日志失败:', err);
    return [];
  }
}

module.exports = {
  // 访问日志
  getPaymentVisitsCollection,
  logPaymentVisit,
  getVisitStats,
  // 订单日志
  getPaymentOrderLogsCollection,
  logPaymentOrderAction,
  getPaymentOrderLogs
};
