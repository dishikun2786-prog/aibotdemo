/**
 * @file pk-queue.js
 * @module services/pk-queue
 * @description PK团任务队列服务 - 使用Redis实现异步PK计算处理
 */
const redis = require('../utils/redis');
const mongo = require('../utils/mongo');
const freePKService = require('./free-pk');
const socketServer = require('../socket');

const QUEUE_KEY = 'queue:pk:start';
const PROCESSING_KEY = 'queue:pk:processing';

/**
 * 将PK开始任务加入队列
 * @param {string} groupId - PK团ID
 * @returns {Promise<boolean>}
 */
async function enqueuePKStart(groupId) {
  try {
    const task = JSON.stringify({
      groupId,
      enqueuedAt: Date.now()
    });
    await redis.lPush(QUEUE_KEY, task);
    console.log(`[PKQueue] 任务已入队: ${groupId}`);
    return true;
  } catch (err) {
    console.error('[PKQueue] 入队失败:', err);
    return false;
  }
}

/**
 * 处理队列任务
 */
async function processQueue() {
  try {
    // 使用原子操作避免重复处理
    const lockAcquired = await redis.acquireLock('lock:pk:queue:processor', 'processor', 5);
    if (!lockAcquired) {
      return;
    }

    try {
      // 从队列获取任务
      const task = await redis.lPop(QUEUE_KEY);
      if (!task) {
        return;
      }

      const { groupId, enqueuedAt } = JSON.parse(task);
      console.log(`[PKQueue] 开始处理PK团: ${groupId}`);

      // 检查是否已经在处理中
      const isProcessing = await redis.get(`${PROCESSING_KEY}:${groupId}`);
      if (isProcessing) {
        console.log(`[PKQueue] PK团 ${groupId} 已在处理中，跳过`);
        return;
      }

      // 标记处理中
      await redis.set(`${PROCESSING_KEY}:${groupId}`, '1', 60); // 60秒超时

      // 执行PK计算
      await executePK(groupId);

      // 清除处理标记
      await redis.del(`${PROCESSING_KEY}:${groupId}`);

      console.log(`[PKQueue] PK团处理完成: ${groupId}`);
    } finally {
      await redis.releaseLock('lock:pk:queue:processor', 'processor');
    }
  } catch (err) {
    console.error('[PKQueue] 处理任务失败:', err);
  }
}

/**
 * 执行PK计算
 * @param {string} groupId - PK团ID
 */
async function executePK(groupId) {
  try {
    // 获取PK团信息
    const group = await mongo.getFreePKGroup(groupId);
    if (!group || group.status !== 'waiting') {
      console.log(`[PKQueue] PK团 ${groupId} 不存在或已开始，跳过`);
      return;
    }

    // 获取参与者
    const participants = await mongo.getFreePKParticipants(groupId);
    if (participants.length < 2) {
      console.log(`[PKQueue] PK团 ${groupId} 人数不足，跳过`);
      return;
    }

    // 执行PK（startPKGroup内部会更新状态为ongoing）
    await freePKService.startPKGroup(groupId);

    // 广播PK完成事件
    await broadcastPKComplete(groupId);
  } catch (err) {
    console.error(`[PKQueue] PK团 ${groupId} 执行失败:`, err);
    try {
      await mongo.updateFreePKGroup(groupId, { status: 'waiting' });
      broadcastPKError(groupId, err.message);
    } catch (recoverErr) {
      console.error(`[PKQueue] PK团 ${groupId} 恢复状态失败:`, recoverErr);
    }
    throw err;
  }
}

/**
 * 广播PK完成事件
 * @param {string} groupId - PK团ID
 */
async function broadcastPKComplete(groupId) {
  try {
    const group = await mongo.getFreePKGroup(groupId);
    const participants = await mongo.getFreePKParticipants(groupId);

    // 获取最新排行榜（兼容 Redis 工具模块没有 zrevrange 的情况）
    let fortuneLeaderboard = [];
    let contributionLeaderboard = [];
    try {
      const redisClient = await redis.getClient();
      if (redisClient && typeof redisClient.zRevRange === 'function') {
        fortuneLeaderboard = await redisClient.zRevRange('leaderboard:fortune:zs', 0, 9, 'WITHSCORES');
        contributionLeaderboard = await redisClient.zRevRange('leaderboard:contribution:zs', 0, 9, 'WITHSCORES');
      }
    } catch (redisErr) {
      console.error('[PKQueue] 获取排行榜失败:', redisErr.message);
    }

    const plazaIO = socketServer.getPlazaIO();
    if (plazaIO) {
      // 广播排行榜更新
      plazaIO.emit('leaderboard_update', {
        fortune: fortuneLeaderboard,
        contribution: contributionLeaderboard,
        timestamp: Date.now()
      });

      // 广播PK团状态更新
      plazaIO.emit('free_pk_update', {
        groupId: groupId,
        status: group?.status || 'completed',
        winnerId: group?.winnerId,
        winnerUsername: group?.winnerUsername,
        totalPrize: group?.totalPrize,
        timestamp: Date.now()
      });

      // 广播PK完成详细结果
      plazaIO.emit('pk_complete', {
        groupId: groupId,
        status: group?.status,
        winnerId: group?.winnerId,
        winnerUsername: group?.winnerUsername,
        totalPrize: group?.totalPrize,
        participants: participants.map(p => ({
          userId: p.userId,
          username: p.username,
          status: p.status,
          energyChange: p.energyChange || 0,
          fortuneChange: p.fortuneChange || 0,
          contributionChange: p.contributionChange || 0
        })),
        timestamp: Date.now()
      });
    }
  } catch (err) {
    console.error('[PKQueue] 广播PK完成事件失败:', err);
  }
}

/**
 * 广播PK执行错误
 * @param {string} groupId - PK团ID
 * @param {string} errorMessage - 错误信息
 */
function broadcastPKError(groupId, errorMessage) {
  try {
    const plazaIO = socketServer.getPlazaIO();
    if (plazaIO) {
      plazaIO.emit('free_pk_update', {
        groupId: groupId,
        status: 'failed',
        message: errorMessage || 'PK执行失败，请重试',
        timestamp: Date.now()
      });
    }
  } catch (err) {
    console.error('[PKQueue] 广播PK错误失败:', err);
  }
}

/**
 * 启动队列处理器
 */
function startQueueProcessor() {
  console.log('[PKQueue] 队列处理器已启动');

  // 每秒处理一次队列
  setInterval(async () => {
    await processQueue();
  }, 1000);
}

/**
 * 手动触发队列处理（用于测试）
 */
async function triggerProcess() {
  await processQueue();
}

module.exports = {
  enqueuePKStart,
  processQueue,
  executePK,
  broadcastPKComplete,
  startQueueProcessor,
  triggerProcess
};
