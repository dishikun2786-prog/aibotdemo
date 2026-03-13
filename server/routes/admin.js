/**
 * @file admin.js
 * @module routes/admin
 * @description 管理员后台：用户管理、配置、统计、日志
 */
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const bcrypt = require('bcrypt');
const treasureStream = require('../services/treasure-stream');
const { authenticateToken, requireAdmin, logAdminAction } = require('../middleware/auth');
const { getIO, calculatePlatformPool } = require('../socket');

// 所有路由都需要认证和管理员权限（公开接口已移至 admin-public.js）
router.use(authenticateToken);
router.use(requireAdmin);

// 获取用户列表
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', status = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = 'SELECT id, username, email, energy, stamina, total_energy, wins, losses, draws, created_at, last_login, status, referral_count FROM users WHERE 1=1';
    const params = [];

    if (search) {
      query += ' AND username LIKE ?';
      params.push(`%${search}%`);
    }

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const users = await db.query(query, params);

    // 获取总数
    let countQuery = 'SELECT COUNT(*) as total FROM users WHERE 1=1';
    const countParams = [];
    if (search) {
      countQuery += ' AND username LIKE ?';
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
      data: users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('获取用户列表失败:', error);
    res.status(500).json({ error: '获取用户列表失败' });
  }
});

// 封禁用户
router.put('/users/:id/ban', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const adminId = req.user.id;

    if (userId === adminId) {
      return res.status(400).json({ error: '不能封禁自己' });
    }

    // 检查用户是否存在
    const users = await db.query('SELECT id, username, status FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    if (users[0].status === 'banned') {
      return res.status(400).json({ error: '用户已被封禁' });
    }

    // 封禁用户
    await db.query('UPDATE users SET status = ? WHERE id = ?', ['banned', userId]);

    // 记录操作日志
    await logAdminAction(adminId, 'ban_user', userId, {
      username: users[0].username
    });

    res.json({
      success: true,
      message: '用户已封禁'
    });
  } catch (error) {
    console.error('封禁用户失败:', error);
    res.status(500).json({ error: '封禁用户失败' });
  }
});

// 解封用户
router.put('/users/:id/unban', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const adminId = req.user.id;

    // 检查用户是否存在
    const users = await db.query('SELECT id, username, status FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    if (users[0].status === 'active') {
      return res.status(400).json({ error: '用户未被封禁' });
    }

    // 解封用户
    await db.query('UPDATE users SET status = ? WHERE id = ?', ['active', userId]);

    // 记录操作日志
    await logAdminAction(adminId, 'unban_user', userId, {
      username: users[0].username
    });

    res.json({
      success: true,
      message: '用户已解封'
    });
  } catch (error) {
    console.error('解封用户失败:', error);
    res.status(500).json({ error: '解封用户失败' });
  }
});

// 删除用户
router.delete('/users/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const adminId = req.user.id;

    if (userId === adminId) {
      return res.status(400).json({ error: '不能删除自己' });
    }

    // 检查用户是否存在
    const users = await db.query('SELECT id, username FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // 删除用户（级联删除相关数据）
    await db.query('DELETE FROM users WHERE id = ?', [userId]);

    // 记录操作日志
    await logAdminAction(adminId, 'delete_user', userId, {
      username: users[0].username
    });

    res.json({
      success: true,
      message: '用户已删除'
    });
  } catch (error) {
    console.error('删除用户失败:', error);
    res.status(500).json({ error: '删除用户失败' });
  }
});

// 生成用户权威识别码
router.get('/users/:id/auth-code', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const adminId = req.user.id;

    // 查询用户信息（包含password字段）
    const users = await db.query('SELECT id, username, password, energy FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const user = users[0];

    // 提取bcrypt哈希值的最后5个字符
    const hashLast5 = user.password.slice(-5);

    // 拼接生成识别码：用户名 + bcrypt哈希值最后5位 + 能量余额
    const authCode = `${user.username}${hashLast5}${user.energy}`;

    // 记录操作日志
    await logAdminAction(adminId, 'generate_auth_code', userId, {
      username: user.username,
      energy: user.energy,
      authCode: authCode
    });

    res.json({
      success: true,
      data: {
        authCode: authCode,
        username: user.username,
        energy: user.energy
      }
    });
  } catch (error) {
    console.error('生成识别码失败:', error);
    res.status(500).json({ error: '生成识别码失败' });
  }
});

