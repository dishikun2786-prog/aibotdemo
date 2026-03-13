/**
 * @file admin-virtual-agents.js
 * @module routes/admin-virtual-agents
 * @description 管理员后台：虚拟AI智能体管理
 */
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { authenticateToken, requireAdmin, logAdminAction } = require('../middleware/auth');
const { getIO } = require('../socket');
const virtualAgentSocket = require('../services/virtual-agent-socket');

// 所有路由都需要认证和管理员权限
router.use(authenticateToken);
router.use(requireAdmin);

/**
 * 生成随机智能体名称
 */
function generateAgentName() {
  const prefixes = ['AI', '智能体', '虚拟', '自动', '机械'];
  const suffixes = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Omega', 'Zero', 'One', 'Two', 'Three'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
  const number = Math.floor(Math.random() * 9999);
  return `${prefix}${suffix}${number}`;
}

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
 * 占据节点（虚拟智能体）
 */
async function occupyNodeForVirtualAgent(agentId, roomId = 1) {
  try {
    // 获取智能体信息
    const agents = await db.query(
      'SELECT energy, current_node_id FROM virtual_ai_agents WHERE id = ?',
      [agentId]
    );
    
    if (agents.length === 0) {
      throw new Error('智能体不存在');
    }
    
    const agent = agents[0];
    
    // 检查是否已占据节点
    if (agent.current_node_id) {
      return { success: true, nodeId: agent.current_node_id, message: '已占据节点' };
    }
    
    // 获取占据节点能量消耗配置
    const configs = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      ['occupy_node_energy_cost']
    );
    const energyCost = configs.length > 0 ? parseInt(configs[0].config_value, 10) : 50;
    
    // 检查能量是否足够
    if (agent.energy < energyCost) {
      return { success: false, message: `能量不足，需要${energyCost}点能量` };
    }
    
    // 获取随机空闲节点
    const nodeId = await getRandomAvailableNode(roomId);
    if (!nodeId) {
      return { success: false, message: '没有可用的节点' };
    }
    
    // 使用事务占据节点
    await db.transaction(async (conn) => {
      // 更新节点所有者（使用特殊标记，如负数ID表示虚拟智能体）
      // 注意：由于game_nodes.owner_id外键指向users表，我们需要特殊处理
      // 方案：使用负数ID，但需要修改外键约束或使用特殊用户ID
      // 临时方案：先不设置owner_id，而是使用current_node_id字段记录
      await conn.execute(
        'UPDATE game_nodes SET owner_id = NULL, occupied_at = NOW() WHERE room_id = ? AND node_id = ? AND owner_id IS NULL',
        [roomId, nodeId]
      );
      
      // 更新智能体信息
      await conn.execute(
        'UPDATE virtual_ai_agents SET current_node_id = ?, energy = energy - ?, last_action_at = NOW() WHERE id = ?',
        [nodeId, energyCost, agentId]
      );
    });
    
    // 占据节点成功后，广播game_state事件
    const io = getIO();
    if (io) {
      // 获取智能体名称
      const agentInfo = await db.query('SELECT name FROM virtual_ai_agents WHERE id = ?', [agentId]);
      const agentName = agentInfo[0]?.name || 'Unknown';
      
      io.to(`room_${roomId}`).emit('game_state', {
        type: 'node_occupied',
        nodeId: nodeId,
        ownerId: -agentId, // 使用负数ID标识虚拟智能体
        ownerName: agentName,
        ownerType: 'virtual_agent'
      });
    }
    
    return { success: true, nodeId, message: `成功占据节点 ${nodeId}` };
  } catch (error) {
    console.error('占据节点失败:', error);
    throw error;
  }
}

/**
 * 释放节点（虚拟智能体）
 */
