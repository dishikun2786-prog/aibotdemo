/**
 * @file virtual-agent-socket.js
 * @module services/virtual-agent-socket
 * @description 虚拟AI智能体Socket连接模拟服务：处理PK挑战和响应
 */
const db = require('../utils/db');
const redis = require('../utils/redis');
const { getIO, updateTaskProgress, getConnectedUsers, addChallengeToQueue, calculatePlatformPool } = require('../socket');
const mongo = require('../utils/mongo');
const { isDefenderInPendingChallenge, getCanPK } = require('../utils/pk-challenge-helper');

// 虚拟智能体Socket映射：agentId -> { roomId, socketId (虚拟) }
const virtualAgentSockets = new Map();

/**
 * 获取用户当前皮肤的 PK 攻防值（与 socket.js 中逻辑一致；虚拟智能体无皮肤返回 0）
 * @param {number} userId - 用户ID 或 虚拟智能体ID
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
    console.error('[虚拟智能体Socket] getSkinPkStats 失败:', err);
    return { pk_attack: 0, pk_defense: 0 };
  }
}

/**
 * 注册虚拟智能体Socket（当智能体上线时调用）
 */
function registerVirtualAgentSocket(agentId, roomId = 1) {
  const virtualSocketId = `virtual_agent_${agentId}`;
  virtualAgentSockets.set(agentId, {
    roomId,
    socketId: virtualSocketId,
    registeredAt: Date.now()
  });
  console.log(`[虚拟智能体Socket] 智能体 ${agentId} 已注册，房间: ${roomId}`);
}

/**
 * 注销虚拟智能体Socket（当智能体下线时调用）
 */
function unregisterVirtualAgentSocket(agentId) {
  virtualAgentSockets.delete(agentId);
  console.log(`[虚拟智能体Socket] 智能体 ${agentId} 已注销`);
}

/**
 * 检查是否为虚拟智能体
 */
function isVirtualAgent(id) {
  return virtualAgentSockets.has(id);
}

/**
 * 获取虚拟智能体Socket信息
 */
function getVirtualAgentSocket(agentId) {
  return virtualAgentSockets.get(agentId);
}

/**
 * 根据真人 userId 解析 socketId，兼容 number/string 类型（与 socket.js connectedUsers 一致）
 * @param {Map} connectedUsers - userId -> socketId
 * @param {number|string} userId - 用户 ID
 * @returns {string|undefined} socketId 或 undefined
 */
function getRealUserSocketId(connectedUsers, userId) {
  if (userId == null) return undefined;

  // 尝试获取用户的 socket 记录
  const socketRecord = connectedUsers.get(userId)
    ?? connectedUsers.get(Number(userId))
    ?? connectedUsers.get(String(userId));

  if (!socketRecord) return undefined;

  // 兼容旧版 single socketId 和新版 Set 结构
  if (socketRecord instanceof Set) {
    // 新版 Set 结构：返回第一个 socketId
    for (const socketId of socketRecord) {
      return socketId;
    }
    return undefined;
  } else {
    // 旧版 single socketId：直接返回
    return socketRecord;
  }
}

/**
 * 获取真实用户的所有 Socket ID（仅适用于新版 Set 结构）
 * @param {Map} connectedUsers - userId -> socketId
 * @param {number|string} userId - 用户 ID
 * @returns {Set|undefined} socketId 的 Set 或 undefined
 */
function getRealUserSocketIds(connectedUsers, userId) {
  if (userId == null) return undefined;

  return connectedUsers.get(userId)
    ?? connectedUsers.get(Number(userId))
    ?? connectedUsers.get(String(userId));
}

/**
 * 虚拟智能体自动响应PK挑战
 */
async function handleVirtualAgentPKChallenge(agentId, attackerId, attackerName, attackerType, roomId) {
  try {
    // 获取智能体信息
    const agents = await db.query(
      'SELECT energy, name FROM virtual_ai_agents WHERE id = ?',
      [agentId]
    );
    
    if (agents.length === 0) {
      return { accepted: false, reason: '智能体不存在' };
    }
    
    const agent = agents[0];
    
    // 获取接受PK概率配置
    const configs = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      ['virtual_agent_accept_pk_probability']
    );
    const acceptProbability = parseFloat(configs[0]?.config_value || '0.7');
    
    // 基于概率和能量状态决定是否接受
    // 能量越高，接受概率越大
    const energyFactor = Math.min(agent.energy / 100, 1); // 0-1之间
    const finalProbability = acceptProbability * (0.5 + energyFactor * 0.5); // 基础概率 * (0.5-1.0)
    
    const shouldAccept = Math.random() < finalProbability;
    
    if (!shouldAccept) {
      // 拒绝PK
      return { accepted: false, reason: 'rejected' };
    }
    
    // 接受PK，自动设置PK数值
    const king = Math.floor(Math.random() * 100) + 1;
    const assassin = Math.floor(Math.random() * 100) + 1;
    
    // 存储PK数值到Redis
    await redis.set(`pk:${agentId}`, {
      king,
      assassin
    }, 300);
    
    console.log(`[虚拟智能体Socket] 智能体 ${agent.name} (ID: ${agentId}) 接受PK挑战，设置数值: King=${king}, Assassin=${assassin}`);
    
    return { 
      accepted: true, 
      king, 
      assassin,
      agentName: agent.name
    };
  } catch (error) {
    console.error(`[虚拟智能体Socket] 处理PK挑战失败:`, error);
    return { accepted: false, reason: 'error' };
  }
}

/**
 * 虚拟智能体发起PK挑战
 */
