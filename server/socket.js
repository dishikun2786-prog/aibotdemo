/**
 * @file socket.js
 * @module socket
 * @description Socket.io 实时通信：房间、节点占据、挖矿、PK 挑战与结算
 */
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('./config/database');
const db = require('./utils/db');
const redis = require('./utils/redis');
const mongo = require('./utils/mongo');
const treasureStream = require('./services/treasure-stream');
const chessSocket = require('./services/chess-socket');
const { isParticipantInAnyChallenge, isDefenderInPendingChallenge, userHasNodeInRoom, getCanPK } = require('./utils/pk-challenge-helper');

let io = null;
const connectedUsers = new Map(); // userId -> Set<socketId>
const challengeQueue = new Map(); // challengeKey -> { attackerId, defenderId, roomId, createdAt }

// ========== 关键词匹配函数（Socket版本）==========
async function tryKeywordMatchForSocket(avatarId, userMessage) {
  try {
    if (!userMessage || userMessage.trim().length < 2) {
      return null;
    }

    const cache = require('./utils/cache');

    // 使用缓存的关键词索引
    const { index, docCount } = await cache.getKeywordIndex(avatarId);

    if (docCount === 0) {
      return null;
    }

    const messageLower = userMessage.toLowerCase();
    const words = messageLower.split(/[\s,，。.!?:;]+/).filter(w => w.length >= 2);

    const matches = [];

    for (const word of words) {
      // 精确匹配
      if (index[word]) {
        for (const match of index[word]) {
          matches.push(match);
        }
      }

      // 模糊匹配
      for (const [keyword, docs] of Object.entries(index)) {
        if (keyword.includes(word) || word.includes(keyword)) {
          for (const match of docs) {
            if (!matches.find(m => m.docId === match.docId)) {
              matches.push(match);
            }
          }
        }
      }
    }

    if (matches.length > 0) {
      matches.sort((a, b) => {
        if (a.matchType === 'keyword' && b.matchType !== 'keyword') return -1;
        if (a.matchType !== 'keyword' && b.matchType === 'keyword') return 1;
        return 0;
      });

      return {
        content: matches[0].content,
        title: matches[0].title,
        matchType: matches[0].matchType
      };
    }

    return null;
  } catch (err) {
    console.error('[Socket AI] 关键词匹配失败:', err);
    return null;
  }
}
// ========== 关键词匹配函数结束 ==========

// 排行榜 Redis Key 常量（与 leaderboard.js 保持一致）
const LEADERBOARD_KEYS = {
  CONTRIBUTION_ZS: 'leaderboard:contribution:zs',
  FORTUNE_ZS: 'leaderboard:fortune:zs',
  CONTRIBUTION_DATA: 'leaderboard:contribution:data',
  FORTUNE_DATA: 'leaderboard:fortune:data'
};

/**
 * 获取用户当前皮肤的 PK 攻防值（用于有效距离计算）
 * @param {number} userId - 用户ID
 * @returns {Promise<{ pk_attack: number, pk_defense: number }>}
 */
async function getSkinPkStats(userId) {
  try {
    const users = await db.query('SELECT current_skin_id FROM users WHERE id = ?', [userId]);
    const skinId = users[0] && users[0].current_skin_id != null ? parseInt(users[0].current_skin_id, 10) : null;
    if (!skinId) return { pk_attack: 0, pk_defense: 0 };
    const skins = await db.query('SELECT pk_attack, pk_defense FROM ai_agent_skins WHERE id = ?', [skinId]);
    if (!skins.length) return { pk_attack: 0, pk_defense: 0 };
    return {
      pk_attack: Math.max(0, parseInt(skins[0].pk_attack, 10) || 0),
      pk_defense: Math.max(0, parseInt(skins[0].pk_defense, 10) || 0)
    };
  } catch (err) {
    console.error('getSkinPkStats 失败:', err);
    return { pk_attack: 0, pk_defense: 0 };
  }
}

/**
 * 更新任务进度（辅助函数）
 * @param {number} userId - 用户ID
 * @param {string} taskType - 任务类型（occupy_node/mine_energy/complete_pk/find_treasure/reach_energy/chat_with_ai）
 * @param {number} progressValue - 进度值（可选，默认+1）
 * @param {number} targetValue - 目标值（可选，用于特定任务）
 */
async function updateTaskProgress(userId, taskType, progressValue = 1, targetValue = null) {
  try {
    // 获取用户当前章节的活跃任务
    const chapters = await db.query(
      `SELECT id FROM story_chapters WHERE is_active = 1 ORDER BY sort_order ASC, chapter_number ASC`
    );

    for (const chapter of chapters) {
      // 检查章节是否已完成
      const chapterProgress = await db.query(
        `SELECT is_completed FROM user_story_progress WHERE user_id = ? AND chapter_id = ?`,
        [userId, chapter.id]
      );

      // 如果章节已完成，跳过
      if (chapterProgress.length > 0 && chapterProgress[0].is_completed === 1) {
        continue;
      }

      // 获取该章节的匹配任务
      const tasks = await db.query(
        `SELECT id, task_type, target_value 
         FROM story_tasks 
         WHERE chapter_id = ? AND task_type = ? AND is_active = 1`,
        [chapter.id, taskType]
      );

      for (const task of tasks) {
        // 获取当前任务进度
        const taskProgresses = await db.query(
          `SELECT progress_value, is_completed 
           FROM user_task_progress 
           WHERE user_id = ? AND task_id = ?`,
          [userId, task.id]
        );

        // 如果已完成，跳过
        if (taskProgresses.length > 0 && taskProgresses[0].is_completed === 1) {
          continue;
        }

        // 计算新进度
        const currentProgress = taskProgresses.length > 0 ? taskProgresses[0].progress_value : 0;
        let newProgress;

        if (taskType === 'occupy_node') {
          // 占据节点：统计用户占据的不同节点数
          const occupiedNodes = await db.query(
            `SELECT COUNT(DISTINCT node_id) as count 
             FROM game_nodes 
             WHERE owner_id = ?`,
            [userId]
          );
          newProgress = occupiedNodes[0]?.count || 0;
        } else if (taskType === 'mine_energy') {
          // 挖掘能量：使用total_energy
          const userStats = await db.query(
            `SELECT total_energy FROM users WHERE id = ?`,
            [userId]
          );
          newProgress = userStats[0]?.total_energy || 0;
        } else if (taskType === 'reach_energy') {
          // 能量达到100：使用当前能量
          const userStats = await db.query(
            `SELECT energy FROM users WHERE id = ?`,
            [userId]
          );
          newProgress = Math.min(userStats[0]?.energy || 0, task.target_value || 100);
        } else if (taskType === 'complete_pk') {
          // 完成PK：统计PK次数
          const pkStats = await db.query(
            `SELECT wins + losses + draws as total FROM users WHERE id = ?`,
            [userId]
          );
          newProgress = pkStats[0]?.total || 0;
        } else if (taskType === 'find_treasure') {
          // 发现宝藏：统计宝藏领取次数
          const treasureCount = await db.query(
            `SELECT COUNT(*) as count FROM treasure_claims WHERE user_id = ?`,
            [userId]
          );
          newProgress = treasureCount[0]?.count || 0;
        } else {
          // 其他类型：使用增量
          newProgress = currentProgress + progressValue;
        }

        // 确保不超过目标值
        const taskTargetValue = targetValue !== null ? targetValue : (task.target_value || 1);
        if (taskTargetValue !== null) {
          newProgress = Math.min(newProgress, taskTargetValue);
        }

        // 更新或插入任务进度
        if (taskProgresses.length > 0) {
          await db.query(
            `UPDATE user_task_progress 
             SET progress_value = ?, updated_at = NOW() 
             WHERE user_id = ? AND task_id = ?`,
            [newProgress, userId, task.id]
          );
        } else {
          await db.query(
            `INSERT INTO user_task_progress (user_id, task_id, progress_value) 
             VALUES (?, ?, ?)`,
            [userId, task.id, newProgress]
          );
        }

        // 如果达到目标值，发送事件通知（但不自动完成，由前端调用API完成）
        if (taskTargetValue !== null && newProgress >= taskTargetValue) {
          broadcastToUser(parseInt(userId), 'task_progress_ready', {
            taskId: task.id,
            taskType: task.task_type,
            progress: newProgress,
            target: taskTargetValue
          });
        }
      }

      // 只处理第一个未完成章节的任务
      break;
    }
  } catch (error) {
    console.error(`更新任务进度失败 (userId: ${userId}, taskType: ${taskType}):`, error);
    // 不影响主流程
  }
}

/**
 * 处理PK拒绝/超时的统一函数
 * @param {number} attackerId - 攻击者ID
 * @param {number} defenderId - 防御者ID
 * @param {number} roomId - 房间ID
 * @param {string} reason - 原因：'rejected' | 'timeout'
 * @param {object} [options] - { skipChallengeCheck: true } 表示被邀请方处于PK中未发挑战，不要求 Redis 中已有该 challenge
 */
async function handlePKRejection(attackerId, defenderId, roomId, reason, options = {}) {
  try {
    const challengeKey = `pk_challenge:${defenderId}:${attackerId}`;
    const challengeState = await redis.get(challengeKey);

    if (!options.skipChallengeCheck && !challengeState) {
      return;
    }

    // 幂等校验：检查是否已经处理过（使用分布式锁）
    const settledKey = `pk_settled:${defenderId}:${attackerId}`;
    const isSettled = await redis.get(settledKey);
    if (isSettled) {
      // 清理challengeKey
      await redis.del(challengeKey);
      challengeQueue.delete(challengeKey);
      return;
    }

    // 设置"已结算"标记，防止并发重复结算
    const setResult = await redis.set(settledKey, { settledAt: Date.now(), reason }, 10);
    if (!setResult) {
      console.warn(`[handlePKRejection] 设置settledKey失败，跳过结算，key=${settledKey}`);
      return;
    }

    // 清理challengeKey和队列
    await redis.del(challengeKey);
    challengeQueue.delete(challengeKey);

    // 获取配置值
    const rewardConfig = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      ['pk_energy_reward']
    );
    const lossConfig = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      ['pk_energy_loss']
    );
    
    const reward = rewardConfig.length > 0 ? parseInt(rewardConfig[0].config_value, 10) : 50;
    const loss = lossConfig.length > 0 ? parseInt(lossConfig[0].config_value, 10) : 50;

    // 更新攻击者（胜）：能量+reward，total_energy+reward，wins+1
    await db.query(
      'UPDATE users SET energy = GREATEST(0, energy + ?), total_energy = total_energy + ?, wins = wins + 1 WHERE id = ?',
      [reward, reward, attackerId]
    );

    // 更新防御者（败）：能量-50，losses+1
    await db.query(
      'UPDATE users SET energy = GREATEST(0, energy + ?), losses = losses + 1 WHERE id = ?',
      [-loss, defenderId]
    );

    // 从MySQL数据库获取更新后的能量和体力数据
    const attackerUser = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [attackerId]);
    const defenderUser = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [defenderId]);

    // 发送PK结果给攻击者（胜）
    if (attackerUser.length > 0) {
      const user = attackerUser[0];
      let energy = user.energy != null ? Number(user.energy) : 0;
      if (isNaN(energy)) energy = 0;
      energy = Math.max(0, energy);

      let stamina = user.stamina != null ? Number(user.stamina) : 0;
      if (isNaN(stamina)) stamina = 0;
      stamina = Math.max(0, Math.min(100, stamina));

      const canPK = await getCanPK(attackerId, roomId, energy);

      // 使用 broadcastToUser 发送消息到用户所有连接
      broadcastToUser(attackerId, 'pk_result', {
        result: 'win',
        myAttackDist: null,
        enemyAttackDist: null,
        energyChange: reward,
        reason: reason
      });
      broadcastToUser(attackerId, 'player_update', {
        energy: energy,
        stamina: stamina,
        canPK
      });
    }

    // 发送PK结果给防御者（败）
    if (defenderUser.length > 0) {
      const user = defenderUser[0];
      let energy = user.energy != null ? Number(user.energy) : 0;
      if (isNaN(energy)) energy = 0;
      energy = Math.max(0, energy);

      let stamina = user.stamina != null ? Number(user.stamina) : 0;
      if (isNaN(stamina)) stamina = 0;
      stamina = Math.max(0, Math.min(100, stamina));

      const canPK = await getCanPK(defenderId, roomId, energy);

      broadcastToUser(defenderId, 'pk_result', {
        result: 'lose',
        myAttackDist: null,
        enemyAttackDist: null,
        energyChange: -loss,
        reason: reason
      });
      broadcastToUser(defenderId, 'player_update', {
        energy: energy,
        stamina: stamina,
        canPK
      });
    }

    // 写入 MongoDB 对战日志（拒绝/超时）
    try {
      const users = await db.query('SELECT id, username FROM users WHERE id IN (?, ?)', [attackerId, defenderId]);
      const aid = Number(attackerId);
      const did = Number(defenderId);
      const attackerName = users.find(u => Number(u.id) === aid)?.username || 'Unknown';
      const defenderName = users.find(u => Number(u.id) === did)?.username || 'Unknown';
      const createdAt = new Date();
      await mongo.insertBattleLog({
        attackerId,
        defenderId,
        attackerName,
        defenderName,
        type: reason,
        result: 'win',
        attackerEnergyChange: reward,
        defenderEnergyChange: -loss,
        roomId,
        createdAt
      });
      try {
        await mongo.insertUserGameRecord({
          userId: attackerId,
          recordType: 'battle',
          type: reason,
          myResult: 'win',
          opponentName: defenderName,
          myEnergyChange: reward,
          opponentEnergyChange: -loss,
          roomId,
          createdAt
        });
        await mongo.insertUserGameRecord({
          userId: defenderId,
          recordType: 'battle',
          type: reason,
          myResult: 'lose',
          opponentName: attackerName,
          myEnergyChange: -loss,
          opponentEnergyChange: reward,
          roomId,
          createdAt
        });
      } catch (ugrErr) {
        console.error('MongoDB user_game_records (rejection/timeout) 写入失败:', ugrErr);
      }
    } catch (mongoErr) {
      console.error('MongoDB battle_logs (rejection/timeout) 写入失败:', mongoErr);
    }
  } catch (error) {
    console.error('处理PK拒绝失败:', error);
  }
}

/**
 * 处理PK超时逻辑（根据双方是否设置参数决定胜负/平局）
 * 场景1：攻击者设置参数，防御者未应答 -> 攻击者胜，防御者负
 * 场景2：双方都设置参数 -> 正常PK结算（此处不会触发，因为已提交）
 * 场景3：攻击者未设置参数，防御者设置参数 -> 防御者胜，攻击者负
 * 场景4：双方都未设置参数 -> 平局，各自扣能量，平台池增加
 * @param {number} attackerId - 攻击者ID
 * @param {number} defenderId - 防御者ID
 * @param {number} roomId - 房间ID
 */
