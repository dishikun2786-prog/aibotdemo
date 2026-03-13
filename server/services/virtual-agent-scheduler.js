/**
 * @file virtual-agent-scheduler.js
 * @module services/virtual-agent-scheduler
 * @description 虚拟AI智能体智能行为调度服务：占据节点、PK对战、挖矿
 */
const db = require('../utils/db');
const redis = require('../utils/redis');
const { getIO } = require('../socket');

let occupyInterval = null;
let pkInterval = null;
let challengeUserTimeout = null;
let isInitialized = false;

/**
 * 获取随机空闲节点
 */
async function getRandomAvailableNode(roomId = 1) {
  const nodes = await db.query(
    'SELECT node_id FROM game_nodes WHERE room_id = ? AND owner_id IS NULL ORDER BY RAND() LIMIT 1',
    [roomId]
  );
  return nodes.length > 0 ? nodes[0].node_id : null;
}

/**
 * 占据节点任务（每30秒执行一次）
 */
async function occupyNodeTask() {
  try {
    // 获取配置
    const configs = await db.query(
      'SELECT config_key, config_value FROM game_config WHERE config_key IN (?, ?)',
      ['virtual_agent_occupy_interval', 'occupy_node_energy_cost']
    );
    
    const configMap = {};
    configs.forEach(item => {
      configMap[item.config_key] = item.config_value;
    });
    
    const occupyInterval = parseInt(configMap.virtual_agent_occupy_interval || '30', 10);
    const energyCost = parseInt(configMap.occupy_node_energy_cost || '50', 10);
    
    // 获取所有在线且未占据节点的虚拟智能体
    const agents = await db.query(
      `SELECT id, name, energy, room_id, current_node_id 
       FROM virtual_ai_agents 
       WHERE status = 'online' AND current_node_id IS NULL`
    );
    
    for (const agent of agents) {
      try {
        // 检查能量是否足够
        if (agent.energy < energyCost) {
          continue;
        }
        
        // 获取随机空闲节点
        const nodeId = await getRandomAvailableNode(agent.room_id);
        if (!nodeId) {
          continue;
        }
        
        // 使用事务占据节点
        await db.transaction(async (conn) => {
          // 更新节点（注意：虚拟智能体不设置owner_id，因为外键指向users表）
          // 我们通过virtual_ai_agents表的current_node_id字段来记录占据状态
          await conn.execute(
            'UPDATE game_nodes SET occupied_at = NOW() WHERE room_id = ? AND node_id = ? AND owner_id IS NULL',
            [agent.room_id, nodeId]
          );
          
          // 更新智能体信息
          await conn.execute(
            'UPDATE virtual_ai_agents SET current_node_id = ?, energy = energy - ?, last_action_at = NOW() WHERE id = ?',
            [nodeId, energyCost, agent.id]
          );
        });
        
        // 占据节点成功后，广播game_state事件
        const io = getIO();
        if (io) {
          io.to(`room_${agent.room_id}`).emit('game_state', {
            type: 'node_occupied',
            nodeId: nodeId,
            ownerId: -agent.id, // 使用负数ID标识虚拟智能体
            ownerName: agent.name,
            ownerType: 'virtual_agent'
          });
        }
      } catch (error) {
        console.error(`[虚拟智能体调度] 智能体 ${agent.id} 占据节点失败:`, error);
      }
    }
  } catch (error) {
    console.error('[虚拟智能体调度] 占据节点任务错误:', error);
  }
}

/**
 * PK对战任务（每60秒执行一次）
 */
