/**
 * @file free-pk.js
 * @module services/free-pk
 * @description 自由PK团逻辑服务
 */
const mongo = require('../utils/mongo');
const db = require('../utils/db');
const redis = require('../utils/redis');
const socketServer = require('../socket');

// Redis Key 常量
const LEADERBOARD_KEYS = {
  FORTUNE_ZS: 'leaderboard:fortune:zs',
  CONTRIBUTION_ZS: 'leaderboard:contribution:zs'
};

/**
 * 计算有效攻击距离（与游戏PK一致）
 * @param {number} king - 攻击值
 * @param {number} assassin - 防御值
 * @returns {number} 有效距离（越小越强）
 */
function calculateAttackDistance(king, assassin) {
  return Math.abs(100 - king - assassin);
}

/**
 * 计算PK结果
 * @param {number} attackerKing
 * @param {number} attackerAssassin
 * @param {number} defenderKing
 * @param {number} defenderAssassin
 * @returns {string} 'attacker_win' | 'defender_win' | 'draw'
 */
function calculatePKResult(attackerKing, attackerAssassin, defenderKing, defenderAssassin) {
  const attackerDistance = calculateAttackDistance(attackerKing, attackerAssassin);
  const defenderDistance = calculateAttackDistance(defenderKing, defenderAssassin);

  if (attackerDistance < defenderDistance) return 'attacker_win';
  if (attackerDistance > defenderDistance) return 'defender_win';
  return 'draw';
}

/**
 * 开始自由PK团
 * @param {string} groupId - PK团ID
 */
async function startPKGroup(groupId) {
  // 获取PK团信息
  const group = await mongo.getFreePKGroup(groupId);
  if (!group || group.status !== 'waiting') {
    throw new Error('PK团不存在或已开始');
  }

  // 获取所有参与者
  const participants = await mongo.getFreePKParticipants(groupId);
  if (participants.length < 2) {
    throw new Error('参与人数不足');
  }

  // 更新PK团状态
  await mongo.updateFreePKGroup(groupId, {
    status: 'ongoing'
  });

  // 执行淘汰赛
  const pkResults = await runTournament(groupId, participants, group.energyCost);

  // 结算奖励
  await settleRewards(groupId, group, participants, pkResults);

  // 更新PK团状态为完成
  const winner = participants.find(p => p.userId === pkResults.winnerId);
  await mongo.updateFreePKGroup(groupId, {
    status: 'completed',
    completedAt: new Date(),
    winnerId: pkResults.winnerId,
    winnerUsername: winner?.username,
    totalPrize: group.energyCost * participants.length,
    pkResults: pkResults.rounds
  });
}

/**
 * 执行淘汰赛
 * @param {string} groupId
 * @param {Array} participants
 * @param {number} energyCost
 * @returns {Object} { winnerId, rounds }
 */
async function runTournament(groupId, participants, energyCost) {
  let round = 1;
  let pkResults = [];
  let remaining = [...participants];

  // 淘汰赛循环
  while (remaining.length > 1) {
    const nextRound = [];
    const winners = [];

    // 两两对战
    for (let i = 0; i < remaining.length; i += 2) {
      if (i + 1 >= remaining.length) {
        // 奇数，最后一个直接晋级
        nextRound.push(remaining[i]);
        continue;
      }

      const p1 = remaining[i];
      const p2 = remaining[i + 1];

      const result = calculatePKResult(p1.king, p1.assassin, p2.king, p2.assassin);

      let winner, loser;
      if (result === 'attacker_win') {
        winner = p1;
        loser = p2;
      } else if (result === 'defender_win') {
        winner = p2;
        loser = p1;
      } else {
        // 平局，先手获胜
        winner = p1;
        loser = p2;
      }

      // 记录PK结果
      pkResults.push({
        round,
        attackerId: p1.userId,
        attackerUsername: p1.username,
        defenderId: p2.userId,
        defenderUsername: p2.username,
        attackerKing: p1.king,
        attackerAssassin: p1.assassin,
        defenderKing: p2.king,
        defenderAssassin: p2.assassin,
        result,
        winnerId: winner.userId,
        winnerUsername: winner.username,
        createdAt: new Date()
      });

      // 更新参与者状态
      await mongo.updateFreePKParticipant(winner._id.toString(), { status: 'pk_win' });
      await mongo.updateFreePKParticipant(loser._id.toString(), { status: 'pk_lose' });

      winners.push(winner);
      nextRound.push(winner);
    }

    remaining = winners;
    round++;
  }

  // 最后一个获胜者
  const finalWinner = remaining[0];
  await mongo.updateFreePKParticipant(finalWinner._id.toString(), { status: 'winner' });

  return {
    winnerId: finalWinner.userId,
    rounds: pkResults
  };
}

/**
 * 结算奖励
 * @param {string} groupId
 * @param {Object} group
 * @param {Array} participants
 * @param {Object} pkResults
 */