async function handlePKTimeout(attackerId, defenderId, roomId) {
  try {
    const challengeKey = `pk_challenge:${defenderId}:${attackerId}`;

    // 幂等校验：检查是否已经处理过
    const settledKey = `pk_settled:${defenderId}:${attackerId}`;
    const isSettled = await redis.get(settledKey);
    if (isSettled) {
      await redis.del(challengeKey);
      challengeQueue.delete(challengeKey);
      return;
    }

    // 设置"已结算"标记，防止并发重复结算
    const setResult = await redis.set(settledKey, { settledAt: Date.now(), reason: 'timeout' }, 10);
    if (!setResult) {
      console.warn(`[handlePKTimeout] 设置settledKey失败，跳过结算，key=${settledKey}`);
      return;
    }

    await redis.del(challengeKey);
    challengeQueue.delete(challengeKey);

    // 获取双方是否设置了PK参数
    const attackerPk = await redis.get(`pk:${attackerId}`);
    const defenderPk = await redis.get(`pk:${defenderId}`);

    // 获取配置值
    const rewardConfig = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      ['pk_energy_reward']
    );
    const lossConfig = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      ['pk_energy_loss']
    );
    const platformPoolBonusConfig = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      ['platform_pool_bonus']
    );

    const reward = rewardConfig.length > 0 ? parseInt(rewardConfig[0].config_value, 10) : 50;
    const loss = lossConfig.length > 0 ? parseInt(lossConfig[0].config_value, 10) : 50;
    const bonus = platformPoolBonusConfig.length > 0 ? parseInt(platformPoolBonusConfig[0].config_value, 10) : 100;

    let result = 'draw';
    let energyChange = -loss;
    let defenderEnergyChange = -loss;

    // 根据双方是否设置参数决定胜负
    if (attackerPk && defenderPk) {
      // 场景2：双方都设置了参数，正常结算（理论上不会到这里）
      result = 'draw';
      energyChange = -loss;
      defenderEnergyChange = -loss;
    } else if (attackerPk && !defenderPk) {
      // 场景1：攻击者设置了参数，防御者未应答 -> 攻击者胜，防御者负
      result = 'win';
      energyChange = reward;
      defenderEnergyChange = -loss;
    } else if (!attackerPk && defenderPk) {
      // 场景3：攻击者未设置参数，防御者设置参数 -> 防御者胜，攻击者负
      result = 'lose';
      energyChange = -loss;
      defenderEnergyChange = reward;
    } else {
      // 场景4：双方都未设置参数 -> 平局，各自扣能量，平台池增加
      result = 'draw';
      energyChange = -loss;
      defenderEnergyChange = -loss;

      // 平局时平台池增加能量
      await db.query(
        'UPDATE game_rooms SET platform_pool = platform_pool + ? WHERE id = ?',
        [bonus, roomId]
      );
    }

    // 更新攻击者能量
    if (result === 'win') {
      await db.query(
        'UPDATE users SET energy = GREATEST(0, energy + ?), total_energy = total_energy + ?, wins = wins + 1 WHERE id = ?',
        [reward, reward, attackerId]
      );
    } else if (result === 'lose') {
      await db.query(
        'UPDATE users SET energy = GREATEST(0, energy + ?), losses = losses + 1 WHERE id = ?',
        [-loss, attackerId]
      );
    } else {
      // 平局
      await db.query(
        'UPDATE users SET energy = GREATEST(0, energy - ?), draws = draws + 1 WHERE id = ?',
        [loss, attackerId]
      );
    }

    // 更新防御者能量
    if (result === 'lose') {
      // 攻击者输，防御者胜
      await db.query(
        'UPDATE users SET energy = GREATEST(0, energy + ?), total_energy = total_energy + ?, wins = wins + 1 WHERE id = ?',
        [reward, reward, defenderId]
      );
    } else if (result === 'win') {
      // 攻击者胜，防御者输
      await db.query(
        'UPDATE users SET energy = GREATEST(0, energy + ?), losses = losses + 1 WHERE id = ?',
        [-loss, defenderId]
      );
    } else {
      // 平局
      await db.query(
        'UPDATE users SET energy = GREATEST(0, energy - ?), draws = draws + 1 WHERE id = ?',
        [loss, defenderId]
      );
    }

    // 获取更新后的能量值
    const attackerUser = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [attackerId]);
    const defenderUser = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [defenderId]);

    // 发送PK结果给攻击者
    const attackerEnergy = attackerUser[0]?.energy || 0;
    const attackerStamina = attackerUser[0]?.stamina || 0;
    const attackerCanPK = attackerEnergy >= 100;

    let attackerResult = result === 'win' ? 'win' : (result === 'lose' ? 'lose' : 'draw');
    let attackerMsg = '';

    if (result === 'win') {
      attackerMsg = '>> 对手超时未响应 <<\n对方未在规定时间内设置PK参数，你获得胜利。';
    } else if (result === 'lose') {
      attackerMsg = '>> 超时未响应 <<\n你未在规定时间内设置PK参数，被判负。';
    } else {
      attackerMsg = '>> 能量湮灭 <<\n双方都未设置PK参数，能量被平台吞噬。';
    }

    broadcastToUser(attackerId, 'pk_result', {
      result: attackerResult,
      reason: 'timeout',
      myAttackDist: null,
      enemyAttackDist: null,
      energyChange: energyChange,
      energy: attackerEnergy,
      canPK: attackerCanPK
    });
    broadcastToUser(attackerId, 'player_update', {
      energy: attackerEnergy,
      stamina: attackerStamina,
      canPK: attackerCanPK
    });

    // 发送PK结果给防御者
    const defenderEnergy = defenderUser[0]?.energy || 0;
    const defenderStamina = defenderUser[0]?.stamina || 0;
    const defenderCanPK = defenderEnergy >= 100;

    let defenderResult = result === 'win' ? 'lose' : (result === 'lose' ? 'win' : 'draw');
    let defenderMsg = '';

    if (result === 'win') {
      defenderMsg = '>> 超时未响应 <<\n你未在规定时间内响应PK挑战，被判负。';
    } else if (result === 'lose') {
      defenderMsg = '>> 对手超时未响应 <<\n对方未在规定时间内设置PK参数，你获得胜利。';
    } else {
      defenderMsg = '>> 能量湮灭 <<\n双方都未设置PK参数，能量被平台吞噬。';
    }

    broadcastToUser(defenderId, 'pk_result', {
      result: defenderResult,
      reason: 'timeout',
      myAttackDist: null,
      enemyAttackDist: null,
      energyChange: defenderEnergyChange,
      energy: defenderEnergy,
      canPK: defenderCanPK
    });
    broadcastToUser(defenderId, 'player_update', {
      energy: defenderEnergy,
      stamina: defenderStamina,
      canPK: defenderCanPK
    });

    // 如果是平局，广播平台池更新
    if (result === 'draw') {
      const newPlatformPool = await calculatePlatformPool(roomId);
      const treasureConfig = await getTreasureConfig(roomId);
      const treasureInfo = {
        configured: treasureConfig.length > 0,
        nodeCount: treasureConfig.length,
        totalAmount: treasureConfig.reduce((sum, t) => sum + (parseInt(t.amount, 10) || 0), 0)
      };
      if (io) {
        io.to(`room_${roomId}`).emit('game_state', {
          type: 'platform_pool_update',
          platformPool: newPlatformPool,
          treasureInfo
        });
      }
    }

    // 记录PK战斗到MySQL（超时场景）
    // 使用0表示未设置参数（因为正常PK参数范围是1-100）
    const attackerKingVal = attackerPk ? JSON.parse(attackerPk).king : 0;
    const attackerAssassinVal = attackerPk ? JSON.parse(attackerPk).assassin : 0;
    const defenderKingVal = defenderPk ? JSON.parse(defenderPk).king : 0;
    const defenderAssassinVal = defenderPk ? JSON.parse(defenderPk).assassin : 0;

    await db.query(
      `INSERT INTO pk_records (attacker_id, defender_id, attacker_king, attacker_assassin, defender_king, defender_assassin, result, energy_change, attacker_type, defender_type, room_id, room_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', 'user', ?, ?)`,
      [attackerId, defenderId, attackerKingVal, attackerAssassinVal, defenderKingVal, defenderAssassinVal, result, energyChange, roomId, roomId === 1 ? '平台房间' : `房间${roomId}`]
    );

    // 推送结算到 Redis Stream（处理MongoDB记录）
    const attackerResultForStream = result === 'win' ? 'win' : (result === 'lose' ? 'lose' : 'draw');
    const defenderResultForStream = result === 'win' ? 'lose' : (result === 'lose' ? 'win' : 'draw');
    const settlementPayload = {
      actualAttackerId: attackerId,
      actualDefenderId: defenderId,
      roomId,
      attackerKing: attackerKingVal,
      attackerAssassin: attackerAssassinVal,
      defenderKing: defenderKingVal,
      defenderAssassin: defenderAssassinVal,
      result,
      attackerResult: attackerResultForStream,
      defenderResult: defenderResultForStream,
      energyChange,
      myAttackDist: null,
      enemyAttackDist: null,
      reason: 'timeout',
      isTimeoutNoParams: !attackerPk && !defenderPk
    };
    await redis.xAdd('pk:settlement', settlementPayload, 10000);

    // 清理Redis中的PK参数
    await redis.del(`pk:${attackerId}`);
    await redis.del(`pk:${defenderId}`);
  } catch (error) {
    console.error('处理PK超时失败:', error);
  }
}

/**
 * 处理玩家离开房间（退出自定义房间时调用）
 * @param {Object} socket - Socket对象
 * @param {number} roomId - 房间ID
 */
async function handleLeaveRoom(socket, roomId) {
  try {
    // 释放该房间内的节点
    const userNodes = await db.query(
      'SELECT room_id, node_id FROM game_nodes WHERE owner_id = ? AND room_id = ?',
      [socket.userId, roomId]
    );
    
    if (userNodes.length > 0) {
      await db.transaction(async (conn) => {
        for (const node of userNodes) {
          await conn.execute(
            'UPDATE game_nodes SET owner_id = NULL, occupied_at = NULL WHERE room_id = ? AND node_id = ?',
            [node.room_id, node.node_id]
          );
          await redis.del(`game:room:${node.room_id}:node:${node.node_id}`);
        }
      });
      
      // 广播节点释放
      if (io) {
        for (const node of userNodes) {
          io.to(`room_${node.room_id}`).emit('game_state', {
            type: 'node_occupied',
            nodeId: node.node_id,
            ownerId: null,
            ownerName: null
          });
        }
      }
    }
    
    // 清理该房间的PK挑战（使用内存队列）
    if (typeof clearChallengesForUser === 'function') {
      await clearChallengesForUser(socket.userId);
    }
    
    // 离开Socket房间
    socket.leave(`room_${roomId}`);
    
    // 更新房间人数
    await updateRoomPlayers(roomId);
  } catch (error) {
    console.error(`[退出房间] 处理退出房间失败:`, error);
    throw error;
  }
}

/**
 * 释放用户占据的所有节点（辅助函数，可在登录/登出时调用）
 * @param {number} userId - 用户ID
 * @param {boolean} shouldBroadcast - 是否广播节点释放事件（默认true）
 * @returns {Promise<number>} 释放的节点数量
 */
async function releaseUserNodes(userId, shouldBroadcast = true) {
  try {
    // 查找用户占据的所有节点
    const userNodes = await db.query(
      'SELECT room_id, node_id FROM game_nodes WHERE owner_id = ?',
      [userId]
    );
    
    if (userNodes.length === 0) {
      return 0;
    }
    
    // 使用事务确保数据一致性
    await db.transaction(async (conn) => {
      // 释放每个节点
      for (const node of userNodes) {
        // 更新数据库：释放节点
        await conn.execute(
          'UPDATE game_nodes SET owner_id = NULL, occupied_at = NULL WHERE room_id = ? AND node_id = ?',
          [node.room_id, node.node_id]
        );
        
        // 清理Redis缓存
        await redis.del(`game:room:${node.room_id}:node:${node.node_id}`);
      }
    });
    
    // 广播节点释放事件（如果需要）
    if (shouldBroadcast && io) {
      for (const node of userNodes) {
        io.to(`room_${node.room_id}`).emit('game_state', {
          type: 'node_occupied',
          nodeId: node.node_id,
          ownerId: null,
          ownerName: null
        });
      }
    }
    
    return userNodes.length;
  } catch (error) {
    console.error(`[释放节点] 用户 ${userId} 释放节点失败:`, error);
    throw error;
  }
}

/**
 * 初始化 Socket.io，挂载到 HTTP 服务
 * @param {import('http').Server} server - HTTP 服务实例
 */
