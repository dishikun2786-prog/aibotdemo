/**
 * @file ai-agents.js
 * @module routes/ai-agents
 * @description AI智能体相关路由：初始化、对话、设定、记忆管理
 */
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');
const minimax = require('../utils/minimax');
const bailian = require('../utils/bailian');
const memoryManager = require('../utils/memory-manager');
const mongo = require('../utils/mongo');
const redis = require('../utils/redis');
const messageQueue = require('../services/message-queue');

/**
 * 从 game_config 读取对话/图片能量消耗
 * @param {string} configKey - 'ai_agent_energy_cost' | 'ai_agent_image_energy_cost'
 * @param {number} fallback - 默认值
 * @returns {Promise<number>}
 */
async function getEnergyCostFromConfig(configKey, fallback = 5) {
  try {
    const rows = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      [configKey]
    );
    if (rows.length === 0 || rows[0].config_value == null) return fallback;
    const n = parseInt(rows[0].config_value, 10);
    return isNaN(n) ? fallback : Math.max(0, Math.min(100, n));
  } catch (e) {
    return fallback;
  }
}

/**
 * 获取当前 AI 服务提供商配置（minimax | bailian）
 * @returns {Promise<string>}
 */
async function getAiProvider() {
  try {
    const rows = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      ['ai_provider']
    );
    const value = rows.length > 0 ? (rows[0].config_value || '').toLowerCase().trim() : '';
    return value === 'bailian' ? 'bailian' : 'minimax';
  } catch (e) {
    return 'minimax';
  }
}

/**
 * 获取当前 AI 提供商模块（与 minimax 接口对齐）
 * @returns {Promise<Object>} 提供 testConnection, generateInitialGreeting, generateConversation, generateImage, createVideoTask, queryVideoTask, generateSpeech
 */
async function getAiProviderModule() {
  const provider = await getAiProvider();
  return provider === 'bailian' ? bailian : minimax;
}

/**
 * 检查AI智能体多模态功能是否启用
 * 注意：此函数仅用于检查图片/视频/语音等多模态功能的开关状态
 * 基础对话功能不受此函数影响，始终可用
 * @param {string} featureName - 功能名称（'image', 'video', 'voice'）
 * @returns {Promise<boolean>} 功能是否启用
 */
async function checkFeatureEnabled(featureName) {
  try {
    const configKey = `ai_agent_${featureName}_enabled`;
    const configs = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      [configKey]
    );
    
    if (configs.length === 0) {
      // 如果配置不存在，默认启用
      return true;
    }
    
    const value = configs[0].config_value;
    // 处理字符串形式的boolean值
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true' || value === '1';
    }
    
    return !!value;
  } catch (error) {
    console.error(`[功能检查] 检查${featureName}功能失败:`, error);
    // 出错时默认启用，避免影响正常使用
    return true;
  }
}

/**
 * 清理和验证字符串，确保可以安全保存到数据库
 * @param {string} text - 要清理的文本
 * @returns {string} 清理后的文本
 */
function cleanTextForDB(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }
  
  // 确保不超过TEXT字段的最大长度（65,535字节）
  // UTF-8中，一个字符最多4字节，所以安全长度约为16,000字符
  const maxLength = 16000;
  if (text.length > maxLength) {
    text = text.substring(0, maxLength);
  }
  
  // 更严格的UTF-8验证和修复
  try {
    // 先尝试正常编码
    let buffer = Buffer.from(text, 'utf8');
    let validated = buffer.toString('utf8');
    
    // 移除所有无效字符和替换字符
    validated = validated.replace(/\uFFFD/g, '');
    
    // 移除可能导致问题的控制字符（保留常用字符：换行\n、回车\r、制表符\t）
    // 移除范围：\x00-\x08 (NULL到BS), \x0B-\x0C (VT和FF), \x0E-\x1F (SO到US), \x7F-\x9F (DEL和控制字符)
    validated = validated.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '');
    
    // 再次验证编码
    buffer = Buffer.from(validated, 'utf8');
    const finalText = buffer.toString('utf8');
    
    // 最终检查：确保没有替换字符
    return finalText.replace(/\uFFFD/g, '');
  } catch (e) {
    console.error('[数据清理] UTF-8编码验证失败:', e.message);
    // 如果失败，尝试移除所有非ASCII字符（极端情况，保留基本ASCII字符和常用空白字符）
    try {
      const fallback = text.replace(/[^\x20-\x7E\n\r\t]/g, '').substring(0, maxLength);
      return Buffer.from(fallback, 'utf8').toString('utf8');
    } catch (e2) {
      console.error('[数据清理] 降级清理也失败:', e2.message);
      return '';
    }
  }
}

/**
 * 测试MiniMAX API连接（管理员功能）
 * GET /api/ai-agents/test-connection
 */
router.get('/test-connection', authenticateToken, async (req, res) => {
  try {
    // 检查是否为管理员
    if (!req.user.is_admin) {
      return res.status(403).json({ 
        success: false,
        error: '仅管理员可以执行此操作' 
      });
    }

    console.log('[API测试] 管理员请求测试MiniMAX API连接');
    const ai = await getAiProviderModule();
    const testResult = await ai.testConnection();
    
    res.json({
      success: true,
      testResult
    });
  } catch (error) {
    console.error('[API测试] 测试失败:', error);
    res.status(500).json({ 
      success: false,
      error: '测试失败: ' + error.message 
    });
  }
});

/**
 * 初始化AI智能体（首次登录时调用）
 * POST /api/ai-agents/initialize
 */
router.post('/initialize', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const username = req.user.username;
    const { name } = req.body;

    console.log(`[AI智能体初始化] 开始为用户 ${username} (ID: ${userId}) 初始化AI智能体`);

    // 检查用户是否已有AI智能体
    const existingAgents = await db.query(
      'SELECT id FROM ai_agents WHERE user_id = ?',
      [userId]
    );

    if (existingAgents.length > 0) {
      console.log(`[AI智能体初始化] 用户 ${username} 已存在AI智能体，ID: ${existingAgents[0].id}`);
      return res.status(400).json({ 
        success: false,
        error: 'AI智能体已存在' 
      });
    }

    // 处理名字参数：如果提供了名字，使用它；否则使用默认名字
    const agentName = name && name.trim() ? cleanTextForDB(name.trim()) : `AI智能体_${username}`;
    // 如果提供了名字，标记为已初始化；否则需要后续设置
    const isInitialized = name && name.trim() ? 1 : 0;
    
    console.log(`[AI智能体初始化] AI智能体名称: ${agentName}, 是否已初始化: ${isInitialized}`);

    // 查询用户的当前能量（统一使用用户表能量字段）
    const userInfo = await db.query(
      'SELECT energy FROM users WHERE id = ?',
      [userId]
    );

    // 初始化时直接使用用户表的能量字段，新用户能量为0
    const userEnergy = userInfo.length > 0 && userInfo[0].energy !== null 
      ? parseInt(userInfo[0].energy, 10) 
      : 0;
    
    // 确保新注册用户初始化后能量为0
    if (userEnergy !== 0) {
      // 如果用户能量不为0，重置为0（新用户首次初始化应该为0）
      await db.query('UPDATE users SET energy = 0 WHERE id = ?', [userId]);
      console.log(`[AI智能体初始化] 用户 ${username} 能量已重置为0（新用户初始化）`);
    } else {
      console.log(`[AI智能体初始化] 用户 ${username} 当前能量为0，符合新用户初始化要求`);
    }

    // 根据当前 AI 提供商检查 API 配置（bailian 已由 testConnection 校验）
    const provider = await getAiProvider();
    const ai = await getAiProviderModule();
    if (provider === 'minimax') {
      const apiKey = process.env.MINIMAX_API_KEY;
      if (!apiKey || apiKey === 'your_minimax_api_key' || apiKey.trim().length === 0) {
        const dbKey = await minimax.getConfig('minimax_api_key');
        if (!dbKey || dbKey === 'your_minimax_api_key' || String(dbKey).trim().length === 0) {
          console.error('[AI智能体初始化] MINIMAX_API_KEY 未配置或使用默认值');
          return res.status(500).json({
            success: false,
            error: 'AI服务配置错误：API密钥未配置',
            errorCode: 'CONFIG_ERROR',
            errorDetails: '请在 .env 或管理后台配置有效的 MiniMAX API 密钥。获取密钥：https://platform.minimaxi.com/user-center/basic-information/interface-key'
          });
        }
      }
    }
    console.log(`[AI智能体初始化] 使用 AI 提供商: ${provider}`);

    console.log(`[AI智能体初始化] 开始生成首次见面对话`);
    const greeting = await ai.generateInitialGreeting(username);
    console.log(`[AI智能体初始化] 首次见面对话生成成功，长度: ${greeting.length}`);

    // 清理和验证对话内容，确保可以安全保存到数据库
    const cleanGreeting = cleanTextForDB(greeting);
    console.log(`[AI智能体初始化] 对话内容清理完成，清理后长度: ${cleanGreeting.length}`);

    // 创建AI智能体记录（不设置energy字段，统一使用用户表energy字段）
    console.log(`[AI智能体初始化] 开始创建AI智能体数据库记录，能量统一使用用户表字段（当前为0）`);
    const result = await db.query(
      `INSERT INTO ai_agents (user_id, name, is_initialized) 
       VALUES (?, ?, ?)`,
      [userId, agentName, isInitialized]
    );

    const agentId = result.insertId;
    console.log(`[AI智能体初始化] AI智能体记录创建成功，ID: ${agentId}，能量统一使用用户表字段（当前为0）`);

    // 保存首次对话记录
    try {
      await db.query(
        `INSERT INTO ai_agent_conversations (agent_id, user_message, agent_message, energy_cost) 
         VALUES (?, ?, ?, 0)`,
        [agentId, '初始化', cleanGreeting, 0]
      );
      console.log(`[AI智能体初始化] 首次对话记录保存成功`);
    } catch (dbError) {
      // 如果保存对话记录失败，记录错误但不影响主流程
      console.error(`[AI智能体初始化] 保存对话记录失败:`, dbError);
      console.error(`[AI智能体初始化] 错误详情:`, {
        code: dbError.code,
        errno: dbError.errno,
        sqlMessage: dbError.sqlMessage,
        message: dbError.message
      });
      
      // 如果是字符编码错误，提供更友好的错误信息
      if (dbError.code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD') {
        console.error(`[AI智能体初始化] 字符编码错误 - 可能是数据库字符集配置问题或内容包含特殊字符`);
        console.error(`[AI智能体初始化] 建议检查：1. 数据库表字符集是否为 utf8mb4；2. 数据库连接字符集配置`);
        // 不抛出错误，允许智能体创建成功，只是对话记录保存失败
      } else {
        // 其他数据库错误，重新抛出
        throw dbError;
      }
    }

    // 再次查询用户能量（统一使用用户表能量字段）
    const finalUserInfo = await db.query('SELECT energy FROM users WHERE id = ?', [userId]);
    const finalEnergy = finalUserInfo.length > 0 && finalUserInfo[0].energy !== null 
      ? parseInt(finalUserInfo[0].energy, 10) 
      : 0;
    
    console.log(`[AI智能体初始化] 初始化完成，用户: ${username}, 智能体ID: ${agentId}, 能量: ${finalEnergy}（来自用户表）`);
    res.json({
      success: true,
      message: 'AI智能体初始化成功',
      agent: {
        id: agentId,
        greeting: cleanGreeting,
        energy: finalEnergy // 统一使用用户表能量字段
      }
    });
  } catch (error) {
    console.error('[AI智能体初始化] 初始化失败:', error);
    console.error('[AI智能体初始化] 错误堆栈:', error.stack);
    console.error('[AI智能体初始化] 错误详情:', {
      message: error.message,
      code: error.code,
      name: error.name,
      response: error.response ? {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      } : null
    });
    
    // 根据错误类型返回不同的错误信息
    // 优先检查 error.code（网络错误），然后检查 error.message
    let errorMessage = '初始化AI智能体失败，请稍后重试';
    let errorCode = 'UNKNOWN_ERROR';
    let errorDetails = null;
    
    // 优先检查网络错误代码
    if (error.code === 'ECONNREFUSED') {
      errorMessage = '无法连接到AI服务，请检查网络连接';
      errorCode = 'NETWORK_ERROR';
      errorDetails = '连接被拒绝，服务器可能无法访问外网。请检查防火墙是否允许访问 api.minimax.io:443';
    } else if (error.code === 'ETIMEDOUT') {
      errorMessage = 'AI服务响应超时，请稍后重试';
      errorCode = 'TIMEOUT_ERROR';
      errorDetails = '请求超时，请检查网络连接或稍后重试';
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = '无法解析AI服务域名，请联系管理员';
      errorCode = 'DNS_ERROR';
      errorDetails = 'DNS解析失败，请检查服务器DNS配置';
    } else     if (error.message && error.message.includes('MINIMAX_API_KEY')) {
      errorMessage = 'AI服务配置错误：API密钥未配置或无效';
      errorCode = 'CONFIG_ERROR';
      errorDetails = '请在 .env 文件中配置有效的 MINIMAX_API_KEY。获取密钥：https://platform.minimaxi.com/user-center/basic-information/interface-key';
    } else if (error.message && error.message.includes('ER_NO_SUCH_TABLE')) {
      errorMessage = '数据库表不存在，请联系管理员';
      errorCode = 'DATABASE_ERROR';
      errorDetails = '请执行数据库迁移脚本创建 ai_agents 表';
    } else if (error.message && (error.message.includes('API调用失败') || error.message.includes('MiniMAX API') || error.message.includes('无法连接') || error.message.includes('超时') || error.message.includes('DNS') || error.message.includes('解析') || error.message.includes('invalid api key') || error.message.includes('api key'))) {
      // MiniMAX API 调用失败
      errorCode = 'API_ERROR';
      if (error.message.includes('invalid api key') || error.message.includes('api key')) {
        errorMessage = 'API密钥无效，请检查配置';
        errorDetails = 'API密钥可能已过期或无效。请访问 https://platform.minimaxi.com/user-center/basic-information/interface-key 重新获取有效的API密钥，并确保已正确配置到 .env 文件中';
      } else if (error.message.includes('无法连接')) {
        errorMessage = '无法连接到AI服务，请检查网络连接';
        errorDetails = '服务器无法访问 api.minimax.io，请检查防火墙设置';
      } else if (error.message.includes('超时')) {
        errorMessage = 'AI服务响应超时，请稍后重试';
        errorDetails = '请求超时，可能是网络延迟或服务繁忙';
      } else if (error.message.includes('DNS') || error.message.includes('解析')) {
        errorMessage = '无法解析AI服务域名，请联系管理员';
        errorDetails = 'DNS解析失败，请检查服务器DNS配置';
      } else {
        errorMessage = 'AI服务暂时不可用，请稍后重试';
        errorDetails = error.message;
      }
    }
    
    res.status(500).json({ 
      success: false,
      error: errorMessage,
      errorCode: errorCode,
      errorDetails: errorDetails,
      // 开发环境返回详细错误信息
      ...(process.env.NODE_ENV !== 'production' && {
        debug: {
          message: error.message,
          code: error.code,
          stack: error.stack
        }
      })
    });
  }
});