// 编辑用户能量和体力
router.put('/users/:id/stats', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const adminId = req.user.id;
    const { energy, stamina } = req.body;

    // 验证参数
    if (energy === undefined && stamina === undefined) {
      return res.status(400).json({ error: '至少需要提供energy或stamina之一' });
    }

    // 验证数值范围
    if (energy !== undefined) {
      const energyNum = parseInt(energy, 10);
      if (isNaN(energyNum) || energyNum < 0) {
        return res.status(400).json({ error: '能量值不能为负数' });
      }
    }

    if (stamina !== undefined) {
      const staminaNum = parseInt(stamina, 10);
      if (isNaN(staminaNum) || staminaNum < 0 || staminaNum > 100) {
        return res.status(400).json({ error: '体力值必须在0-100之间' });
      }
    }

    // 检查用户是否存在
    const users = await db.query('SELECT id, username, energy, stamina FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const oldEnergy = users[0].energy;
    const oldStamina = users[0].stamina;

    // 构建更新SQL
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
    
    params.push(userId);

    // 更新用户数据
    await db.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    // 获取更新后的数据
    const updatedUsers = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [userId]);
    const newEnergy = updatedUsers[0].energy;
    const newStamina = updatedUsers[0].stamina;

    // 如果用户在线，通过Socket.io通知更新
    const io = getIO();
    if (io) {
      // 安全地转换能量和体力值（管理员可以设置超过100的能量，比如PK胜利后的奖励）
      let finalEnergy = newEnergy != null ? Number(newEnergy) : 0;
      if (isNaN(finalEnergy)) finalEnergy = 0;
      finalEnergy = Math.max(0, finalEnergy); // 只确保不小于0，允许超过100
      
      let finalStamina = newStamina != null ? Number(newStamina) : 0;
      if (isNaN(finalStamina)) finalStamina = 0;
      finalStamina = Math.max(0, Math.min(100, finalStamina)); // 体力上限100
      
      // 通过socket.io查找该用户的所有连接并发送更新
      const sockets = await io.fetchSockets();
      for (const socket of sockets) {
        if (socket.userId === userId) {
          io.to(socket.id).emit('player_update', {
            energy: finalEnergy,
            stamina: finalStamina,
            canPK: finalEnergy >= 100
          });
        }
      }
    }

    // 记录操作日志
    await logAdminAction(adminId, 'edit_user_stats', userId, {
      username: users[0].username,
      oldEnergy,
      oldStamina,
      newEnergy,
      newStamina
    });

    res.json({
      success: true,
      message: '用户数据更新成功'
    });
  } catch (error) {
    console.error('编辑用户数据失败:', error);
    res.status(500).json({ error: '编辑用户数据失败' });
  }
});

// 修改用户密码
router.put('/users/:id/password', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const adminId = req.user.id;
    const { password } = req.body;

    // 验证参数
    if (!password) {
      return res.status(400).json({ error: '请提供新密码' });
    }

    // 验证密码长度
    if (password.length < 6) {
      return res.status(400).json({ error: '密码长度至少6位' });
    }

    if (password.length > 20) {
      return res.status(400).json({ error: '密码长度不能超过20位' });
    }

    // 检查用户是否存在
    const users = await db.query('SELECT id, username FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // 加密新密码
    const hashedPassword = await bcrypt.hash(password, 10);

    // 更新密码
    await db.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);

    // 记录操作日志
    await logAdminAction(adminId, 'change_password', userId, {
      username: users[0].username,
      action: '修改密码'
    });

    res.json({
      success: true,
      message: '密码修改成功'
    });
  } catch (error) {
    console.error('修改密码失败:', error);
    res.status(500).json({ error: '修改密码失败' });
  }
});