function init(server) {
  io = new Server(server, {
    cors: {
      origin: config.server.corsOrigin,
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  // ========== 客服聊天 Socket 命名空间 ==========
  const agentChatIO = io.of('/agent-chat');

  // ========== 玩家广场 Socket 命名空间 ==========
  const plazaIO = io.of('/plaza');

  // ========== 象棋房间 Socket 命名空间 ==========
  chessSocket.initChessSocket(io);

  // 玩家广场 Socket 验证（需要JWT）
  plazaIO.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error('未提供认证令牌'));
      }

      const decoded = jwt.verify(token, config.jwt.secret);
      const [user] = await db.query('SELECT id, username, status FROM users WHERE id = ?', [decoded.userId]);

      if (!user || user.status !== 'active') {
        return next(new Error('用户不存在或已禁用'));
      }

      socket.userId = decoded.userId;
      socket.username = user.username;
      next();
    } catch (err) {
      next(new Error('认证失败: ' + err.message));
    }
  });

  // 广场在线用户集合
  const plazaOnlineUsers = new Set();

  plazaIO.on('connection', (socket) => {
    // 加入广场房间
    socket.join('plaza');
    // 加入播客房间
    socket.join('podcast');

    // 记录在线用户
    plazaOnlineUsers.add(socket.userId);
    console.log(`[Plaza] 用户 ${socket.username} (ID: ${socket.userId}) 进入广场，当前在线: ${plazaOnlineUsers.size}`);

    // 广播在线用户列表（给所有人）
    plazaIO.to('plaza').emit('online_users', {
      count: plazaOnlineUsers.size,
      users: Array.from(plazaOnlineUsers)
    });

    // 同时也给新连接的用户单独发送一次，确保能收到
    socket.emit('online_users', {
      count: plazaOnlineUsers.size,
      users: Array.from(plazaOnlineUsers)
    });

    /**
     * 用户离开广场
     */
    socket.on('disconnect', () => {
      plazaOnlineUsers.delete(socket.userId);
      console.log(`[Plaza] 用户 ${socket.username} (ID: ${socket.userId}) 离开广场，当前在线: ${plazaOnlineUsers.size}`);

      plazaIO.to('plaza').emit('online_users', {
        count: plazaOnlineUsers.size,
        users: Array.from(plazaOnlineUsers)
      });
    });

    /**
     * 点赞通知（当有人点赞帖子/评论时，通知作者）
     */
    socket.on('like_notify', async (data) => {
      try {
        const { targetType, targetId, authorId } = data;

        // 不通知自己
        if (authorId === socket.userId) return;

        // 查找作者是否在线
        const authorSocket = Array.from(plazaIO.sockets.values()).find(s => s.userId === authorId);
        if (authorSocket) {
          authorSocket.emit('like_notification', {
            type: targetType,
            targetId,
            fromUserId: socket.userId,
            fromUsername: socket.username,
            message: `${socket.username} 赞了你的${targetType === 'post' ? '帖子' : '评论'}`
          });
        }
      } catch (err) {
        console.error('[Plaza] 点赞通知失败:', err);
      }
    });
  });

  // ========== 能量交易 Socket 命名空间 ==========
  const energyTradeIO = io.of('/energy-trade');

  // 能量交易 Socket 验证（需要JWT）
  energyTradeIO.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error('未提供认证令牌'));
      }

      const decoded = jwt.verify(token, config.jwt.secret);
      const [user] = await db.query('SELECT id, username, status FROM users WHERE id = ?', [decoded.userId]);

      if (!user || user.status !== 'active') {
        return next(new Error('用户不存在或已禁用'));
      }

      socket.userId = decoded.userId;
      socket.username = user.username;
      next();
    } catch (err) {
      next(new Error('认证失败: ' + err.message));
    }
  });

  // 能量交易 Socket 连接处理
  energyTradeIO.on('connection', (socket) => {
    console.log(`[EnergyTrade] 用户 ${socket.username} (ID: ${socket.userId}) 连接能量交易Socket`);

    /**
     * 加入交易聊天室
     */
    socket.on('join_trade_room', async (data) => {
      try {
        const { tradeId, tradeNo } = data;
        const tradeIdNum = parseInt(tradeId, 10);
        console.log('[EnergyTrade] join_trade_room:', { tradeId, tradeIdNum, tradeNo, userId: socket.userId, username: socket.username });

        // 验证用户是该交易的参与者
        const trades = await db.query(
          'SELECT * FROM energy_trades WHERE id = ? AND (seller_id = ? OR buyer_id = ?)',
          [tradeIdNum, socket.userId, socket.userId]
        );

        console.log('[EnergyTrade] 查询结果:', { trades: trades?.length, tradeId: tradeIdNum, socketUserId: socket.userId });

        if (!trades || !trades[0]) {
          return socket.emit('error', { message: '无权限加入此交易聊天室' });
        }

        // 加入交易房间
        socket.join(`trade:${tradeNo}`);
        console.log(`[EnergyTrade] 用户 ${socket.username} 加入交易房间: ${tradeNo}`);
        
        // 通知用户加入成功
        socket.emit('joined_room', { tradeNo });
        
        // 获取未读消息数量并通知
        let unreadCount = 0;
        try {
          unreadCount = await mongo.getUnreadEnergyTradeMessageCount(tradeIdNum, socket.userId);
        } catch (err) {
          console.error('[EnergyTrade] 获取未读消息数失败:', err.message);
        }

        if (unreadCount > 0) {
          socket.emit('unread_messages', { trade_id: tradeIdNum, count: unreadCount });
        }

        // 获取未读通知数量并通知
        let notificationCount = 0;
        try {
          notificationCount = await mongo.getUnreadEnergyTradeNotificationCount(socket.userId);
        } catch (err) {
          console.error('[EnergyTrade] 获取未读通知数失败:', err.message);
        }
        
        if (notificationCount > 0) {
          socket.emit('unread_notifications', { count: notificationCount });
        }
        
        // 发送系统消息
        energyTradeIO.to(`trade:${tradeNo}`).emit('trade_message', {
          type: 'system',
          content: `${socket.username} 加入了交易聊天室`,
          created_at: new Date().toISOString()
        });
      } catch (err) {
        console.error('[EnergyTrade] 加入交易房间失败:', err);
        socket.emit('error', { message: '加入交易房间失败' });
      }
    });

    /**
     * 离开交易聊天室
     */
    socket.on('leave_trade_room', (data) => {
      const { tradeNo } = data;
      socket.leave(`trade:${tradeNo}`);
      console.log(`[EnergyTrade] 用户 ${socket.username} 离开交易房间: ${tradeNo}`);
    });

    /**
     * 发送交易消息
     */
    socket.on('send_message', async (data) => {
      try {
        const { tradeId, tradeNo, content, tempId } = data;
        const tradeIdNum = parseInt(tradeId, 10);

        if (!content || !content.trim()) {
          return;
        }

        // 验证用户是该交易的参与者
        const trades = await db.query(
          'SELECT * FROM energy_trades WHERE id = ? AND (seller_id = ? OR buyer_id = ?)',
          [tradeIdNum, socket.userId, socket.userId]
        );

        console.log('[EnergyTrade] 发送消息-查询结果:', { trades, tradeId: tradeIdNum, socketUserId: socket.userId });

        if (!trades || !trades[0]) {
          return socket.emit('error', { message: '无权限发送消息' });
        }

        const trade = trades[0];
        const senderRole = socket.userId === trade.seller_id ? 'seller' : 'buyer';

        // 保存消息到MongoDB
        let messageId = null;
        let createdAt = new Date();
        console.log('[EnergyTrade] 收到发送消息请求:', { tradeId: tradeIdNum, tradeNo, content, tempId, userId: socket.userId });

        try {
          const mongoId = await mongo.saveEnergyTradeMessage(
            tradeIdNum, socket.userId, socket.username, senderRole, content.trim(), 'text'
          );
          messageId = mongoId.toString();
          console.log('[EnergyTrade] 消息保存成功, messageId:', messageId);
        } catch (err) {
          console.error('[EnergyTrade] MongoDB保存消息失败，降级到MySQL:', err.message);
          const [result] = await db.execute(
            `INSERT INTO energy_trade_messages (trade_id, sender_id, sender_username, sender_role, message_type, content)
             VALUES (?, ?, ?, ?, 'text', ?)`,
            [tradeIdNum, socket.userId, socket.username, senderRole, content.trim()]
          );
          messageId = result.insertId;
        }

        // 获取接收者ID
        const receiverId = socket.userId === trade.seller_id ? trade.buyer_id : trade.seller_id;

        // 创建通知（用于离线用户上线后获取未读消息提醒）
        try {
          await mongo.createEnergyTradeNotification(
            receiverId,
            tradeIdNum,
            'new_message',
            '新交易消息',
            `${socket.username} 发送了新消息`,
            { sender_id: socket.userId, sender_username: socket.username, sender_role: senderRole }
          );
        } catch (err) {
          console.error('[EnergyTrade] 创建通知失败:', err.message);
        }

        // 广播消息给交易双方
        console.log('[EnergyTrade] 广播消息到房间:', `trade:${tradeNo}`);
        energyTradeIO.to(`trade:${tradeNo}`).emit('new_message', {
          id: messageId,
          tempId: tempId,
          trade_id: tradeIdNum,
          sender_id: socket.userId,
          sender_username: socket.username,
          sender_role: senderRole,
          content: content.trim(),
          created_at: createdAt.toISOString()
        });
        console.log('[EnergyTrade] 消息广播完成');
      } catch (err) {
        console.error('[EnergyTrade] 发送消息失败:', err);
        console.error('[EnergyTrade] 错误堆栈:', err.stack);
        socket.emit('error', { message: '发送消息失败' });
      }
    });

    /**
     * 断开连接
     */
    socket.on('disconnect', () => {
      console.log(`[EnergyTrade] 用户 ${socket.username} (ID: ${socket.userId}) 断开能量交易Socket`);
    });
  });

  // 定时广播交易倒计时（每10秒广播一次）
  setInterval(async () => {
    try {
      const db = require('./utils/db');

      // 查询所有待付款和待确认的交易
      const activeTrades = await db.query(
        "SELECT id, trade_no, status, payment_deadline, confirm_deadline FROM energy_trades WHERE status IN ('pending_payment', 'payment_submitted')"
      );

      for (const trade of activeTrades) {
        let deadline = null;
        let remainingSeconds = 0;

        if (trade.status === 'pending_payment' && trade.payment_deadline) {
          deadline = new Date(trade.payment_deadline);
          remainingSeconds = Math.max(0, Math.floor((deadline - new Date()) / 1000));
        } else if (trade.status === 'payment_submitted' && trade.confirm_deadline) {
          deadline = new Date(trade.confirm_deadline);
          remainingSeconds = Math.max(0, Math.floor((deadline - new Date()) / 1000));
        }

        // 广播倒计时给交易房间
        const io = require('./socket').getEnergyTradeIO();
        if (io && remainingSeconds > 0) {
          io.to(`trade:${trade.trade_no}`).emit('trade_countdown', {
            trade_id: trade.id,
            trade_no: trade.trade_no,
            status: trade.status,
            remaining_seconds: remainingSeconds,
            deadline: deadline ? deadline.toISOString() : null
          });
        }
      }
    } catch (err) {
      console.error('[EnergyTrade] 广播倒计时失败:', err);
    }
  }, 10 * 1000);

  // 客服聊天不需要JWT验证，使用自定义验证
  agentChatIO.use(async (socket, next) => {
    try {
      const { sessionId, token, role } = socket.handshake.query;

      if (!sessionId || !token) {
        return next(new Error('缺少会话ID或令牌'));
      }

      // 验证会话有效性
      const session = await mongo.getAgentSession(sessionId);
      if (!session || session.status !== 'active') {
        return next(new Error('会话不存在或已关闭'));
      }

      // 验证token (如果是客服后台，需要验证operator token)
      if (role === 'operator') {
        const operatorToken = socket.handshake.auth.operatorToken;
        if (!operatorToken) {
          return next(new Error('缺少客服令牌'));
        }
        // 验证客服token (这里简化为检查token格式)
        // 实际应该验证JWT或从数据库验证
      }

      socket.sessionId = sessionId;
      socket.role = role || 'user';
      socket.avatarId = session.avatarId;

      next();
    } catch (error) {
      next(new Error('验证失败: ' + error.message));
    }
  });

  agentChatIO.on('connection', (socket) => {
    // 加入会话房间
    socket.join(`session:${socket.sessionId}`);

    // 客服加入分身房间，可以接收该分身所有会话的消息
    if (socket.role === 'operator' && socket.avatarId) {
      socket.join(`avatar:${socket.avatarId}`);
    }

    // 异步预加载会话上下文到缓存（不阻塞连接）
    const cache = require('./utils/cache');
    cache.preloadSessionContext(socket.sessionId).catch(err => {
      console.error('[Socket] 连接时预加载会话上下文失败:', err.message);
    });

    // 标记在线
    const onlineKey = `agent:online:${socket.sessionId}`;
    redis.hSet(onlineKey, {
      socketId: socket.id,
      role: socket.role,
      lastHeartbeat: Date.now()
    }).then(() => redis.expire(onlineKey, 300)); // 5分钟过期

    /**
     * 用户/客服发送消息
     */
    socket.on('send_message', async (data) => {
      try {
        const { content, tempId, enableSearch, imageUrl, messageType } = data;
        if (!content && !imageUrl) {
          socket.emit('message_error', { tempId, error: '消息内容不能为空' });
          return;
        }

        // 预加载会话上下文到缓存（异步，不阻塞消息发送）
        const cache = require('./utils/cache');
        cache.preloadSessionContext(socket.sessionId).catch(err => {
          console.error('[Socket] 会话上下文预加载失败:', err.message);
        });

        const session = await mongo.getAgentSession(socket.sessionId);
        if (!session || session.status !== 'active') {
          socket.emit('message_error', { tempId, error: '会话已关闭' });
          return;
        }

        // 确定消息角色
        const role = socket.role === 'operator' ? 'human_operator' : 'user';
        const msgType = messageType || (imageUrl ? 'image' : 'text');

        // 生成消息ID
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // 保存消息到MongoDB（支持图片类型）
        const messageText = imageUrl ? '[图片消息]' : (content || '');
        await mongo.addSessionMessage(socket.sessionId, role, messageText, msgType, imageUrl);
        await mongo.updateSessionLastMessage(socket.sessionId);

        // 构建消息对象
        const message = {
          messageId,
          role,
          content: content || '',
          messageType: msgType,
          imageUrl: imageUrl,
          timestamp: new Date(),
          read: false
        };

        // 只广播给房间内的其他人（不包括发送者自己）
        // 这样发送者不会收到自己发送的消息，避免重复显示
        socket.to(`session:${socket.sessionId}`).emit('new_message', message);

        // 确认发送成功，返回真实messageId给发送者
        socket.emit('message_sent', { tempId, messageId });

        // 如果是AI模式且是用户消息，触发AI响应（图片消息不触发，等待人工客服）
        if (role === 'user' && session.mode === 'ai' && !session.pendingHuman && !imageUrl) {
          // 异步触发AI响应
          setImmediate(async () => {
            try {
              // 构建用户消息内容（支持图片多模态）
              const userMessageContent = imageUrl ? `[图片消息: ${imageUrl}]` : (content || '');
              await handleAIChatResponse(socket.sessionId, userMessageContent, messageId, agentChatIO, enableSearch, imageUrl, socket);
            } catch (err) {
              console.error('AI响应失败:', err);
            }
          });
        } else {
          // 跳过AI响应
        }

      } catch (error) {
        console.error('发送消息失败:', error);
        socket.emit('message_error', { tempId: data.tempId, error: error.message });
      }
    });

    /**
     * 正在输入状态
     */
    socket.on('typing', (data) => {
      const { isTyping } = data;
      socket.to(`session:${socket.sessionId}`).emit('typing', {
        role: socket.role,
        isTyping: !!isTyping
      });
    });

    /**
     * 标记消息已读
     */
    socket.on('mark_read', async (data) => {
      const { messageId } = data;

      if (messageId) {
        await mongo.markMessageRead(socket.sessionId, messageId);
      } else {
        // 标记对方的所有消息为已读
        const oppositeRole = socket.role === 'operator' ? 'user' : 'human_operator';
        await mongo.markSessionMessagesRead(socket.sessionId, oppositeRole);
      }

      // 通知对方已读
      socket.to(`session:${socket.sessionId}`).emit('messages_read', {
        reader: socket.role
      });
    });

    /**
     * 心跳
     */
    socket.on('heartbeat', async () => {
      const onlineKey = `agent:online:${socket.sessionId}`;
      await redis.hSet(onlineKey, 'lastHeartbeat', Date.now());
      await redis.expire(onlineKey, 300);
    });

    /**
     * 断开连接
     */
    socket.on('disconnect', async () => {
      const onlineKey = `agent:online:${socket.sessionId}`;
      await redis.hDel(onlineKey, 'socketId');
    });
  });

  // ========== AI客服响应处理函数 ==========
  async function handleAIChatResponse(sessionId, userMessage, userMessageId, io, enableSearch = false, imageUrl = null, socket = null) {
    try {
      // 使用缓存模块获取会话上下文（并行查询 + 缓存）
      const cache = require('./utils/cache');

      // 尝试从缓存获取会话上下文
      let sessionContext;
      try {
        sessionContext = await cache.getSessionContext(sessionId);
      } catch (err) {
        console.error('[Socket AI] 缓存获取失败，降级到直接查询:', err.message);
        // 降级：直接查询MongoDB
        sessionContext = {
          session: await mongo.getAgentSession(sessionId),
          avatarConfig: null,
          knowledgeBase: null
        };
      }

      const session = sessionContext?.session;
      if (!session || session.status !== 'active') return;
      if (session.mode === 'human' || session.pendingHuman) return;

      // 从缓存获取分身配置
      const avatar = sessionContext?.avatarConfig || await cache.getAvatarConfig(session.avatarId);
      if (!avatar) return;

      // 发送正在输入提示
      io.to(`session:${sessionId}`).emit('typing', {
        role: 'assistant',
        isTyping: true
      });

      // ========== 尝试关键词匹配 ==========
      const mongo = require('./utils/mongo');
      const keywordMatchResult = await tryKeywordMatchForSocket(session.avatarId, userMessage);
      if (keywordMatchResult) {
        console.log(`[Socket AI] 关键词匹配成功: ${keywordMatchResult.title}`);

        // 直接返回匹配结果
        const aiContent = keywordMatchResult.content;

        const aiMessageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        io.to(`session:${sessionId}`).emit('ai_stream_start', {
          messageId: aiMessageId,
          role: 'assistant'
        });

        io.to(`session:${sessionId}`).emit('ai_stream_end', {
          messageId: aiMessageId,
          content: aiContent,
          role: 'assistant',
          is_keyword_match: true,
          match_type: keywordMatchResult.matchType
        });

        return; // 关键词匹配成功，不再调用AI
      }
      // ========== 关键词匹配结束 ==========

      // 获取AI服务模块（使用已导入的模块）
      const minimax = require('./utils/minimax');
      const bailian = require('./utils/bailian');

      // 使用缓存获取AI配置
      let aiConfig;
      try {
        aiConfig = await cache.getAIConfig();
      } catch (err) {
        console.error('[Socket AI] AI配置缓存获取失败:', err.message);
        // 降级：直接查询数据库
        const configRows = await db.query(
          'SELECT config_key, config_value FROM game_config WHERE config_key IN (?, ?)',
          ['ai_provider', 'ai_agent_web_search_enabled']
        );
        const configMap = {};
        configRows.forEach(row => { configMap[row.config_key] = row.config_value; });
        aiConfig = {
          ai_provider: configMap.ai_provider || 'bailian',
          web_search_enabled: configMap.ai_agent_web_search_enabled === 'true' || configMap.ai_agent_web_search_enabled === '1'
        };
      }

      const aiProvider = aiConfig.ai_provider?.toLowerCase().trim() === 'bailian' ? bailian : minimax;
      const webSearchEnabled = aiConfig.web_search_enabled || false;

      // 只有全局联网开关开启且用户选择了联网时才启用
      const isSearchEnabled = webSearchEnabled && enableSearch;

      // 获取知识库（使用缓存）
      let knowledgeBase = sessionContext?.knowledgeBase;
      if (!knowledgeBase) {
        try {
          knowledgeBase = await cache.getKnowledgeBase(session.avatarId);
        } catch (err) {
          console.error('[Socket AI] 知识库缓存获取失败:', err.message);
          knowledgeBase = await mongo.getAgentKnowledgeBase(session.avatarId);
        }
      }

      // 构建系统提示词（使用缓存工具函数）
      const knowledgePrompt = cache.buildKnowledgePrompt(knowledgeBase);
      let systemPrompt = avatar.prompt_template || '';
      systemPrompt += knowledgePrompt;

      // 获取历史消息（不缓存，每次获取最新）
      const history = await cache.getConversationHistory(sessionId, 10);

      // 构建消息列表 - 转换角色以适配MiniMax API
      // MiniMax只接受: system, user, assistant
      const roleMap = {
        'human_operator': 'assistant',  // 客服的消息转为assistant
        'user': 'user',
        'assistant': 'assistant',
        'system': 'system'
      };

      const messages = [];

      // 添加系统提示词
      const finalSystemPrompt = systemPrompt || `你是一个名叫${avatar.avatar_name}的AI助手，请友好地回答用户的问题。`;

      // 添加历史消息（转换角色）
      history.slice(-10).forEach(msg => {
        const mappedRole = roleMap[msg.role] || 'user';
        messages.push({ role: mappedRole, content: msg.content });
      });

      // 添加当前消息（支持图片多模态格式）
      let userMessageContent;
      if (imageUrl) {
        // 从数据库获取客户端Socket URL配置来构建图片URL
        let chatImageHost = socket?.chatImageHost;
        if (!chatImageHost) {
          try {
            const rows = await db.query(
              'SELECT config_value FROM game_config WHERE config_key = ?',
              ['client_socket_url']
            );
            if (rows.length > 0 && rows[0].config_value) {
              // 从 https://xxx.com 提取域名
              const url = rows[0].config_value;
              chatImageHost = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
              if (socket) {
                socket.chatImageHost = chatImageHost; // 缓存到socket对象
              }
            }
          } catch (e) {
            console.error('[Socket AI] 获取配置失败:', e.message);
          }
        }
        const fullImageUrl = imageUrl.startsWith('http') ? imageUrl : (`https://${chatImageHost}${imageUrl}`);
        userMessageContent = [
          {
            text: userMessage || '请分析这张图片'
          },
          {
            image: fullImageUrl
          }
        ];
      } else {
        userMessageContent = userMessage;
      }
      messages.push({ role: 'user', content: userMessageContent });

      // 检查AI模块是否支持流式回调
      const useStreaming = aiProvider.generateConversationWithCallback && true;

      if (useStreaming) {
        // 首先生成messageId
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // 发送流式开始事件
        io.to(`session:${sessionId}`).emit('ai_stream_start', {
          messageId: messageId,
          role: 'assistant'
        });

        // 使用流式回调处理AI响应
        await aiProvider.generateConversationWithCallback(messages, {
          temperature: 0.7,
          enableSearch: isSearchEnabled,
          studioMode: true,
          maxTokens: 800,
          role: systemPrompt
        }, {
          onChunk: (chunk) => {
            // 实时推送chunk
            io.to(`session:${sessionId}`).emit('ai_stream_chunk', {
              messageId: messageId,
              chunk: chunk,
              role: 'assistant'
            });
          },
          onDone: async (fullContent) => {

            // 发送完成事件
            io.to(`session:${sessionId}`).emit('ai_stream_end', {
              messageId: messageId,
              content: fullContent,
              role: 'assistant'
            });

            // 保存消息
            await mongo.addSessionMessage(sessionId, 'assistant', fullContent);

            // 不再发送new_message，避免重复显示
            // new_message事件只用于非流式模式

            // 停止输入提示
            io.to(`session:${sessionId}`).emit('typing', {
              role: 'assistant',
              isTyping: false
            });

            // ========== Socket能量扣减逻辑 ==========
            try {
              // 获取能量消耗配置
              const energyCostRows = await db.query(
                'SELECT config_key, config_value FROM game_config WHERE config_key IN (?, ?, ?, ?, ?, ?)',
                ['ai_provider', 'agent_chat_energy_cost', 'agent_chat_web_search_energy_cost', 'ai_agent_web_search_enabled', 'ai_agent_energy_cost', 'ai_agent_web_search_energy_cost']
              );
              const configMap = {};
              energyCostRows.forEach(row => { configMap[row.config_key] = row.config_value; });

              const agentChatEnergyCost = configMap.agent_chat_energy_cost;
              const agentChatWebSearchEnergyCost = configMap.agent_chat_web_search_energy_cost;
              const conversationEnergyCost = parseInt(agentChatEnergyCost, 10) || parseInt(configMap.ai_agent_energy_cost, 10) || 5;
              const webSearchExtraCost = parseInt(agentChatWebSearchEnergyCost, 10) || parseInt(configMap.ai_agent_web_search_energy_cost, 10) || 5;
              const totalEnergyCost = conversationEnergyCost + (isSearchEnabled ? webSearchExtraCost : 0);

              // 获取分身创建者ID
              const creatorUserId = avatar.user_id;

              if (totalEnergyCost > 0 && creatorUserId) {
                // 查询用户当前能量
                const [user] = await db.query('SELECT energy FROM users WHERE id = ?', [creatorUserId]);

                if (user && user.energy >= totalEnergyCost) {
                  // 扣减能量
                  await db.query(
                    'UPDATE users SET energy = GREATEST(0, energy - ?) WHERE id = ?',
                    [totalEnergyCost, creatorUserId]
                  );

                  // 记录能量消耗到MongoDB
                  try {
                    await mongo.insertEnergyConsumption({
                      userId: creatorUserId,
                      type: 'agent_chat',
                      amount: totalEnergyCost,
                      mode: isSearchEnabled ? 'web_search' : 'text',
                      avatarId: session.avatarId,
                      sessionId: sessionId,
                      createdAt: new Date()
                    });
                  } catch (mongoErr) {
                    console.error('[Socket AI] MongoDB记录能量消耗失败:', mongoErr.message);
                  }
                }
              }
            } catch (energyErr) {
              console.error('[Socket AI] 能量扣减失败:', energyErr.message);
            }
          },
          onError: (err) => {
            console.error('[Socket AI] AI流式响应出错:', err);
            io.to(`session:${sessionId}`).emit('typing', {
              role: 'assistant',
              isTyping: false
            });
          }
        });
      } else {
        // 不支持流式，使用传统方式
        const aiResponse = await aiProvider.generateConversation(messages, {
          temperature: 0.7,
          enableSearch: isSearchEnabled,
          studioMode: true,
          maxTokens: 800,
          role: systemPrompt
        });

        // 处理AI响应
        const aiText = typeof aiResponse === 'string' ? aiResponse : (aiResponse?.text || '');

        if (!aiText) {
          throw new Error('AI响应内容为空');
        }

        // 保存AI响应
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await mongo.addSessionMessage(sessionId, 'assistant', aiText);

        // 发送AI响应给房间内的所有人
        io.to(`session:${sessionId}`).emit('new_message', {
          messageId,
          role: 'assistant',
          content: aiText,
          timestamp: new Date(),
          read: false
        });

        // 停止输入提示
        io.to(`session:${sessionId}`).emit('typing', {
          role: 'assistant',
          isTyping: false
        });
      }
    } catch (error) {
      console.error('AI响应失败:', error);
      io.to(`session:${sessionId}`).emit('typing', {
        role: 'assistant',
        isTyping: false
      });
    }
  }

  // ========== 主游戏 Socket 中间件 ==========
  // Socket.io中间件：验证Token
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error('未提供认证令牌'));
      }

      const decoded = jwt.verify(token, config.jwt.secret);
      
      // 验证用户
      const users = await db.query(
        'SELECT id, username, status FROM users WHERE id = ?',
        [decoded.userId]
      );

      if (users.length === 0 || users[0].status !== 'active') {
        return next(new Error('用户不存在或已被封禁'));
      }

      // 统一为 number，保证 connectedUsers Map 的 key 类型一致，避免 PK 拒绝/结算时查不到 socket
      const uid = decoded.userId;
      socket.userId = uid != null && !isNaN(Number(uid)) ? Number(uid) : uid;
      socket.username = decoded.username;
      next();
    } catch (error) {
      next(new Error('认证失败'));
    }
  });

  io.on('connection', (socket) => {
    // 将socketId添加到用户的Set中
    if (!connectedUsers.has(socket.userId)) {
      connectedUsers.set(socket.userId, new Set());
    }
    connectedUsers.get(socket.userId).add(socket.id);

    /**
     * 加入游戏房间，发送 full_state 和 player_update
     * @emits game_state - full_state
     * @emits player_update - 能量/体力/canPK
     * @emits system_message
     */
    socket.on('join_game', async (data) => {
      try {
        // 检查该用户是否已有连接，如果有则踢掉旧连接（单登录限制）
        if (connectedUsers.has(socket.userId)) {
          const oldSocketIds = connectedUsers.get(socket.userId);

          for (const oldSocketId of oldSocketIds) {
            // 跳过当前连接
            if (oldSocketId === socket.id) continue;

            const oldSocket = io.sockets.sockets.get(oldSocketId);
            if (oldSocket) {
              // 发送强制下线通知
              oldSocket.emit('force_logout', {
                message: '您的账号已在其他设备登录，您被迫下线。',
                reason: 'multi_login'
              });
              // 断开旧连接
              oldSocket.disconnect(true);
              console.log(`[单登录] 用户 ${socket.userId} 的旧连接 ${oldSocketId} 已被踢下线`);
            }
          }
        }

        // 重新设置当前用户的连接（清除旧的Set，创建新的）
        connectedUsers.set(socket.userId, new Set([socket.id]));

        let roomId = data.roomId || 1; // 默认房间ID为1
        const { password, inviteCode } = data;
        
        // 如果是自定义房间（roomId > 1），验证房间配置
        if (roomId > 1) {
          const rooms = await db.query(
            'SELECT * FROM game_rooms WHERE id = ? AND is_active = 1',
            [roomId]
          );
          
          if (rooms.length === 0) {
            return socket.emit('system_message', {
              type: 'error',
              message: '房间不存在或已关闭'
            });
          }
          
          const room = rooms[0];
          
          // 检查密码（只要房间有密码就需要验证）
          // 邀请码可以绕过密码验证（邀请链接包含授权）
          if (room.room_password) {
            const hasValidInviteCode = inviteCode && inviteCode === room.invite_code;
            
            // 如果没有有效的邀请码，才需要验证密码
            if (!hasValidInviteCode) {
              if (!password) {
                return socket.emit('room_password_required', { roomId });
              }
              if (password !== room.room_password) {
                return socket.emit('system_message', {
                  type: 'error',
                  message: '房间密码错误'
                });
              }
            }
          }
          
          // 验证邀请码（当没有密码时，或者密码验证失败后）
          if (inviteCode && inviteCode !== room.invite_code) {
            return socket.emit('system_message', {
              type: 'error',
              message: '邀请码无效'
            });
          }
          
          // 检查人数限制
          const currentPlayers = await db.query(
            'SELECT COUNT(*) as count FROM game_nodes WHERE room_id = ? AND owner_id IS NOT NULL',
            [roomId]
          );
          
          if (currentPlayers[0].count >= room.max_players) {
            return socket.emit('system_message', {
              type: 'error',
              message: '房间已满，无法加入'
            });
          }
          
          // 记录当前房间ID到socket
          socket.currentRoomId = roomId;
        }
        
        // 如果之前在其他房间，先退出
        if (socket.currentRoomId && socket.currentRoomId !== roomId) {
          await handleLeaveRoom(socket, socket.currentRoomId);
        }
        
        socket.join(`room_${roomId}`);
        
        // 更新房间在线人数
        await updateRoomPlayers(roomId);
        
        // 发送当前游戏状态
        await sendGameState(socket, roomId);
        
        // 立即发送当前用户的能量和体力数据（从MySQL数据库获取真实值）
        const users = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [socket.userId]);
        if (users.length > 0) {
          const user = users[0];
          // 安全地转换数据库返回的能量值（PK胜利后能量可以超过100）
          let energy = user.energy != null ? Number(user.energy) : 0;
          if (isNaN(energy)) energy = 0;
          energy = Math.max(0, energy); // 只确保不小于0，允许超过100
          
          // 安全地转换数据库返回的体力值
          let stamina = user.stamina != null ? Number(user.stamina) : 0;
          if (isNaN(stamina)) stamina = 0;
          stamina = Math.max(0, Math.min(100, stamina)); // 体力上限100
          
          const canPK = await getCanPK(socket.userId, roomId, energy);
          socket.emit('player_update', {
            energy: energy,
            stamina: stamina,
            canPK
          });
        }
        
        socket.emit('system_message', {
          type: 'success',
          message: '已加入游戏房间'
        });
      } catch (error) {
        console.error('加入游戏房间失败:', error);
        socket.emit('system_message', {
          type: 'error',
          message: '加入游戏房间失败'
        });
      }
    });

    /**
     * 退出游戏房间，跳转到默认房间
     * @emits game_state - full_state
     * @emits player_update - 能量/体力/canPK
     * @emits system_message
     */
    socket.on('leave_room', async (data) => {
      try {
        const currentRoomId = socket.currentRoomId;
        
        if (!currentRoomId || currentRoomId === 1) {
          return socket.emit('system_message', {
            type: 'info',
            message: '已在默认房间'
          });
        }
        
        // 处理退出房间逻辑
        await handleLeaveRoom(socket, currentRoomId);
        
        // 跳转到默认房间
        const defaultRoomId = 1;
        socket.currentRoomId = defaultRoomId;
        socket.join(`room_${defaultRoomId}`);
        
        // 更新房间人数
        await updateRoomPlayers(defaultRoomId);
        
        // 发送默认房间状态
        await sendGameState(socket, defaultRoomId);
        
        // 发送玩家数据
        const users = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [socket.userId]);
        if (users.length > 0) {
          const user = users[0];
          let energy = user.energy != null ? Number(user.energy) : 0;
          if (isNaN(energy)) energy = 0;
          energy = Math.max(0, energy);
          
          let stamina = user.stamina != null ? Number(user.stamina) : 0;
          if (isNaN(stamina)) stamina = 0;
          stamina = Math.max(0, Math.min(100, stamina));
          
          const canPK = await getCanPK(socket.userId, defaultRoomId, energy);
          socket.emit('player_update', {
            energy: energy,
            stamina: stamina,
            canPK
          });
        }
        
        socket.emit('system_message', {
          type: 'success',
          message: '已退出房间，返回平台房间'
        });
      } catch (error) {
        console.error('退出房间失败:', error);
        socket.emit('system_message', {
          type: 'error',
          message: '退出房间失败'
        });
      }
    });

    /**
     * 占据节点，若已占其他节点则先释放。服务端权威，广播 node_occupied
     * @emits game_state - node_occupied
     * @emits system_message
     */
    socket.on('occupy_node', async (data) => {
            try {
                const { nodeId, roomId = 1 } = data;
                
                // 检查节点是否已被占用
                const nodes = await db.query(
                    'SELECT owner_id FROM game_nodes WHERE room_id = ? AND node_id = ?',
                    [roomId, nodeId]
                );

                if (nodes.length === 0) {
                    return socket.emit('system_message', {
                        type: 'error',
                        message: '节点不存在'
                    });
                }

                if (nodes[0].owner_id) {
                    return socket.emit('system_message', {
                        type: 'error',
                        message: '节点已被占用'
                    });
                }

                // 检查用户是否已占据其他节点
                const userNodes = await db.query(
                    'SELECT node_id FROM game_nodes WHERE owner_id = ? AND room_id = ?',
                    [socket.userId, roomId]
                );

                if (userNodes.length > 0) {
                    // 释放旧节点
                    await db.query(
                        'UPDATE game_nodes SET owner_id = NULL, occupied_at = NULL WHERE room_id = ? AND node_id = ?',
                        [roomId, userNodes[0].node_id]
                    );
                    await redis.del(`game:room:${roomId}:node:${userNodes[0].node_id}`);
                    // 广播旧节点释放
                    io.to(`room_${roomId}`).emit('game_state', {
                        type: 'node_occupied',
                        nodeId: userNodes[0].node_id,
                        ownerId: null,
                        ownerName: null
                    });
                    const playersAfterRelease = await getPlayersWithNodesInRoom(roomId);
                    io.to(`room_${roomId}`).emit('game_state', { type: 'players_update', players: playersAfterRelease });
                }

                // 检查用户是否已经使用过首次免费占据
                const userInfo = await db.query(
                    'SELECT has_used_first_free_occupy, energy FROM users WHERE id = ?',
                    [socket.userId]
                );
                
                const hasUsedFirstFreeOccupy = userInfo.length > 0 && userInfo[0].has_used_first_free_occupy === 1;
                let isFirstOccupy = userInfo.length > 0 && userInfo[0].has_used_first_free_occupy === 0;
                let energyCost = 0;
                let currentEnergy = userInfo.length > 0 && userInfo[0].energy != null ? Number(userInfo[0].energy) : 0;
                if (isNaN(currentEnergy)) currentEnergy = 0;
                currentEnergy = Math.max(0, currentEnergy);

                // 如果不是首次占据，需要扣除能量
                if (!isFirstOccupy) {
                    // 获取占据节点能量消耗配置
                    // 优先使用房间自定义配置，否则使用全局配置
                    energyCost = 50; // 默认值
                    
                    try {
                        const roomConfig = await db.query(
                            'SELECT occupy_energy_cost FROM game_rooms WHERE id = ?',
                            [roomId]
                        );
                        
                        if (roomConfig.length > 0 && roomConfig[0].occupy_energy_cost != null) {
                            // 房间有自定义配置
                            energyCost = Number(roomConfig[0].occupy_energy_cost);
                        } else {
                            // 使用全局配置
                            const configRows = await db.query(
                                'SELECT config_value FROM game_config WHERE config_key = ?',
                                ['occupy_node_energy_cost']
                            );
                            energyCost = configRows.length > 0 && configRows[0].config_value != null 
                                ? Number(configRows[0].config_value) 
                                : 50;
                        }
                    } catch (err) {
                        console.error('获取占据能量消耗配置失败:', err);
                        // 使用默认值
                        const configRows = await db.query(
                            'SELECT config_value FROM game_config WHERE config_key = ?',
                            ['occupy_node_energy_cost']
                        );
                        energyCost = configRows.length > 0 && configRows[0].config_value != null 
                            ? Number(configRows[0].config_value) 
                            : 50;
                    }
                    
                    if (isNaN(energyCost)) energyCost = 50;
                    energyCost = Math.max(0, Math.min(1000, energyCost)); // 限制在0-1000范围内

                    // 检查能量是否足够
                    if (currentEnergy < energyCost) {
                        return socket.emit('system_message', {
                            type: 'error',
                            message: `⚠️ 能量核心不足（当前：${currentEnergy} 点），无法建立神经链接。需要 ${energyCost} 点能量才能占据节点。请联系推荐人购买能量。`
                        });
                    }
                }

                // 使用事务处理占据节点和能量扣除
                await db.transaction(async (conn) => {
                    // 占据节点
                    await conn.execute(
                        'UPDATE game_nodes SET owner_id = ?, occupied_at = NOW() WHERE room_id = ? AND node_id = ?',
                        [socket.userId, roomId, nodeId]
                    );

                    // 如果是首次占据，更新标记；如果不是首次占据，扣除能量
                    if (isFirstOccupy) {
                        // 首次占据：更新标记为已使用
                        await conn.execute(
                            'UPDATE users SET has_used_first_free_occupy = 1 WHERE id = ?',
                            [socket.userId]
                        );
                    } else {
                        // 后续占据：扣除能量
                        await conn.execute(
                            'UPDATE users SET energy = GREATEST(0, energy - ?) WHERE id = ?',
                            [energyCost, socket.userId]
                        );
                        currentEnergy = Math.max(0, currentEnergy - energyCost);
                    }
                });

                // 发送剧情化系统消息
                if (isFirstOccupy) {
                    socket.emit('system_message', {
                        type: 'success',
                        message: `✨ 协议校准：首次神经链接建立成功！作为新晋链接者，你获得了协议校准的初始连接特权，本次占据节点免费。这是零号协议对你的欢迎礼遇。`
                    });
                } else {
                    socket.emit('system_message', {
                        type: 'info',
                        message: `⚡ 协议校准：建立神经链接消耗了 ${energyCost} 点能量。这是接入矩阵网络的必要代价。`
                    });
                    try {
                        await mongo.insertUserGameRecord({
                            userId: socket.userId,
                            recordType: 'energy_consume',
                            amount: -energyCost,
                            reason: 'occupy_node',
                            roomId,
                            nodeId,
                            createdAt: new Date()
                        });
                    } catch (ugrErr) {
                        console.error('MongoDB user_game_records (energy_consume) 写入失败:', ugrErr);
                    }
                }

                // 更新Redis缓存
                await redis.set(`game:room:${roomId}:node:${nodeId}`, {
                    ownerId: socket.userId,
                    ownerName: socket.username,
                    occupiedAt: new Date().toISOString()
                }, 3600);

                // 广播节点占用事件
                io.to(`room_${roomId}`).emit('game_state', {
                    type: 'node_occupied',
                    nodeId,
                    ownerId: socket.userId,
                    ownerName: socket.username
                });
                const playersAfterOccupy = await getPlayersWithNodesInRoom(roomId);
                io.to(`room_${roomId}`).emit('game_state', { type: 'players_update', players: playersAfterOccupy });

                // 更新占据节点任务进度
                await updateTaskProgress(socket.userId, 'occupy_node');

                // 能量宝藏：检查是否可领取，有配置就能领取，领取后从配置中移除该节点
                let treasureGranted = null;
                const treasureConfig = await getTreasureConfig(roomId);
                const treasure = treasureConfig.find(t => Number(t.nodeId) === Number(nodeId) && t.amount > 0);
                if (treasure) {
                    const amount = Math.max(0, parseInt(treasure.amount, 10) || 0);
                    if (amount > 0) {
                        treasureGranted = await db.transaction(async (conn) => {
                            // 获取 max_energy 配置
                            const [maxRows] = await conn.execute(
                                'SELECT config_value FROM game_config WHERE config_key = ?',
                                ['max_energy']
                            );
                            let maxEnergy = 100;
                            if (maxRows && maxRows.length > 0 && maxRows[0].config_value != null) {
                                maxEnergy = Number(maxRows[0].config_value) || 100;
                            }
                            if (isNaN(maxEnergy)) maxEnergy = 100;

                            // 获取用户当前能量和体力
                            const [userRows] = await conn.execute('SELECT energy, stamina FROM users WHERE id = ?', [socket.userId]);
                            let currentEnergy = 0;
                            let currentStamina = 0;
                            if (userRows && userRows.length > 0) {
                                currentEnergy = userRows[0].energy != null ? Number(userRows[0].energy) : 0;
                                currentStamina = userRows[0].stamina != null ? Number(userRows[0].stamina) : 0;
                            }
                            if (isNaN(currentEnergy)) currentEnergy = 0;
                            currentEnergy = Math.max(0, currentEnergy);
                            if (isNaN(currentStamina)) currentStamina = 0;
                            currentStamina = Math.max(0, Math.min(100, currentStamina));

                            // 能量宝藏可以无限制增加能量，不受maxEnergy限制
                            const gain = amount;
                            const newEnergy = currentEnergy + gain;

                            // 更新用户能量
                            await conn.execute(
                                'UPDATE users SET energy = ?, total_energy = total_energy + ? WHERE id = ?',
                                [newEnergy, gain, socket.userId]
                            );

                            // 更新已领取能量宝藏金额
                            await conn.execute(
                                'UPDATE game_rooms SET energy_treasure_claimed = energy_treasure_claimed + ? WHERE id = ?',
                                [gain, roomId]
                            );

                            // 更新 room_treasures 表的 is_claimed 标记（房间宝藏配置）
                            await conn.execute(
                                'UPDATE room_treasures SET is_claimed = 1 WHERE room_id = ? AND node_id = ?',
                                [roomId, nodeId]
                            );

                            // 从全局配置中移除该节点（宝藏一次性领取，领取后需重新配置）
                            const [configRows] = await conn.execute(
                                'SELECT config_value FROM game_config WHERE config_key = ?',
                                ['energy_treasure']
                            );
                            if (configRows && configRows.length > 0 && configRows[0].config_value) {
                                try {
                                    const currentConfig = JSON.parse(configRows[0].config_value);
                                    if (Array.isArray(currentConfig)) {
                                        const newConfig = currentConfig.filter(t => Number(t.nodeId) !== Number(nodeId));
                                        await conn.execute(
                                            'UPDATE game_config SET config_value = ? WHERE config_key = ?',
                                            [JSON.stringify(newConfig), 'energy_treasure']
                                        );
                                    }
                                } catch (e) {
                                    console.error('更新能量宝藏配置失败:', e);
                                }
                            }

                            return { gain, newEnergy, maxEnergy, currentStamina };
                        });
                    }
                }
                if (treasureGranted) {
                    const { gain, newEnergy, maxEnergy, currentStamina } = treasureGranted;
                    socket.emit('treasure_claimed', { nodeId, amount: gain, newEnergy });
                    io.to(`room_${roomId}`).emit('treasure_node_revealed', { nodeId, claimedAt: new Date().toISOString() });
                    socket.emit('player_update', {
                        energy: newEnergy,
                        stamina: currentStamina,
                        canPK: newEnergy >= maxEnergy
                    });
                    // 广播平台池更新（包含宝藏配置信息）
                    const newPlatformPool = await calculatePlatformPool(roomId);
                    const updatedTreasureConfig = await getTreasureConfig(roomId);  // 传递 roomId 获取房间配置
                    const updatedTreasureInfo = {
                        configured: updatedTreasureConfig.length > 0,
                        nodeCount: updatedTreasureConfig.length,
                        totalAmount: updatedTreasureConfig.reduce((sum, t) => sum + (parseInt(t.amount, 10) || 0), 0)
                    };
                    io.to(`room_${roomId}`).emit('game_state', {
                        type: 'platform_pool_update',
                        platformPool: newPlatformPool,
                        treasureInfo: updatedTreasureInfo
                    });
                    // 通过 Redis Stream 消息队列发布宝藏领取事件（用于多实例同步）
                    try {
                        await treasureStream.publishTreasureClaimed({
                            userId: socket.userId,
                            roomId,
                            nodeId,
                            amount: gain,
                            newEnergy,
                            platformPool: newPlatformPool
                        });
                    } catch (tsErr) {
                        console.error('[TreasureStream] 发布宝藏领取消息失败:', tsErr.message);
                    }
                    try {
                        await mongo.insertUserGameRecord({
                            userId: socket.userId,
                            recordType: 'treasure',
                            amount: gain,
                            claimType: 'fixed',
                            roomId,
                            nodeId,
                            createdAt: new Date()
                        });
                    } catch (ugrErr) {
                        console.error('MongoDB user_game_records (treasure fixed) 写入失败:', ugrErr);
                    }
                    // 更新发现宝藏任务进度
                    await updateTaskProgress(socket.userId, 'find_treasure');
                } else {
                        // 即使没有能量宝藏，也要发送最新的用户能量和体力信息
                        // 重新查询数据库获取最新的能量值（因为可能已经扣除或更新了标记）
                        const users = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [socket.userId]);
                        if (users.length > 0) {
                            const user = users[0];
                            // 安全地转换数据库返回的能量值（PK胜利后能量可以超过100）
                            let energy = user.energy != null ? Number(user.energy) : 0;
                            if (isNaN(energy)) energy = 0;
                            energy = Math.max(0, energy); // 只确保不小于0，允许超过100
                            
                            // 安全地转换数据库返回的体力值
                            let stamina = user.stamina != null ? Number(user.stamina) : 0;
                            if (isNaN(stamina)) stamina = 0;
                            stamina = Math.max(0, Math.min(100, stamina)); // 体力上限100
                            
                            const maxEnergyConfig = await db.query(
                                'SELECT config_value FROM game_config WHERE config_key = ?',
                                ['max_energy']
                            );
                            const maxEnergy = maxEnergyConfig.length > 0 ? Number(maxEnergyConfig[0].config_value) : 100;
                            if (isNaN(maxEnergy)) maxEnergy = 100;
                            
                            socket.emit('player_update', {
                                energy: energy,
                                stamina: stamina,
                                canPK: energy >= maxEnergy
                            });
                    }
                }

                socket.emit('system_message', {
                    type: 'success',
                    message: `节点 ${nodeId} 占据成功，开始挖矿`
                });
            } catch (error) {
                console.error('占据节点失败:', error);
                socket.emit('system_message', {
                    type: 'error',
                    message: '占据节点失败'
                });
            }
        });

    /**
     * 标记开始挖矿，需已占据节点。实际挖矿由定时任务驱动
     * @emits system_message
     */
    socket.on('start_mining', async (data) => {
      try {
        const { roomId = 1 } = data;
        
        // 检查用户是否占据节点
        const nodes = await db.query(
          'SELECT node_id FROM game_nodes WHERE owner_id = ? AND room_id = ?',
          [socket.userId, roomId]
        );

        if (nodes.length === 0) {
          return socket.emit('system_message', {
            type: 'error',
            message: '请先占据一个节点'
          });
        }

        // 设置挖矿状态
        await redis.set(`mining:${socket.userId}`, {
          roomId,
          nodeId: nodes[0].node_id,
          startTime: new Date().toISOString()
        }, 3600);

        socket.emit('system_message', {
          type: 'success',
          message: '开始挖矿'
        });
      } catch (error) {
        console.error('开始挖矿失败:', error);
        socket.emit('system_message', {
          type: 'error',
          message: '开始挖矿失败'
        });
      }
    });

    /**
     * 发起 PK 挑战，向防御者发送 pk_challenge
     * @emits pk_challenge - 发给防御者
     * @emits system_message
     */
    socket.on('challenge_player', async (data) => {
      try {
        const { defenderId, roomId = 1 } = data;
        
        if (defenderId === socket.userId) {
          return socket.emit('system_message', {
            type: 'error',
            message: '不能挑战自己'
          });
        }

        // 检查攻击者是否已占据能量节点（发起PK需已占据节点）
        const attackerHasNode = await userHasNodeInRoom(socket.userId, roomId);
        if (!attackerHasNode) {
          return socket.emit('system_message', {
            type: 'error',
            message: '需要占据能量节点才能发起PK'
          });
        }

        // 检查房间内是否有其他在线玩家（排除自己）
        const room = io.sockets.adapter.rooms.get(`room_${roomId}`);
        if (!room) {
          return socket.emit('system_message', {
            type: 'info',
            message: '你是第一人，没有人在挖矿，请继续等待'
          });
        }

        // 检查房间内是否有其他在线玩家（排除当前玩家）
        let hasOtherPlayers = false;
        for (const socketId of room) {
          const otherSocket = io.sockets.sockets.get(socketId);
          if (otherSocket && otherSocket.userId && otherSocket.userId !== socket.userId) {
            hasOtherPlayers = true;
            break;
          }
        }

        // 如果没有其他在线玩家，尝试自动匹配其他在线对手（虚拟智能体）
        if (!hasOtherPlayers) {
          const requestAutoMatch = defenderId == null || defenderId === 0;
          if (requestAutoMatch) {
            const virtualAgents = await db.query(
              `SELECT id, name FROM virtual_ai_agents 
               WHERE status = 'online' AND room_id = ? 
               AND current_node_id IS NOT NULL AND energy >= 100 
               ORDER BY RAND() LIMIT 1`,
              [roomId]
            );
            if (virtualAgents.length > 0) {
              const matchedDefenderId = virtualAgents[0].id;
              const matchedDefenderName = virtualAgents[0].name;
              const virtualAgentSocket = require('./services/virtual-agent-socket');
              if (await isDefenderInPendingChallenge(matchedDefenderId)) {
                await virtualAgentSocket.handleVirtualAgentPKRejection(
                  socket.userId,
                  matchedDefenderId,
                  roomId,
                  'rejected',
                  { attackerSocketId: socket.id }
                );
                // 二次推送：保证当前请求页签收到能量更新
                const rewardConfig = await db.query('SELECT config_value FROM game_config WHERE config_key = ?', ['pk_energy_reward']);
                const reward = rewardConfig.length > 0 ? parseInt(rewardConfig[0].config_value, 10) : 50;
                const attackerUser = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [socket.userId]);
                if (attackerUser.length > 0) {
                  const u = attackerUser[0];
                  let energy = u.energy != null ? Number(u.energy) : 0;
                  if (isNaN(energy)) energy = 0;
                  energy = Math.max(0, energy);
                  let stamina = u.stamina != null ? Number(u.stamina) : 0;
                  if (isNaN(stamina)) stamina = 0;
                  stamina = Math.max(0, Math.min(100, stamina));
                  const canPK = await getCanPK(socket.userId, roomId, energy);
                  socket.emit('pk_result', { result: 'win', myAttackDist: null, enemyAttackDist: null, energyChange: reward, reason: 'rejected', energy, canPK });
                  socket.emit('player_update', { energy, stamina, canPK });
                }
                socket.emit('system_message', {
                  type: 'info',
                  message: '对方正在协议对决中，无法应战，判你胜。'
                });
                return;
              }
              const response = await virtualAgentSocket.handleVirtualAgentPKChallenge(
                matchedDefenderId,
                socket.userId,
                socket.username,
                'user',
                roomId
              );
              if (response.accepted) {
                const challengeKey = `pk_challenge:${matchedDefenderId}:${socket.userId}`;
                const challengeData = {
                  attackerId: socket.userId,
                  attackerType: 'user',
                  defenderId: matchedDefenderId,
                  defenderType: 'virtual_agent',
                  roomId: roomId,
                  createdAt: new Date().toISOString()
                };
                await redis.set(challengeKey, challengeData, 30);
                challengeQueue.set(challengeKey, { ...challengeData, createdAt: Date.now() });
                socket.emit('pk_matched_virtual', { defenderId: matchedDefenderId, defenderName: matchedDefenderName });
                socket.emit('system_message', {
                  type: 'info',
                  message: `${matchedDefenderName} 接受了你的挑战！请设置PK数值。`
                });
                return;
              } else {
                // 存储挑战状态（即使被拒绝，也需要记录挑战信息）
                const challengeKey = `pk_challenge:${matchedDefenderId}:${socket.userId}`;
                const challengeData = {
                  attackerId: socket.userId,
                  attackerType: 'user',
                  defenderId: matchedDefenderId,
                  defenderType: 'virtual_agent',
                  roomId: roomId,
                  createdAt: new Date().toISOString()
                };
                await redis.set(challengeKey, challengeData, 30);
                challengeQueue.set(challengeKey, { ...challengeData, createdAt: Date.now() });
                
                await virtualAgentSocket.handleVirtualAgentPKRejection(
                  socket.userId,
                  matchedDefenderId,
                  roomId,
                  'rejected',
                  { attackerSocketId: socket.id }
                );
                socket.emit('system_message', {
                  type: 'info',
                  message: `${matchedDefenderName || '对手'} 拒绝了你的挑战`
                });
                return;
              }
            }
          }
          return socket.emit('system_message', {
            type: 'info',
            message: '当前没有其他在线用户占据节点，请等待'
          });
        }

        // 检查防御者是否为虚拟智能体
        const virtualAgentSocket = require('./services/virtual-agent-socket');
        const defenderIsVirtual = virtualAgentSocket.isVirtualAgent(defenderId);
        
        if (defenderIsVirtual) {
          if (await isDefenderInPendingChallenge(defenderId)) {
            await virtualAgentSocket.handleVirtualAgentPKRejection(
              socket.userId,
              defenderId,
              roomId,
              'rejected',
              { attackerSocketId: socket.id }
            );
            // 二次推送：保证当前请求页签收到能量更新
            const rewardConfig = await db.query('SELECT config_value FROM game_config WHERE config_key = ?', ['pk_energy_reward']);
            const reward = rewardConfig.length > 0 ? parseInt(rewardConfig[0].config_value, 10) : 50;
            const attackerUser = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [socket.userId]);
            if (attackerUser.length > 0) {
              const u = attackerUser[0];
              let energy = u.energy != null ? Number(u.energy) : 0;
              if (isNaN(energy)) energy = 0;
              energy = Math.max(0, energy);
              let stamina = u.stamina != null ? Number(u.stamina) : 0;
              if (isNaN(stamina)) stamina = 0;
              stamina = Math.max(0, Math.min(100, stamina));
              const canPK = await getCanPK(socket.userId, roomId, energy);
              socket.emit('pk_result', { result: 'win', myAttackDist: null, enemyAttackDist: null, energyChange: reward, reason: 'rejected', energy, canPK });
              socket.emit('player_update', { energy, stamina, canPK });
            }
            socket.emit('system_message', {
              type: 'info',
              message: '对方正在协议对决中，无法应战，判你胜。'
            });
            return;
          }
          const response = await virtualAgentSocket.handleVirtualAgentPKChallenge(
            defenderId, 
            socket.userId, 
            socket.username, 
            'user', 
            roomId
          );
          
          if (response.accepted) {
            // 虚拟智能体接受了挑战，设置攻击者的PK数值（需要用户手动设置，这里先提示）
            socket.emit('system_message', {
              type: 'info',
              message: `虚拟智能体 ${response.agentName} 接受了你的挑战！请设置PK数值。`
            });
            
            // 存储挑战状态
            const challengeKey = `pk_challenge:${defenderId}:${socket.userId}`;
            const challengeData = {
              attackerId: socket.userId,
              attackerType: 'user',
              defenderId: defenderId,
              defenderType: 'virtual_agent',
              roomId: roomId,
              createdAt: new Date().toISOString()
            };
            await redis.set(challengeKey, challengeData, 30);
            challengeQueue.set(challengeKey, {
              ...challengeData,
              createdAt: Date.now()
            });
            
            // 等待用户设置PK数值后自动结算（在resolve_pk中处理）
          } else {
            // 存储挑战状态（即使被拒绝，也需要记录挑战信息）
            const challengeKey = `pk_challenge:${defenderId}:${socket.userId}`;
            const challengeData = {
              attackerId: socket.userId,
              attackerType: 'user',
              defenderId: defenderId,
              defenderType: 'virtual_agent',
              roomId: roomId,
              createdAt: new Date().toISOString()
            };
            await redis.set(challengeKey, challengeData, 30);
            challengeQueue.set(challengeKey, { ...challengeData, createdAt: Date.now() });
            
            // 虚拟智能体拒绝了挑战（传入当前 socket，保证多标签时发到发起请求的页签）
            await virtualAgentSocket.handleVirtualAgentPKRejection(
              socket.userId,
              defenderId,
              roomId,
              'rejected',
              { attackerSocketId: socket.id }
            );
            
            socket.emit('system_message', {
              type: 'info',
              message: `虚拟智能体 ${response.agentName || 'Unknown'} 拒绝了你的挑战`
            });
          }
          return;
        }
        
        // 防御者是真实用户
        const defenderSocketIds = connectedUsers.has(defenderId) ? connectedUsers.get(defenderId) :
                                 (connectedUsers.has(Number(defenderId)) ? connectedUsers.get(Number(defenderId)) : null);
        if (!defenderSocketIds || defenderSocketIds.size === 0) {
          return socket.emit('system_message', {
            type: 'error',
            message: '目标玩家不在线'
          });
        }
        
        // 检查防御者能量是否≥100
        const defenderUser = await db.query('SELECT energy FROM users WHERE id = ?', [defenderId]);
        if (defenderUser.length === 0) {
          return socket.emit('system_message', {
            type: 'error',
            message: '目标玩家不存在'
          });
        }
        
        let defenderEnergy = defenderUser[0].energy != null ? Number(defenderUser[0].energy) : 0;
        if (isNaN(defenderEnergy)) defenderEnergy = 0;
        defenderEnergy = Math.max(0, defenderEnergy);
        
        if (defenderEnergy < 100) {
          return socket.emit('system_message', {
            type: 'error',
            message: '目标玩家能量不足100，无法进行协议对决'
          });
        }
        
        // 检查防御者是否占据节点
        const defenderNodes = await db.query(
          'SELECT node_id FROM game_nodes WHERE owner_id = ? AND room_id = ?',
          [defenderId, roomId]
        );
        
        if (defenderNodes.length === 0) {
          return socket.emit('system_message', {
            type: 'error',
            message: '目标玩家未占据能量节点，无法进行协议对决'
          });
        }
        
        if (await isDefenderInPendingChallenge(defenderId)) {
          await handlePKRejection(socket.userId, defenderId, roomId, 'rejected', { skipChallengeCheck: true });
          socket.emit('system_message', {
            type: 'info',
            message: '对方正在协议对决中，无法应战，判你胜。'
          });
          return;
        }

        // 存储挑战状态到Redis（30秒过期，用于超时检查）
        const challengeKey = `pk_challenge:${defenderId}:${socket.userId}`;
        const challengeData = {
          attackerId: socket.userId,
          attackerType: 'user',
          defenderId: defenderId,
          defenderType: 'user',
          roomId: roomId,
          createdAt: new Date().toISOString()
        };
        await redis.set(challengeKey, challengeData, 30);
        
        // 添加到内存队列，用于超时检查
        challengeQueue.set(challengeKey, {
          ...challengeData,
          createdAt: Date.now() // 使用时间戳便于计算
        });

        // 发送挑战请求到防御者的所有连接
        broadcastToUser(defenderId, 'pk_challenge', {
          attackerId: socket.userId,
          attackerName: socket.username,
          attackerType: 'user',
          roomId
        });

        socket.emit('system_message', {
          type: 'success',
          message: '挑战请求已发送'
        });
      } catch (error) {
        console.error('挑战玩家失败:', error);
        socket.emit('system_message', {
          type: 'error',
          message: '挑战玩家失败'
        });
      }
    });

    /**
     * 设置 PK 数值（king, assassin）存入 Redis，300 秒有效
     */
    socket.on('pk_set_values', (data) => {
      // 存储PK数值到Redis
      redis.set(`pk:${socket.userId}`, {
        king: data.king,
        assassin: data.assassin
      }, 300);
    });

    /**
     * 拒绝PK挑战，执行判输逻辑
     * @emits pk_result - 双方
     * @emits player_update - 双方
     */
    socket.on('reject_pk_challenge', async (data) => {
      try {
        const { attackerId, roomId = 1 } = data;
        
        // 验证挑战者ID
        if (!attackerId) {
          return socket.emit('system_message', {
            type: 'error',
            message: '无效的挑战者ID'
          });
        }

        // 检查攻击者是否为虚拟智能体
        const virtualAgentSocket = require('./services/virtual-agent-socket');
        const attackerIsVirtual = virtualAgentSocket.isVirtualAgent(attackerId);
        
        if (attackerIsVirtual) {
          // 攻击者是虚拟智能体，使用虚拟智能体的拒绝处理（传入当前 socket，防御者为本页签）
          await virtualAgentSocket.handleVirtualAgentPKRejection(
            attackerId,
            socket.userId,
            roomId,
            'rejected',
            { defenderSocketId: socket.id }
          );
        } else {
          // 攻击者是真实用户，使用原有逻辑
          await handlePKRejection(attackerId, socket.userId, roomId, 'rejected');
        }
      } catch (error) {
        console.error('拒绝PK挑战失败:', error);
        socket.emit('system_message', {
          type: 'error',
          message: '拒绝PK挑战失败'
        });
      }
    });

    /**
     * 提交 PK 结算，服务端权威计算胜负，更新 MySQL，向双方发送 pk_result 和 player_update
     * @emits pk_result - 双方
     * @emits player_update - 双方
     * @emits game_state - platform_pool_update（平局时）
     * @emits system_message
     */
    socket.on('resolve_pk', async (data) => {
      try {
        const { defenderId, roomId = 1 } = data;

        // 如果攻击者是虚拟智能体，说明是用户接受虚拟智能体的挑战
        // 此时socket.userId是防御者（用户），defenderId是攻击者（虚拟智能体）
        let actualAttackerId = socket.userId;
        let actualDefenderId = defenderId;

        // 从Redis获取挑战状态，确定真正的攻击者和防御者
        const challengeKey = `pk_challenge:${defenderId}:${socket.userId}`;
        const reverseChallengeKey = `pk_challenge:${socket.userId}:${defenderId}`;
        const challengeState = await redis.get(challengeKey) || await redis.get(reverseChallengeKey);

        // 先从challengeState获取正确的攻击者/防御者ID
        if (challengeState) {
          // 如果挑战状态存在，使用挑战状态中的攻击者和防御者
          actualAttackerId = challengeState.attackerId;
          actualDefenderId = challengeState.defenderId;
        }

        // 幂等校验：使用与 handlePKTimeout 相同的 settledKey 格式
        // settledKey 格式: pk_settled:${defenderId}:${attackerId}
        // 与 challengeKey 格式: pk_challenge:${defenderId}:${attackerId} 保持顺序一致
        const settledKey = `pk_settled:${defenderId}:${socket.userId}`;
        const isSettled = await redis.get(settledKey);
        if (isSettled) {
          return socket.emit('system_message', {
            type: 'info',
            message: 'PK已结算，请等待结果'
          });
        }

        // 可靠识别虚拟智能体：优先使用 challengeState 中的类型，否则查询数据库
        let attackerIsVirtual = false;
        let defenderIsVirtual = false;
        
        if (challengeState) {
          attackerIsVirtual = challengeState.attackerType === 'virtual_agent';
          defenderIsVirtual = challengeState.defenderType === 'virtual_agent';
        }
        
        // 如果 challengeState 不存在或未包含类型信息，查询数据库作为兜底：优先 users 表判定真人
        if (!challengeState || challengeState.attackerType === undefined) {
          try {
            const userAttacker = await db.query('SELECT 1 FROM users WHERE id = ? LIMIT 1', [actualAttackerId]);
            if (userAttacker.length === 0) {
              const attackerCheck = await db.query('SELECT 1 FROM virtual_ai_agents WHERE id = ? LIMIT 1', [actualAttackerId]);
              attackerIsVirtual = attackerCheck.length > 0;
            }
          } catch (err) {
            console.error('查询攻击者类型失败:', err);
          }
        }
        
        if (!challengeState || challengeState.defenderType === undefined) {
          try {
            const userDefender = await db.query('SELECT 1 FROM users WHERE id = ? LIMIT 1', [actualDefenderId]);
            if (userDefender.length === 0) {
              const defenderCheck = await db.query('SELECT 1 FROM virtual_ai_agents WHERE id = ? LIMIT 1', [actualDefenderId]);
              defenderIsVirtual = defenderCheck.length > 0;
            }
          } catch (err) {
            console.error('查询防御者类型失败:', err);
          }
        }
        
        // 从Redis获取攻击者的PK数值（确保数据一致性）
        const attackerPk = await redis.get(`pk:${actualAttackerId}`);
        
        // 从Redis获取防御者的PK数值
        const defenderPk = await redis.get(`pk:${actualDefenderId}`);
        
        // 如果攻击者或防御者是虚拟智能体，进入真人 vs 虚拟的处理流程
        if (attackerIsVirtual || defenderIsVirtual) {
          const virtualAgentSocket = require('./services/virtual-agent-socket');
          
          // 确定真人和虚拟智能体的身份
          const realUserId = attackerIsVirtual ? actualDefenderId : actualAttackerId;
          const virtualAgentId = attackerIsVirtual ? actualAttackerId : actualDefenderId;
          const realUserPk = attackerIsVirtual ? defenderPk : attackerPk;
          
          // 真人方PK必须存在
          if (!realUserPk) {
            return socket.emit('system_message', {
              type: 'error',
              message: '请先设置PK数值'
            });
          }
          
          // 虚拟方PK允许缺失，将在延迟后自动生成
          // 查询虚拟AI智能体的名称
          let virtualAgentName = '对手';
          try {
            const agentInfo = await db.query('SELECT name FROM virtual_ai_agents WHERE id = ?', [virtualAgentId]);
            if (agentInfo.length > 0 && agentInfo[0].name) {
              virtualAgentName = agentInfo[0].name;
            }
          } catch (err) {
            console.error('查询虚拟AI智能体名称失败:', err);
          }
          
          // 发送提示消息
          socket.emit('system_message', {
            type: 'info',
            message: `${virtualAgentName}正在确认参与,请稍等...`
          });
          
          // 延迟 3-5 秒后执行结算
          const delayMs = 3000 + Math.random() * 2000; // 3000-5000ms
          
          setTimeout(async () => {
            try {
              // 强制重新生成虚拟方的随机PK参数（确保每次都是随机对战）
              // 不检查Redis中是否已有值，直接生成新的随机参数
              const virtualKing = Math.floor(Math.random() * 100) + 1; // 1-100
              const virtualAssassin = Math.floor(Math.random() * 100) + 1; // 1-100
              const virtualPk = { king: virtualKing, assassin: virtualAssassin };
              
              // 可选：将生成的参数存入Redis（虽然即将被清理，但保持一致性）
              await redis.set(`pk:${virtualAgentId}`, virtualPk, 300);
              
              // 确定最终的PK参数
              let attackerKing, attackerAssassin, defenderKing, defenderAssassin;
              
              if (attackerIsVirtual) {
                // 攻击者是虚拟智能体，防御者是真人
                attackerKing = virtualPk.king;
                attackerAssassin = virtualPk.assassin;
                defenderKing = realUserPk.king;
                defenderAssassin = realUserPk.assassin;
              } else {
                // 攻击者是真人，防御者是虚拟智能体
                attackerKing = realUserPk.king;
                attackerAssassin = realUserPk.assassin;
                defenderKing = virtualPk.king;
                defenderAssassin = virtualPk.assassin;
              }
              
              // 调用虚拟智能体PK结算函数
              await virtualAgentSocket.resolveVirtualAgentPK(
                actualAttackerId,
                actualDefenderId,
                roomId,
                attackerKing,
                attackerAssassin,
                defenderKing,
                defenderAssassin,
                challengeState  // 传递 challengeState
              );
            } catch (error) {
              console.error('延迟结算虚拟智能体PK失败:', error);
              socket.emit('system_message', {
                type: 'error',
                message: 'PK结算失败，请重试'
              });
            }
          }, delayMs);
          
          return;
        }

        // 防御者是真实用户，使用原有逻辑
        // 真人方PK必须存在
        if (!attackerPk) {
          return socket.emit('system_message', {
            type: 'error',
            message: '请先设置PK数值'
          });
        }

        if (!defenderPk) {
          return socket.emit('system_message', {
            type: 'error',
            message: '对方尚未设置PK数值'
          });
        }

        // 设置"已结算"标记，防止并发重复结算
        const setResult = await redis.set(settledKey, { settledAt: Date.now(), reason: 'resolve_pk' }, 10);
        if (!setResult) {
          console.warn(`[resolve_pk] 设置settledKey失败，跳过结算，key=${settledKey}`);
          return socket.emit('system_message', {
            type: 'error',
            message: 'PK结算失败，请重试'
          });
        }

        // 从Redis获取PK数值（确保实时同步）
        const attackerKing = attackerPk.king;
        const attackerAssassin = attackerPk.assassin;
        const defenderKing = defenderPk.king;
        const defenderAssassin = defenderPk.assassin;

        // 根据 socket.userId 确定"我"和"敌人"的PK参数
        const myKing = socket.userId === actualAttackerId ? attackerKing : defenderKing;
        const myAssassin = socket.userId === actualAttackerId ? attackerAssassin : defenderAssassin;
        const enemyKing = socket.userId === actualAttackerId ? defenderKing : attackerKing;
        const enemyAssassin = socket.userId === actualAttackerId ? defenderAssassin : attackerAssassin;
        
        // 原始攻击距离
        const myAttackDist = Math.abs(myAssassin - enemyKing);
        const enemyAttackDist = Math.abs(enemyAssassin - myKing);

        // 皮肤攻防：获取双方当前皮肤的 pk_attack / pk_defense，及防御距离上限配置
        const attackerSkin = await getSkinPkStats(actualAttackerId);
        const defenderSkin = await getSkinPkStats(actualDefenderId);
        const thresholdRows = await db.query(
          'SELECT config_value FROM game_config WHERE config_key = ?',
          ['pk_skin_defense_distance_threshold']
        );
        const defenseDistThreshold = Math.min(99, Math.max(1, parseInt(thresholdRows[0]?.config_value, 10) || 30));
        const myPkAttack = socket.userId === actualAttackerId ? attackerSkin.pk_attack : defenderSkin.pk_attack;
        const myPkDefense = socket.userId === actualAttackerId ? attackerSkin.pk_defense : defenderSkin.pk_defense;
        // 攻击：己方原始距离 >= 己方 pk_attack 时才扣减，否则不扣减
        const myEffectiveDist = myAttackDist >= myPkAttack ? myAttackDist - myPkAttack : myAttackDist;
        // 防御：对方原始距离 <= 配置上限时才加上己方 pk_defense，否则不加
        const enemyEffectiveDist = enemyAttackDist <= defenseDistThreshold ? enemyAttackDist + myPkDefense : enemyAttackDist;

        let result = 'draw';
        let energyChange = 0;
        if (myEffectiveDist < enemyEffectiveDist) {
          result = 'win';
          energyChange = 50;
        } else if (enemyEffectiveDist < myEffectiveDist) {
          result = 'lose';
          energyChange = -50;
        } else {
          result = 'draw';
          energyChange = -50;
        }

        // 确定攻击者和防御者的结果
        // result 是从 socket.userId 的视角计算的（使用 myAttackDist 和 enemyAttackDist）
        // 如果 socket.userId 是攻击者，result 就是攻击者的结果；如果是防御者，result 就是防御者的结果
        const attackerResult = socket.userId === actualAttackerId ? result : (result === 'win' ? 'lose' : (result === 'lose' ? 'win' : 'draw'));
        const defenderResult = socket.userId === actualDefenderId ? result : (result === 'win' ? 'lose' : (result === 'lose' ? 'win' : 'draw'));

        // 更新攻击者能量和战绩（更新MySQL数据库）
        await db.query(
          'UPDATE users SET energy = GREATEST(0, energy + ?), wins = wins + ?, losses = losses + ?, draws = draws + ? WHERE id = ?',
          [
            attackerResult === 'win' ? 50 : (attackerResult === 'lose' ? -50 : -50),
            attackerResult === 'win' ? 1 : 0,
            attackerResult === 'lose' ? 1 : 0,
            attackerResult === 'draw' ? 1 : 0,
            actualAttackerId
          ]
        );

        // 更新防御者能量和战绩（更新MySQL数据库）
        await db.query(
          'UPDATE users SET energy = GREATEST(0, energy + ?), wins = wins + ?, losses = losses + ?, draws = draws + ? WHERE id = ?',
          [
            defenderResult === 'win' ? 50 : (defenderResult === 'lose' ? -50 : -50),
            defenderResult === 'win' ? 1 : 0,
            defenderResult === 'lose' ? 1 : 0,
            defenderResult === 'draw' ? 1 : 0,
            actualDefenderId
          ]
        );

        // 从MySQL数据库获取更新后的能量和体力数据，实时同步给客户端
        const attackerUser = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [actualAttackerId]);
        const defenderUser = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [actualDefenderId]);

        // 记录PK战斗
        await db.query(
          `INSERT INTO pk_records (attacker_id, defender_id, attacker_king, attacker_assassin, defender_king, defender_assassin, result, energy_change, attacker_type, defender_type, room_id, room_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', 'user', ?, ?)`,
          [actualAttackerId, actualDefenderId, attackerKing, attackerAssassin, defenderKing, defenderAssassin, result, energyChange, roomId, roomId === 1 ? '平台房间' : `房间${roomId}`]
        );

        // 推送结算到 Redis Stream，由消费者异步处理 MongoDB、任务进度、平台池（保证对战响应即时，其余由 stream 统一处理）
        const settlementPayload = {
          actualAttackerId,
          actualDefenderId,
          roomId,
          attackerKing,
          attackerAssassin,
          defenderKing,
          defenderAssassin,
          result,
          attackerResult,
          defenderResult,
          energyChange,
          myAttackDist,
          enemyAttackDist
        };
        await redis.xAdd('pk:settlement', settlementPayload, 10000);

        // 发送PK结果并实时同步MySQL数据库中的能量和体力（提交方）；settlementComplete: false 表示 stream 消费者尚未处理完，前端显示「结算中」
        socket.emit('pk_result', {
          result,
          myAttackDist,
          enemyAttackDist,
          energyChange,
          settlementComplete: false
        });

        // 提交方自己的能量和体力（从 attackerUser/defenderUser 中取对应用户）
        const submitterUser = socket.userId === actualAttackerId ? attackerUser : defenderUser;
        if (submitterUser.length > 0) {
          const user = submitterUser[0];
          let energy = user.energy != null ? Number(user.energy) : 0;
          if (isNaN(energy)) energy = 0;
          energy = Math.max(0, energy);
          let stamina = user.stamina != null ? Number(user.stamina) : 0;
          if (isNaN(stamina)) stamina = 0;
          stamina = Math.max(0, Math.min(100, stamina));
          const submitterId = socket.userId === actualAttackerId ? actualAttackerId : actualDefenderId;
          const canPK = await getCanPK(submitterId, roomId, energy);
          socket.emit('player_update', {
            energy: energy,
            stamina: stamina,
            canPK
          });
        }

        // 向“另一方”推送 pk_result 和 player_update（确保攻击者/防御者谁后提交对方都能收到）
        // 确定另一方的ID
        const otherUserId = socket.userId === actualAttackerId ? actualDefenderId : actualAttackerId;
        const otherResult = socket.userId === actualAttackerId ? defenderResult : attackerResult;
        const otherEnergyChange = otherResult === 'win' ? 50 : -50;

        // 获取另一方的用户信息
        const otherUser = socket.userId === actualAttackerId ? defenderUser : attackerUser;
        if (otherUser.length > 0) {
          const user = otherUser[0];
          let energy = user.energy != null ? Number(user.energy) : 0;
          if (isNaN(energy)) energy = 0;
          energy = Math.max(0, energy);
          let stamina = user.stamina != null ? Number(user.stamina) : 0;
          if (isNaN(stamina)) stamina = 0;
          stamina = Math.max(0, Math.min(100, stamina));
          const canPK = await getCanPK(otherUserId, roomId, energy);

          // 使用 broadcastToUser 发送到另一方的所有连接
          broadcastToUser(otherUserId, 'pk_result', {
            result: otherResult,
            myAttackDist: enemyAttackDist,
            enemyAttackDist: myAttackDist,
            energyChange: otherEnergyChange,
            settlementComplete: false
          });
          broadcastToUser(otherUserId, 'player_update', {
            energy: energy,
            stamina: stamina,
            canPK
          });
        }

        // 清理PK数据和挑战状态
        await redis.del(`pk:${actualAttackerId}`);
        await redis.del(`pk:${actualDefenderId}`);
        // 清理挑战状态（challengeKey 已在上面定义）
        await redis.del(challengeKey);
        challengeQueue.delete(challengeKey);

        // 更新Redis排行榜（实时更新，无需等待缓存失效）
        try {
          // 使用文件顶部定义的完整 LEADERBOARD_KEYS
          // 使用实际的能量变化值，而不是硬编码的50
          const absEnergyChange = Math.abs(energyChange);

          // 更新福力榜：胜者增加分数
          if (attackerResult === 'win') {
            await redis.zIncrBy(LEADERBOARD_KEYS.FORTUNE_ZS, absEnergyChange, actualAttackerId.toString());
            // 败者增加贡献榜分数（使用绝对值）
            await redis.zIncrBy(LEADERBOARD_KEYS.CONTRIBUTION_ZS, absEnergyChange, actualDefenderId.toString());
          } else if (attackerResult === 'lose') {
            // 攻击者输了，防御者赢了
            await redis.zIncrBy(LEADERBOARD_KEYS.FORTUNE_ZS, absEnergyChange, actualDefenderId.toString());
            // 攻击者增加贡献榜分数（使用绝对值）
            await redis.zIncrBy(LEADERBOARD_KEYS.CONTRIBUTION_ZS, absEnergyChange, actualAttackerId.toString());
          }
          // 平局不更新排行榜

          // 清除排行榜缓存，确保下次请求获取最新数据
          await redis.del(LEADERBOARD_KEYS.CONTRIBUTION_DATA);
          await redis.del(LEADERBOARD_KEYS.FORTUNE_DATA);
        } catch (leaderboardErr) {
          console.error('[排行榜] 更新失败:', leaderboardErr.message);
          // 不阻塞主流程
        }

        // 广播排行榜更新事件（PK结算完成后通知所有客户端刷新排行榜）
        io.emit('leaderboard_update', {
          type: 'pk_settled',
          timestamp: Date.now()
        });
      } catch (error) {
        console.error('PK战斗失败:', error);
        socket.emit('system_message', {
          type: 'error',
          message: 'PK战斗失败'
        });
      }
    });

    // 离开游戏
    socket.on('leave_game', async (data) => {
      const roomId = data.roomId || 1;
      socket.leave(`room_${roomId}`);
      await updateRoomPlayers(roomId);
    });

    // 断开连接
    socket.on('disconnect', async () => {
      // 从 connectedUsers 中移除该 socket
      if (connectedUsers.has(socket.userId)) {
        const socketIds = connectedUsers.get(socket.userId);
        socketIds.delete(socket.id);
        if (socketIds.size === 0) {
          connectedUsers.delete(socket.userId);
        }
      }

      try {
        if (socket.userId != null && socket.userId !== undefined) {
          // 清理挖矿状态
          await redis.del(`mining:${socket.userId}`);
          // 释放用户占据的所有节点（使用辅助函数，包含事务和广播）
          const releasedCount = await releaseUserNodes(socket.userId, true);
          // 清理该用户作为防御者或攻击者的待处理 PK 挑战，避免重登后超时轮询误判负
          await clearChallengesForUser(socket.userId);
        }
        // 更新所有房间的在线人数
        const rooms = await db.query('SELECT id FROM game_rooms');
        for (const room of rooms) {
          await updateRoomPlayers(room.id);
        }
        // 广播可挑战玩家列表更新，避免其他客户端仍把已断开用户当作可挑战对象
        if (io) {
          for (const room of rooms) {
            const players = await getPlayersWithNodesInRoom(room.id);
            io.to(`room_${room.id}`).emit('game_state', { type: 'players_update', players });
          }
        }
      } catch (error) {
        console.error(`[Socket断开] 用户 ${socket.username} (${socket.userId}) 断开处理失败:`, error);
        // 即使出错也继续执行，不影响其他逻辑
      }
    });
  });

  // 启动 PK 结算流消费者（MongoDB、任务进度、平台池由 stream 统一处理）
  startPkSettlementConsumer();

  // 启动挖矿循环（每秒钟）
  setInterval(async () => {
    try {
      // 获取能量产出配置
      const energyPerSecondConfig = await db.query(
        'SELECT config_value FROM game_config WHERE config_key = ?',
        ['energy_per_second']
      );
      const energyPerSecondValue = energyPerSecondConfig.length > 0 && energyPerSecondConfig[0].config_value !== undefined
        ? parseInt(energyPerSecondConfig[0].config_value, 10)
        : 5;
      // 修复：如果配置值为0，应该使用0，而不是默认值5
      const energyPerSecond = isNaN(energyPerSecondValue) ? 5 : energyPerSecondValue;

      // 获取所有占据节点的用户
      const nodes = await db.query(
        'SELECT DISTINCT owner_id FROM game_nodes WHERE owner_id IS NOT NULL'
      );
      
      for (const node of nodes) {
        const userId = node.owner_id;
        
        // 使用事务确保SELECT和UPDATE的一致性，避免连接池导致的数据不一致问题
        await db.transaction(async (conn) => {
          // 1. SELECT查询（在同一事务中）
          const [users] = await conn.query('SELECT stamina, energy FROM users WHERE id = ?', [userId]);
          if (users.length === 0) return;
          
          const user = users[0];
          
          // 2. 解析energy值，添加日志
          let currentEnergy = user.energy != null ? Number(user.energy) : 0;
          if (isNaN(currentEnergy)) {
            console.warn(`[挖矿] 用户${userId} energy值无效: ${user.energy}`);
            currentEnergy = 0;
          }
          currentEnergy = Math.max(0, currentEnergy); // 只确保>=0，不限制上限
          
          // 安全地转换数据库返回的体力值
          let currentStamina = user.stamina != null ? Number(user.stamina) : 0;
          if (isNaN(currentStamina)) currentStamina = 0;
          currentStamina = Math.max(0, Math.min(100, currentStamina)); // 体力上限100
          
          // 3. 检查体力和能量
          if (currentStamina <= 0) {
            // 体力为0，不发送player_update（能量没有变化）
            return;
          }
          
          if (currentEnergy >= 100) {
            // 能量已满，不发送player_update（能量没有变化）
            return;
          }
          
          // 4. 计算新值
          const energyGain = energyPerSecond; // 使用配置的每秒能量产出
          const newEnergy = Math.min(100, currentEnergy + energyGain);
          
          // 如果本次更新后能量会达到100，则不消耗体力
          // 这是关键：能量满100时，体力不应该损耗
          let newStamina = currentStamina;
          if (newEnergy < 100) {
            // 只有当能量不足100时，才消耗体力
            const staminaLoss = 1; // 每秒1点体力
            newStamina = Math.max(0, currentStamina - staminaLoss);
          }
          // 如果newEnergy >= 100，newStamina保持原值，不消耗体力
          
          // 5. UPDATE（在同一事务中）
          await conn.query(
            'UPDATE users SET energy = ?, stamina = ?, total_energy = total_energy + ? WHERE id = ?',
            [newEnergy, newStamina, energyGain, userId]
          );
          
          // 6. 发送player_update（使用计算值，确保一致性）
          broadcastToUser(parseInt(userId), 'player_update', {
            energy: newEnergy,
            stamina: newStamina,
            canPK: newEnergy >= 100
          });

          // 7. 更新挖掘能量和能量达到100的任务进度
          await updateTaskProgress(parseInt(userId), 'mine_energy');
          if (newEnergy >= 100) {
            await updateTaskProgress(parseInt(userId), 'reach_energy');
          }
        });
      }
      
      // 处理虚拟智能体挖矿
      const virtualAgentScheduler = require('./services/virtual-agent-scheduler');
      await virtualAgentScheduler.virtualAgentMiningTask();
    } catch (error) {
      console.error('挖矿循环错误:', error);
    }
  }, 1000);

  // 体力恢复循环（每分钟）
  setInterval(async () => {
    try {
      // 从配置获取体力恢复速率
      const staminaRecoveryConfig = await db.query(
        'SELECT config_value FROM game_config WHERE config_key = ?',
        ['stamina_recovery_rate']
      );
      const staminaRecoveryConfigValue = staminaRecoveryConfig.length > 0 && staminaRecoveryConfig[0].config_value !== undefined
        ? parseInt(staminaRecoveryConfig[0].config_value, 10)
        : 1;
      // 修复：如果配置值为0，应该使用0，而不是默认的1
      const staminaRecoveryRate = isNaN(staminaRecoveryConfigValue) ? 1 : staminaRecoveryConfigValue;

      // 只有配置值 > 0 时才恢复体力
      if (staminaRecoveryRate > 0) {
        await db.query(
          'UPDATE users SET stamina = LEAST(100, stamina + ?) WHERE stamina < 100',
          [staminaRecoveryRate]
        );
      }
      
      // 处理虚拟智能体体力恢复
      const virtualAgentScheduler = require('./services/virtual-agent-scheduler');
      await virtualAgentScheduler.virtualAgentStaminaRecoveryTask(staminaRecoveryRate);
    } catch (error) {
      console.error('体力恢复循环错误:', error);
    }
  }, 60000);
  
  // 初始化虚拟智能体调度服务
  const virtualAgentScheduler = require('./services/virtual-agent-scheduler');
  virtualAgentScheduler.init();

  // PK挑战超时检查循环（每5秒）
  setInterval(async () => {
    try {
      const now = Date.now();
      // 从配置获取PK超时时间，默认15秒
      const timeoutConfig = await db.query(
        'SELECT config_value FROM game_config WHERE config_key = ?',
        ['pk_timeout']
      );
      const timeoutSeconds = parseInt(timeoutConfig[0]?.config_value, 10) || 15;
      const timeoutMs = timeoutSeconds * 1000;
      const virtualAgentSocket = require('./services/virtual-agent-socket');

      // 遍历挑战队列，检查是否超时
      for (const [challengeKey, challengeData] of challengeQueue.entries()) {
        const elapsed = now - challengeData.createdAt;

        // 如果超过超时时间，检查Redis中是否还存在挑战状态
        if (elapsed >= timeoutMs) {
          const redisState = await redis.get(challengeKey);

          // 如果Redis中还存在挑战状态，说明超时了
          if (redisState) {
            // 检查挑战者和防御者类型
            const attackerIsVirtual = virtualAgentSocket.isVirtualAgent(challengeData.attackerId);
            const defenderIsVirtual = virtualAgentSocket.isVirtualAgent(challengeData.defenderId);

            // 检查挑战者和防御者是否都在线
            const attackerOnline = attackerIsVirtual
              ? virtualAgentSocket.getVirtualAgentSocket(challengeData.attackerId) !== undefined
              : connectedUsers.has(challengeData.attackerId);
            const defenderOnline = defenderIsVirtual
              ? virtualAgentSocket.getVirtualAgentSocket(challengeData.defenderId) !== undefined
              : connectedUsers.has(challengeData.defenderId);

            // 只有当挑战者在线时，才执行超时处理
            if (attackerOnline) {
              if (attackerIsVirtual || defenderIsVirtual) {
                // 涉及虚拟智能体，使用虚拟智能体的拒绝处理
                await virtualAgentSocket.handleVirtualAgentPKRejection(
                  challengeData.attackerId,
                  challengeData.defenderId,
                  challengeData.roomId,
                  'timeout'
                );
              } else {
                // 双方都是真实用户，处理超时场景
                await handlePKTimeout(
                  challengeData.attackerId,
                  challengeData.defenderId,
                  challengeData.roomId
                );
              }
            } else {
              // 如果挑战者已离线，清理挑战状态
              await redis.del(challengeKey);
              challengeQueue.delete(challengeKey);
            }
          } else {
            // Redis中不存在，说明已经被处理了，从队列中删除
            challengeQueue.delete(challengeKey);
          }
        }
      }
    } catch (error) {
      console.error('PK挑战超时检查错误:', error);
    }
  }, 5000);

  // PK倒计时广播循环（每5秒）
  setInterval(async () => {
    try {
      // 从配置获取PK超时时间
      const timeoutConfig = await db.query(
        'SELECT config_value FROM game_config WHERE config_key = ?',
        ['pk_timeout']
      );
      const timeoutSeconds = parseInt(timeoutConfig[0]?.config_value, 10) || 15;
      const timeoutMs = timeoutSeconds * 1000;
      const now = Date.now();

      // 遍历挑战队列，发送倒计时
      for (const [challengeKey, challengeData] of challengeQueue.entries()) {
        const elapsed = now - challengeData.createdAt;
        const remainingMs = timeoutMs - elapsed;

        // 如果还在倒计时范围内（剩余5秒以上），发送倒计时
        if (remainingMs > 5000 && remainingMs <= timeoutMs) {
          const remainingSeconds = Math.ceil(remainingMs / 1000);
          const virtualAgentSocket = require('./services/virtual-agent-socket');

          // 向房间内相关玩家发送倒计时
          const roomId = challengeData.roomId;
          const attackerId = challengeData.attackerId;
          const defenderId = challengeData.defenderId;

          // 使用 broadcastToUser 发送倒计时
          broadcastToUser(attackerId, 'pk_countdown', {
            remainingSeconds,
            role: 'attacker'
          });
          broadcastToUser(defenderId, 'pk_countdown', {
            remainingSeconds,
            role: 'defender'
          });
        }
      }
    } catch (error) {
      console.error('PK倒计时广播错误:', error);
    }
  }, 5000);

  // PK状态定期清理（每30秒）- 清理过期的pk:userId和pk_settled数据
  setInterval(async () => {
    try {
      const now = Date.now();
      const CLEANUP_INTERVAL = 60000; // 60秒以上的key视为过期

      // 清理过期的pk:userId数据
      const pkValueKeys = await redis.scan('pk:*', 100);
      for (const key of pkValueKeys) {
        const ttl = await redis.ttl(key);
        if (ttl === -1) { // -1 表示没有设置过期时间，手动检查
          const data = await redis.get(key);
          if (data && data.createdAt) {
            const age = now - new Date(data.createdAt).getTime();
            if (age > CLEANUP_INTERVAL) {
              await redis.del(key);
            }
          }
        }
      }

      // 清理pk_settled标记（这些有10秒TTL，但以防万一）
      const settledKeys = await redis.scan('pk_settled:*', 100);
      for (const key of settledKeys) {
        const ttl = await redis.ttl(key);
        if (ttl === -1) {
          await redis.del(key);
        }
      }

      // 清理过期或孤立的pk_challenge
      const challengeKeys = await redis.scan('pk_challenge:*', 100);
      for (const key of challengeKeys) {
        const data = await redis.get(key);
        if (!data) {
          // Redis中不存在但可能在内存队列中，清理内存队列
          challengeQueue.delete(key);
        }
      }
    } catch (error) {
      console.error('PK状态清理错误:', error);
    }
  }, 30000);

  // 平台池更新广播（每10秒）- 使用calculatePlatformPool计算
  setInterval(async () => {
    try {
      const rooms = await db.query('SELECT id FROM game_rooms WHERE status IN (?, ?)', ['waiting', 'playing']);
      for (const room of rooms) {
        // 使用calculatePlatformPool计算：剩余能量宝藏 + PK平局累计增加
        const platformPool = await calculatePlatformPool(room.id);
        // 获取宝藏配置信息
        const treasureConfig = await getTreasureConfig(room.id);
        const treasureInfo = {
          configured: treasureConfig.length > 0,
          nodeCount: treasureConfig.length,
          totalAmount: treasureConfig.reduce((sum, t) => sum + (parseInt(t.amount, 10) || 0), 0)
        };
        io.to(`room_${room.id}`).emit('game_state', {
          type: 'platform_pool_update',
          platformPool,
          treasureInfo
        });
      }
    } catch (error) {
      console.error('平台池更新广播错误:', error);
    }
  }, 10000);
}