/**
 * 获取当前用户的AI智能体信息
 * GET /api/ai-agents/my-agent
 */
router.get('/my-agent', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 查询智能体信息，JOIN用户表获取能量（统一使用用户表能量字段）
    const agents = await db.query(
      `SELECT a.id, a.name, a.role, a.appearance, a.is_initialized, a.created_at, a.updated_at,
              u.energy
       FROM ai_agents a
       INNER JOIN users u ON a.user_id = u.id
       WHERE a.user_id = ?`,
      [userId]
    );

    if (agents.length === 0) {
      return res.json({
        success: true,
        agent: null,
        needsInitialization: true
      });
    }

    const agent = agents[0];
    res.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        role: typeof agent.role === 'string' ? JSON.parse(agent.role) : agent.role,
        appearance: typeof agent.appearance === 'string' ? JSON.parse(agent.appearance) : agent.appearance,
        energy: parseInt(agent.energy, 10) || 0, // 统一使用用户表能量字段
        isInitialized: agent.is_initialized === 1,
        createdAt: agent.created_at,
        updatedAt: agent.updated_at
      },
      needsInitialization: agent.is_initialized === 0
    });
  } catch (error) {
    console.error('获取AI智能体信息失败:', error);
    res.status(500).json({ error: '获取AI智能体信息失败，请稍后重试' });
  }
});

const DEFAULT_SKIN_IMAGE_PATH = '/bg/180.png';

/**
 * GET /api/ai-agents/skins/list - 已拥有皮肤 + 可兑换皮肤列表
 */
router.get('/skins/list', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const owned = await db.query(
      `SELECT s.id, s.name, s.description, s.image_path, s.energy_price, s.pk_attack, s.pk_defense
       FROM user_ai_agent_skins uas
       INNER JOIN ai_agent_skins s ON uas.skin_id = s.id
       WHERE uas.user_id = ? AND s.is_active = 1
       ORDER BY s.sort_order ASC, s.id ASC`,
      [userId]
    );
    const ownedIds = owned.map(r => r.id);
    let available;
    if (ownedIds.length === 0) {
      available = await db.query(
        `SELECT id, name, description, image_path, energy_price, pk_attack, pk_defense
         FROM ai_agent_skins WHERE is_active = 1 ORDER BY sort_order ASC, id ASC`
      );
    } else {
      available = await db.query(
        `SELECT id, name, description, image_path, energy_price, pk_attack, pk_defense
         FROM ai_agent_skins WHERE is_active = 1 AND id NOT IN (?)
         ORDER BY sort_order ASC, id ASC`,
        [ownedIds]
      );
    }
    res.json({ success: true, data: { owned, available } });
  } catch (error) {
    console.error('获取皮肤列表失败:', error);
    res.status(500).json({ error: '获取皮肤列表失败' });
  }
});

/**
 * POST /api/ai-agents/skins/activate-by-code - 通过激活码激活皮肤
 */
router.post('/skins/activate-by-code', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const code = (req.body.code || '').trim().toUpperCase();
    if (!code) {
      return res.status(400).json({ error: '请输入激活码' });
    }
    const codes = await db.query(
      'SELECT id, skin_id, user_id FROM ai_agent_skin_codes WHERE code = ?',
      [code]
    );
    if (codes.length === 0) {
      return res.status(404).json({ error: '激活码无效' });
    }
    const row = codes[0];
    if (row.user_id != null && row.user_id !== userId) {
      return res.status(400).json({ error: '该激活码已被其他用户使用' });
    }
    if (row.user_id === userId) {
      const owned = await db.query(
        'SELECT skin_id FROM user_ai_agent_skins WHERE user_id = ? AND skin_id = ?',
        [userId, row.skin_id]
      );
      if (owned.length > 0) {
        const skin = await db.query('SELECT * FROM ai_agent_skins WHERE id = ?', [row.skin_id]);
        return res.json({ success: true, data: skin[0], message: '您已拥有该皮肤' });
      }
    }
    await db.transaction(async (conn) => {
      await conn.query(
        'UPDATE ai_agent_skin_codes SET user_id = ?, used_at = NOW() WHERE id = ?',
        [userId, row.id]
      );
      await conn.query(
        'INSERT INTO user_ai_agent_skins (user_id, skin_id, source, code_id) VALUES (?, ?, ?, ?)',
        [userId, row.skin_id, 'activation_code', row.id]
      );
    });
    const skin = await db.query('SELECT * FROM ai_agent_skins WHERE id = ?', [row.skin_id]);
    res.json({ success: true, data: skin[0], message: '激活成功' });
  } catch (error) {
    console.error('激活码激活失败:', error);
    res.status(500).json({ error: '激活失败，请稍后重试' });
  }
});

/**
 * POST /api/ai-agents/skins/exchange - 能量兑换皮肤
 */
router.post('/skins/exchange', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const skinId = parseInt(req.body.skin_id, 10);
    if (isNaN(skinId)) {
      return res.status(400).json({ error: '请选择要兑换的皮肤' });
    }
    const skins = await db.query(
      'SELECT id, energy_price FROM ai_agent_skins WHERE id = ? AND is_active = 1',
      [skinId]
    );
    if (skins.length === 0) {
      return res.status(404).json({ error: '皮肤不存在或已下架' });
    }
    const price = skins[0].energy_price;
    const owned = await db.query(
      'SELECT id FROM user_ai_agent_skins WHERE user_id = ? AND skin_id = ?',
      [userId, skinId]
    );
    if (owned.length > 0) {
      return res.status(400).json({ error: '您已拥有该皮肤' });
    }
    const users = await db.query('SELECT energy FROM users WHERE id = ?', [userId]);
    const currentEnergy = parseInt(users[0]?.energy, 10) || 0;
    if (currentEnergy < price) {
      return res.status(400).json({
        error: `能量不足，需要 ${price} 点能量`,
        energy: currentEnergy,
        required: price
      });
    }
    await db.transaction(async (conn) => {
      await conn.query('UPDATE users SET energy = GREATEST(0, energy - ?) WHERE id = ?', [price, userId]);
      await conn.query(
        'INSERT INTO user_ai_agent_skins (user_id, skin_id, source) VALUES (?, ?, ?)',
        [userId, skinId, 'energy_exchange']
      );
    });
    const skin = await db.query('SELECT * FROM ai_agent_skins WHERE id = ?', [skinId]);
    res.json({ success: true, data: skin[0], message: '兑换成功' });
  } catch (error) {
    console.error('能量兑换皮肤失败:', error);
    res.status(500).json({ error: '兑换失败，请稍后重试' });
  }
});