async function virtualAgentChallengePlayer(agentId, defenderId, defenderType, roomId = 1) {
  try {
    const agents = await db.query(
      'SELECT name, energy FROM virtual_ai_agents WHERE id = ?',
      [agentId]
    );
    
    if (agents.length === 0) {
      return { success: false, error: '智能体不存在' };
    }
    
    const agent = agents[0];
    
    // 检查能量是否足够
    if (agent.energy < 100) {
      return { success: false, error: '能量不足' };
    }

    // 防御者是真人时：仅当真人已占据节点才可被虚拟 AI 发起 PK
    if (defenderType === 'user') {
      const nodeRows = await db.query(
        'SELECT 1 FROM game_nodes WHERE room_id = ? AND owner_id = ? LIMIT 1',
        [roomId, defenderId]
      );
      if (!nodeRows || nodeRows.length === 0) {
        return { success: false, error: '目标玩家未占据节点' };
      }
    }

    if (await isDefenderInPendingChallenge(defenderId)) {
      const opts = {};
      if (defenderType === 'user') {
        const io = getIO();
        if (io) {
          const sockets = await io.fetchSockets();
          const defenderSocket = sockets.find(s => s.userId === defenderId);
          if (defenderSocket) opts.defenderSocketId = defenderSocket.id;
        }
      }
      await handleVirtualAgentPKRejection(agentId, defenderId, roomId, 'rejected', opts);
      return { success: true, message: '对方正在协议对决中，判我方胜' };
    }

    // 存储挑战状态到Redis
    const challengeKey = `pk_challenge:${defenderId}:${agentId}`;
    const challengeData = {
      attackerId: agentId,
      attackerType: 'virtual_agent',
      attackerName: agent.name,
      defenderId: defenderId,
      defenderType: defenderType,
      roomId: roomId,
      createdAt: new Date().toISOString()
    };
    await redis.set(challengeKey, challengeData, 30);
    
    // 如果防御者是虚拟智能体，自动处理
    if (defenderType === 'virtual_agent') {
      const response = await handleVirtualAgentPKChallenge(defenderId, agentId, agent.name, 'virtual_agent', roomId);
      
      if (response.accepted) {
        // 虚拟智能体接受了挑战，自动设置攻击者的PK数值
        const attackerKing = Math.floor(Math.random() * 100) + 1;
        const attackerAssassin = Math.floor(Math.random() * 100) + 1;
        await redis.set(`pk:${agentId}`, {
          king: attackerKing,
          assassin: attackerAssassin
        }, 300);
        
        // 自动结算PK
        setTimeout(async () => {
          await resolveVirtualAgentPK(agentId, defenderId, roomId, attackerKing, attackerAssassin, response.king, response.assassin, null);
        }, 1000); // 延迟1秒模拟思考时间
        
        return { success: true, message: 'PK挑战已接受，正在结算...' };
      } else {
        // 虚拟智能体拒绝了挑战
        await handleVirtualAgentPKRejection(agentId, defenderId, roomId, 'rejected');
        return { success: true, message: 'PK挑战被拒绝' };
      }
    } else {
      // 防御者是真实用户，发送挑战事件
      const io = getIO();
      if (io) {
        // 查找用户的Socket ID
        const sockets = await io.fetchSockets();
        const defenderSocket = sockets.find(s => s.userId === defenderId);
        
        if (defenderSocket) {
          io.to(defenderSocket.id).emit('pk_challenge', {
            attackerId: agentId,
            attackerName: agent.name,
            attackerType: 'virtual_agent',
            roomId
          });
          addChallengeToQueue(challengeKey, challengeData);
          return { success: true, message: 'PK挑战已发送' };
        } else {
          return { success: false, error: '目标玩家不在线' };
        }
      }
    }
    
    return { success: false, error: '无法发送挑战' };
  } catch (error) {
    console.error(`[虚拟智能体Socket] 发起PK挑战失败:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * 处理虚拟智能体PK拒绝/超时
 * @param {object} [options] - 可选，{ attackerSocketId, defenderSocketId } 请求方 socket 优先，多标签时保证发到发起操作的页签
 */
async function handleVirtualAgentPKRejection(attackerId, defenderId, roomId, reason, options = {}) {
  try {
    const challengeKey = `pk_challenge:${defenderId}:${attackerId}`;
    await redis.del(challengeKey);
    
    // 获取配置
    const configs = await db.query(
      'SELECT config_key, config_value FROM game_config WHERE config_key IN (?, ?)',
      ['pk_energy_reward', 'pk_energy_loss']
    );
    
    const configMap = {};
    configs.forEach(item => {
      configMap[item.config_key] = item.config_value;
    });
    
    const reward = parseInt(configMap.pk_energy_reward || '50', 10);
    const loss = parseInt(configMap.pk_energy_loss || '50', 10);
    
    // 判断攻击者和防御者类型：优先用 users 表判定真人，避免 users.id 与 virtual_ai_agents.id 同值时误判
    let attackerIsVirtual = true;
    let defenderIsVirtual = true;
    try {
      const userAttacker = await db.query('SELECT 1 FROM users WHERE id = ? LIMIT 1', [attackerId]);
      if (userAttacker.length > 0) {
        attackerIsVirtual = false;
      } else {
        attackerIsVirtual = virtualAgentSockets.has(attackerId);
        if (!attackerIsVirtual) {
          const attackerCheck = await db.query('SELECT 1 FROM virtual_ai_agents WHERE id = ? LIMIT 1', [attackerId]);
          attackerIsVirtual = attackerCheck.length > 0;
          if (attackerIsVirtual) {
            console.log(`[虚拟智能体Socket] 通过数据库查询确认攻击者 ${attackerId} 是虚拟AI智能体（拒绝/超时处理）`);
          }
        }
      }
    } catch (err) {
      console.error('[虚拟智能体Socket] 查询攻击者类型失败（拒绝/超时处理）:', err);
    }
    try {
      const userDefender = await db.query('SELECT 1 FROM users WHERE id = ? LIMIT 1', [defenderId]);
      if (userDefender.length > 0) {
        defenderIsVirtual = false;
      } else {
        defenderIsVirtual = virtualAgentSockets.has(defenderId);
        if (!defenderIsVirtual) {
          const defenderCheck = await db.query('SELECT 1 FROM virtual_ai_agents WHERE id = ? LIMIT 1', [defenderId]);
          defenderIsVirtual = defenderCheck.length > 0;
          if (defenderIsVirtual) {
            console.log(`[虚拟智能体Socket] 通过数据库查询确认防御者 ${defenderId} 是虚拟AI智能体（拒绝/超时处理）`);
          }
        }
      }
    } catch (err) {
      console.error('[虚拟智能体Socket] 查询防御者类型失败（拒绝/超时处理）:', err);
    }
    
    console.log(`[虚拟智能体Socket] 拒绝/超时处理类型判断: 攻击者${attackerId} ${attackerIsVirtual ? '是' : '不是'}虚拟AI智能体, 防御者${defenderId} ${defenderIsVirtual ? '是' : '不是'}虚拟AI智能体`);
    
    /** 真人攻击者胜时的计算能量（更新块内赋值），通知时优先使用，避免二次 SELECT 读到旧值 */
    let realAttackerNewEnergy = null;
    
    // 更新攻击者（胜）
    try {
      let attackerEnergyBefore = null;
      if (attackerIsVirtual) {
        const attackerBefore = await db.query('SELECT energy FROM virtual_ai_agents WHERE id = ?', [attackerId]);
        attackerEnergyBefore = attackerBefore.length > 0 ? (attackerBefore[0].energy != null ? Number(attackerBefore[0].energy) : 0) : 0;
        
        const updateResult = await db.query(
          'UPDATE virtual_ai_agents SET energy = GREATEST(0, energy + ?), wins = wins + 1 WHERE id = ?',
          [reward, attackerId]
        );
        
        const attackerAfter = await db.query('SELECT energy FROM virtual_ai_agents WHERE id = ?', [attackerId]);
        const attackerEnergyAfter = attackerAfter.length > 0 ? (attackerAfter[0].energy != null ? Number(attackerAfter[0].energy) : 0) : 0;
        
        console.log(`[虚拟智能体Socket] 攻击者(虚拟AI智能体)${attackerId}能量更新(拒绝/超时): ${attackerEnergyBefore} + ${reward} = ${attackerEnergyAfter}, affectedRows:${updateResult.affectedRows || 0}`);
        
        if (updateResult.affectedRows === 0) {
          console.warn(`[虚拟智能体Socket] 警告: 攻击者(虚拟AI智能体)${attackerId}能量更新失败（拒绝/超时），affectedRows为0`);
        }
      } else {
        const attackerBefore = await db.query('SELECT energy FROM users WHERE id = ?', [attackerId]);
        attackerEnergyBefore = attackerBefore.length > 0 ? (attackerBefore[0].energy != null ? Number(attackerBefore[0].energy) : 0) : 0;
        
        const updateResult = await db.query(
          'UPDATE users SET energy = GREATEST(0, energy + ?), total_energy = total_energy + ?, wins = wins + 1 WHERE id = ?',
          [reward, reward, attackerId]
        );
        
        const attackerAfter = await db.query('SELECT energy FROM users WHERE id = ?', [attackerId]);
        const attackerEnergyAfter = attackerAfter.length > 0 ? (attackerAfter[0].energy != null ? Number(attackerAfter[0].energy) : 0) : 0;
        
        console.log(`[虚拟智能体Socket] 攻击者(真人用户)${attackerId}能量更新(拒绝/超时): ${attackerEnergyBefore} + ${reward} = ${attackerEnergyAfter}, affectedRows:${updateResult.affectedRows || 0}`);
        
        if (updateResult.affectedRows === 0) {
          console.warn(`[虚拟智能体Socket] 警告: 攻击者(真人用户)${attackerId}能量更新失败（拒绝/超时），affectedRows为0`);
        }
        realAttackerNewEnergy = Math.max(0, attackerEnergyBefore + reward);
        
        // 更新真人用户的任务进度
        await updateTaskProgress(attackerId, 'complete_pk');
      }
    } catch (error) {
      console.error(`[虚拟智能体Socket] 更新攻击者${attackerId}能量失败（拒绝/超时）:`, error);
      throw error;
    }
    
    // 更新防御者（败）
    try {
      let defenderEnergyBefore = null;
      if (defenderIsVirtual) {
        const defenderBefore = await db.query('SELECT energy FROM virtual_ai_agents WHERE id = ?', [defenderId]);
        defenderEnergyBefore = defenderBefore.length > 0 ? (defenderBefore[0].energy != null ? Number(defenderBefore[0].energy) : 0) : 0;
        
        const updateResult = await db.query(
          'UPDATE virtual_ai_agents SET energy = GREATEST(0, energy - ?), losses = losses + 1 WHERE id = ?',
          [loss, defenderId]
        );
        
        const defenderAfter = await db.query('SELECT energy FROM virtual_ai_agents WHERE id = ?', [defenderId]);
        const defenderEnergyAfter = defenderAfter.length > 0 ? (defenderAfter[0].energy != null ? Number(defenderAfter[0].energy) : 0) : 0;
        
        console.log(`[虚拟智能体Socket] 防御者(虚拟AI智能体)${defenderId}能量更新(拒绝/超时): ${defenderEnergyBefore} - ${loss} = ${defenderEnergyAfter}, affectedRows:${updateResult.affectedRows || 0}`);
        
        if (updateResult.affectedRows === 0) {
          console.warn(`[虚拟智能体Socket] 警告: 防御者(虚拟AI智能体)${defenderId}能量更新失败（拒绝/超时），affectedRows为0`);
        }
      } else {
        const defenderBefore = await db.query('SELECT energy FROM users WHERE id = ?', [defenderId]);
        defenderEnergyBefore = defenderBefore.length > 0 ? (defenderBefore[0].energy != null ? Number(defenderBefore[0].energy) : 0) : 0;
        
        const updateResult = await db.query(
          'UPDATE users SET energy = GREATEST(0, energy - ?), losses = losses + 1 WHERE id = ?',
          [loss, defenderId]
        );
        
        const defenderAfter = await db.query('SELECT energy FROM users WHERE id = ?', [defenderId]);
        const defenderEnergyAfter = defenderAfter.length > 0 ? (defenderAfter[0].energy != null ? Number(defenderAfter[0].energy) : 0) : 0;
        
        console.log(`[虚拟智能体Socket] 防御者(真人用户)${defenderId}能量更新(拒绝/超时): ${defenderEnergyBefore} - ${loss} = ${defenderEnergyAfter}, affectedRows:${updateResult.affectedRows || 0}`);
        
        if (updateResult.affectedRows === 0) {
          console.warn(`[虚拟智能体Socket] 警告: 防御者(真人用户)${defenderId}能量更新失败（拒绝/超时），affectedRows为0`);
        }
        
        // 更新真人用户的任务进度
        await updateTaskProgress(defenderId, 'complete_pk');
      }
    } catch (error) {
      console.error(`[虚拟智能体Socket] 更新防御者${defenderId}能量失败（拒绝/超时）:`, error);
      throw error;
    }
    
    // 记录对战记录
    const attackerName = attackerIsVirtual 
      ? (await db.query('SELECT name FROM virtual_ai_agents WHERE id = ?', [attackerId]))[0]?.name || 'Unknown'
      : (await db.query('SELECT username FROM users WHERE id = ?', [attackerId]))[0]?.username || 'Unknown';
    
    const defenderName = defenderIsVirtual
      ? (await db.query('SELECT name FROM virtual_ai_agents WHERE id = ?', [defenderId]))[0]?.name || 'Unknown'
      : (await db.query('SELECT username FROM users WHERE id = ?', [defenderId]))[0]?.username || 'Unknown';
    
    await db.query(
      `INSERT INTO virtual_agent_battles 
       (attacker_id, attacker_type, attacker_name, defender_id, defender_type, defender_name, 
        result, attacker_energy_change, defender_energy_change, room_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [attackerId, attackerIsVirtual ? 'virtual_agent' : 'user', attackerName,
       defenderId, defenderIsVirtual ? 'virtual_agent' : 'user', defenderName,
       'rejected', reward, -loss, roomId]
    );
    
    // 写入MongoDB对战记录（与真实用户一致）
    try {
      const battleType = reason === 'rejected' ? 'rejected' : 'timeout';
      const createdAt = new Date();
      await mongo.insertBattleLog({
        attackerId: attackerId,
        defenderId: defenderId,
        attackerName: attackerName, // 直接使用名称，不添加标识
        defenderName: defenderName, // 直接使用名称，不添加标识
        type: battleType,
        result: 'win', // 攻击者胜（防御者拒绝/超时）
        attackerEnergyChange: reward,
        defenderEnergyChange: -loss,
        roomId: roomId,
        createdAt
      });
      try {
        await mongo.insertUserGameRecord({
          userId: attackerId,
          recordType: 'battle',
          type: battleType,
          myResult: 'win',
          opponentName: defenderName,
          myEnergyChange: reward,
          opponentEnergyChange: -loss,
          createdAt
        });
        await mongo.insertUserGameRecord({
          userId: defenderId,
          recordType: 'battle',
          type: battleType,
          myResult: 'lose',
          opponentName: attackerName,
          myEnergyChange: -loss,
          opponentEnergyChange: reward,
          createdAt
        });
      } catch (ugrErr) {
        console.error('[虚拟智能体Socket] MongoDB user_game_records (rejection/timeout) 写入失败:', ugrErr);
      }
    } catch (mongoErr) {
      console.error('[虚拟智能体Socket] MongoDB battle_logs (rejection/timeout) 写入失败:', mongoErr);
      // 不中断流程，MongoDB写入失败不影响PK结算
    }
    
    // 通知真实用户（如果有）；双路发送：options.attackerSocketId + getRealUserSocketId，提高送达率
    const io = getIO();
    const connectedUsers = getConnectedUsers();
    if (io) {
      if (!attackerIsVirtual) {
        const primarySocketId = options.attackerSocketId ?? getRealUserSocketId(connectedUsers, attackerId);
        const fallbackSocketId = getRealUserSocketId(connectedUsers, attackerId);
        const attackerSocketIds = [primarySocketId, fallbackSocketId].filter(Boolean);
        const uniqueAttackerSocketIds = [...new Set(attackerSocketIds)];
        console.log(`[虚拟智能体Socket] 拒绝/超时 攻击者(真人) attackerId=${attackerId}, primarySocketId=${primarySocketId}, fallbackSocketId=${fallbackSocketId}, 将发送至: ${uniqueAttackerSocketIds.join(',')}`);
        if (uniqueAttackerSocketIds.length > 0) {
          try {
            const attackerUser = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [attackerId]);
            const hasUserRow = attackerUser.length > 0;
            console.log(`[虚拟智能体Socket] 拒绝/超时 攻击者(真人) attackerId=${attackerId}, SELECT users 命中: ${hasUserRow}`);
            let energy = null;
            let stamina = null;
            let canPK = null;
            if (realAttackerNewEnergy != null) {
              energy = realAttackerNewEnergy;
              canPK = energy >= 100;
            }
            if (hasUserRow) {
              const user = attackerUser[0];
              if (energy == null) {
                energy = user.energy != null ? Number(user.energy) : 0;
                if (isNaN(energy)) energy = 0;
                energy = Math.max(0, energy);
                canPK = energy >= 100;
              }
              stamina = user.stamina != null ? Number(user.stamina) : 0;
              if (isNaN(stamina)) stamina = 0;
              stamina = Math.max(0, Math.min(100, stamina));
            }
            // 始终发送 pk_result（至少含 result/reason/energyChange），确保前端可兜底
            const pkResultPayload = {
              result: 'win',
              myAttackDist: null,
              enemyAttackDist: null,
              energyChange: reward,
              reason: reason
            };
            if (energy != null) {
              pkResultPayload.energy = energy;
              pkResultPayload.canPK = canPK;
            }
            for (const sid of uniqueAttackerSocketIds) {
              io.to(sid).emit('pk_result', pkResultPayload);
            }
            if (hasUserRow) {
              console.log(`[虚拟智能体Socket] 即将发送 player_update 给攻击者(真人) attackerId=${attackerId}, socketIds=[${uniqueAttackerSocketIds.join(',')}], energy=${energy}, stamina=${stamina}`);
              for (const sid of uniqueAttackerSocketIds) {
                io.to(sid).emit('player_update', {
                  energy: energy,
                  stamina: stamina,
                  canPK: canPK
                });
              }
              console.log(`[虚拟智能体Socket] 成功发送PK结果(拒绝/超时)和能量更新给攻击者(真人用户)${attackerId}, 能量:${energy}`);
            } else {
              console.warn(`[虚拟智能体Socket] 警告: 无法获取攻击者(真人用户)${attackerId}的用户数据，已仅发送 pk_result(energyChange) 兜底`);
            }
          } catch (error) {
            console.error(`[虚拟智能体Socket] 发送PK结果给攻击者(真人用户)${attackerId}失败（拒绝/超时）:`, error);
          }
        } else {
          console.warn(`[虚拟智能体Socket] 警告: 攻击者(真人用户)${attackerId}不在线，无法发送PK结果和能量更新（拒绝/超时）`);
        }
      }
      
      if (!defenderIsVirtual) {
        const defenderSocketId = options.defenderSocketId ?? getRealUserSocketId(connectedUsers, defenderId);
        if (defenderSocketId) {
          try {
            // 获取更新后的能量和体力数据
            const defenderUser = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [defenderId]);
            if (defenderUser.length > 0) {
              const user = defenderUser[0];
              let energy = user.energy != null ? Number(user.energy) : 0;
              if (isNaN(energy)) energy = 0;
              energy = Math.max(0, energy);
              
              let stamina = user.stamina != null ? Number(user.stamina) : 0;
              if (isNaN(stamina)) stamina = 0;
              stamina = Math.max(0, Math.min(100, stamina));
              const defenderCanPK = await getCanPK(defenderId, roomId, energy);
              io.to(defenderSocketId).emit('pk_result', {
                result: 'lose',
                myAttackDist: null,
                enemyAttackDist: null,
                energyChange: -loss,
                reason: reason,
                energy: energy,
                canPK: defenderCanPK
              });
              console.log(`[虚拟智能体Socket] 即将发送 player_update 给防御者(真人) defenderId=${defenderId}, defenderSocketId=${defenderSocketId}, energy=${energy}, stamina=${stamina}`);
              io.to(defenderSocketId).emit('player_update', {
                energy: energy,
                stamina: stamina,
                canPK: defenderCanPK
              });
              console.log(`[虚拟智能体Socket] 成功发送PK结果(拒绝/超时)和能量更新给防御者(真人用户)${defenderId}, SocketId:${defenderSocketId}, 能量:${energy}`);
            } else {
              console.warn(`[虚拟智能体Socket] 警告: 无法获取防御者(真人用户)${defenderId}的用户数据（拒绝/超时）`);
            }
          } catch (error) {
            console.error(`[虚拟智能体Socket] 发送PK结果给防御者(真人用户)${defenderId}失败（拒绝/超时）:`, error);
          }
        } else {
          console.warn(`[虚拟智能体Socket] 警告: 防御者(真人用户)${defenderId}不在线，无法发送PK结果和能量更新（拒绝/超时）`);
        }
      }
    }
    
    console.log(`[虚拟智能体Socket] PK拒绝/超时处理完成: 攻击者${attackerId}胜，防御者${defenderId}败`);
  } catch (error) {
    console.error('[虚拟智能体Socket] 处理PK拒绝失败:', error);
  }
}