async function pkTask() {
  try {
    // 获取配置
    const configs = await db.query(
      'SELECT config_key, config_value FROM game_config WHERE config_key IN (?, ?)',
      ['virtual_agent_pk_interval', 'virtual_agent_pk_probability']
    );
    
    const configMap = {};
    configs.forEach(item => {
      configMap[item.config_key] = item.config_value;
    });
    
    const pkInterval = parseInt(configMap.virtual_agent_pk_interval || '60', 10);
    const pkProbability = parseFloat(configMap.virtual_agent_pk_probability || '0.3');
    
    // 获取所有在线且能量>=100的虚拟智能体
    const agents = await db.query(
      `SELECT id, name, energy, room_id 
       FROM virtual_ai_agents 
       WHERE status = 'online' AND energy >= 100`
    );
    
    for (const agent of agents) {
      try {
        // 基于概率决定是否发起PK
        if (Math.random() > pkProbability) {
          continue;
        }
        
        // 选择目标：可以是其他虚拟智能体或真实用户
        // 优先选择其他虚拟智能体，如果没有则选择真实用户
        // 目标必须：已占据节点且能量≥100
        const targets = await db.query(
          `SELECT id, 'virtual_agent' as type, name 
           FROM virtual_ai_agents 
           WHERE status = 'online' 
             AND id != ? 
             AND room_id = ?
             AND current_node_id IS NOT NULL
             AND energy >= 100
           ORDER BY RAND() 
           LIMIT 1`,
          [agent.id, agent.room_id]
        );
        
        let targetId = null;
        let targetType = null;
        let targetName = null;
        
        if (targets.length > 0) {
          targetId = targets[0].id;
          targetType = 'virtual_agent';
          targetName = targets[0].name;
        } else {
          // 如果没有其他虚拟智能体，选择真实用户
          // 目标必须：已占据节点（通过JOIN检查）且能量≥100
          const users = await db.query(
            `SELECT u.id, u.username 
             FROM users u
             INNER JOIN game_nodes gn ON gn.owner_id = u.id
             WHERE gn.room_id = ? 
               AND u.status = 'active'
               AND u.energy >= 100
             ORDER BY RAND()
             LIMIT 1`,
            [agent.room_id]
          );
          
          if (users.length > 0) {
            targetId = users[0].id;
            targetType = 'user';
            targetName = users[0].username;
          }
        }
        
        if (!targetId) {
          continue;
        }
        
        // 发起PK挑战（通过虚拟智能体Socket服务）
        const virtualAgentSocket = require('./virtual-agent-socket');
        const result = await virtualAgentSocket.virtualAgentChallengePlayer(
          agent.id,
          targetId,
          targetType,
          agent.room_id
        );
        
        if (result.success) {
          // 挑战成功
        } else {
          // 挑战失败
        }
      } catch (error) {
        console.error(`[虚拟智能体调度] 智能体 ${agent.id} PK任务失败:`, error);
      }
    }
  } catch (error) {
    console.error('[虚拟智能体调度] PK对战任务错误:', error);
  }
}

/**
 * 虚拟智能体主动挑战真人任务（真人不足 N 人时，按配置间隔随机发起）
 */
async function virtualAgentChallengeUserTask() {
  try {
    const configs = await db.query(
      `SELECT config_key, config_value FROM game_config 
       WHERE config_key IN (?, ?, ?)`,
      ['virtual_agent_challenge_user_when_real_below', 'virtual_agent_challenge_user_interval_min', 'virtual_agent_challenge_user_interval_max']
    );
    const configMap = {};
    configs.forEach(item => { configMap[item.config_key] = item.config_value; });
    const whenRealBelow = parseInt(configMap.virtual_agent_challenge_user_when_real_below || '10', 10);
    const intervalMin = parseInt(configMap.virtual_agent_challenge_user_interval_min || '180', 10);
    const intervalMax = parseInt(configMap.virtual_agent_challenge_user_interval_max || '300', 10);

    const io = getIO();
    if (!io || !io.sockets || !io.sockets.adapter || !io.sockets.adapter.rooms) {
      return;
    }

    const rooms = io.sockets.adapter.rooms;
    for (const [roomName, room] of rooms) {
      if (!roomName.startsWith('room_')) continue;
      const roomId = parseInt(roomName.replace('room_', ''), 10);
      if (isNaN(roomId)) continue;

      const realUserCount = room.size;
      if (realUserCount >= whenRealBelow || realUserCount === 0) continue;

      const userIds = [];
      for (const socketId of room) {
        const s = io.sockets.sockets.get(socketId);
        if (s && s.userId) userIds.push(s.userId);
      }
      if (userIds.length === 0) continue;

      // 仅从已占据节点且能量≥100的真人中选目标：真人未占节点或能量不足时虚拟 AI 不向其发起 PK
      const occupiedNodes = await db.query(
        `SELECT DISTINCT gn.owner_id 
         FROM game_nodes gn
         INNER JOIN users u ON u.id = gn.owner_id
         WHERE gn.room_id = ? 
           AND gn.owner_id IN (?)
           AND u.status = 'active'
           AND u.energy >= 100`,
        [roomId, userIds]
      );
      const eligibleUserIds = (occupiedNodes || []).map(n => n.owner_id);
      if (eligibleUserIds.length === 0) continue;

      const agents = await db.query(
        `SELECT id, name, room_id FROM virtual_ai_agents 
         WHERE status = 'online' AND room_id = ? AND energy >= 100 
         ORDER BY RAND() LIMIT 1`,
        [roomId]
      );
      if (agents.length === 0) continue;

      const agent = agents[0];
      const targetUserId = eligibleUserIds[Math.floor(Math.random() * eligibleUserIds.length)];
      const virtualAgentSocket = require('./virtual-agent-socket');
      const result = await virtualAgentSocket.virtualAgentChallengePlayer(
        agent.id,
        targetUserId,
        'user',
        roomId
      );
      if (result.success) {
        // 挑战成功
      }
      break; // 每轮只发起一次挑战
    }
  } catch (error) {
    console.error('[虚拟智能体调度] 虚拟智能体主动挑战真人任务错误:', error);
  }
}