/**
 * GET /api/ai-agents/current-skin - 当前选中的皮肤（未设置则返回默认）
 */
router.get('/current-skin', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const users = await db.query(
      'SELECT current_skin_id FROM users WHERE id = ?',
      [userId]
    );
    let skinId = users[0]?.current_skin_id != null ? parseInt(users[0].current_skin_id, 10) : null;
    if (skinId) {
      const skins = await db.query(
        'SELECT id, name, image_path, energy_price, pk_attack, pk_defense FROM ai_agent_skins WHERE id = ? AND is_active = 1',
        [skinId]
      );
      const owned = await db.query(
        'SELECT id FROM user_ai_agent_skins WHERE user_id = ? AND skin_id = ?',
        [userId, skinId]
      );
      if (skins.length > 0 && owned.length > 0) {
        return res.json({ success: true, data: skins[0] });
      }
    }
    const defaultSkin = await db.query(
      "SELECT id, name, image_path, energy_price, pk_attack, pk_defense FROM ai_agent_skins WHERE image_path = ? AND is_active = 1 LIMIT 1",
      [DEFAULT_SKIN_IMAGE_PATH]
    );
    const data = defaultSkin[0] || {
      id: null,
      name: '默认皮肤',
      image_path: DEFAULT_SKIN_IMAGE_PATH,
      energy_price: 0,
      pk_attack: 0,
      pk_defense: 0
    };
    res.json({ success: true, data });
  } catch (error) {
    console.error('获取当前皮肤失败:', error);
    res.status(500).json({ error: '获取当前皮肤失败' });
  }
});

/**
 * PUT /api/ai-agents/current-skin - 设置当前使用的皮肤
 */
router.put('/current-skin', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const skinId = parseInt(req.body.skin_id, 10);
    if (isNaN(skinId)) {
      return res.status(400).json({ error: '请选择皮肤' });
    }
    const owned = await db.query(
      'SELECT id FROM user_ai_agent_skins WHERE user_id = ? AND skin_id = ?',
      [userId, skinId]
    );
    if (owned.length === 0) {
      const skin = await db.query('SELECT id FROM ai_agent_skins WHERE id = ? AND is_active = 1', [skinId]);
      if (skin.length === 0) {
        return res.status(404).json({ error: '皮肤不存在或您尚未拥有' });
      }
      return res.status(403).json({ error: '您尚未拥有该皮肤，请先兑换或使用激活码' });
    }
    await db.query('UPDATE users SET current_skin_id = ? WHERE id = ?', [skinId, userId]);
    const skins = await db.query(
      'SELECT id, name, image_path, energy_price, pk_attack, pk_defense FROM ai_agent_skins WHERE id = ?',
      [skinId]
    );
    res.json({ success: true, data: skins[0], message: '设置成功' });
  } catch (error) {
    console.error('设置当前皮肤失败:', error);
    res.status(500).json({ error: '设置当前皮肤失败' });
  }
});

/**
 * 发送消息给AI智能体（基础对话功能）
 * POST /api/ai-agents/conversation
 * 
 * 注意：此API不受图片/视频/语音功能开关影响，基础对话功能始终可用
 * 功能开关（ai_agent_image_enabled、ai_agent_video_enabled、ai_agent_voice_enabled）
 * 仅影响对应的多模态API，不影响此基础对话API
 */