async function releaseNodeForVirtualAgent(agentId) {
  try {
    const agents = await db.query(
      'SELECT current_node_id, room_id FROM virtual_ai_agents WHERE id = ?',
      [agentId]
    );
    
    if (agents.length === 0) {
      return { success: false, message: '智能体不存在' };
    }
    
    const agent = agents[0];
    
    if (!agent.current_node_id) {
      return { success: true, message: '未占据节点' };
    }
    
    // 释放节点（将owner_id设为NULL）
    await db.query(
      'UPDATE game_nodes SET owner_id = NULL, occupied_at = NULL WHERE room_id = ? AND node_id = ?',
      [agent.room_id, agent.current_node_id]
    );
    
    // 更新智能体信息
    await db.query(
      'UPDATE virtual_ai_agents SET current_node_id = NULL WHERE id = ?',
      [agentId]
    );
    
    // 释放节点后，广播game_state事件
    const io = getIO();
    if (io) {
      io.to(`room_${agent.room_id}`).emit('game_state', {
        type: 'node_occupied',
        nodeId: agent.current_node_id,
        ownerId: null,
        ownerName: null,
        ownerType: null
      });
    }
    
    return { success: true, message: '节点已释放' };
  } catch (error) {
    console.error('释放节点失败:', error);
    throw error;
  }
}

// GET /api/admin/virtual-agents - 获取虚拟智能体列表
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', status = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT id, name, energy, stamina, status, room_id, current_node_id, 
             wins, losses, draws, total_energy, created_at, updated_at, last_action_at
      FROM virtual_ai_agents 
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      query += ' AND name LIKE ?';
      params.push(`%${search}%`);
    }

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const agents = await db.query(query, params);

    // 获取总数
    let countQuery = 'SELECT COUNT(*) as total FROM virtual_ai_agents WHERE 1=1';
    const countParams = [];
    if (search) {
      countQuery += ' AND name LIKE ?';
      countParams.push(`%${search}%`);
    }
    if (status) {
      countQuery += ' AND status = ?';
      countParams.push(status);
    }
    const countResult = await db.query(countQuery, countParams);
    const total = countResult[0].total;

    res.json({
      success: true,
      data: agents,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('获取虚拟智能体列表失败:', error);
    res.status(500).json({ success: false, error: '获取虚拟智能体列表失败' });
  }
});

// POST /api/admin/virtual-agents/create - 一键创建虚拟智能体
router.post('/create', async (req, res) => {
  try {
    const adminId = req.user.id;
    const { name } = req.body;

    // 检查最大数量限制
    const configs = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      ['virtual_agent_max_count']
    );
    const maxCount = configs.length > 0 ? parseInt(configs[0].config_value, 10) : 50;
    
    const countResult = await db.query('SELECT COUNT(*) as total FROM virtual_ai_agents');
    if (countResult[0].total >= maxCount) {
      return res.status(400).json({
        success: false,
        error: `虚拟智能体数量已达上限（${maxCount}个）`
      });
    }

    // 生成名称
    const agentName = name && name.trim() ? name.trim() : generateAgentName();

    // 创建智能体
    const result = await db.query(
      `INSERT INTO virtual_ai_agents (name, energy, stamina, status, room_id) 
       VALUES (?, 100, 100, 'offline', 1)`,
      [agentName]
    );

    const agentId = result.insertId;

    // 记录操作日志
    await logAdminAction(adminId, 'create_virtual_agent', agentId, {
      name: agentName
    });

    // 获取创建的智能体信息
    const agents = await db.query(
      'SELECT * FROM virtual_ai_agents WHERE id = ?',
      [agentId]
    );

    res.json({
      success: true,
      message: '虚拟智能体创建成功',
      data: agents[0]
    });
  } catch (error) {
    console.error('创建虚拟智能体失败:', error);
    res.status(500).json({ success: false, error: '创建虚拟智能体失败' });
  }
});

// GET /api/admin/virtual-agents/:id - 获取智能体详细信息
router.get('/:id', async (req, res) => {
  try {
    const agentId = parseInt(req.params.id);

    const agents = await db.query(
      'SELECT * FROM virtual_ai_agents WHERE id = ?',
      [agentId]
    );

    if (agents.length === 0) {
      return res.status(404).json({ success: false, error: '智能体不存在' });
    }

    const agent = agents[0];

    // 获取对战记录统计
    const battleStats = await db.query(
      `SELECT 
        COUNT(*) as total_battles,
        SUM(CASE WHEN attacker_id = ? AND result = 'win' THEN 1 ELSE 0 END) as attacker_wins,
        SUM(CASE WHEN defender_id = ? AND result = 'win' THEN 1 ELSE 0 END) as defender_wins,
        SUM(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) as draws
       FROM virtual_agent_battles
       WHERE (attacker_id = ? AND attacker_type = 'virtual_agent') 
          OR (defender_id = ? AND defender_type = 'virtual_agent')`,
      [agentId, agentId, agentId, agentId]
    );

    res.json({
      success: true,
      data: {
        ...agent,
        battleStats: battleStats[0] || {
          total_battles: 0,
          attacker_wins: 0,
          defender_wins: 0,
          draws: 0
        }
      }
    });
  } catch (error) {
    console.error('获取智能体详情失败:', error);
    res.status(500).json({ success: false, error: '获取智能体详情失败' });
  }
});