async function settleRewards(groupId, group, participants, pkResults) {
  const totalPrize = group.energyCost * participants.length;
  const winner = participants.find(p => p.userId === pkResults.winnerId);

  // 使用事务进行结算
  await db.transaction(async (conn) => {
    // 1. 获胜者获得所有能量和福力值
    await conn.execute(
      'UPDATE users SET energy = energy + ? WHERE id = ?',
      [totalPrize, pkResults.winnerId]
    );

    // 2. 更新所有参与者的状态和结算结果
    for (const p of participants) {
      if (p.userId === pkResults.winnerId) {
        // 获胜者
        await mongo.updateFreePKParticipant(p._id.toString(), {
          status: 'winner',
          energyChange: totalPrize,
          fortuneChange: totalPrize,
          contributionChange: 0
        });

        // 记录到battle_logs
        await mongo.insertBattleLog({
          recordType: 'battle',
          type: 'free_pk',
          groupId: group._id,
          postId: group.postId,
          attackerId: 0,
          attackerUsername: 'System',
          defenderId: p.userId,
          defenderUsername: p.username,
          attackerKing: 0,
          attackerAssassin: 0,
          defenderKing: p.king,
          defenderAssassin: p.assassin,
          result: 'winner',
          winnerId: p.userId,
          winnerUsername: p.username,
          attackerEnergyChange: 0,
          defenderEnergyChange: totalPrize,
          attackerFortuneChange: 0,
          defenderFortuneChange: totalPrize,
          attackerContributionChange: 0,
          defenderContributionChange: 0
        });

        // 记录到user_game_records
        await mongo.insertUserGameRecord({
          userId: p.userId,
          recordType: 'free_pk_reward',
          type: 'winner',
          groupId: group._id,
          postId: group.postId,
          energyChange: totalPrize,
          fortuneChange: totalPrize,
          contributionChange: 0
        });
      } else {
        // 淘汰者
        await mongo.updateFreePKParticipant(p._id.toString(), {
          status: 'eliminated',
          energyChange: -group.energyCost,
          fortuneChange: 0,
          contributionChange: group.energyCost
        });

        // 记录到battle_logs
        await mongo.insertBattleLog({
          recordType: 'battle',
          type: 'free_pk',
          groupId: group._id,
          postId: group.postId,
          attackerId: pkResults.winnerId,
          attackerUsername: winner.username,
          defenderId: p.userId,
          defenderUsername: p.username,
          attackerKing: winner.king,
          attackerAssassin: winner.assassin,
          defenderKing: p.king,
          defenderAssassin: p.assassin,
          result: 'loser',
          winnerId: pkResults.winnerId,
          winnerUsername: winner.username,
          attackerEnergyChange: 0,
          defenderEnergyChange: -group.energyCost,
          attackerFortuneChange: 0,
          defenderFortuneChange: 0,
          attackerContributionChange: 0,
          defenderContributionChange: group.energyCost
        });

        // 记录到user_game_records
        await mongo.insertUserGameRecord({
          userId: p.userId,
          recordType: 'free_pk_reward',
          type: 'loser',
          groupId: group._id,
          postId: group.postId,
          energyChange: -group.energyCost,
          fortuneChange: 0,
          contributionChange: group.energyCost
        });
      }
    }
  });

  // 更新Redis排行榜
  try {
    // 获胜者增加福力值
    await redis.zIncrBy(LEADERBOARD_KEYS.FORTUNE_ZS, totalPrize, pkResults.winnerId.toString());

    // 淘汰者增加贡献值
    for (const p of participants) {
      if (p.userId !== pkResults.winnerId) {
        await redis.zIncrBy(LEADERBOARD_KEYS.CONTRIBUTION_ZS, group.energyCost, p.userId.toString());
      }
    }
  } catch (err) {
    console.error('更新排行榜失败:', err);
  }
}

/**
 * 检查并处理过期的PK团
 */
async function checkExpiredGroups() {
  try {
    const groupsColl = await mongo.getPlazaFreePKGroupsCollection();
    const expiredGroups = await groupsColl.find({
      status: 'waiting',
      expiredAt: { $lt: new Date() }
    }).toArray();

    for (const group of expiredGroups) {
      await mongo.updateFreePKGroup(group._id.toString(), { status: 'expired' });
      // 广播过期通知
      broadcastGroupExpire(group._id.toString());
    }

    console.log(`[FreePK] 检查过期PK团，完成${expiredGroups.length}个`);
  } catch (err) {
    console.error('检查过期PK团失败:', err);
  }
}

/**
 * 广播PK团过期通知
 * @param {string} groupId - PK团ID
 */
function broadcastGroupExpire(groupId) {
  try {
    const plazaIO = socketServer.getPlazaIO();
    if (plazaIO) {
      plazaIO.emit('free_pk_update', {
        groupId: groupId,
        status: 'expired',
        message: 'PK团已过期',
        timestamp: Date.now()
      });
    }
  } catch (err) {
    console.error('广播PK团过期通知失败:', err);
  }
}

module.exports = {
  startPKGroup,
  calculateAttackDistance,
  calculatePKResult,
  checkExpiredGroups
};