router.post('/conversation', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { message, context, thread_id: bodyThreadId, images: bodyImages } = req.body;
    const isStudio = context === 'studio';
    const threadIdFromBody = isStudio && bodyThreadId != null ? parseInt(bodyThreadId, 10) : null;
    const trimmedMessage = typeof message === 'string' ? message.trim() : '';
    const images = Array.isArray(bodyImages) ? bodyImages : [];
    const imageDataUrls = images.map(item => item && (item.data_url || (item.base64 && item.mime ? `data:${item.mime};base64,${item.base64}` : null))).filter(Boolean);

    if (trimmedMessage.length === 0 && imageDataUrls.length === 0) {
      return res.status(400).json({ error: '消息内容不能为空' });
    }

    // 获取用户的AI智能体（包括参数偏好设置），JOIN用户表获取能量（统一使用用户表能量字段）
    const agents = await db.query(
      `SELECT a.id, a.role, a.appearance, a.is_initialized, a.model_preferences,
              u.energy
       FROM ai_agents a
       INNER JOIN users u ON a.user_id = u.id
       WHERE a.user_id = ?`,
      [userId]
    );

    if (agents.length === 0) {
      return res.status(404).json({ error: 'AI智能体不存在，请先初始化' });
    }

    const agent = agents[0];
    const userEnergy = parseInt(agent.energy, 10) || 0; // 统一使用用户表能量字段

    const conversationEnergyCost = await getEnergyCostFromConfig('ai_agent_energy_cost', 5);

    // 检查能量是否充足
    if (userEnergy < conversationEnergyCost) {
      return res.status(400).json({ 
        error: '能量不足，无法进行对话',
        energy: userEnergy,
        required: conversationEnergyCost
      });
    }

    // 获取用户游戏状态（使用缓存优化）；工作室模式不传游戏状态与剧情
    let userGameState = null;
    let storyProgress = null;
    if (!isStudio) {
      const userCacheKey = `user_game_state:${req.user.id}`;
      userGameState = await redis.get(userCacheKey);
      
      if (!userGameState) {
        const [userStats, nodeInfo] = await Promise.all([
          db.query('SELECT energy, stamina, total_energy, wins, losses, draws, has_used_first_free_occupy FROM users WHERE id = ?', [req.user.id]),
          db.query('SELECT node_id FROM game_nodes WHERE owner_id = ? LIMIT 1', [req.user.id])
        ]);

        userGameState = userStats[0] ? {
          energy: userStats[0].energy,
          stamina: userStats[0].stamina,
          totalEnergy: userStats[0].total_energy,
          pkRecord: {
            wins: userStats[0].wins || 0,
            losses: userStats[0].losses || 0,
            draws: userStats[0].draws || 0
          },
          currentNode: nodeInfo[0]?.node_id || null,
          hasUsedFirstFreeOccupy: userStats[0].has_used_first_free_occupy === 1
        } : null;
        
        // 缓存30秒（游戏状态变化较快）
        if (userGameState) {
          await redis.set(userCacheKey, userGameState, 30);
        }
      }

      // 获取用户剧情章节进度
      try {
        // 获取当前章节
        const chapters = await db.query(
        `SELECT id, chapter_number, chapter_title, chapter_description, story_content
         FROM story_chapters 
         WHERE is_active = 1 
         ORDER BY sort_order ASC, chapter_number ASC`
      );

      if (chapters.length > 0) {
        // 找到第一个未完成的章节
        let currentChapter = null;
        for (const chapter of chapters) {
          const chapterProgress = await db.query(
            `SELECT is_completed 
             FROM user_story_progress 
             WHERE user_id = ? AND chapter_id = ?`,
            [userId, chapter.id]
          );
          
          if (chapterProgress.length === 0 || chapterProgress[0].is_completed === 0) {
            currentChapter = chapter;
            break;
          }
        }

        // 如果所有章节都完成，使用最后一个章节
        if (!currentChapter && chapters.length > 0) {
          currentChapter = chapters[chapters.length - 1];
        }

        if (currentChapter) {
          // 获取当前章节的任务列表
          const tasks = await db.query(
            `SELECT id, task_type, task_title, task_description, task_hint, target_value, stamina_reward
             FROM story_tasks 
             WHERE chapter_id = ? AND is_active = 1 
             ORDER BY sort_order ASC`,
            [currentChapter.id]
          );

          // 获取用户任务进度
          const taskProgresses = await db.query(
            `SELECT task_id, progress_value, is_completed 
             FROM user_task_progress 
             WHERE user_id = ? AND task_id IN (?)`,
            [userId, tasks.map(t => t.id)]
          );

          // 找到当前任务（第一个未完成的任务）
          let currentTask = null;
          for (const task of tasks) {
            const taskProgress = taskProgresses.find(tp => tp.task_id === task.id);
            if (!taskProgress || taskProgress.is_completed === 0) {
              currentTask = {
                ...task,
                progress: taskProgress ? {
                  progressValue: taskProgress.progress_value,
                  isCompleted: false
                } : {
                  progressValue: 0,
                  isCompleted: false
                }
              };
              break;
            }
          }

          storyProgress = {
            chapter: currentChapter,
            currentTask: currentTask,
            allTasks: tasks.map(task => {
              const taskProgress = taskProgresses.find(tp => tp.task_id === task.id);
              return {
                ...task,
                progress: taskProgress ? {
                  progressValue: taskProgress.progress_value,
                  isCompleted: taskProgress.is_completed === 1
                } : {
                  progressValue: 0,
                  isCompleted: false
                }
              };
            })
          };
        }
      }
    } catch (storyError) {
      console.error('获取剧情进度失败:', storyError);
      // 不影响主流程，继续执行
    }
    }

    // 检查并更新chat_with_ai任务进度
    if (storyProgress && storyProgress.currentTask && storyProgress.currentTask.task_type === 'chat_with_ai') {
      try {
        const taskId = storyProgress.currentTask.id;
        const taskProgresses = await db.query(
          `SELECT progress_value, is_completed 
           FROM user_task_progress 
           WHERE user_id = ? AND task_id = ?`,
          [userId, taskId]
        );

        if (taskProgresses.length === 0 || taskProgresses[0].is_completed === 0) {
          // 更新任务进度（首次对话完成）
          const currentProgress = taskProgresses.length > 0 ? taskProgresses[0].progress_value : 0;
          const newProgress = currentProgress + 1;
          const targetValue = storyProgress.currentTask.target_value || 1;

          if (taskProgresses.length > 0) {
            await db.query(
              `UPDATE user_task_progress 
               SET progress_value = ?, updated_at = NOW() 
               WHERE user_id = ? AND task_id = ?`,
              [newProgress, userId, taskId]
            );
          } else {
            await db.query(
              `INSERT INTO user_task_progress (user_id, task_id, progress_value) 
               VALUES (?, ?, ?)`,
              [userId, taskId, newProgress]
            );
          }

          // 如果达到目标值，自动完成任务
          if (newProgress >= targetValue) {
            // 这里不直接完成任务，让用户通过API完成，避免重复奖励
            // 但可以更新进度标记为可完成
          }
        }
      } catch (taskError) {
        console.error('更新chat_with_ai任务进度失败:', taskError);
        // 不影响主流程
      }
    }

    // 构建对话消息历史（工作室按会话线程，非工作室按短期记忆）
    let conversationMessages = [];
    let threadIdForDb = null;
    let threadIdForResponse = null;

    if (isStudio) {
      if (threadIdFromBody) {
        // 已有会话：按 thread_id 取该会话最近 N 条构建上下文
        const rows = await db.query(
          `SELECT user_message, agent_message FROM ai_agent_conversations 
           WHERE thread_id = ? AND agent_id = ? 
           ORDER BY created_at ASC LIMIT 20`,
          [threadIdFromBody, agent.id]
        );
        if (rows && rows.length > 0) {
          rows.forEach(row => {
            if (row.user_message && String(row.user_message).trim()) {
              conversationMessages.push({ role: 'user', content: String(row.user_message).trim() });
            }
            if (row.agent_message && String(row.agent_message).trim()) {
              conversationMessages.push({ role: 'assistant', content: String(row.agent_message).trim() });
            }
          });
        }
        conversationMessages.push({ role: 'user', content: trimmedMessage });
        threadIdForDb = threadIdFromBody;
        threadIdForResponse = threadIdFromBody;
      } else {
        // 新建会话：创建线程（MySQL + MongoDB 双写），仅当前一条用户消息
        const title = trimmedMessage.length > 20 ? trimmedMessage.substring(0, 20) + '...' : trimmedMessage;
        const insertResult = await db.query(
          'INSERT INTO ai_agent_conversation_threads (agent_id, title) VALUES (?, ?)',
          [agent.id, title]
        );
        const newThreadId = insertResult.insertId;
        threadIdForDb = newThreadId;
        threadIdForResponse = newThreadId;
        conversationMessages = [{ role: 'user', content: trimmedMessage }];
        try {
          await mongo.insertAgentConversationThread({ threadId: newThreadId, agentId: agent.id, title, createdAt: new Date() });
        } catch (mongoThreadErr) {
          console.warn('MongoDB insertAgentConversationThread 失败，不影响主流程:', mongoThreadErr.message);
        }
      }
    } else {
      // 非工作室：使用短期记忆构建上下文
      const memories = await memoryManager.getAllMemories(agent.id);
      if (memories.short && memories.short.conversations) {
        memories.short.conversations.forEach(conv => {
          if (conv.user && typeof conv.user === 'string' && conv.user.trim().length > 0) {
            conversationMessages.push({ role: 'user', content: conv.user.trim() });
          }
          if (conv.agent && typeof conv.agent === 'string' && conv.agent.trim().length > 0) {
            conversationMessages.push({ role: 'assistant', content: conv.agent.trim() });
          }
        });
      }
      if (trimmedMessage.length > 0 || imageDataUrls.length > 0) {
        conversationMessages.push({ role: 'user', content: trimmedMessage });
      }
    }

    if (conversationMessages.length === 0) {
      return res.status(400).json({ error: '消息内容无效' });
    }

    // 联网搜索：读取全局开关与“仅工作台”配置
    let webSearchEnabled = false;
    let webSearchStudioOnly = false;
    try {
      const configRows = await db.query(
        'SELECT config_key, config_value FROM game_config WHERE config_key IN (?, ?)',
        ['ai_agent_web_search_enabled', 'ai_agent_web_search_studio_only']
      );
      const configMap = {};
      configRows.forEach(r => { configMap[r.config_key] = (r.config_value || '').toLowerCase().trim(); });
      webSearchEnabled = configMap.ai_agent_web_search_enabled === 'true' || configMap.ai_agent_web_search_enabled === '1';
      webSearchStudioOnly = configMap.ai_agent_web_search_studio_only === 'true' || configMap.ai_agent_web_search_studio_only === '1';
    } catch (e) {
      // 配置表或键不存在时保持关闭
    }
    const enableSearch = webSearchEnabled && (!webSearchStudioOnly || isStudio) &&
      (req.body.enable_search !== false); // 允许单次请求关闭；仅当全局开启时允许 body.enable_search 开启

    // 联网搜索额外能量消耗（仅当启用联网时叠加）
    const webSearchEnergyCost = enableSearch ? await getEnergyCostFromConfig('ai_agent_web_search_energy_cost', 5) : 0;
    const totalEnergyCost = conversationEnergyCost + webSearchEnergyCost;
    if (userEnergy < totalEnergyCost) {
      return res.status(400).json({
        error: '能量不足，无法进行对话',
        energy: userEnergy,
        required: totalEnergyCost
      });
    }

    // 获取用户参数偏好设置
    let userPreferences = null;
    if (agent.model_preferences) {
      try {
        userPreferences = typeof agent.model_preferences === 'string' 
          ? JSON.parse(agent.model_preferences) 
          : agent.model_preferences;
      } catch (e) {
        console.error('[对话] 解析用户参数偏好设置失败:', e);
      }
    }

    // 调用MiniMAX API生成回复
    // 工作室模式传 studioMode: true，不传游戏状态与剧情；否则传 gameState、storyProgress
    // 优先使用用户设置的参数，其次使用全局默认值
    const conversationOptions = {
      role: agent.role || null,
      appearance: agent.appearance || null,
      gameState: userGameState,
      storyProgress: storyProgress,
      studioMode: isStudio,
      enableSearch: !!enableSearch
    };

    // 应用用户参数偏好（如果存在）
    if (userPreferences && userPreferences.conversation) {
      if (userPreferences.conversation.temperature !== undefined) {
        conversationOptions.temperature = userPreferences.conversation.temperature;
      }
      if (userPreferences.conversation.max_tokens !== undefined) {
        conversationOptions.maxTokens = userPreferences.conversation.max_tokens;
      }
      if (userPreferences.conversation.top_p !== undefined) {
        conversationOptions.topP = userPreferences.conversation.top_p;
      }
    }

    const messagesForAi = imageDataUrls.length > 0
      ? conversationMessages.slice(0, -1).concat([{
          role: 'user',
          content: imageDataUrls.map(url => ({ image: url })).concat(trimmedMessage ? [{ text: trimmedMessage }] : [])
        }])
      : conversationMessages;

    const ai = await getAiProviderModule();
    const agentMessage = await ai.generateConversation(messagesForAi, conversationOptions);

    // 检查能量是否低于50%，添加提醒（统一使用用户表能量字段）
    const newEnergy = userEnergy - totalEnergyCost;
    let finalMessage = agentMessage;
    
    if (newEnergy < 50 && newEnergy >= totalEnergyCost) {
      finalMessage += '\n\n⚠️ 我的能量不足50%了，主人，我们需要去能量山挖矿PK赚取能量！';
    }

    // 清理和验证消息内容，确保可以安全保存到数据库
    const cleanUserMessage = cleanTextForDB(trimmedMessage);
    const cleanAgentMessage = cleanTextForDB(finalMessage);
    const attachmentsJson = imageDataUrls.length > 0
      ? JSON.stringify(imageDataUrls.map(url => ({ url })))
      : null;

    // 使用事务保存对话记录和更新能量（统一使用用户表能量字段）
    try {
      await db.transaction(async (conn) => {
        try {
          await conn.execute(
            `INSERT INTO ai_agent_conversations (agent_id, thread_id, user_message, user_message_attachments, agent_message, energy_cost)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [agent.id, threadIdForDb, cleanUserMessage, attachmentsJson, cleanAgentMessage, totalEnergyCost]
          );
        } catch (insertErr) {
          if (insertErr.code === 'ER_BAD_FIELD_ERROR' && insertErr.message && insertErr.message.includes('user_message_attachments')) {
            await conn.execute(
              `INSERT INTO ai_agent_conversations (agent_id, thread_id, user_message, agent_message, energy_cost)
               VALUES (?, ?, ?, ?, ?)`,
              [agent.id, threadIdForDb, cleanUserMessage, cleanAgentMessage, totalEnergyCost]
            );
          } else {
            throw insertErr;
          }
        }

        // 更新用户表能量（统一使用用户表能量字段）
        await conn.execute(
          'UPDATE users SET energy = ? WHERE id = ?',
          [newEnergy, userId]
        );

        // 记录能量消耗到MongoDB
        try {
          await mongo.insertEnergyConsumption({
            userId,
            type: 'studio',
            amount: totalEnergyCost,
            mode: enableSearch ? 'web_search' : 'text',
            threadId: threadIdForDb,
            createdAt: new Date()
          });
        } catch (mongoErr) {
          console.error('[AI智能体对话] 记录能量消耗失败:', mongoErr.message);
        }
      });
    } catch (dbError) {
      // 如果保存对话记录失败，记录错误
      console.error(`[AI智能体对话] 保存对话记录失败:`, dbError);
      console.error(`[AI智能体对话] 错误详情:`, {
        code: dbError.code,
        errno: dbError.errno,
        sqlMessage: dbError.sqlMessage,
        message: dbError.message
      });

      // 如果是字符编码错误，提供更友好的错误信息
      if (dbError.code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD') {
        console.error(`[AI智能体对话] 字符编码错误 - 可能是数据库字符集配置问题或内容包含特殊字符`);
        console.error(`[AI智能体对话] 建议检查：1. 数据库表字符集是否为 utf8mb4；2. 数据库连接字符集配置`);
        // 即使保存失败，也返回对话结果给用户，只是记录没有保存
      } else {
        // 其他数据库错误，重新抛出
        throw dbError;
      }
    }

    // 立即返回响应（核心逻辑完成）
    const payload = {
      success: true,
      message: cleanAgentMessage,
      energy: newEnergy,
      energyCost: totalEnergyCost,
      lowEnergyWarning: newEnergy < 50,
      web_search_enabled: !!enableSearch
    };
    if (isStudio && threadIdForResponse != null) {
      payload.thread_id = threadIdForResponse;
    }
    res.json(payload);

    // 异步任务：MongoDB写入、记忆更新、缓存清除（不阻塞响应）
    try {
      // MongoDB写入
      const mongoDoc = {
        agentId: agent.id,
        userId,
        userMessage: message.trim(),
        agentMessage: finalMessage,
        energyCost: totalEnergyCost,
        energyAfter: newEnergy,
        createdAt: new Date()
      };
      if (threadIdForDb != null) mongoDoc.threadId = threadIdForDb;
      await mongo.insertAgentConversation(mongoDoc).catch(err => console.error('[AI智能体] MongoDB写入失败:', err.message));

      // 短期记忆更新（非工作室）
      if (!isStudio) {
        await memoryManager.addShortTermMemory(agent.id, cleanUserMessage, cleanAgentMessage).catch(err => console.error('[AI智能体] 短期记忆更新失败:', err.message));
        if (await memoryManager.shouldGenerateMediumTermMemory(agent.id)) {
          await memoryManager.addMediumTermMemory(agent.id).catch(err => console.error('[AI智能体] 中期记忆生成失败:', err.message));
        }
      }

      // 清除对话历史缓存
      try {
        const cachePattern = `conversation_history:${agent.id}:*`;
        const keys = await redis.keys(cachePattern);
        if (keys && keys.length > 0) {
          await Promise.all(keys.map(key => redis.del(key)));
        }
      } catch (cacheError) {
        console.warn('[AI智能体] 清除缓存失败:', cacheError.message);
      }
      console.log('[AI智能体] 异步任务完成');
    } catch (asyncErr) {
      console.error('[AI智能体] 异步任务执行失败:', asyncErr.message);
    }
  } catch (error) {
    console.error('[AI智能体对话] 对话失败:', error);
    console.error('[AI智能体对话] 错误堆栈:', error.stack);
    console.error('[AI智能体对话] 错误详情:', {
      message: error.message,
      code: error.code,
      name: error.name
    });
    
    // 根据错误类型返回更具体的错误信息
    let errorMessage = 'AI智能体对话失败，请稍后重试';
    let statusCode = 500;
    
    // API密钥相关错误
    if (error.message && (
      error.message.includes('API密钥') || 
      error.message.includes('MINIMAX_API_KEY') ||
      error.message.includes('Unauthorized') ||
      error.message.includes('authorized_error')
    )) {
      statusCode = 503; // 服务配置错误
      errorMessage = 'AI服务配置错误：API密钥无效，请联系管理员检查配置';
    }
    // 上游 AI 接口返回 400（如百炼参数不兼容）
    else if (error.response && error.response.status === 400) {
      statusCode = 400;
      const apiErr = error.response.data?.error;
      errorMessage = apiErr?.message || apiErr?.code || error.message || 'AI 接口请求参数错误';
    }
    // 网络相关错误
    else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      statusCode = 503;
      errorMessage = 'AI服务暂时不可用，请稍后重试';
    }
    // 数据库相关错误
    else if (error.code && error.code.startsWith('ER_')) {
      statusCode = 500;
      errorMessage = '数据保存失败，请稍后重试';
    }
    
    res.status(statusCode).json({ 
      error: errorMessage,
      // 开发环境返回详细错误信息（可选）
      ...(process.env.NODE_ENV === 'development' && {
        details: error.message,
        code: error.code
      })
    });
  }
});

/**
 * 设定AI智能体角色和形象
 * POST /api/ai-agents/set-role
 */
router.post('/set-role', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    let { role, appearance, name } = req.body;

    // 获取用户的AI智能体
    const agents = await db.query(
      'SELECT id FROM ai_agents WHERE user_id = ?',
      [userId]
    );

    if (agents.length === 0) {
      return res.status(404).json({ error: 'AI智能体不存在，请先初始化' });
    }

    const agentId = agents[0].id;

    // 构建更新数据
    const updateData = {};
    const updateParams = [];

    // 验证和清理 role
    if (role !== undefined) {
      if (typeof role === 'string') {
        // 如果是字符串，尝试解析为JSON
        try {
          const parsed = JSON.parse(role);
          // 确保解析后是有效对象
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            updateData.role = JSON.stringify(parsed);
          } else {
            console.warn('[set-role] role 解析后不是有效对象，使用空对象');
            updateData.role = JSON.stringify({});
          }
        } catch (e) {
          // 如果解析失败，检查是否是有效的JSON字符串格式
          const trimmed = role.trim();
          if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            // 看起来像JSON但解析失败，使用空对象
            console.warn('[set-role] role JSON解析失败，使用空对象:', e.message);
            updateData.role = JSON.stringify({});
          } else {
            // 不是JSON格式，可能是普通字符串，转换为对象
            console.warn('[set-role] role 不是JSON格式，转换为对象');
            updateData.role = JSON.stringify({ description: cleanTextForDB(role) });
          }
        }
      } else if (typeof role === 'object' && role !== null && !Array.isArray(role)) {
        // 如果是对象，转换为JSON字符串
        updateData.role = JSON.stringify(role);
      } else {
        // 其他类型（null、数组等），使用空对象
        console.warn('[set-role] role 类型无效，使用空对象');
        updateData.role = JSON.stringify({});
      }
      updateParams.push(`role = ?`);
    }

    // 验证和清理 appearance（同样的逻辑）
    if (appearance !== undefined) {
      if (typeof appearance === 'string') {
        try {
          const parsed = JSON.parse(appearance);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            updateData.appearance = JSON.stringify(parsed);
          } else {
            console.warn('[set-role] appearance 解析后不是有效对象，使用空对象');
            updateData.appearance = JSON.stringify({});
          }
        } catch (e) {
          const trimmed = appearance.trim();
          if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            console.warn('[set-role] appearance JSON解析失败，使用空对象:', e.message);
            updateData.appearance = JSON.stringify({});
          } else {
            console.warn('[set-role] appearance 不是JSON格式，转换为对象');
            updateData.appearance = JSON.stringify({ description: cleanTextForDB(appearance) });
          }
        }
      } else if (typeof appearance === 'object' && appearance !== null && !Array.isArray(appearance)) {
        updateData.appearance = JSON.stringify(appearance);
      } else {
        console.warn('[set-role] appearance 类型无效，使用空对象');
        updateData.appearance = JSON.stringify({});
      }
      updateParams.push(`appearance = ?`);
    }

    // 清理 name
    if (name !== undefined && name !== null) {
      const cleanedName = cleanTextForDB(String(name));
      if (cleanedName.trim().length > 0) {
        updateData.name = cleanedName.trim();
        updateParams.push(`name = ?`);
      }
    }

    if (updateParams.length === 0) {
      return res.status(400).json({ error: '请提供要更新的内容' });
    }

    // 更新AI智能体信息
    const updateValues = [];
    if (updateData.role !== undefined) updateValues.push(updateData.role);
    if (updateData.appearance !== undefined) updateValues.push(updateData.appearance);
    if (updateData.name !== undefined) updateValues.push(updateData.name);
    updateValues.push(agentId);

    await db.query(
      `UPDATE ai_agents SET ${updateParams.join(', ')} WHERE id = ?`,
      updateValues
    );

    // 更新长期记忆
    if (role !== undefined || appearance !== undefined) {
      const currentAgent = await db.query(
        'SELECT role, appearance FROM ai_agents WHERE id = ?',
        [agentId]
      );
      
      if (currentAgent.length > 0) {
        const agent = currentAgent[0];
        await memoryManager.addLongTermMemory(
          agentId,
          typeof agent.role === 'string' ? JSON.parse(agent.role) : agent.role,
          typeof agent.appearance === 'string' ? JSON.parse(agent.appearance) : agent.appearance
        );
      }
    }

    // 标记为已初始化（如果设置了角色和形象）
    if (role !== undefined && appearance !== undefined) {
      await db.query(
        'UPDATE ai_agents SET is_initialized = 1 WHERE id = ?',
        [agentId]
      );
    }

    res.json({
      success: true,
      message: 'AI智能体设定更新成功'
    });
  } catch (error) {
    console.error('设定AI智能体角色失败:', error);
    res.status(500).json({ error: '设定AI智能体角色失败，请稍后重试' });
  }
});

/**
 * 获取记忆（按类型）
 * GET /api/ai-agents/memories
 */
router.get('/memories', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { type } = req.query; // 'short' | 'medium' | 'long'

    // 获取用户的AI智能体
    const agents = await db.query(
      'SELECT id FROM ai_agents WHERE user_id = ?',
      [userId]
    );

    if (agents.length === 0) {
      return res.status(404).json({ error: 'AI智能体不存在' });
    }

    const agentId = agents[0].id;

    if (type) {
      // 获取指定类型的记忆
      const memory = await memoryManager.getMemories(agentId, type);
      res.json({
        success: true,
        type,
        memory
      });
    } else {
      // 获取所有类型的记忆
      const memories = await memoryManager.getAllMemories(agentId);
      res.json({
        success: true,
        memories
      });
    }
  } catch (error) {
    console.error('获取记忆失败:', error);
    res.status(500).json({ error: '获取记忆失败，请稍后重试' });
  }
});

/**
 * 生成图像（Text-to-Image）
 * POST /api/ai-agents/generate-image
 */
router.post('/generate-image', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // 检查图片生成功能是否启用
    const imageEnabled = await checkFeatureEnabled('image');
    if (!imageEnabled) {
      return res.status(403).json({
        success: false,
        error: '该功能已被管理员禁用'
      });
    }
    
    const { prompt, model, aspect_ratio, width, height, response_format, n, seed, negative_prompt, prompt_extend, watermark, images: bodyImages } = req.body;

    if (!prompt || prompt.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: '请提供图像描述文本'
      });
    }

    // 参考图：0～3 张，每项 data_url 为 data:image/xxx;base64,...，仅 wan2.6-image 使用
    const MAX_REF_IMAGES = 3;
    const MAX_DATA_URL_LEN = 14 * 1024 * 1024; // ~10MB base64 约 13MB 字符
    let images = [];
    if (Array.isArray(bodyImages) && bodyImages.length > 0) {
      const list = bodyImages.slice(0, MAX_REF_IMAGES);
      for (const item of list) {
        const dataUrl = typeof item === 'string' ? item : (item && item.data_url);
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
          continue;
        }
        if (dataUrl.length > MAX_DATA_URL_LEN) {
          return res.status(400).json({
            success: false,
            error: '参考图过大或格式不支持，单张请不超过约 10MB'
          });
        }
        images.push({ data_url: dataUrl });
      }
    }

    const imageEnergyCost = await getEnergyCostFromConfig('ai_agent_image_energy_cost', 5);
    const userRows = await db.query('SELECT energy FROM users WHERE id = ?', [userId]);
    const userEnergy = userRows.length > 0 && userRows[0].energy != null
      ? parseInt(userRows[0].energy, 10) || 0
      : 0;

    if (userEnergy < imageEnergyCost) {
      return res.status(400).json({
        success: false,
        error: '能量不足，无法生成图像',
        energy: userEnergy,
        required: imageEnergyCost
      });
    }

    // 获取用户参数偏好设置
    const agents = await db.query(
      'SELECT id, model_preferences FROM ai_agents WHERE user_id = ?',
      [userId]
    );
    let userPreferences = null;
    const agentId = agents.length > 0 ? agents[0].id : null;
    if (agents.length > 0 && agents[0].model_preferences) {
      try {
        userPreferences = typeof agents[0].model_preferences === 'string' 
          ? JSON.parse(agents[0].model_preferences) 
          : agents[0].model_preferences;
      } catch (e) {
        console.error('[图像生成] 解析用户参数偏好设置失败:', e);
      }
    }

    console.log(`[多模态API] 用户 ${userId} 请求生成图像: ${prompt.substring(0, 50)}...`);

    // 文生图/图生图模型自动匹配：有参考图用图生图模型，否则用文生图模型；未单独配置时回退到 image_model
    const provider = await getAiProvider();
    const t2iKey = provider === 'bailian' ? 'bailian_image_model_t2i' : 'minimax_image_model_t2i';
    const i2iKey = provider === 'bailian' ? 'bailian_image_model_i2i' : 'minimax_image_model_i2i';
    const fallbackKey = provider === 'bailian' ? 'bailian_image_model' : 'minimax_image_model';
    const configRows = await db.query(
      'SELECT config_key, config_value FROM game_config WHERE config_key IN (?, ?, ?)',
      [t2iKey, i2iKey, fallbackKey]
    );
    const configMap = {};
    configRows.forEach(row => { configMap[row.config_key] = row.config_value; });
    const fallbackModel = configMap[fallbackKey] || (provider === 'bailian' ? 'wanx-v1' : 'image-01');
    const resolvedModel = (images && images.length > 0)
      ? (configMap[i2iKey] && String(configMap[i2iKey]).trim() ? configMap[i2iKey] : fallbackModel)
      : (configMap[t2iKey] && String(configMap[t2iKey]).trim() ? configMap[t2iKey] : fallbackModel);

    // 构建选项，优先使用请求体，其次用户偏好；模型由上方自动匹配决定
    const imageOptions = {
      model: resolvedModel,
      aspect_ratio: aspect_ratio ?? userPreferences?.image?.aspect_ratio,
      width,
      height,
      response_format: response_format || 'url',
      n: Math.min(4, Math.max(1, parseInt(n, 10) || 1)),
      seed,
      negative_prompt: negative_prompt ?? userPreferences?.image?.negative_prompt,
      prompt_extend: prompt_extend !== undefined ? !!prompt_extend : (userPreferences?.image?.prompt_extend !== false),
      watermark: watermark === true || userPreferences?.image?.watermark === true,
      images
    };

    const ai = await getAiProviderModule();
    const result = await ai.generateImage(prompt, imageOptions);

    const newEnergy = Math.max(0, userEnergy - imageEnergyCost);
    const userMsgSummary = prompt.length > 200 ? prompt.substring(0, 200) + '...' : prompt;

    try {
      await db.transaction(async (conn) => {
        await conn.execute('UPDATE users SET energy = ? WHERE id = ?', [newEnergy, userId]);
        if (agentId) {
          const firstUrl = result.images && result.images[0] && result.images[0].url
            ? result.images[0].url
            : '[图像]';
          await conn.execute(
            `INSERT INTO ai_agent_conversations (agent_id, user_message, agent_message, energy_cost) VALUES (?, ?, ?, ?)`,
            [agentId, '生成图像: ' + userMsgSummary, firstUrl, imageEnergyCost]
          );
        }
      });

      // 记录能量消耗到MongoDB
      try {
        await mongo.insertEnergyConsumption({
          userId,
          type: 'studio',
          amount: imageEnergyCost,
          mode: 'image',
          threadId: agentId,
          createdAt: new Date()
        });
      } catch (mongoErr) {
        console.error('[图像生成] 记录能量消耗失败:', mongoErr.message);
      }
    } catch (dbErr) {
      console.error('[图像生成] 扣减能量或保存记录失败:', dbErr);
      return res.status(500).json({
        success: false,
        error: '扣减能量失败，请重试'
      });
    }

    res.json({
      success: true,
      ...result,
      energy: newEnergy,
      energyCost: imageEnergyCost,
      lowEnergyWarning: newEnergy < 50
    });
  } catch (error) {
    console.error('[多模态API] 图像生成失败:', error);
    const status = error.response?.status;
    const data = error.response?.data;
    const msg = (data?.message || error.message || '图像生成失败');
    if (status === 400 && data?.code === 'InvalidParameter' && (msg.indexOf('Image dimensions') !== -1 || msg.indexOf('Image dimensions must be') !== -1)) {
      return res.status(400).json({
        success: false,
        error: '参考图尺寸需在 384～5000 像素之间，请上传更大或更清晰的图片。',
        detail: msg
      });
    }
    res.status(500).json({
      success: false,
      error: error.message || '图像生成失败'
    });
  }
});

/**
 * 创建视频生成任务（Text-to-Video）
 * POST /api/ai-agents/create-video-task
 */
router.post('/create-video-task', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // 检查视频生成功能是否启用
    const videoEnabled = await checkFeatureEnabled('video');
    if (!videoEnabled) {
      return res.status(403).json({
        success: false,
        error: '该功能已被管理员禁用'
      });
    }
    
    const { prompt, model, duration, resolution, prompt_optimizer, fast_pretreatment } = req.body;

    if (!prompt || prompt.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: '请提供视频描述文本'
      });
    }

    // 获取用户参数偏好设置
    const agents = await db.query(
      'SELECT model_preferences FROM ai_agents WHERE user_id = ?',
      [userId]
    );
    let userPreferences = null;
    if (agents.length > 0 && agents[0].model_preferences) {
      try {
        userPreferences = typeof agents[0].model_preferences === 'string' 
          ? JSON.parse(agents[0].model_preferences) 
          : agents[0].model_preferences;
      } catch (e) {
        console.error('[视频生成] 解析用户参数偏好设置失败:', e);
      }
    }

    console.log(`[多模态API] 用户 ${userId} 请求创建视频任务: ${prompt.substring(0, 50)}...`);

    // 构建选项，优先使用用户设置的参数
    const videoOptions = {
      model,
      duration: duration !== undefined ? duration : (userPreferences?.video?.duration),
      resolution: resolution || (userPreferences?.video?.resolution),
      prompt_optimizer: prompt_optimizer !== undefined ? prompt_optimizer : true,
      fast_pretreatment: fast_pretreatment !== undefined ? fast_pretreatment : false
    };

    const ai = await getAiProviderModule();
    const result = await ai.createVideoTask(prompt, videoOptions);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[多模态API] 创建视频任务失败:', error);
    res.status(500).json({
      success: false,
      error: error.message || '创建视频任务失败'
    });
  }
});

/**
 * 查询视频生成任务状态
 * GET /api/ai-agents/query-video-task/:taskId
 */
router.get('/query-video-task/:taskId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // 检查视频生成功能是否启用
    const videoEnabled = await checkFeatureEnabled('video');
    if (!videoEnabled) {
      return res.status(403).json({
        success: false,
        error: '该功能已被管理员禁用'
      });
    }
    
    const { taskId } = req.params;

    if (!taskId) {
      return res.status(400).json({
        success: false,
        error: '请提供任务ID'
      });
    }

    console.log(`[多模态API] 用户 ${userId} 查询视频任务状态: ${taskId}`);

    const ai = await getAiProviderModule();
    const result = await ai.queryVideoTask(taskId);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[多模态API] 查询视频任务状态失败:', error);
    res.status(500).json({
      success: false,
      error: error.message || '查询视频任务状态失败'
    });
  }
});

/**
 * 文本转语音（Text-to-Speech/T2A）
 * POST /api/ai-agents/generate-speech
 */
router.post('/generate-speech', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // 检查语音合成功能是否启用
    const voiceEnabled = await checkFeatureEnabled('voice');
    if (!voiceEnabled) {
      return res.status(403).json({
        success: false,
        error: '该功能已被管理员禁用'
      });
    }
    
    const { 
      text, 
      model, 
      voice_id, 
      speed, 
      vol, 
      pitch, 
      format, 
      sample_rate, 
      stream 
    } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: '请提供要合成的文本'
      });
    }

    // 获取用户参数偏好设置
    const agents = await db.query(
      'SELECT model_preferences FROM ai_agents WHERE user_id = ?',
      [userId]
    );
    let userPreferences = null;
    if (agents.length > 0 && agents[0].model_preferences) {
      try {
        userPreferences = typeof agents[0].model_preferences === 'string' 
          ? JSON.parse(agents[0].model_preferences) 
          : agents[0].model_preferences;
      } catch (e) {
        console.error('[语音合成] 解析用户参数偏好设置失败:', e);
      }
    }

    console.log(`[多模态API] 用户 ${userId} 请求语音合成: ${text.substring(0, 50)}...`);

    // 构建选项，优先使用用户设置的参数
    const speechOptions = {
      model,
      voice_id,
      speed: speed !== undefined ? speed : (userPreferences?.speech?.speed),
      vol: vol !== undefined ? vol : (userPreferences?.speech?.vol),
      pitch: pitch !== undefined ? pitch : (userPreferences?.speech?.pitch),
      format: format || 'mp3',
      sample_rate,
      stream: stream || false
    };

    const ai = await getAiProviderModule();
    const result = await ai.generateSpeech(text, speechOptions);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[多模态API] 语音合成失败:', error);
    res.status(500).json({
      success: false,
      error: error.message || '语音合成失败'
    });
  }
});

/**
 * 获取会话线程列表（工作台多会话）：优先 MongoDB，失败回退 MySQL
 * GET /api/ai-agents/conversations/threads
 */
router.get('/conversations/threads', authenticateToken, async (req, res) => {
  try {
    const agent = await db.query('SELECT id FROM ai_agents WHERE user_id = ?', [req.user.id]);
    if (agent.length === 0) {
      return res.status(404).json({ success: false, error: 'AI智能体不存在' });
    }
    const agentId = agent[0].id;
    let threads = [];
    try {
      threads = await mongo.getAgentConversationThreads(agentId);
    } catch (mongoErr) {
      console.warn('MongoDB getAgentConversationThreads 失败，回退 MySQL:', mongoErr.message);
      const rows = await db.query(
        `SELECT id, title, created_at FROM ai_agent_conversation_threads 
         WHERE agent_id = ? ORDER BY created_at DESC`,
        [agentId]
      );
      threads = (rows || []).map(t => ({ id: t.id, title: t.title || '新对话', created_at: t.created_at }));
    }
    res.json({ success: true, threads });
  } catch (error) {
    console.error('获取会话线程列表失败:', error);
    res.status(500).json({ success: false, error: '获取会话线程列表失败' });
  }
});

/**
 * 获取对话历史
 * GET /api/ai-agents/conversations/history
 * 可选 query: thread_id — 指定则仅返回该会话内记录（工作台用）；不传则按 agent 分页（game 等兼容）
 */
router.get('/conversations/history', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const threadId = req.query.thread_id != null ? parseInt(req.query.thread_id, 10) : null;

    const agent = await db.query('SELECT id FROM ai_agents WHERE user_id = ?', [req.user.id]);
    if (agent.length === 0) {
      return res.status(404).json({ success: false, error: 'AI智能体不存在' });
    }

    const agentId = agent[0].id;
    const cacheKey = threadId
      ? `conversation_history:${agentId}:thread:${threadId}:page:${page}:limit:${limit}`
      : `conversation_history:${agentId}:page:${page}:limit:${limit}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    if (threadId) {
      let result;
      try {
        const data = await mongo.getAgentConversationHistoryByThread(agentId, threadId, limit, offset);
        result = {
          success: true,
          conversations: data.conversations,
          pagination: {
            page,
            limit,
            total: data.total,
            totalPages: Math.ceil(data.total / limit)
          }
        };
      } catch (mongoErr) {
        console.warn('MongoDB getAgentConversationHistoryByThread 失败，回退 MySQL:', mongoErr.message);
        let conversations;
        try {
          conversations = await db.query(
            `SELECT user_message, user_message_attachments, agent_message, created_at, energy_cost 
             FROM ai_agent_conversations 
             WHERE agent_id = ? AND thread_id = ? 
             ORDER BY created_at ASC 
             LIMIT ? OFFSET ?`,
            [agentId, threadId, limit, offset]
          );
        } catch (colErr) {
          if (colErr.code === 'ER_BAD_FIELD_ERROR' && colErr.message && colErr.message.includes('user_message_attachments')) {
            conversations = await db.query(
              `SELECT user_message, agent_message, created_at, energy_cost 
               FROM ai_agent_conversations 
               WHERE agent_id = ? AND thread_id = ? 
               ORDER BY created_at ASC 
               LIMIT ? OFFSET ?`,
              [agentId, threadId, limit, offset]
            );
          } else throw colErr;
        }
        const total = await db.query(
          'SELECT COUNT(*) as count FROM ai_agent_conversations WHERE agent_id = ? AND thread_id = ?',
          [agentId, threadId]
        );
        const totalCount = total[0]?.count || 0;
        const norm = (list) => (list || []).map(c => ({
          ...c,
          user_message_attachments: typeof c.user_message_attachments === 'string'
            ? (() => { try { return JSON.parse(c.user_message_attachments || '[]'); } catch (e) { return []; } })()
            : (c.user_message_attachments || [])
        }));
        result = {
          success: true,
          conversations: norm(conversations),
          pagination: { page, limit, total: totalCount, totalPages: Math.ceil(totalCount / limit) }
        };
      }
      await redis.set(cacheKey, result, 300);
      return res.json(result);
    }

    let conversations;
    try {
      conversations = await db.query(
        `SELECT user_message, user_message_attachments, agent_message, created_at, energy_cost 
         FROM ai_agent_conversations 
         WHERE agent_id = ? 
         ORDER BY created_at DESC 
         LIMIT ? OFFSET ?`,
        [agentId, limit, offset]
      );
    } catch (colErr) {
      if (colErr.code === 'ER_BAD_FIELD_ERROR' && colErr.message && colErr.message.includes('user_message_attachments')) {
        conversations = await db.query(
          `SELECT user_message, agent_message, created_at, energy_cost 
           FROM ai_agent_conversations 
           WHERE agent_id = ? 
           ORDER BY created_at DESC 
           LIMIT ? OFFSET ?`,
          [agentId, limit, offset]
        );
      } else throw colErr;
    }

    const total = await db.query(
      'SELECT COUNT(*) as count FROM ai_agent_conversations WHERE agent_id = ?',
      [agentId]
    );

    const normConv = (list) => (list || []).map(c => ({
      ...c,
      user_message_attachments: typeof c.user_message_attachments === 'string'
        ? (() => { try { return JSON.parse(c.user_message_attachments || '[]'); } catch (e) { return []; } })()
        : (c.user_message_attachments || [])
    }));
    const result = {
      success: true,
      conversations: conversations && conversations.length > 0 ? normConv(conversations).reverse() : [],
      pagination: {
        page,
        limit,
        total: total[0]?.count || 0,
        totalPages: Math.ceil((total[0]?.count || 0) / limit)
      }
    };

    await redis.set(cacheKey, result, 300);
    res.json(result);
  } catch (error) {
    console.error('获取对话历史失败:', error);
    res.status(500).json({ success: false, error: '获取对话历史失败' });
  }
});

/**
 * 获取模型配置信息（包括模型和参数配置）
 * GET /api/ai-agents/model-config
 */
router.get('/model-config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 获取用户的AI智能体
    const agents = await db.query(
      'SELECT id, model_preferences FROM ai_agents WHERE user_id = ?',
      [userId]
    );

    if (agents.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'AI智能体不存在，请先初始化' 
      });
    }

    const agent = agents[0];
    let userPreferences = null;
    
    // 解析用户偏好设置
    if (agent.model_preferences) {
      try {
        userPreferences = typeof agent.model_preferences === 'string' 
          ? JSON.parse(agent.model_preferences) 
          : agent.model_preferences;
      } catch (e) {
        console.error('[模型配置] 解析用户偏好设置失败:', e);
      }
    }

    const provider = await getAiProvider();
    const configPrefix = provider === 'bailian' ? 'bailian_%' : 'minimax_%';
    const configs = await db.query(
      'SELECT config_key, config_value FROM game_config WHERE config_key LIKE ?',
      [configPrefix]
    );
    const configMap = {};
    configs.forEach(item => {
      configMap[item.config_key] = item.config_value;
    });

    const MODEL_DESCRIPTIONS_MINIMAX = {
      minimax_default_model: { 'MiniMax-M2.5': 'Peak Performance. Ultimate Value. Master the Complex (输出速度约60 tps)', 'MiniMax-M2.5-highspeed': 'M2.5高速版：相同性能，更快更敏捷 (输出速度约100 tps)', 'MiniMax-M2.1': '强大的多语言编程能力，全面提升编程体验 (输出速度约60 tps)', 'MiniMax-M2.1-highspeed': '更快更敏捷 (输出速度约100 tps)', 'MiniMax-M2': '智能体能力，高级推理' },
      minimax_image_model: { 'image-01': '高质量图像生成模型，产生精细细节。支持文本生成图像和图像生成图像（支持人物主体参考）', 'image-01-live': '实时图像生成模型，支持快速图像生成' },
      minimax_video_model: { 'MiniMax-Hailuo-2.3': '新视频生成模型，在身体动作、面部表情、物理真实感和提示词遵循方面取得突破。支持15种相机运动控制命令', 'MiniMax-Hailuo-02': '视频生成模型，支持更高分辨率（1080P）、更长时长（10秒）和更强的提示词遵循能力。支持15种相机运动控制命令', 'T2V-01-Director': '专业级文本生成视频模型，增强的精确控制和电影美学，卓越的提示词遵循能力。支持15种相机运动控制命令', 'T2V-01': '标准文本生成视频模型' },
      minimax_i2v_model: { 'MiniMax-Hailuo-2.3': '新视频生成模型，在身体动作、面部表情、物理真实感和提示词遵循方面取得突破。支持15种相机运动控制命令', 'MiniMax-Hailuo-2.3-Fast': '新的图像到视频模型，注重价值和效率，快速生成视频', 'MiniMax-Hailuo-02': '视频生成模型，支持更高分辨率（1080P）、更长时长（10秒）和更强的提示词遵循能力。支持15种相机运动控制命令', 'I2V-01-Director': '专业级图生视频模型，增强的精确控制和电影美学，卓越的提示词遵循能力。支持15种相机运动控制命令', 'I2V-01-live': '专用于2D插画的图生视频模型，流畅生动的运动效果，支持多种艺术风格（包括动漫风格）', 'I2V-01': '标准图生视频模型' },
      minimax_t2a_model: { 'speech-2.8-hd': '最新HD模型。完善音调细节。最大化音色相似度', 'speech-2.8-turbo': '最新Turbo模型。完善音调细节。最大化音色相似度', 'speech-2.6-hd': 'HD模型，出色的韵律和优秀的克隆相似度', 'speech-2.6-turbo': 'Turbo模型，支持40种语言', 'speech-02-hd': '卓越的节奏和稳定性，在复制相似度和音质方面表现突出', 'speech-02-turbo': '卓越的节奏和稳定性，增强的多语言能力和出色的性能', 'speech-01-hd': 'HD语音合成模型，提供高质量的语音生成', 'speech-01-turbo': 'Turbo语音合成模型，快速语音生成' }
    };
    const MODEL_DESCRIPTIONS_BAILIAN = {
      bailian_default_model: { 'qwen-max': '千问最强模型，综合能力最佳', 'qwen-plus': '千问推荐模型，性能与成本平衡', 'qwen-turbo': '千问高速模型，响应更快', 'qwen-long': '长文本理解与生成', 'qwen-max-longcontext': '超长上下文模型', 'qwen3.5-plus': '千问 3.5 Plus，支持联网搜索', 'qwen3.5-plus-2026-02-15': '千问 3.5 Plus 快照，支持联网搜索', 'qwen3-max': '千问 3 Max，支持联网搜索', 'qwen3-max-2026-01-23': '千问 3 Max 快照，支持联网搜索', 'qwen3-max-2025-09-23': '千问 3 Max 快照，支持联网搜索' },
      bailian_image_model: { 'wanx-v1': '万相文本生成图像 V1，中英文双语，多种风格', 'wan2.6-image': '万相 2.6 图像生成，支持图像编辑与图文混排', 'qwen-image-max': '千问图像 Max，真实感与文字渲染更强，同步生成', 'qwen-image-max-2025-12-30': '千问图像 Max 时间戳版', 'qwen-image-plus': '千问图像 Plus，多艺术风格与图文混排', 'qwen-image-plus-2026-01-09': '千问图像 Plus 推荐版', 'qwen-image': '千问图像，与 Plus 能力相同' },
      bailian_video_model: { 'wanx2.1-t2v-plus': '万相文生视频 Plus，更高质量', 'wanx2.1-t2v-turbo': '万相文生视频 Turbo，更快生成' },
      bailian_i2v_model: { 'wan2.6-i2v-flash': '万相图生视频 2.6 Flash', 'wan2.5-i2v-preview': '万相图生视频 2.5 Preview' },
      bailian_speech_model: { 'cosyvoice-v3-plus': 'CosyVoice V3 Plus，最佳音质与表现力', 'cosyvoice-v3-flash': 'CosyVoice V3 Flash，性能与成本平衡', 'cosyvoice-v2': 'CosyVoice V2，兼容旧版', 'qwen-tts': '千问 TTS 语音合成' }
    };

    const defaultModelKey = provider === 'bailian' ? 'bailian_default_model' : 'minimax_default_model';
    const imageModelKey = provider === 'bailian' ? 'bailian_image_model' : 'minimax_image_model';
    const imageModelT2IKey = provider === 'bailian' ? 'bailian_image_model_t2i' : 'minimax_image_model_t2i';
    const imageModelI2IKey = provider === 'bailian' ? 'bailian_image_model_i2i' : 'minimax_image_model_i2i';
    const fallbackImg = configMap[imageModelKey] || defaultImg;
    const modelT2I = (configMap[imageModelT2IKey] && String(configMap[imageModelT2IKey]).trim()) ? configMap[imageModelT2IKey] : fallbackImg;
    const modelI2I = (configMap[imageModelI2IKey] && String(configMap[imageModelI2IKey]).trim()) ? configMap[imageModelI2IKey] : fallbackImg;
    const videoModelKey = provider === 'bailian' ? 'bailian_video_model' : 'minimax_video_model';
    const speechModelKey = provider === 'bailian' ? 'bailian_speech_model' : 'minimax_t2a_model';
    const tempKey = provider === 'bailian' ? 'bailian_temperature' : 'minimax_temperature';
    const maxTokKey = provider === 'bailian' ? 'bailian_max_tokens' : 'minimax_max_tokens';
    const topPKey = provider === 'bailian' ? 'bailian_top_p' : 'minimax_top_p';
    const desc = provider === 'bailian' ? MODEL_DESCRIPTIONS_BAILIAN : MODEL_DESCRIPTIONS_MINIMAX;
    const defaultConv = provider === 'bailian' ? 'qwen-plus' : 'MiniMax-M2.5';
    const defaultImg = provider === 'bailian' ? 'wanx-v1' : 'image-01';
    const defaultVid = provider === 'bailian' ? 'wanx2.1-t2v-turbo' : 'MiniMax-Hailuo-2.3';
    const defaultSpeech = provider === 'bailian' ? 'cosyvoice-v3-flash' : 'speech-2.8-hd';

    const result = {
      provider,
      conversation: {
        model: {
          name: configMap[defaultModelKey] || defaultConv,
          description: (desc[defaultModelKey] && desc[defaultModelKey][configMap[defaultModelKey]]) || '默认对话模型',
          readonly: true
        },
        parameters: {
          temperature: { value: userPreferences?.conversation?.temperature ?? parseFloat(configMap[tempKey] || '0.7'), min: 0.01, max: 1.0, default: parseFloat(configMap[tempKey] || '0.7'), description: '控制输出的随机性，值越大越随机' },
          max_tokens: { value: userPreferences?.conversation?.max_tokens ?? parseInt(configMap[maxTokKey] || '2000', 10), min: 1, max: 204800, default: parseInt(configMap[maxTokKey] || '2000', 10), description: '最大生成token数' },
          top_p: { value: userPreferences?.conversation?.top_p ?? parseFloat(configMap[topPKey] || '0.95'), min: 0.0, max: 1.0, default: parseFloat(configMap[topPKey] || '0.95'), description: '核采样参数' }
        }
      },
      image: {
        model: { name: configMap[imageModelKey] || defaultImg, description: (desc[imageModelKey] && desc[imageModelKey][configMap[imageModelKey]]) || '默认图像生成模型', readonly: true },
        model_t2i: modelT2I,
        model_i2i: modelI2I,
        parameters: {
          aspect_ratio: { value: userPreferences?.image?.aspect_ratio || '1:1', options: ['1:1', '16:9', '9:16', '4:3', '3:4'], default: '1:1', description: '图像宽高比' },
          negative_prompt: { value: userPreferences?.image?.negative_prompt || '', default: '', description: '反向提示词，描述不希望在画面中出现的内容（可选，最长500字）' },
          prompt_extend: { value: userPreferences?.image?.prompt_extend !== false, default: true, description: '是否智能改写提示词' },
          watermark: { value: userPreferences?.image?.watermark === true, default: false, description: '是否添加水印' }
        }
      },
      video: {
        model: { name: configMap[videoModelKey] || defaultVid, description: (desc[videoModelKey] && desc[videoModelKey][configMap[videoModelKey]]) || '默认视频生成模型', readonly: true },
        parameters: { duration: { value: userPreferences?.video?.duration ?? 6, min: 4, max: 10, default: 6, description: '视频时长（秒）' }, resolution: { value: userPreferences?.video?.resolution || '1080P', options: ['720P', '1080P'], default: '1080P', description: '视频分辨率' } }
      },
      speech: {
        model: { name: configMap[speechModelKey] || defaultSpeech, description: (desc[speechModelKey] && desc[speechModelKey][configMap[speechModelKey]]) || '默认语音合成模型', readonly: true },
        parameters: { speed: { value: userPreferences?.speech?.speed ?? 1.0, min: 0.5, max: 2.0, default: 1.0, description: '语速（倍速）' }, vol: { value: userPreferences?.speech?.vol ?? 1.0, min: 0.0, max: 1.0, default: 1.0, description: '音量（0.0-1.0）' }, pitch: { value: userPreferences?.speech?.pitch ?? 0, min: -12, max: 12, default: 0, description: '音调（半音）' } }
      }
    };

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('[模型配置] 获取配置失败:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取模型配置失败' 
    });
  }
});