/**
 * 调度下一轮「虚拟智能体主动挑战真人」执行（随机间隔 3～5 分钟）
 */
function scheduleNextChallengeUserRun() {
  db.query(
    `SELECT config_key, config_value FROM game_config 
     WHERE config_key IN (?, ?)`,
    ['virtual_agent_challenge_user_interval_min', 'virtual_agent_challenge_user_interval_max']
  ).then(configs => {
    const configMap = {};
    configs.forEach(item => { configMap[item.config_key] = item.config_value; });
    const minSec = parseInt(configMap.virtual_agent_challenge_user_interval_min || '180', 10);
    const maxSec = parseInt(configMap.virtual_agent_challenge_user_interval_max || '300', 10);
    const intervalSec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
    const intervalMs = Math.min(intervalSec, 3600) * 1000;

    challengeUserTimeout = setTimeout(async () => {
      challengeUserTimeout = null;
      await virtualAgentChallengeUserTask();
      scheduleNextChallengeUserRun();
    }, intervalMs);
  }).catch(err => {
    console.error('[虚拟智能体调度] 读取挑战真人间隔配置失败:', err);
    challengeUserTimeout = setTimeout(() => {
      challengeUserTimeout = null;
      virtualAgentChallengeUserTask().then(() => scheduleNextChallengeUserRun());
    }, 240000);
  });
}

/**
 * 虚拟智能体挖矿任务（集成到现有挖矿循环）
 * 在socket.js的挖矿循环中调用此函数
 */
async function virtualAgentMiningTask() {
  try {
    // 获取所有占据节点的在线虚拟智能体
    const agents = await db.query(
      `SELECT id, name, energy, stamina, current_node_id, room_id, total_energy
       FROM virtual_ai_agents 
       WHERE status = 'online' AND current_node_id IS NOT NULL`
    );
    
    // 获取配置
    const configs = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      ['energy_per_second']
    );
    const energyPerSecond = parseInt(configs[0]?.config_value || '5', 10);
    
    for (const agent of agents) {
      try {
        // 使用事务确保数据一致性
        await db.transaction(async (conn) => {
          // 重新查询获取最新数据
          const [agents] = await conn.query(
            'SELECT energy, stamina FROM virtual_ai_agents WHERE id = ?',
            [agent.id]
          );
          
          if (agents.length === 0) return;
          
          const currentAgent = agents[0];
          
          // 安全地转换能量和体力值
          let currentEnergy = currentAgent.energy != null ? Number(currentAgent.energy) : 0;
          if (isNaN(currentEnergy)) currentEnergy = 0;
          currentEnergy = Math.max(0, currentEnergy);
          
          let currentStamina = currentAgent.stamina != null ? Number(currentAgent.stamina) : 0;
          if (isNaN(currentStamina)) currentStamina = 0;
          currentStamina = Math.max(0, Math.min(100, currentStamina));
          
          // 检查体力和能量
          if (currentStamina <= 0) {
            return; // 体力为0，不挖矿
          }
          
          if (currentEnergy >= 100) {
            return; // 能量已满，不挖矿
          }
          
          // 计算新值
          const energyGain = energyPerSecond;
          const newEnergy = Math.min(100, currentEnergy + energyGain);
          
          // 如果能量不足100，消耗体力
          let newStamina = currentStamina;
          if (newEnergy < 100) {
            const staminaLoss = 1; // 每秒1点体力
            newStamina = Math.max(0, currentStamina - staminaLoss);
          }
          
          // 更新数据库
          await conn.query(
            'UPDATE virtual_ai_agents SET energy = ?, stamina = ?, total_energy = total_energy + ?, last_action_at = NOW() WHERE id = ?',
            [newEnergy, newStamina, energyGain, agent.id]
          );
        });
      } catch (error) {
        console.error(`[虚拟智能体调度] 智能体 ${agent.id} 挖矿失败:`, error);
      }
    }
  } catch (error) {
    console.error('[虚拟智能体调度] 挖矿任务错误:', error);
  }
}

