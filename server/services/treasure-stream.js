/**
 * @file treasure-stream.js
 * @module services/treasure-stream
 * @description 能量宝藏 Redis Stream 消息队列服务
 * 处理能量宝藏配置更新、领取事件、平台池同步等实时消息
 */
const redis = require('../utils/redis');
const db = require('../utils/db');

// Stream键名定义
const STREAMS = {
  TREASURE_UPDATES: 'treasure:updates'  // 能量宝藏更新事件
};

// 消息类型
const MESSAGE_TYPES = {
  TREASURE_CLAIMED: 'TREASURE_CLAIMED',           // 宝藏被领取
  TREASURE_CONFIG_UPDATED: 'TREASURE_CONFIG_UPDATED', // 宝藏配置更新
  PLATFORM_POOL_UPDATE: 'PLATFORM_POOL_UPDATE'   // 平台池更新
};

/**
 * 发布宝藏更新消息
 * @param {string} type - 消息类型
 * @param {Object} data - 消息数据
 * @returns {Promise<string|null>} 消息ID
 */
async function publishTreasureUpdate(type, data) {
  const payload = {
    type,
    ...data,
    timestamp: new Date().toISOString()
  };
  return await redis.xAdd(STREAMS.TREASURE_UPDATES, payload, 500);
}

/**
 * 宝藏被领取事件发布
 * @param {Object} params - 参数
 * @param {number} params.userId - 用户ID
 * @param {number} params.roomId - 房间ID
 * @param {number} params.nodeId - 节点ID
 * @param {number} params.amount - 领取金额
 * @param {number} params.newEnergy - 领取后能量
 * @param {number} params.platformPool - 更新后平台池
 * @returns {Promise<string|null>}
 */
async function publishTreasureClaimed({ userId, roomId, nodeId, amount, newEnergy, platformPool }) {
  return await publishTreasureUpdate(MESSAGE_TYPES.TREASURE_CLAIMED, {
    userId,
    roomId,
    nodeId,
    amount,
    newEnergy,
    platformPool
  });
}

/**
 * 宝藏配置更新事件发布
 * @param {Object} params - 参数
 * @param {Array} params.treasureConfig - 新的宝藏配置
 * @param {number} params.totalAmount - 配置总金额
 * @param {number} params.platformPool - 更新后平台池
 * @returns {Promise<string|null>}
 */
async function publishTreasureConfigUpdated({ treasureConfig, totalAmount, platformPool }) {
  return await publishTreasureUpdate(MESSAGE_TYPES.TREASURE_CONFIG_UPDATED, {
    treasureConfig: JSON.stringify(treasureConfig),
    totalAmount,
    platformPool
  });
}

/**
 * 平台池更新事件发布
 * @param {Object} params - 参数
 * @param {number} params.roomId - 房间ID
 * @param {number} params.platformPool - 新平台池金额
 * @param {Object} params.treasureInfo - 宝藏信息
 * @returns {Promise<string|null>}
 */
async function publishPlatformPoolUpdate({ roomId, platformPool, treasureInfo }) {
  return await publishTreasureUpdate(MESSAGE_TYPES.PLATFORM_POOL_UPDATE, {
    roomId,
    platformPool,
    treasureInfo: JSON.stringify(treasureInfo)
  });
}

/**
 * 订阅宝藏更新消息（用于多实例同步）
 * @param {Function} callback - 处理回调函数，接收 (type, data) 参数
 * @returns {Promise<void>}
 */
async function subscribeTreasureUpdates(callback) {
  let lastId = '0';

  const readLoop = async () => {
    try {
      const messages = await redis.xRead(STREAMS.TREASURE_UPDATES, lastId, 10);

      if (messages && messages.length > 0) {
        for (const msg of messages) {
          for (const item of msg.messages) {
            lastId = item.id;
            const { type, ...data } = item.message;
            callback(type, data);
          }
        }
      }
    } catch (error) {
      console.error('[TreasureStream] 读取消息失败:', error.message);
    }

    // 继续监听（间隔500ms）
    setTimeout(readLoop, 500);
  };

  readLoop();
  console.log('[TreasureStream] 已启动消息监听');
}

/**
 * 启动后台消费者（处理跨实例同步）
 * @param {Object} io - Socket.io实例
 * @returns {Promise<void>}
 */
async function startConsumer(io) {
  await subscribeTreasureUpdates(async (type, data) => {
    console.log(`[TreasureStream] 收到消息: ${type}`, data);

    switch (type) {
      case MESSAGE_TYPES.TREASURE_CLAIMED:
        // 广播给房间内所有玩家
        if (data.roomId) {
          io.to(`room_${data.roomId}`).emit('game_state', {
            type: 'platform_pool_update',
            platformPool: data.platformPool,
            treasureInfo: {
              configured: true,
              nodeCount: data.nodeCount || 0,
              totalAmount: data.totalAmount || 0
            }
          });
        }
        break;

      case MESSAGE_TYPES.TREASURE_CONFIG_UPDATED:
        // 广播配置更新给所有房间
        const rooms = await db.query('SELECT id FROM game_rooms WHERE status IN (?, ?)', ['waiting', 'playing']);
        for (const room of rooms) {
          io.to(`room_${room.id}`).emit('game_state', {
            type: 'treasure_config_updated',
            treasureConfig: JSON.parse(data.treasureConfig || '[]'),
            totalAmount: data.totalAmount,
            platformPool: data.platformPool
          });
        }
        break;

      case MESSAGE_TYPES.PLATFORM_POOL_UPDATE:
        // 广播平台池更新
        if (data.roomId) {
          io.to(`room_${data.roomId}`).emit('game_state', {
            type: 'platform_pool_update',
            platformPool: data.platformPool,
            treasureInfo: data.treasureInfo ? JSON.parse(data.treasureInfo) : null
          });
        }
        break;

      default:
        console.log(`[TreasureStream] 未知消息类型: ${type}`);
    }
  });
}

module.exports = {
  STREAMS,
  MESSAGE_TYPES,
  publishTreasureUpdate,
  publishTreasureClaimed,
  publishTreasureConfigUpdated,
  publishPlatformPoolUpdate,
  subscribeTreasureUpdates,
  startConsumer
};