/**
 * 保存用户模型参数偏好设置
 * POST /api/ai-agents/model-preferences
 */
router.post('/model-preferences', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { preferences } = req.body;

    if (!preferences || typeof preferences !== 'object') {
      return res.status(400).json({ 
        success: false, 
        error: '参数格式错误' 
      });
    }

    // 获取用户的AI智能体
    const agents = await db.query(
      'SELECT id FROM ai_agents WHERE user_id = ?',
      [userId]
    );

    if (agents.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'AI智能体不存在，请先初始化' 
      });
    }

    const agentId = agents[0].id;

    // 验证和清理参数
    const cleanedPreferences = {};
    
    // 对话参数
    if (preferences.conversation) {
      cleanedPreferences.conversation = {};
      if (preferences.conversation.temperature !== undefined) {
        const temp = parseFloat(preferences.conversation.temperature);
        if (!isNaN(temp) && temp >= 0.01 && temp <= 1.0) {
          cleanedPreferences.conversation.temperature = temp;
        }
      }
      if (preferences.conversation.max_tokens !== undefined) {
        const tokens = parseInt(preferences.conversation.max_tokens, 10);
        if (!isNaN(tokens) && tokens >= 1 && tokens <= 204800) {
          cleanedPreferences.conversation.max_tokens = tokens;
        }
      }
      if (preferences.conversation.top_p !== undefined) {
        const topP = parseFloat(preferences.conversation.top_p);
        if (!isNaN(topP) && topP >= 0.0 && topP <= 1.0) {
          cleanedPreferences.conversation.top_p = topP;
        }
      }
    }

    // 图像参数
    if (preferences.image) {
      cleanedPreferences.image = {};
      if (preferences.image.aspect_ratio) {
        const validRatios = ['1:1', '16:9', '9:16', '4:3', '3:4'];
        if (validRatios.includes(preferences.image.aspect_ratio)) {
          cleanedPreferences.image.aspect_ratio = preferences.image.aspect_ratio;
        }
      }
      if (preferences.image.negative_prompt !== undefined) {
        const s = String(preferences.image.negative_prompt).substring(0, 500);
        cleanedPreferences.image.negative_prompt = s;
      }
      if (preferences.image.prompt_extend !== undefined) {
        cleanedPreferences.image.prompt_extend = !!preferences.image.prompt_extend;
      }
      if (preferences.image.watermark !== undefined) {
        cleanedPreferences.image.watermark = !!preferences.image.watermark;
      }
    }

    // 视频参数
    if (preferences.video) {
      cleanedPreferences.video = {};
      if (preferences.video.duration !== undefined) {
        const duration = parseInt(preferences.video.duration, 10);
        if (!isNaN(duration) && duration >= 4 && duration <= 10) {
          cleanedPreferences.video.duration = duration;
        }
      }
      if (preferences.video.resolution) {
        const validResolutions = ['720P', '1080P'];
        if (validResolutions.includes(preferences.video.resolution)) {
          cleanedPreferences.video.resolution = preferences.video.resolution;
        }
      }
    }

    // 语音参数
    if (preferences.speech) {
      cleanedPreferences.speech = {};
      if (preferences.speech.speed !== undefined) {
        const speed = parseFloat(preferences.speech.speed);
        if (!isNaN(speed) && speed >= 0.5 && speed <= 2.0) {
          cleanedPreferences.speech.speed = speed;
        }
      }
      if (preferences.speech.vol !== undefined) {
        const vol = parseFloat(preferences.speech.vol);
        if (!isNaN(vol) && vol >= 0.0 && vol <= 1.0) {
          cleanedPreferences.speech.vol = vol;
        }
      }
      if (preferences.speech.pitch !== undefined) {
        const pitch = parseInt(preferences.speech.pitch, 10);
        if (!isNaN(pitch) && pitch >= -12 && pitch <= 12) {
          cleanedPreferences.speech.pitch = pitch;
        }
      }
    }

    // 更新数据库
    await db.query(
      'UPDATE ai_agents SET model_preferences = ? WHERE id = ?',
      [JSON.stringify(cleanedPreferences), agentId]
    );

    console.log(`[模型配置] 用户 ${userId} 更新了参数偏好设置`);

    res.json({
      success: true,
      message: '参数设置已保存',
      preferences: cleanedPreferences
    });
  } catch (error) {
    console.error('[模型配置] 保存参数偏好失败:', error);
    res.status(500).json({ 
      success: false, 
      error: '保存参数设置失败' 
    });
  }
});