// PUT /api/admin/virtual-agents/:id/online - 上线智能体
router.put('/:id/online', async (req, res) => {
  try {
    const agentId = parseInt(req.params.id);
    const adminId = req.user.id;
    const { roomId = 1 } = req.body;

    // 检查智能体是否存在
    const agents = await db.query(
      'SELECT * FROM virtual_ai_agents WHERE id = ?',
      [agentId]
    );

    if (agents.length === 0) {
      return res.status(404).json({ success: false, error: '智能体不存在' });
    }

    const agent = agents[0];

    if (agent.status === 'online') {
      return res.status(400).json({ success: false, error: '智能体已在线' });
    }

    // 更新状态为在线
    await db.query(
      'UPDATE virtual_ai_agents SET status = ?, room_id = ?, last_action_at = NOW() WHERE id = ?',
      ['online', roomId, agentId]
    );

    // 尝试自动占据节点
    const occupyResult = await occupyNodeForVirtualAgent(agentId, roomId);

    // 记录操作日志
    await logAdminAction(adminId, 'virtual_agent_online', agentId, {
      name: agent.name,
      roomId,
      occupyResult
    });

    // 获取更新后的信息
    const updatedAgents = await db.query(
      'SELECT * FROM virtual_ai_agents WHERE id = ?',
      [agentId]
    );

    res.json({
      success: true,
      message: '智能体已上线' + (occupyResult.success ? `，${occupyResult.message}` : `，${occupyResult.message}`),
      data: updatedAgents[0],
      occupyResult
    });
  } catch (error) {
    console.error('上线智能体失败:', error);
    res.status(500).json({ success: false, error: '上线智能体失败: ' + error.message });
  }
});

// PUT /api/admin/virtual-agents/:id/offline - 下线智能体
router.put('/:id/offline', async (req, res) => {
  try {
    const agentId = parseInt(req.params.id);
    const adminId = req.user.id;

    // 检查智能体是否存在
    const agents = await db.query(
      'SELECT * FROM virtual_ai_agents WHERE id = ?',
      [agentId]
    );

    if (agents.length === 0) {
      return res.status(404).json({ success: false, error: '智能体不存在' });
    }

    const agent = agents[0];

    if (agent.status === 'offline') {
      return res.status(400).json({ success: false, error: '智能体已离线' });
    }

    // 释放节点
    await releaseNodeForVirtualAgent(agentId);

    // 注销虚拟智能体Socket
    virtualAgentSocket.unregisterVirtualAgentSocket(agentId);

    // 更新状态为离线
    await db.query(
      'UPDATE virtual_ai_agents SET status = ?, last_action_at = NOW() WHERE id = ?',
      ['offline', agentId]
    );

    // 记录操作日志
    await logAdminAction(adminId, 'virtual_agent_offline', agentId, {
      name: agent.name
    });

    // 获取更新后的信息
    const updatedAgents = await db.query(
      'SELECT * FROM virtual_ai_agents WHERE id = ?',
      [agentId]
    );

    res.json({
      success: true,
      message: '智能体已下线',
      data: updatedAgents[0]
    });
  } catch (error) {
    console.error('下线智能体失败:', error);
    res.status(500).json({ success: false, error: '下线智能体失败: ' + error.message });
  }
});