// 获取统计数据
router.get('/stats', async (req, res) => {
  try {
    // 总用户数
    const totalUsers = await db.query('SELECT COUNT(*) as count FROM users');
    
    // 在线用户数（通过Socket.io连接数，这里简化处理）
    const activeUsers = await db.query('SELECT COUNT(*) as count FROM users WHERE status = ?', ['active']);
    
    // 被封禁用户数
    const bannedUsers = await db.query('SELECT COUNT(*) as count FROM users WHERE status = ?', ['banned']);
    
    // 今日注册用户数
    const todayUsers = await db.query(
      'SELECT COUNT(*) as count FROM users WHERE DATE(created_at) = CURDATE()'
    );
    
    // 总PK战斗次数
    const totalPk = await db.query('SELECT COUNT(*) as count FROM pk_records');
    
    // 今日PK战斗次数
    const todayPk = await db.query(
      'SELECT COUNT(*) as count FROM pk_records WHERE DATE(created_at) = CURDATE()'
    );
    
    // 平台总能量池（从MySQL数据库实时获取，不使用默认值）
    const rooms = await db.query('SELECT SUM(platform_pool) as total FROM game_rooms');
    const platformPoolTotal = rooms.length > 0 && rooms[0].total !== null && rooms[0].total !== undefined
      ? parseInt(rooms[0].total, 10)
      : 0;
    
    // 用户总能量
    const totalEnergy = await db.query('SELECT SUM(total_energy) as total FROM users');
    const totalEnergyValue = totalEnergy.length > 0 && totalEnergy[0].total !== null && totalEnergy[0].total !== undefined
      ? parseInt(totalEnergy[0].total, 10)
      : 0;
    
    // 最近7天注册趋势
    const registerTrend = await db.query(`
      SELECT DATE(created_at) as date, COUNT(*) as count 
      FROM users 
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);

    res.json({
      success: true,
      data: {
        users: {
          total: totalUsers[0].count,
          active: activeUsers[0].count,
          banned: bannedUsers[0].count,
          today: todayUsers[0].count
        },
        game: {
          totalPk: totalPk[0].count,
          todayPk: todayPk[0].count,
          platformPool: platformPoolTotal,  // 使用MySQL数据库真实值
          totalEnergy: totalEnergyValue
        },
        trends: {
          registerTrend: registerTrend
        }
      }
    });
  } catch (error) {
    console.error('获取统计数据失败:', error);
    res.status(500).json({ error: '获取统计数据失败' });
  }
});

// 获取已领取的宝藏节点ID集合（每个节点全局仅可被领取一次）
async function getClaimedTreasureNodeIds() {
  try {
    const claims = await db.query('SELECT DISTINCT node_id FROM treasure_claims');
    return new Set(claims.map(c => parseInt(c.node_id, 10)));
  } catch (error) {
    console.error('获取已领取宝藏节点失败:', error);
    return new Set();
  }
}

// 获取游戏配置
router.get('/config', async (req, res) => {
  try {
    const configs = await db.query('SELECT config_key, config_value, description FROM game_config');
    const configMap = {};
    const { isSensitive } = require('../utils/config-validator');
    
    configs.forEach(item => {
      // 对敏感配置进行脱敏处理（只显示前4位和后4位，中间用*代替）
      let displayValue = item.config_value;
      if (isSensitive(item.config_key) && item.config_value && item.config_value.length > 8) {
        const value = item.config_value;
        displayValue = value.substring(0, 4) + '*'.repeat(Math.min(value.length - 8, 20)) + value.substring(value.length - 4);
      }
      
      configMap[item.config_key] = {
        value: displayValue,
        description: item.description,
        isSensitive: isSensitive(item.config_key)
      };
    });

    // 添加平台池余额信息（使用calculatePlatformPool计算：剩余能量宝藏 + PK平局累计）
    try {
      const rooms = await db.query('SELECT id FROM game_rooms WHERE status = ? ORDER BY id ASC', ['waiting']);
      if (rooms.length > 0) {
        // 如果只有一个房间，直接返回该房间的平台池
        // 如果有多个房间，返回第一个房间的平台池（可以根据需要扩展为支持多房间）
        const platformPool = await calculatePlatformPool(rooms[0].id);
        configMap.platform_pool = {
          value: platformPool.toString(),
          description: '平台能量池余额'
        };
      } else {
        configMap.platform_pool = {
          value: '0',
          description: '平台能量池余额'
        };
      }
    } catch (e) {
      console.error('获取平台池余额失败:', e);
      configMap.platform_pool = {
        value: '0',
        description: '平台能量池余额'
      };
    }

    res.json({
      success: true,
      data: configMap
    });
  } catch (error) {
    console.error('获取游戏配置失败:', error);
    res.status(500).json({ error: '获取游戏配置失败' });
  }
});

// 更新游戏配置
router.put('/config', async (req, res) => {
  try {
    const { configs } = req.body;
    const adminId = req.user.id;

    if (!configs || typeof configs !== 'object') {
      return res.status(400).json({ error: '配置格式错误' });
    }

    // 导入配置验证工具
    const { validateConfigs, isSensitive, encryptSensitiveValue } = require('../utils/config-validator');
    const minimax = require('../utils/minimax');
    
    // 验证配置值
    const validationResult = validateConfigs(configs);
    if (!validationResult.valid) {
      return res.status(400).json({ 
        error: '配置验证失败', 
        errors: validationResult.errors 
      });
    }
    
    // 处理敏感配置的加密
    const jwtSecret = process.env.JWT_SECRET || 'energy-mountain-secret-key-change-in-production';
    const processedConfigs = {};
    for (const [key, value] of Object.entries(validationResult.normalized)) {
      if (isSensitive(key) && value && value.trim().length > 0) {
        // 如果值已经是脱敏格式（包含*），则不更新
        if (value.includes('*') && value.length < 50) {
          // 跳过脱敏值，不更新
          continue;
        }
        // 加密敏感值
        processedConfigs[key] = encryptSensitiveValue(value, jwtSecret);
      } else {
        processedConfigs[key] = value;
      }
    }

    // 如果包含 platform_pool 配置，更新游戏房间的平台池余额
    let platformPoolUpdated = false;
    let newPlatformPool = null;
    if (configs.platform_pool !== undefined) {
      try {
        const platformPoolValue = parseInt(configs.platform_pool, 10);
        
        // 验证平台池值（非负整数，上限999999999）
        if (isNaN(platformPoolValue) || platformPoolValue < 0 || platformPoolValue > 999999999) {
          return res.status(400).json({ error: '平台池余额必须在0-999999999之间' });
        }

        // 更新所有活跃房间的平台池（支持 waiting 和 playing 状态）
        await db.query(
          'UPDATE game_rooms SET platform_pool = ? WHERE status IN (?, ?)',
          [platformPoolValue, 'waiting', 'playing']
        );

        newPlatformPool = platformPoolValue;
        platformPoolUpdated = true;

        // 通过Socket.io实时广播给所有房间内的用户
        const io = getIO();
        if (io) {
          const rooms = await db.query('SELECT id FROM game_rooms WHERE status IN (?, ?)', ['waiting', 'playing']);
          for (const room of rooms) {
            // 获取宝藏配置信息
            const treasureConfig = await require('../socket').getTreasureConfig();
            const treasureInfo = {
              configured: treasureConfig.length > 0,
              nodeCount: treasureConfig.length,
              totalAmount: treasureConfig.reduce((sum, t) => sum + (parseInt(t.amount, 10) || 0), 0)
            };
            io.to(`room_${room.id}`).emit('game_state', {
              type: 'platform_pool_update',
              platformPool: platformPoolValue,
              treasureInfo
            });
          }
        }

        // 从configs中移除platform_pool，因为它不是game_config表的配置项
        delete configs.platform_pool;
      } catch (e) {
        console.error('更新平台池失败:', e);
        return res.status(500).json({ error: '更新平台池失败' });
      }
    }

    // 如果包含 energy_treasure 配置，更新游戏房间的 energy_treasure_total 字段
    let treasureTotalUpdated = false;
    if (configs.energy_treasure !== undefined) {
      try {
        // 计算新配置的总金额
        let treasureArr = [];
        if (typeof configs.energy_treasure === 'string') {
          treasureArr = JSON.parse(configs.energy_treasure);
        } else if (Array.isArray(configs.energy_treasure)) {
          treasureArr = configs.energy_treasure;
        }
        const newTreasureTotal = Array.isArray(treasureArr)
          ? treasureArr.reduce((sum, t) => sum + (parseInt(t.amount, 10) || 0), 0)
          : 0;

        // 获取当前 energy_treasure_total（兼容字段不存在的情况）
        // 支持 waiting 和 playing 状态的游戏房间
        const roomRows = await db.query('SELECT id, energy_treasure_total, platform_pool FROM game_rooms WHERE status IN (?, ?)', ['waiting', 'playing']);
        if (roomRows.length > 0) {
          const currentTreasureTotal = (roomRows[0].energy_treasure_total !== undefined && roomRows[0].energy_treasure_total !== null)
            ? parseInt(roomRows[0].energy_treasure_total, 10) || 0
            : 0;

          // 只有当新配置金额增加时才重置已领取金额（表示新一轮宝藏配置）
          // 当配置金额减少或删除时，保留已领取金额，避免平台池异常增加
          const shouldResetClaimed = newTreasureTotal > currentTreasureTotal;

          if (shouldResetClaimed) {
            await db.query(
              'UPDATE game_rooms SET energy_treasure_total = ?, energy_treasure_claimed = 0 WHERE status IN (?, ?)',
              [newTreasureTotal, 'waiting', 'playing']
            );
          } else {
            await db.query(
              'UPDATE game_rooms SET energy_treasure_total = ? WHERE status IN (?, ?)',
              [newTreasureTotal, 'waiting', 'playing']
            );
          }
          treasureTotalUpdated = true;

          // 广播平台池更新（包含宝藏配置信息）
          const io = getIO();
          if (io) {
            const rooms = await db.query('SELECT id FROM game_rooms WHERE status IN (?, ?)', ['waiting', 'playing']);
            for (const room of rooms) {
              const newPlatformPool = await require('../socket').calculatePlatformPool(room.id);
              // 获取宝藏配置信息
              const treasureConfig = await require('../socket').getTreasureConfig();
              const treasureInfo = {
                configured: treasureConfig.length > 0,
                nodeCount: treasureConfig.length,
                totalAmount: treasureConfig.reduce((sum, t) => sum + (parseInt(t.amount, 10) || 0), 0)
              };
              io.to(`room_${room.id}`).emit('game_state', {
                type: 'platform_pool_update',
                platformPool: newPlatformPool,
                treasureInfo: treasureInfo
              });
              // 通过 Redis Stream 消息队列发布配置更新事件（用于多实例同步）
              try {
                await treasureStream.publishTreasureConfigUpdated({
                  treasureConfig,
                  totalAmount: treasureInfo.totalAmount,
                  platformPool: newPlatformPool
                });
              } catch (tsErr) {
                console.error('[TreasureStream] 发布配置更新消息失败:', tsErr.message);
              }
            }
          }
        }
      } catch (e) {
        console.error('更新能量宝藏总额失败:', e);
      }
    }

    // 更新配置（energy_treasure 等新配置键可能不存在，使用 INSERT ... ON DUPLICATE KEY UPDATE）
    // 使用处理后的配置（包含加密的敏感值），如果没有处理过的配置则使用原始配置
    // 合并processedConfigs和configs（确保energy_treasure等配置也被包含）
    const configsToUpdate = { ...configs, ...processedConfigs };
    // 敏感项若未在 processedConfigs 中（如脱敏显示值被跳过），则不写回 DB，避免用脱敏串覆盖真实加密密钥
    for (const key of Object.keys(configsToUpdate)) {
      if (isSensitive(key) && !(key in processedConfigs)) {
        delete configsToUpdate[key];
      }
    }
    for (const [key, value] of Object.entries(configsToUpdate)) {
      const strValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
      await db.query(
        'INSERT INTO game_config (config_key, config_value, description) VALUES (?, ?, "") ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)',
        [key, strValue]
      );
    }

    // 记录操作日志（包含平台池更新信息，敏感配置只记录是否更新，不记录实际值）
    const logData = {};
    for (const [key, value] of Object.entries(configsToUpdate)) {
      if (isSensitive(key)) {
        logData[key] = '[已更新]'; // 敏感配置不记录实际值
      } else {
        logData[key] = value;
      }
    }
    if (platformPoolUpdated) {
      logData.platform_pool = newPlatformPool;
    }
    await logAdminAction(adminId, 'update_config', null, {
      configs: logData
    });

    // 清除 minimax 与百炼配置缓存，保证下次测试或业务从 DB 重新加载
    minimax.clearConfigCache();
    try {
      const bailian = require('../utils/bailian');
      if (bailian.clearConfigCache) bailian.clearConfigCache();
    } catch (e) {
      // bailian 模块可能尚未存在
    }

    // 清除 OSS 配置缓存
    try {
      const oss = require('../utils/oss');
      if (oss.clearConfigCache) {
        oss.clearConfigCache();
      }
      if (oss.resetClient) {
        oss.resetClient();
      }
    } catch (e) {
      console.error('清除OSS配置缓存失败:', e.message);
    }

    res.json({
      success: true,
      message: '配置更新成功'
    });
  } catch (error) {
    console.error('更新游戏配置失败:', error);
    res.status(500).json({ error: '更新游戏配置失败' });
  }
});

// 获取操作日志
router.get('/logs', async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const logs = await db.query(`
      SELECT al.*, u.username as admin_name, u2.username as target_name
      FROM admin_logs al
      LEFT JOIN users u ON al.admin_id = u.id
      LEFT JOIN users u2 ON al.target_id = u2.id
      ORDER BY al.created_at DESC
      LIMIT ? OFFSET ?
    `, [parseInt(limit), parseInt(offset)]);

    const countResult = await db.query('SELECT COUNT(*) as total FROM admin_logs');
    const total = countResult[0].total;

    res.json({
      success: true,
      data: logs.map(log => ({
        ...log,
        details: log.details ? JSON.parse(log.details) : null
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('获取操作日志失败:', error);
    res.status(500).json({ error: '获取操作日志失败' });
  }
});

// 测试Minimax API连接
router.post('/config/test-minimax', async (req, res) => {
  try {
    const minimax = require('../utils/minimax');
    const result = await minimax.testConnection();
    
    res.json({
      success: result.success,
      data: result,
      message: result.success ? 'API连接测试成功' : 'API连接测试失败'
    });
  } catch (error) {
    console.error('测试Minimax API连接失败:', error);
    res.status(500).json({ 
      success: false,
      error: '测试失败: ' + error.message 
    });
  }
});

// 测试百炼 API 连接
router.post('/config/test-bailian', async (req, res) => {
  try {
    const bailian = require('../utils/bailian');
    const result = await bailian.testConnection();

    res.json({
      success: result.success,
      data: result,
      message: result.success ? '百炼连接测试成功' : '百炼连接测试失败'
    });
  } catch (error) {
    console.error('测试百炼 API 连接失败:', error);
    res.status(500).json({
      success: false,
      error: '测试失败: ' + error.message
    });
  }
});

// 测试 OSS 连接
router.post('/config/test-oss', async (req, res) => {
  try {
    const OSS = require('ali-oss');
    const { accessKeyId, accessKeySecret, bucket, region, endpoint, accelerateDomain } = req.body;

    if (!accessKeyId || !accessKeySecret || !bucket) {
      return res.status(400).json({
        success: false,
        error: '请提供完整的OSS配置信息'
      });
    }

    // 创建临时的OSS客户端进行测试
    const ossClient = new OSS({
      region: region || 'oss-cn-shenzhen',
      accessKeyId: accessKeyId,
      accessKeySecret: accessKeySecret,
      bucket: bucket,
      endpoint: endpoint || `${region || 'oss-cn-shenzhen'}.aliyuncs.com`,
      secure: true,
      timeout: 10000
    });

    // 尝试列出Bucket中的文件（测试连接）
    await ossClient.list({
      maxKeys: 1
    });

    res.json({
      success: true,
      message: 'OSS连接测试成功'
    });
  } catch (error) {
    console.error('测试OSS连接失败:', error);
    res.status(500).json({
      success: false,
      error: 'OSS连接测试失败: ' + error.message
    });
  }
});

// ============================================================
// 游戏房间管理 API (SAAS模式)
// ============================================================

// 生成邀请码
function generateInviteCode(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// 获取房间列表
router.get('/rooms', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, status, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    
    let whereClause = '1=1';
    const params = [];
    
    if (status !== undefined) {
      whereClause += ' AND is_active = ?';
      params.push(status === '1' ? 1 : 0);
    }
    
    if (search) {
      whereClause += ' AND (room_name LIKE ? OR room_description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    
    // 获取总数
    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM game_rooms WHERE ${whereClause}`,
      params
    );
    const total = countResult[0].total;
    
    // 获取列表（关联查询宝藏信息和当前玩家数）
    const rooms = await db.query(
      `SELECT 
        r.*,
        (SELECT COUNT(*) FROM game_nodes gn WHERE gn.room_id = r.id AND gn.owner_id IS NOT NULL) as current_players,
        (SELECT SUM(amount) FROM room_treasures WHERE room_id = r.id AND is_claimed = 0) as available_treasure
       FROM game_rooms r
       WHERE ${whereClause}
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(pageSize), offset]
    );
    
    res.json({
      success: true,
      data: rooms,
      pagination: {
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        total,
        totalPages: Math.ceil(total / parseInt(pageSize))
      }
    });
  } catch (error) {
    console.error('获取房间列表失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取房间详情
router.get('/rooms/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    
    const rooms = await db.query(
      `SELECT r.*,
        (SELECT COUNT(*) FROM game_nodes gn WHERE gn.room_id = r.id AND gn.owner_id IS NOT NULL) as current_players
       FROM game_rooms r WHERE r.id = ?`,
      [roomId]
    );
    
    if (rooms.length === 0) {
      return res.status(404).json({ success: false, error: '房间不存在' });
    }
    
    // 获取宝藏配置
    const treasures = await db.query(
      'SELECT * FROM room_treasures WHERE room_id = ? ORDER BY node_id',
      [roomId]
    );
    
    // 计算平台池
    const platformPool = await calculatePlatformPool(roomId);
    
    res.json({
      success: true,
      data: {
        ...rooms[0],
        treasures,
        platformPool
      }
    });
  } catch (error) {
    console.error('获取房间详情失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 创建房间
router.post('/rooms', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { 
      room_name, 
      room_description, 
      room_password, 
      max_players = 100, 
      is_public = true,
      treasures = [],
      occupy_energy_cost
    } = req.body;
    
    // 验证必填字段
    if (!room_name) {
      return res.status(400).json({ success: false, error: '请输入房间名称' });
    }
    
    // 确保所有参数都不是 undefined
    const safeParams = {
      room_name: room_name || '',
      room_description: room_description || null, 
      room_password: room_password || null,
      max_players: max_players || 100,
      is_public: is_public ? 1 : 0,
      invite_code: generateInviteCode(),
      creator_id: req.user.id || null,
      occupy_energy_cost: typeof occupy_energy_cost === 'number' ? occupy_energy_cost : null
    };
    
    // 计算宝藏总能量
    const treasureTotal = treasures.reduce((sum, t) => sum + (parseInt(t.amount, 10) || 0), 0);
    
    console.log('创建房间参数:', {
      room_name, room_description, room_password, max_players, is_public, 
      treasures, treasureTotal, occupy_energy_cost
    });
    
    // 开启事务
    await db.transaction(async (conn) => {
      // 创建房间
      const result = await conn.execute(
        `INSERT INTO game_rooms (room_name, room_description, room_password, max_players, is_public, is_active, invite_code, creator_id, energy_treasure_total, platform_pool, occupy_energy_cost)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        [safeParams.room_name, safeParams.room_description, safeParams.room_password, safeParams.max_players, safeParams.is_public, safeParams.invite_code, safeParams.creator_id, treasureTotal, treasureTotal, safeParams.occupy_energy_cost]
      );
      
      // result 是数组 [ResultSetHeader, undefined]
      const insertId = Array.isArray(result) ? result[0]?.insertId : result?.insertId;
      
      if (!insertId) {
        throw new Error('无法获取新创建的房间ID');
      }
      
      const roomId = insertId;
      
      // 插入宝藏配置
      console.log('开始插入宝藏配置, count:', treasures.length);
      for (const treasure of treasures) {
        // 确保每个值都是有效数字
        const nodeId = parseInt(treasure.nodeId || treasure.node_id, 10);
        const amount = parseInt(treasure.amount, 10);
        
        // 跳过无效的配置
        if (isNaN(nodeId) || isNaN(amount) || nodeId < 1 || nodeId > 100 || amount < 1) {
          continue;
        }
        
        await conn.execute(
          'INSERT INTO room_treasures (room_id, node_id, amount) VALUES (?, ?, ?)',
          [roomId, nodeId, amount]
        );
      }
      
      // 初始化节点（如果没有初始化的话）- 使用批量插入更高效
      // 使用 conn.execute 而不是 conn.query，确保正确获取结果
      const [existingNodes] = await conn.query('SELECT COUNT(*) as count FROM game_nodes WHERE room_id = ?', [roomId]);
      const nodeCount = existingNodes[0]?.count ?? 0;
      
      if (nodeCount === 0) {
        console.log(`[创建房间] 为房间${roomId}初始化100个游戏节点`);
        // 批量插入100个节点
        const nodeValues = [];
        for (let i = 1; i <= 100; i++) {
          nodeValues.push([roomId, i, 5]);
        }
        // 批量插入
        const batchInsert = 'INSERT INTO game_nodes (room_id, node_id, energy_production) VALUES ?';
        await conn.query(batchInsert, [nodeValues]);
        
        // 验证插入结果
        const [verifyResult] = await conn.query('SELECT COUNT(*) as count FROM game_nodes WHERE room_id = ?', [roomId]);
        console.log(`[创建房间] 房间${roomId}节点初始化完成，共${verifyResult[0]?.count ?? 0}个节点`);
      } else {
        console.log(`[创建房间] 房间${roomId}已有${nodeCount}个节点，跳过初始化`);
      }
    });
    
    res.json({ success: true, message: '房间创建成功' });
  } catch (error) {
    console.error('创建房间失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 更新房间配置
router.put('/rooms/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    const { 
      room_name, 
      room_description, 
      room_password, 
      max_players, 
      is_public,
      is_active,
      treasures,
      occupy_energy_cost
    } = req.body;
    
    // 检查房间是否存在
    const existingRooms = await db.query('SELECT * FROM game_rooms WHERE id = ?', [roomId]);
    if (existingRooms.length === 0) {
      return res.status(404).json({ success: false, error: '房间不存在' });
    }
    
    // 计算宝藏总能量
    const treasureTotal = treasures ? treasures.reduce((sum, t) => sum + (parseInt(t.amount) || 0), 0) : 0;
    
    await db.transaction(async (conn) => {
      // 更新房间基本信息
      const updates = [];
      const params = [];
      
      if (room_name !== undefined) { updates.push('room_name = ?'); params.push(room_name); }
      if (room_description !== undefined) { updates.push('room_description = ?'); params.push(room_description); }
      if (room_password !== undefined) { updates.push('room_password = ?'); params.push(room_password || null); }
      if (max_players !== undefined) { updates.push('max_players = ?'); params.push(max_players); }
      if (is_public !== undefined) { updates.push('is_public = ?'); params.push(is_public ? 1 : 0); }
      if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
      if (treasureTotal > 0) { updates.push('energy_treasure_total = ?'); params.push(treasureTotal); }
      if (occupy_energy_cost !== undefined) { updates.push('occupy_energy_cost = ?'); params.push(occupy_energy_cost || null); }
      
      if (updates.length > 0) {
        params.push(roomId);
        await conn.execute(
          `UPDATE game_rooms SET ${updates.join(', ')} WHERE id = ?`,
          params
        );
      }
      
      // 更新宝藏配置（如果提供了）
      if (treasures && Array.isArray(treasures)) {
        // 删除旧配置
        await conn.execute('DELETE FROM room_treasures WHERE room_id = ?', [roomId]);
        
        // 插入新配置
        for (const treasure of treasures) {
          const nodeId = treasure.nodeId || treasure.node_id;
          const amount = treasure.amount;
          
          if (!nodeId || !amount) {
            console.warn('跳过无效的宝藏配置:', treasure);
            continue;
          }
          
          await conn.execute(
            'INSERT INTO room_treasures (room_id, node_id, amount) VALUES (?, ?, ?)',
            [roomId, parseInt(nodeId), parseInt(amount)]
          );
        }
        
        // 更新宝藏总能量
        await conn.execute(
          'UPDATE game_rooms SET energy_treasure_total = ? WHERE id = ?',
          [treasureTotal, roomId]
        );
      }
    });
    
    // 广播配置更新给房间内的玩家
    const io = require('../socket').getIO();
    if (io) {
      io.to(`room_${roomId}`).emit('room_config_updated', { roomId });
    }
    
    res.json({ success: true, message: '房间配置更新成功' });
  } catch (error) {
    console.error('更新房间配置失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 删除房间
router.delete('/rooms/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    
    // 不允许删除默认房间
    if (roomId === 1) {
      return res.status(400).json({ success: false, error: '无法删除默认房间' });
    }
    
    // 检查房间是否有人
    const rooms = await db.query(
      'SELECT (SELECT COUNT(*) FROM game_nodes WHERE room_id = ? AND owner_id IS NOT NULL) as player_count',
      [roomId]
    );
    
    if (rooms[0].player_count > 0) {
      return res.status(400).json({ success: false, error: '房间内还有玩家，无法删除' });
    }
    
    await db.transaction(async (conn) => {
      // 删除宝藏配置
      await conn.execute('DELETE FROM room_treasures WHERE room_id = ?', [roomId]);
      // 删除节点
      await conn.execute('DELETE FROM game_nodes WHERE room_id = ?', [roomId]);
      // 删除房间
      await conn.execute('DELETE FROM game_rooms WHERE id = ?', [roomId]);
    });
    
    res.json({ success: true, message: '房间删除成功' });
  } catch (error) {
    console.error('删除房间失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 调整PK奖励（平台池）
router.post('/rooms/:id/pk-bonus', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    const { amount } = req.body;
    
    if (typeof amount !== 'number' || amount === 0) {
      return res.status(400).json({ success: false, error: '请输入有效的调整金额' });
    }
    
    // 当前平台池
    const rooms = await db.query('SELECT platform_pool FROM game_rooms WHERE id = ?', [roomId]);
    if (rooms.length === 0) {
      return res.status(404).json({ success: false, error: '房间不存在' });
    }
    
    const newPool = (parseInt(rooms[0].platform_pool) || 0) + amount;
    
    await db.execute(
      'UPDATE game_rooms SET platform_pool = ? WHERE id = ?',
      [Math.max(0, newPool), roomId]
    );
    
    // 广播平台池更新
    const io = require('../socket').getIO();
    if (io) {
      const newPoolValue = await calculatePlatformPool(roomId);
      io.to(`room_${roomId}`).emit('game_state', {
        type: 'platform_pool_update',
        platformPool: newPoolValue
      });
    }
    
    res.json({ 
      success: true, 
      message: amount > 0 ? '已增加PK奖励' : '已扣除PK奖励',
      newPool: Math.max(0, newPool)
    });
  } catch (error) {
    console.error('调整PK奖励失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 生成/获取邀请链接
router.get('/rooms/:id/invite-link', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    
    const rooms = await db.query('SELECT invite_code, room_password, is_public FROM game_rooms WHERE id = ?', [roomId]);
    if (rooms.length === 0) {
      return res.status(404).json({ success: false, error: '房间不存在' });
    }
    
    const room = rooms[0];
    
    // 从游戏配置中获取客户端URL
    const configRows = await db.query(
      "SELECT config_value FROM game_config WHERE config_key = 'client_socket_url'",
      []
    );
    const baseUrl = (configRows.length > 0 && configRows[0].config_value) 
      ? configRows[0].config_value 
      : 'https://your-domain.com';
    
    const inviteLink = `${baseUrl}/game.html?room=${roomId}&code=${room.invite_code}`;
    
    res.json({
      success: true,
      data: {
        roomId,
        inviteCode: room.invite_code,
        inviteLink,
        hasPassword: !!room.room_password,
        isPublic: room.is_public === 1
      }
    });
  } catch (error) {
    console.error('生成邀请链接失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取当前房间已被占据的节点列表
module.exports = router;