/**
 * 获取能量宝藏配置（兼容全局配置和房间配置）
 * @param {number} roomId - 房间ID（可选，不传则获取全局配置）
 * @returns {Promise<Array<{nodeId: number, amount: number}>>}
 */
async function getTreasureConfig(roomId) {
  try {
    // 如果有房间ID且大于1，优先获取房间宝藏配置
    if (roomId && roomId > 1) {
      const roomTreasures = await db.query(
        'SELECT node_id as nodeId, amount FROM room_treasures WHERE room_id = ? AND is_claimed = 0',
        [roomId]
      );
      if (roomTreasures.length > 0) {
        return roomTreasures;
      }
    }
    
    // 否则获取全局宝藏配置
    const rows = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      ['energy_treasure']
    );
    if (rows.length === 0 || !rows[0].config_value) return [];
    const arr = JSON.parse(rows[0].config_value);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * 计算平台池显示金额
 * 平台池 = 能量宝藏配置总额 - 已领取金额 + PK平局累计增加
 * @param {number} roomId 房间ID
 * @returns {Promise<number>} 平台池金额
 */
async function calculatePlatformPool(roomId) {
  try {
    // 从 game_rooms 表获取能量宝藏相关字段和 PK 平局累计
    const roomRows = await db.query(
      'SELECT platform_pool, energy_treasure_total, energy_treasure_claimed FROM game_rooms WHERE id = ?',
      [roomId]
    );

    const pkBonusTotal = roomRows.length > 0 && roomRows[0].platform_pool != null
      ? parseInt(roomRows[0].platform_pool, 10) || 0
      : 0;

    const treasureTotal = roomRows.length > 0 && roomRows[0].energy_treasure_total != null
      ? parseInt(roomRows[0].energy_treasure_total, 10) || 0
      : 0;

    const treasureClaimed = roomRows.length > 0 && roomRows[0].energy_treasure_claimed != null
      ? parseInt(roomRows[0].energy_treasure_claimed, 10) || 0
      : 0;

    // 平台池 = 配置总额 - 已领取 + PK平局累计
    const platformPool = treasureTotal - treasureClaimed + pkBonusTotal;
    return Math.max(0, platformPool);
  } catch (error) {
    console.error('calculatePlatformPool 计算失败:', error);
    return 0;
  }
}

/**
 * 获取房间内「已在该房间占据节点」的真人列表（可挑战列表），与 sendGameState 中 players 语义一致
 * @param {number} roomId
 * @returns {Promise<Array<{id: number, username: string, energy: number, stamina: number}>>}
 */
async function getPlayersWithNodesInRoom(roomId) {
  try {
    const room = io && io.sockets.adapter.rooms.get(`room_${roomId}`);
    if (!room || room.size === 0) return [];
    const memberIds = [];
    for (const socketId of room) {
      const s = io.sockets.sockets.get(socketId);
      if (s && s.userId != null) memberIds.push(Number(s.userId));
    }
    if (memberIds.length === 0) return [];
    const placeholders = memberIds.map(() => '?').join(',');
    const rows = await db.query(
      `SELECT DISTINCT g.owner_id FROM game_nodes g 
       WHERE g.room_id = ? AND g.owner_id IS NOT NULL AND g.owner_id IN (${placeholders})`,
      [roomId, ...memberIds]
    );
    const ownerIds = rows.map(r => r.owner_id).filter(Boolean);
    if (ownerIds.length === 0) return [];
    const ph = ownerIds.map(() => '?').join(',');
    const users = await db.query(
      `SELECT id, username, energy, stamina, avatar_image FROM users WHERE id IN (${ph})`,
      ownerIds
    );
    return users.map(u => ({
      id: u.id,
      username: u.username,
      energy: u.energy,
      stamina: u.stamina,
      avatarImage: u.avatar_image || null
    }));
  } catch (err) {
    console.error('getPlayersWithNodesInRoom 失败:', err);
    return [];
  }
}

/**
 * 向 socket 发送房间完整状态（节点、玩家、平台池、宝藏节点）
 * @param {import('socket.io').Socket} socket
 * @param {number} roomId
 */
async function sendGameState(socket, roomId) {
  try {
    // 获取所有节点（包括被占据和空节点）- 总是返回100个节点
    const allNodes = await db.query(
      'SELECT node_id, owner_id FROM game_nodes WHERE room_id = ?',
      [roomId]
    );

    // 如果节点少于100个，记录警告但不自动初始化（应由创建房间时初始化）
    if (allNodes.length < 100) {
      console.warn(`[sendGameState] 警告：房间${roomId}只有${allNodes.length}个节点，数据不完整`);
    }

    // 获取虚拟智能体节点
    const virtualAgentNodes = await db.query(
      `SELECT current_node_id as node_id, id as agent_id, name as agent_name 
       FROM virtual_ai_agents 
       WHERE room_id = ? AND status = 'online' AND current_node_id IS NOT NULL`,
      [roomId]
    );

    // 创建节点映射，先填充真人节点，再合并虚拟智能体（避免覆盖）
    const nodeMap = new Map();
    
    // 先填充真人节点
    allNodes.forEach(n => {
      if (n.owner_id) {  // 只填充有主人的节点
        nodeMap.set(n.node_id, {
          nodeId: n.node_id,
          ownerId: n.owner_id,
          ownerType: 'user'
        });
      }
    });
    
    // 再合并虚拟智能体节点（仅当该节点没有被真人占据时）
    virtualAgentNodes.forEach(n => {
      if (!nodeMap.has(n.node_id)) {  // 只添加未被真人占据的节点
        nodeMap.set(n.node_id, {
          nodeId: n.node_id,
          ownerId: -n.agent_id, // 负数ID标识虚拟智能体
          ownerName: n.agent_name,
          ownerType: 'virtual_agent'
        });
      }
    });
    
    // 转换为数组，确保总是返回100个节点
    const nodes = [];
    for (let i = 1; i <= 100; i++) {
      nodes.push(nodeMap.get(i) || { nodeId: i, ownerId: null, ownerType: null });
    }

    // 可挑战玩家列表：仅包含房间内且在该房间已占据节点的真人
    const players = await getPlayersWithNodesInRoom(roomId);

    // 获取平台池数值（使用calculatePlatformPool计算：剩余能量宝藏 + PK平局累计）
    const platformPool = await calculatePlatformPool(roomId);

    // 已中奖节点（仅最近1小时内领取的展示金色，带领取时间供前端到期隐藏）
    const claimedRows = await db.query(
      `SELECT node_id, MAX(created_at) AS created_at FROM treasure_claims
       WHERE room_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
       GROUP BY node_id`,
      [roomId]
    );
    const claimedTreasureNodes = claimedRows.map(r => ({
      nodeId: r.node_id,
      claimedAt: new Date(r.created_at).toISOString()
    }));

    // 获取宝藏配置详情（用于前端显示配置是否生效）
    const treasureConfig = await getTreasureConfig(roomId);
    const treasureTotalAmount = treasureConfig.reduce((sum, t) => sum + (parseInt(t.amount, 10) || 0), 0);
    const treasureInfo = {
      configured: treasureConfig.length > 0,
      nodeCount: treasureConfig.length,
      totalAmount: treasureTotalAmount
    };

    // 获取当前用户信息（包含头像）
    const currentUserRows = await db.query(
      'SELECT id, username, avatar_image FROM users WHERE id = ?',
      [socket.userId]
    );
    const currentUser = currentUserRows.length > 0 ? {
      id: currentUserRows[0].id,
      username: currentUserRows[0].username,
      avatarImage: currentUserRows[0].avatar_image || null
    } : null;

    socket.emit('game_state', {
      type: 'full_state',
      roomId: roomId,  // 添加房间ID，方便前端同步状态
      currentUser: currentUser,  // 当前用户信息（包含头像）
      nodes: nodes.map(n => ({
        nodeId: n.nodeId,
        ownerId: n.ownerId,
        ownerName: n.ownerName || null,
        ownerType: n.ownerType || null
      })),
      players,
      platformPool,
      claimedTreasureNodes,
      treasureInfo
    });
  } catch (error) {
    console.error('发送游戏状态失败:', error);
  }
}

/**
 * 更新房间在线人数并广播 player_count_update
 * @param {number} roomId
 */
async function updateRoomPlayers(roomId) {
  try {
    const room = io.sockets.adapter.rooms.get(`room_${roomId}`);
    const playerCount = room ? room.size : 0;
    
    await db.query(
      'UPDATE game_rooms SET current_players = ? WHERE id = ?',
      [playerCount, roomId]
    );

    io.to(`room_${roomId}`).emit('game_state', {
      type: 'player_count_update',
      playerCount
    });
  } catch (error) {
    console.error('更新房间人数失败:', error);
  }
}

function getConnectedUsers() {
  return connectedUsers;
}

/**
 * 按用户清理待处理 PK 挑战（仅删 Redis 与 challengeQueue，不判负、不发送 pk_result）
 * 登出/断开时调用，避免重登后超时轮询对残留挑战执行判负导致用户误收对战结果
 * @param {number|string} userId - 用户 ID
 */
async function clearChallengesForUser(userId) {
  if (userId == null) return;
  const uid = Number(userId);
  const toDelete = [];
  for (const [challengeKey, challengeData] of challengeQueue.entries()) {
    const defId = challengeData.defenderId != null ? Number(challengeData.defenderId) : challengeData.defenderId;
    const atkId = challengeData.attackerId != null ? Number(challengeData.attackerId) : challengeData.attackerId;
    if (defId === uid || atkId === uid || challengeData.defenderId === userId || challengeData.attackerId === userId) {
      toDelete.push(challengeKey);
    }
  }
  for (const key of toDelete) {
    try {
      await redis.del(key);
    } catch (e) {
      console.error('[clearChallengesForUser] redis.del error:', e);
    }
    challengeQueue.delete(key);
  }
}

/**
 * 将挑战加入内存队列，供超时轮询使用（如虚拟智能体向真人发起挑战后需注册，以便 30 秒超时判负）
 * @param {string} challengeKey - Redis 键，如 pk_challenge:defenderId:attackerId
 * @param {object} challengeData - 含 attackerId, defenderId, roomId, attackerType?, defenderType? 等
 */
function addChallengeToQueue(challengeKey, challengeData) {
  challengeQueue.set(challengeKey, { ...challengeData, createdAt: Date.now() });
}

const PK_SETTLEMENT_STREAM = 'pk:settlement';
let lastPkSettlementId = '0';

/**
 * 消费 pk:settlement 流：执行 MongoDB 对战日志、任务进度、平台池（平局）更新
 * 与 resolve_pk 请求路径解耦，防止对战响应阻塞，保证响应实时、数据由 stream 统一处理
 */
async function consumePkSettlement() {
  const messages = await redis.xRead(PK_SETTLEMENT_STREAM, lastPkSettlementId, 20);
  for (const msg of messages) {
    lastPkSettlementId = msg.id;
    const d = msg.data;
    if (!d || !d.actualAttackerId || !d.actualDefenderId) continue;

    const isTimeout = d.reason === 'timeout';
    const isTimeoutNoParams = d.isTimeoutNoParams === true;

    try {
      await updateTaskProgress(d.actualAttackerId, 'complete_pk');
      await updateTaskProgress(d.actualDefenderId, 'complete_pk');
      const attackerRows = await db.query('SELECT username FROM users WHERE id = ?', [d.actualAttackerId]);
      const defenderRows = await db.query('SELECT username FROM users WHERE id = ?', [d.actualDefenderId]);
      const attackerName = attackerRows.length ? attackerRows[0].username : 'Unknown';
      const defenderName = defenderRows.length ? defenderRows[0].username : 'Unknown';
      const defenderEnergyChange = d.defenderResult === 'win' ? 50 : (d.defenderResult === 'lose' ? -50 : -50);
      const attackerAttackDist = Math.abs((d.attackerAssassin || 0) - (d.defenderKing || 0));
      const defenderAttackDist = Math.abs((d.defenderAssassin || 0) - (d.attackerKing || 0));
      const createdAt = new Date();

      // 根据是否超时场景决定type
      const logType = isTimeout ? 'timeout' : 'normal';

      await mongo.insertBattleLog({
        attackerId: d.actualAttackerId,
        defenderId: d.actualDefenderId,
        attackerName,
        defenderName,
        type: logType,
        attackerKing: d.attackerKing,
        attackerAssassin: d.attackerAssassin,
        defenderKing: d.defenderKing,
        defenderAssassin: d.defenderAssassin,
        attackerAttackDist: isTimeout ? null : attackerAttackDist,
        defenderAttackDist: isTimeout ? null : defenderAttackDist,
        result: d.result,
        attackerEnergyChange: d.energyChange,
        defenderEnergyChange,
        roomId: d.roomId,
        createdAt
      });
      try {
        // 判断是否显示"未设置参数"的标记
        const battleType = isTimeout ? (isTimeoutNoParams ? 'timeout_no_params' : 'timeout') : 'normal';

        await mongo.insertUserGameRecord({
          userId: d.actualAttackerId,
          recordType: 'battle',
          type: battleType,
          myResult: d.result,
          opponentName: defenderName,
          myEnergyChange: d.energyChange,
          opponentEnergyChange: defenderEnergyChange,
          myKing: d.attackerKing,
          myAssassin: d.attackerAssassin,
          opponentKing: d.defenderKing,
          opponentAssassin: d.defenderAssassin,
          myAttackDist: isTimeout ? null : attackerAttackDist,
          opponentAttackDist: isTimeout ? null : defenderAttackDist,
          roomId: d.roomId,
          createdAt
        });
        await mongo.insertUserGameRecord({
          userId: d.actualDefenderId,
          recordType: 'battle',
          type: battleType,
          myResult: d.defenderResult,
          opponentName: attackerName,
          myEnergyChange: defenderEnergyChange,
          opponentEnergyChange: d.energyChange,
          myKing: d.defenderKing,
          myAssassin: d.defenderAssassin,
          opponentKing: d.attackerKing,
          opponentAssassin: d.attackerAssassin,
          myAttackDist: isTimeout ? null : defenderAttackDist,
          opponentAttackDist: isTimeout ? null : attackerAttackDist,
          roomId: d.roomId,
          createdAt
        });
      } catch (ugrErr) {
        console.error('MongoDB user_game_records (PK) 写入失败:', ugrErr);
      }
      if (d.result === 'draw') {
        const configs = await db.query(
          'SELECT config_value FROM game_config WHERE config_key = ?',
          ['platform_pool_bonus']
        );
        const bonus = configs.length > 0 ? parseInt(configs[0].config_value, 10) : 100;
        await db.query(
          'UPDATE game_rooms SET platform_pool = platform_pool + ? WHERE id = ?',
          [bonus, d.roomId]
        );
        // 使用calculatePlatformPool计算新平台池值（剩余能量宝藏 + PK平局累计）
        const newPlatformPool = await calculatePlatformPool(d.roomId);
        // 获取宝藏配置信息
        const treasureConfig = await getTreasureConfig(d.roomId);
        const treasureInfo = {
          configured: treasureConfig.length > 0,
          nodeCount: treasureConfig.length,
          totalAmount: treasureConfig.reduce((sum, t) => sum + (parseInt(t.amount, 10) || 0), 0)
        };
        if (io) {
          io.to(`room_${d.roomId}`).emit('game_state', {
            type: 'platform_pool_update',
            platformPool: newPlatformPool,
            treasureInfo
          });
        }
      }
      // 所有数据库与消息队列处理完毕，通知双方前端展示最终结算结果
      broadcastToUser(d.actualAttackerId, 'pk_settlement_complete', { roomId: d.roomId });
      broadcastToUser(d.actualDefenderId, 'pk_settlement_complete', { roomId: d.roomId });
    } catch (err) {
      console.error('PK settlement consumer 处理失败:', err);
    }
  }
}

/**
 * 启动 PK 结算流消费者（轮询 pk:settlement）
 */
function startPkSettlementConsumer() {
  setInterval(async () => {
    try {
      await consumePkSettlement();
    } catch (e) {
      console.error('PK settlement consumer 轮询异常:', e);
    }
  }, 200);
}

/**
 * 向指定用户的所有连接发送消息
 * @param {number|string} userId - 用户ID
 * @param {string} event - 事件名称
 * @param {object} data - 发送的数据
 */
function broadcastToUser(userId, event, data) {
  // 兼容 userId 类型：尝试 number、string 和原始值
  let socketIds = connectedUsers.get(userId)
    ?? connectedUsers.get(Number(userId))
    ?? connectedUsers.get(String(userId));

  if (!socketIds || socketIds.size === 0) return;

  for (const socketId of socketIds) {
    io.to(socketId).emit(event, data);
  }
}

module.exports = {
  init,
  getIO: () => io,
  getAgentChatIO: () => io.of('/agent-chat'),
  getPlazaIO: () => io.of('/plaza'),
  getEnergyTradeIO: () => io.of('/energy-trade'),
  releaseUserNodes,
  updateTaskProgress,
  getConnectedUsers,
  addChallengeToQueue,
  clearChallengesForUser,
  calculatePlatformPool,
  getTreasureConfig
};