/**
 * 获取知识库内容
 * GET /api/ai-agents/knowledge-base
 */
router.get('/knowledge-base', authenticateToken, async (req, res) => {
  try {
    const { file } = req.query;
    const fs = require('fs');
    const path = require('path');

    // 允许访问的文件列表（白名单）
    const allowedFiles = [
      'README.md',
      'conversation.md',
      'image-generation.md',
      'video-generation.md',
      'speech-synthesis.md',
      'model-parameters.md'
    ];

    // 如果没有指定文件，返回索引
    if (!file) {
      const indexPath = path.join(__dirname, '../../docs/knowledge-base/README.md');
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath, 'utf8');
        return res.json({
          success: true,
          file: 'README.md',
          content: content
        });
      }
      return res.status(404).json({ 
        success: false, 
        error: '知识库索引文件不存在' 
      });
    }

    // 验证文件名
    if (!allowedFiles.includes(file)) {
      return res.status(400).json({ 
        success: false, 
        error: '不允许访问该文件' 
      });
    }

    // 读取文件
    const filePath = path.join(__dirname, '../../docs/knowledge-base', file);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ 
        success: false, 
        error: '文件不存在' 
      });
    }

    const content = fs.readFileSync(filePath, 'utf8');

    res.json({
      success: true,
      file: file,
      content: content
    });
  } catch (error) {
    console.error('[知识库] 获取内容失败:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取知识库内容失败' 
    });
  }
});

module.exports = router;