/**
 * 结算虚拟智能体PK（双方都是虚拟智能体或一方是虚拟智能体）
 */
async function resolveVirtualAgentPK(attackerId, defenderId, roomId, attackerKing, attackerAssassin, defenderKing, defenderAssassin, challengeState = null) {
  try {
    // 从配置读取能量变化值
    const configs = await db.query(
      'SELECT config_key, config_value FROM game_config WHERE config_key IN (?, ?, ?)',
      ['pk_energy_reward', 'pk_energy_loss', 'pk_draw_energy_loss']
    );
    
    const configMap = {};
    configs.forEach(item => {
      configMap[item.config_key] = item.config_value;
    });
    
    const reward = parseInt(configMap.pk_energy_reward || '50', 10);
    const loss = parseInt(configMap.pk_energy_loss || '50', 10);
    const drawLoss = parseInt(configMap.pk_draw_energy_loss || '50', 10);
    
    // 原始攻击距离
    const attackerDist = Math.abs(attackerAssassin - defenderKing);
    const defenderDist = Math.abs(defenderAssassin - attackerKing);
    
    // 皮肤攻防（与真人 PK 一致）：攻击方有效距离 = 原始>=pk_attack 时扣减；防御方有效距离 = 对方原始<=配置上限时加攻击方 pk_defense
    const attackerSkin = await getSkinPkStats(attackerId);
    const defenderSkin = await getSkinPkStats(defenderId);
    const thresholdRows = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      ['pk_skin_defense_distance_threshold']
    );
    const defenseDistThreshold = Math.min(99, Math.max(1, parseInt(thresholdRows[0]?.config_value, 10) || 30));
    const attackerEffectiveDist = attackerDist >= attackerSkin.pk_attack ? attackerDist - attackerSkin.pk_attack : attackerDist;
    const defenderEffectiveDist = defenderDist <= defenseDistThreshold ? defenderDist + attackerSkin.pk_defense : defenderDist;
    
    let result = 'draw';
    let attackerEnergyChange = -drawLoss;
    let defenderEnergyChange = -drawLoss;
    
    if (attackerEffectiveDist < defenderEffectiveDist) {
      result = 'win';
      attackerEnergyChange = reward;
      defenderEnergyChange = -loss;
    } else if (defenderEffectiveDist < attackerEffectiveDist) {
      result = 'lose';
      attackerEnergyChange = -loss;
      defenderEnergyChange = reward;
    }
    
    // 判断攻击者和防御者类型（改进逻辑：优先使用challengeState，添加数据库查询兜底）
    let attackerIsVirtual = false;
    let defenderIsVirtual = false;
    
    // 优先使用 challengeState 中的类型信息
    if (challengeState) {
      attackerIsVirtual = challengeState.attackerType === 'virtual_agent';
      defenderIsVirtual = challengeState.defenderType === 'virtual_agent';
      console.log(`[虚拟智能体Socket] 使用challengeState判断: 攻击者${attackerId} ${attackerIsVirtual ? '是' : '不是'}虚拟AI智能体, 防御者${defenderId} ${defenderIsVirtual ? '是' : '不是'}虚拟AI智能体`);
    }
    
    // 如果 challengeState 不存在或未包含类型信息，使用兜底判断：优先 users 表判定真人
    if (!challengeState || challengeState.attackerType === undefined) {
      try {
        const userAttacker = await db.query('SELECT 1 FROM users WHERE id = ? LIMIT 1', [attackerId]);
        if (userAttacker.length > 0) {
          attackerIsVirtual = false;
        } else {
          attackerIsVirtual = virtualAgentSockets.has(attackerId);
          if (!attackerIsVirtual) {
            const attackerCheck = await db.query('SELECT 1 FROM virtual_ai_agents WHERE id = ? LIMIT 1', [attackerId]);
            attackerIsVirtual = attackerCheck.length > 0;
            if (attackerIsVirtual) {
              console.log(`[虚拟智能体Socket] 通过数据库查询确认攻击者 ${attackerId} 是虚拟AI智能体`);
            }
          }
        }
      } catch (err) {
        console.error('[虚拟智能体Socket] 查询攻击者类型失败:', err);
      }
    }
    
    if (!challengeState || challengeState.defenderType === undefined) {
      try {
        const userDefender = await db.query('SELECT 1 FROM users WHERE id = ? LIMIT 1', [defenderId]);
        if (userDefender.length > 0) {
          defenderIsVirtual = false;
        } else {
          defenderIsVirtual = virtualAgentSockets.has(defenderId);
          if (!defenderIsVirtual) {
            const defenderCheck = await db.query('SELECT 1 FROM virtual_ai_agents WHERE id = ? LIMIT 1', [defenderId]);
            defenderIsVirtual = defenderCheck.length > 0;
            if (defenderIsVirtual) {
              console.log(`[虚拟智能体Socket] 通过数据库查询确认防御者 ${defenderId} 是虚拟AI智能体`);
            }
          }
        }
      } catch (err) {
        console.error('[虚拟智能体Socket] 查询防御者类型失败:', err);
      }
    }
    
    console.log(`[虚拟智能体Socket] 最终判断: 攻击者${attackerId} ${attackerIsVirtual ? '是' : '不是'}虚拟AI智能体, 防御者${defenderId} ${defenderIsVirtual ? '是' : '不是'}虚拟AI智能体`);
    
    // 更新攻击者
    try {
      // 更新前查询当前能量值
      let attackerEnergyBefore = null;
      if (attackerIsVirtual) {
        const attackerBefore = await db.query('SELECT energy FROM virtual_ai_agents WHERE id = ?', [attackerId]);
        attackerEnergyBefore = attackerBefore.length > 0 ? (attackerBefore[0].energy != null ? Number(attackerBefore[0].energy) : 0) : 0;
      } else {
        const attackerBefore = await db.query('SELECT energy FROM users WHERE id = ?', [attackerId]);
        attackerEnergyBefore = attackerBefore.length > 0 ? (attackerBefore[0].energy != null ? Number(attackerBefore[0].energy) : 0) : 0;
      }
      
      if (attackerIsVirtual) {
        const updateResult = await db.query(
          `UPDATE virtual_ai_agents 
           SET energy = GREATEST(0, energy + ?), 
               wins = wins + ${result === 'win' ? 1 : 0},
               losses = losses + ${result === 'lose' ? 1 : 0},
               draws = draws + ${result === 'draw' ? 1 : 0}
           WHERE id = ?`,
          [attackerEnergyChange, attackerId]
        );
        
        // 验证更新结果
        const attackerAfter = await db.query('SELECT energy FROM virtual_ai_agents WHERE id = ?', [attackerId]);
        const attackerEnergyAfter = attackerAfter.length > 0 ? (attackerAfter[0].energy != null ? Number(attackerAfter[0].energy) : 0) : 0;
        
        console.log(`[虚拟智能体Socket] 攻击者(虚拟AI智能体)${attackerId}能量更新: ${attackerEnergyBefore} + ${attackerEnergyChange} = ${attackerEnergyAfter}, 结果:${result}, affectedRows:${updateResult.affectedRows || 0}`);
        
        if (updateResult.affectedRows === 0) {
          console.warn(`[虚拟智能体Socket] 警告: 攻击者(虚拟AI智能体)${attackerId}能量更新失败，affectedRows为0`);
        }
      } else {
        const updateResult = await db.query(
          `UPDATE users 
           SET energy = GREATEST(0, energy + ?), 
               wins = wins + ${result === 'win' ? 1 : 0},
               losses = losses + ${result === 'lose' ? 1 : 0},
               draws = draws + ${result === 'draw' ? 1 : 0}
           WHERE id = ?`,
          [attackerEnergyChange, attackerId]
        );
        
        // 验证更新结果
        const attackerAfter = await db.query('SELECT energy FROM users WHERE id = ?', [attackerId]);
        const attackerEnergyAfter = attackerAfter.length > 0 ? (attackerAfter[0].energy != null ? Number(attackerAfter[0].energy) : 0) : 0;
        
        console.log(`[虚拟智能体Socket] 攻击者(真人用户)${attackerId}能量更新: ${attackerEnergyBefore} + ${attackerEnergyChange} = ${attackerEnergyAfter}, 结果:${result}, affectedRows:${updateResult.affectedRows || 0}`);
        
        if (updateResult.affectedRows === 0) {
          console.warn(`[虚拟智能体Socket] 警告: 攻击者(真人用户)${attackerId}能量更新失败，affectedRows为0`);
        }
        
        // 更新真人用户的任务进度
        await updateTaskProgress(attackerId, 'complete_pk');
      }
    } catch (error) {
      console.error(`[虚拟智能体Socket] 更新攻击者${attackerId}能量失败:`, error);
      throw error; // 重新抛出错误，让外层catch处理
    }
    
    // 更新防御者
    try {
      // 更新前查询当前能量值
      let defenderEnergyBefore = null;
      if (defenderIsVirtual) {
        const defenderBefore = await db.query('SELECT energy FROM virtual_ai_agents WHERE id = ?', [defenderId]);
        defenderEnergyBefore = defenderBefore.length > 0 ? (defenderBefore[0].energy != null ? Number(defenderBefore[0].energy) : 0) : 0;
      } else {
        const defenderBefore = await db.query('SELECT energy FROM users WHERE id = ?', [defenderId]);
        defenderEnergyBefore = defenderBefore.length > 0 ? (defenderBefore[0].energy != null ? Number(defenderBefore[0].energy) : 0) : 0;
      }
      
      if (defenderIsVirtual) {
        const updateResult = await db.query(
          `UPDATE virtual_ai_agents 
           SET energy = GREATEST(0, energy + ?), 
               wins = wins + ${result === 'lose' ? 1 : 0},
               losses = losses + ${result === 'win' ? 1 : 0},
               draws = draws + ${result === 'draw' ? 1 : 0}
           WHERE id = ?`,
          [defenderEnergyChange, defenderId]
        );
        
        // 验证更新结果
        const defenderAfter = await db.query('SELECT energy FROM virtual_ai_agents WHERE id = ?', [defenderId]);
        const defenderEnergyAfter = defenderAfter.length > 0 ? (defenderAfter[0].energy != null ? Number(defenderAfter[0].energy) : 0) : 0;
        
        console.log(`[虚拟智能体Socket] 防御者(虚拟AI智能体)${defenderId}能量更新: ${defenderEnergyBefore} + ${defenderEnergyChange} = ${defenderEnergyAfter}, 结果:${result === 'win' ? 'lose' : (result === 'lose' ? 'win' : 'draw')}, affectedRows:${updateResult.affectedRows || 0}`);
        
        if (updateResult.affectedRows === 0) {
          console.warn(`[虚拟智能体Socket] 警告: 防御者(虚拟AI智能体)${defenderId}能量更新失败，affectedRows为0`);
        }
      } else {
        const updateResult = await db.query(
          `UPDATE users 
           SET energy = GREATEST(0, energy + ?), 
               wins = wins + ${result === 'lose' ? 1 : 0},
               losses = losses + ${result === 'win' ? 1 : 0},
               draws = draws + ${result === 'draw' ? 1 : 0}
           WHERE id = ?`,
          [defenderEnergyChange, defenderId]
        );
        
        // 验证更新结果
        const defenderAfter = await db.query('SELECT energy FROM users WHERE id = ?', [defenderId]);
        const defenderEnergyAfter = defenderAfter.length > 0 ? (defenderAfter[0].energy != null ? Number(defenderAfter[0].energy) : 0) : 0;
        
        console.log(`[虚拟智能体Socket] 防御者(真人用户)${defenderId}能量更新: ${defenderEnergyBefore} + ${defenderEnergyChange} = ${defenderEnergyAfter}, 结果:${result === 'win' ? 'lose' : (result === 'lose' ? 'win' : 'draw')}, affectedRows:${updateResult.affectedRows || 0}`);
        
        if (updateResult.affectedRows === 0) {
          console.warn(`[虚拟智能体Socket] 警告: 防御者(真人用户)${defenderId}能量更新失败，affectedRows为0`);
        }
        
        // 更新真人用户的任务进度
        await updateTaskProgress(defenderId, 'complete_pk');
      }
    } catch (error) {
      console.error(`[虚拟智能体Socket] 更新防御者${defenderId}能量失败:`, error);
      throw error; // 重新抛出错误，让外层catch处理
    }
    
    // 记录对战记录
    const attackerName = attackerIsVirtual 
      ? (await db.query('SELECT name FROM virtual_ai_agents WHERE id = ?', [attackerId]))[0]?.name || 'Unknown'
      : (await db.query('SELECT username FROM users WHERE id = ?', [attackerId]))[0]?.username || 'Unknown';
    
    const defenderName = defenderIsVirtual
      ? (await db.query('SELECT name FROM virtual_ai_agents WHERE id = ?', [defenderId]))[0]?.name || 'Unknown'
      : (await db.query('SELECT username FROM users WHERE id = ?', [defenderId]))[0]?.username || 'Unknown';
    
    await db.query(
      `INSERT INTO virtual_agent_battles 
       (attacker_id, attacker_type, attacker_name, defender_id, defender_type, defender_name,
        attacker_king, attacker_assassin, defender_king, defender_assassin,
        result, attacker_energy_change, defender_energy_change, room_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [attackerId, attackerIsVirtual ? 'virtual_agent' : 'user', attackerName,
       defenderId, defenderIsVirtual ? 'virtual_agent' : 'user', defenderName,
       attackerKing, attackerAssassin, defenderKing, defenderAssassin,
       result, attackerEnergyChange, defenderEnergyChange, roomId]
    );
    
    // 写入MongoDB对战记录（与真实用户一致）
    try {
      const createdAt = new Date();
      await mongo.insertBattleLog({
        attackerId: attackerId,
        defenderId: defenderId,
        attackerName: attackerName, // 直接使用虚拟智能体名称，不添加标识
        defenderName: defenderName, // 直接使用名称，不添加标识
        type: 'normal',
        attackerKing: attackerKing,
        attackerAssassin: attackerAssassin,
        defenderKing: defenderKing,
        defenderAssassin: defenderAssassin,
        attackerAttackDist: attackerDist,
        defenderAttackDist: defenderDist,
        result: result,
        attackerEnergyChange: attackerEnergyChange,
        defenderEnergyChange: defenderEnergyChange,
        roomId: roomId,
        createdAt
      });
      const defenderResult = result === 'win' ? 'lose' : result === 'lose' ? 'win' : 'draw';
      try {
        await mongo.insertUserGameRecord({
          userId: attackerId,
          recordType: 'battle',
          type: 'normal',
          myResult: result,
          opponentName: defenderName,
          myEnergyChange: attackerEnergyChange,
          opponentEnergyChange: defenderEnergyChange,
          myKing: attackerKing,
          myAssassin: attackerAssassin,
          opponentKing: defenderKing,
          opponentAssassin: defenderAssassin,
          myAttackDist: attackerDist,
          opponentAttackDist: defenderDist,
          createdAt
        });
        await mongo.insertUserGameRecord({
          userId: defenderId,
          recordType: 'battle',
          type: 'normal',
          myResult: defenderResult,
          opponentName: attackerName,
          myEnergyChange: defenderEnergyChange,
          opponentEnergyChange: attackerEnergyChange,
          myKing: defenderKing,
          myAssassin: defenderAssassin,
          opponentKing: attackerKing,
          opponentAssassin: attackerAssassin,
          myAttackDist: defenderDist,
          opponentAttackDist: attackerDist,
          createdAt
        });
      } catch (ugrErr) {
        console.error('[虚拟智能体Socket] MongoDB user_game_records (normal) 写入失败:', ugrErr);
      }
    } catch (mongoErr) {
      console.error('[虚拟智能体Socket] MongoDB battle_logs 写入失败:', mongoErr);
      // 不中断流程，MongoDB写入失败不影响PK结算
    }
    
    // 如果平局，更新平台池
    if (result === 'draw') {
      try {
        const configs = await db.query(
          'SELECT config_value FROM game_config WHERE config_key = ?',
          ['platform_pool_bonus']
        );
        const bonus = parseInt(configs[0]?.config_value || '100', 10);
        await db.query(
          'UPDATE game_rooms SET platform_pool = platform_pool + ? WHERE id = ?',
          [bonus, roomId]
        );

        // 广播平台池更新给房间内所有在线用户（使用calculatePlatformPool计算）
        const io = getIO();
        if (io) {
          const newPlatformPool = await calculatePlatformPool(roomId);
          io.to(`room_${roomId}`).emit('game_state', {
            type: 'platform_pool_update',
            platformPool: newPlatformPool
          });
        }
      } catch (error) {
        console.error('[虚拟智能体Socket] 更新平台池失败:', error);
      }
    }
    
    // 通知真实用户（如果有）（兼容 userId 的 number/string 类型，避免查不到 socket）
    const io = getIO();
    const connectedUsers = getConnectedUsers();
    if (io) {
      if (!attackerIsVirtual) {
        const attackerSocketId = getRealUserSocketId(connectedUsers, attackerId);
        if (attackerSocketId) {
          try {
            // 获取更新后的能量和体力数据
            const attackerUser = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [attackerId]);
            if (attackerUser.length > 0) {
              const user = attackerUser[0];
              let energy = user.energy != null ? Number(user.energy) : 0;
              if (isNaN(energy)) energy = 0;
              energy = Math.max(0, energy);
              
              let stamina = user.stamina != null ? Number(user.stamina) : 0;
              if (isNaN(stamina)) stamina = 0;
              stamina = Math.max(0, Math.min(100, stamina));
              
              io.to(attackerSocketId).emit('pk_result', {
                result: result,
                myAttackDist: attackerDist,
                enemyAttackDist: defenderDist,
                energyChange: attackerEnergyChange
              });
              
              const canPK = await getCanPK(attackerId, roomId, energy);
              io.to(attackerSocketId).emit('player_update', {
                energy: energy,
                stamina: stamina,
                canPK
              });
              
              console.log(`[虚拟智能体Socket] 成功发送PK结果和能量更新给攻击者(真人用户)${attackerId}, SocketId:${attackerSocketId}, 能量:${energy}`);
            } else {
              console.warn(`[虚拟智能体Socket] 警告: 无法获取攻击者(真人用户)${attackerId}的用户数据`);
            }
          } catch (error) {
            console.error(`[虚拟智能体Socket] 发送PK结果给攻击者(真人用户)${attackerId}失败:`, error);
          }
        } else {
          console.warn(`[虚拟智能体Socket] 警告: 攻击者(真人用户)${attackerId}不在线，无法发送PK结果和能量更新`);
        }
      }
      
      if (!defenderIsVirtual) {
        const defenderSocketId = getRealUserSocketId(connectedUsers, defenderId);
        if (defenderSocketId) {
          try {
            // 获取更新后的能量和体力数据
            const defenderUser = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [defenderId]);
            if (defenderUser.length > 0) {
              const user = defenderUser[0];
              let energy = user.energy != null ? Number(user.energy) : 0;
              if (isNaN(energy)) energy = 0;
              energy = Math.max(0, energy);
              
              let stamina = user.stamina != null ? Number(user.stamina) : 0;
              if (isNaN(stamina)) stamina = 0;
              stamina = Math.max(0, Math.min(100, stamina));
              
              const defenderResult = result === 'win' ? 'lose' : (result === 'lose' ? 'win' : 'draw');
              io.to(defenderSocketId).emit('pk_result', {
                result: defenderResult,
                myAttackDist: defenderDist,
                enemyAttackDist: attackerDist,
                energyChange: defenderEnergyChange
              });
              
              const canPK = await getCanPK(defenderId, roomId, energy);
              io.to(defenderSocketId).emit('player_update', {
                energy: energy,
                stamina: stamina,
                canPK
              });
              
              console.log(`[虚拟智能体Socket] 成功发送PK结果和能量更新给防御者(真人用户)${defenderId}, SocketId:${defenderSocketId}, 能量:${energy}`);
            } else {
              console.warn(`[虚拟智能体Socket] 警告: 无法获取防御者(真人用户)${defenderId}的用户数据`);
            }
          } catch (error) {
            console.error(`[虚拟智能体Socket] 发送PK结果给防御者(真人用户)${defenderId}失败:`, error);
          }
        } else {
          console.warn(`[虚拟智能体Socket] 警告: 防御者(真人用户)${defenderId}不在线，无法发送PK结果和能量更新`);
        }
      }
    }
    
    // 清理挑战状态
    const challengeKey = `pk_challenge:${defenderId}:${attackerId}`;
    await redis.del(challengeKey);
    
    console.log(`[虚拟智能体Socket] PK结算完成: 攻击者${attackerId} ${result}，防御者${defenderId}`);
  } catch (error) {
    console.error('[虚拟智能体Socket] PK结算失败:', error);
  }
}

module.exports = {
  registerVirtualAgentSocket,
  unregisterVirtualAgentSocket,
  isVirtualAgent,
  getVirtualAgentSocket,
  handleVirtualAgentPKChallenge,
  virtualAgentChallengePlayer,
  handleVirtualAgentPKRejection,
  resolveVirtualAgentPK
};