// PUT /api/admin/virtual-agents/:id/stats - 编辑能量和体力
router.put('/:id/stats', async (req, res) => {
  try {
    const agentId = parseInt(req.params.id);
    const adminId = req.user.id;
    const { energy, stamina } = req.body;

    // 验证参数
    if (energy === undefined && stamina === undefined) {
      return res.status(400).json({ success: false, error: '至少需要提供energy或stamina之一' });
    }

    // 验证数值范围
    if (energy !== undefined) {
      const energyNum = parseInt(energy, 10);
      if (isNaN(energyNum) || energyNum < 0 || energyNum > 1000) {
        return res.status(400).json({ success: false, error: '能量值必须在0-1000之间' });
      }
    }

    if (stamina !== undefined) {
      const staminaNum = parseInt(stamina, 10);
      if (isNaN(staminaNum) || staminaNum < 0 || staminaNum > 100) {
        return res.status(400).json({ success: false, error: '体力值必须在0-100之间' });
      }
    }

    // 检查智能体是否存在
    const agents = await db.query(
      'SELECT id, name, energy, stamina FROM virtual_ai_agents WHERE id = ?',
      [agentId]
    );

    if (agents.length === 0) {
      return res.status(404).json({ success: false, error: '智能体不存在' });
    }

    const oldEnergy = agents[0].energy;
    const oldStamina = agents[0].stamina;

    // 构建更新语句
    const updates = [];
    const params = [];

    if (energy !== undefined) {
      updates.push('energy = ?');
      params.push(parseInt(energy, 10));
    }

    if (stamina !== undefined) {
      updates.push('stamina = ?');
      params.push(parseInt(stamina, 10));
    }

    params.push(agentId);

    // 更新智能体数据
    await db.query(
      `UPDATE virtual_ai_agents SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    // 获取更新后的数据
    const updatedAgents = await db.query(
      'SELECT energy, stamina FROM virtual_ai_agents WHERE id = ?',
      [agentId]
    );

    const newEnergy = updatedAgents[0].energy;
    const newStamina = updatedAgents[0].stamina;

    // 记录操作日志
    await logAdminAction(adminId, 'edit_virtual_agent_stats', agentId, {
      name: agents[0].name,
      oldEnergy,
      oldStamina,
      newEnergy,
      newStamina
    });

    res.json({
      success: true,
      message: '能量和体力更新成功',
      data: {
        energy: newEnergy,
        stamina: newStamina
      }
    });
  } catch (error) {
    console.error('编辑智能体能量体力失败:', error);
    res.status(500).json({ success: false, error: '编辑智能体能量体力失败' });
  }
});

// GET /api/admin/virtual-agents/:id/battles - 获取智能体对战记录
router.get('/:id/battles', async (req, res) => {
  try {
    const agentId = parseInt(req.params.id);
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    // 检查智能体是否存在
    const agents = await db.query(
      'SELECT id FROM virtual_ai_agents WHERE id = ?',
      [agentId]
    );

    if (agents.length === 0) {
      return res.status(404).json({ success: false, error: '智能体不存在' });
    }

    // 获取对战记录
    const battles = await db.query(
      `SELECT * FROM virtual_agent_battles 
       WHERE (attacker_id = ? AND attacker_type = 'virtual_agent') 
          OR (defender_id = ? AND defender_type = 'virtual_agent')
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [agentId, agentId, parseInt(limit), parseInt(offset)]
    );

    // 获取总数
    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM virtual_agent_battles 
       WHERE (attacker_id = ? AND attacker_type = 'virtual_agent') 
          OR (defender_id = ? AND defender_type = 'virtual_agent')`,
      [agentId, agentId]
    );
    const total = countResult[0].total;

    res.json({
      success: true,
      data: battles,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('获取对战记录失败:', error);
    res.status(500).json({ success: false, error: '获取对战记录失败' });
  }
});

// DELETE /api/admin/virtual-agents/:id - 删除智能体
router.delete('/:id', async (req, res) => {
  try {
    const agentId = parseInt(req.params.id);
    const adminId = req.user.id;

    // 检查智能体是否存在
    const agents = await db.query(
      'SELECT * FROM virtual_ai_agents WHERE id = ?',
      [agentId]
    );

    if (agents.length === 0) {
      return res.status(404).json({ success: false, error: '智能体不存在' });
    }

    const agent = agents[0];

    // 如果在线，先释放节点
    if (agent.status === 'online' && agent.current_node_id) {
      await releaseNodeForVirtualAgent(agentId);
    }

    // 删除智能体（级联删除相关数据）
    await db.query('DELETE FROM virtual_ai_agents WHERE id = ?', [agentId]);

    // 记录操作日志
    await logAdminAction(adminId, 'delete_virtual_agent', agentId, {
      name: agent.name
    });

    res.json({
      success: true,
      message: '智能体已删除'
    });
  } catch (error) {
    console.error('删除智能体失败:', error);
    res.status(500).json({ success: false, error: '删除智能体失败' });
  }
});

module.exports = router;