/**
 * 虚拟智能体体力恢复任务（集成到现有体力恢复循环）
 * @param {number} staminaRecoveryRate - 体力恢复速率（每分钟），默认1
 */
async function virtualAgentStaminaRecoveryTask(staminaRecoveryRate = 1) {
  try {
    // 只有配置值 > 0 时才恢复体力
    if (staminaRecoveryRate > 0) {
      await db.query(
        `UPDATE virtual_ai_agents 
         SET stamina = LEAST(100, stamina + ?) 
         WHERE status = 'online' AND stamina < 100`,
        [staminaRecoveryRate]
      );
    }
  } catch (error) {
    console.error('[虚拟智能体调度] 体力恢复任务错误:', error);
  }
}

/**
 * 初始化调度服务
 */
function init() {
  if (isInitialized) {
    console.warn('[虚拟智能体调度] 调度服务已初始化，跳过重复初始化');
    return;
  }
  
  // 获取配置
  db.query(
    'SELECT config_key, config_value FROM game_config WHERE config_key IN (?, ?)',
    ['virtual_agent_occupy_interval', 'virtual_agent_pk_interval']
  ).then(configs => {
    const configMap = {};
    configs.forEach(item => {
      configMap[item.config_key] = item.config_value;
    });
    
    const occupyIntervalMs = parseInt(configMap.virtual_agent_occupy_interval || '30', 10) * 1000;
    const pkIntervalMs = parseInt(configMap.virtual_agent_pk_interval || '60', 10) * 1000;
    
    // 启动占据节点任务
    occupyInterval = setInterval(occupyNodeTask, occupyIntervalMs);
    console.log(`[虚拟智能体调度] 占据节点任务已启动，间隔: ${occupyIntervalMs}ms`);
    
    // 启动PK对战任务
    pkInterval = setInterval(pkTask, pkIntervalMs);
    console.log(`[虚拟智能体调度] PK对战任务已启动，间隔: ${pkIntervalMs}ms`);
    
    // 启动虚拟智能体主动挑战真人任务（每 3～5 分钟随机执行一次）
    scheduleNextChallengeUserRun();
    
    isInitialized = true;
    console.log('[虚拟智能体调度] 调度服务初始化完成');
  }).catch(error => {
    console.error('[虚拟智能体调度] 初始化失败:', error);
  });
}

/**
 * 停止调度服务
 */
function stop() {
  if (occupyInterval) {
    clearInterval(occupyInterval);
    occupyInterval = null;
  }
  
  if (pkInterval) {
    clearInterval(pkInterval);
    pkInterval = null;
  }
  
  if (challengeUserTimeout) {
    clearTimeout(challengeUserTimeout);
    challengeUserTimeout = null;
  }
  
  isInitialized = false;
  console.log('[虚拟智能体调度] 调度服务已停止');
}

module.exports = {
  init,
  stop,
  occupyNodeTask,
  pkTask,
  virtualAgentChallengeUserTask,
  virtualAgentMiningTask,
  virtualAgentStaminaRecoveryTask
};
