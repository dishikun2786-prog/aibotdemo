/**
 * @file auth.js
 * @module routes/auth
 * @description 验证码、注册、登录、获取当前用户
 */
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const router = express.Router();
const db = require('../utils/db');
const mongo = require('../utils/mongo');
const captcha = require('../utils/captcha');
const { authenticateToken } = require('../middleware/auth');
const config = require('../config/database');
const rateLimit = require('express-rate-limit');
const { releaseUserNodes, clearChallengesForUser } = require('../socket');

/** 生成随机激活码（8-16 位字母数字），与 admin-game-codes 一致 */
function generateCode(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/** 生成推荐码（6-8位随机字符串） */
function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const length = 6 + Math.floor(Math.random() * 3); // 6-8位
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/** 确保用户有推荐码 */
async function ensureReferralCode(userId) {
  const users = await db.query('SELECT referral_code FROM users WHERE id = ?', [userId]);
  if (users.length === 0) return null;

  let referralCode = users[0].referral_code;
  if (!referralCode) {
    // 生成唯一的推荐码
    let attempts = 0;
    do {
      referralCode = generateReferralCode();
      const existing = await db.query('SELECT id FROM users WHERE referral_code = ? AND id != ?', [referralCode, userId]);
      if (existing.length === 0) break;
      attempts++;
    } while (attempts < 10);

    await db.query('UPDATE users SET referral_code = ? WHERE id = ?', [referralCode, userId]);
  }
  return referralCode;
}

// 登录和注册的速率限制
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: 10, // 最多10次请求
  message: '请求过于频繁，请稍后再试',
  // 在反向代理环境下，需要明确指定信任代理的数量
  // 设置为 1 表示信任第一个代理（通常是 Nginx）
  standardHeaders: true, // 返回 rate limit 信息到 `RateLimit-*` 头
  legacyHeaders: false, // 禁用 `X-RateLimit-*` 头
  // 如果 express 设置了 trust proxy，这里也需要配置
  // 但 express-rate-limit 会自动检测 express 的 trust proxy 设置
});

// 获取验证码
router.get('/captcha', async (req, res) => {
  try {
    const captchaData = await captcha.generateCaptcha();
    res.json({
      success: true,
      captchaId: captchaData.id,
      image: captchaData.image
    });
  } catch (error) {
    console.error('生成验证码失败:', error);
    res.status(500).json({ error: '生成验证码失败' });
  }
});

// 用户注册
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, password, confirmPassword, captchaId, captchaCode, activationCode, referrer_code } = req.body;

    // 读取是否启用激活码注册配置
    let requireActivationCode = true;
    try {
      const [requireActivationCodeConfig] = await db.query(
        'SELECT config_value FROM game_config WHERE config_key = ?',
        ['require_activation_code']
      );
      requireActivationCode = requireActivationCodeConfig?.config_value !== 'false';
    } catch (err) {
      console.error('读取注册配置失败，使用默认值:', err.message);
    }

    // 验证输入
    if (!username || !password || !confirmPassword || !captchaId || !captchaCode) {
      return res.status(400).json({ error: '请填写所有必填项' });
    }

    // 验证激活码（根据配置决定是否必填）
    if (requireActivationCode && (!activationCode || !activationCode.trim())) {
      return res.status(400).json({ error: '请输入激活码' });
    }

    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: '用户名长度必须在3-20个字符之间' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: '密码长度至少6个字符' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: '两次输入的密码不一致' });
    }

    // 验证验证码
    const isValidCaptcha = await captcha.verifyCaptcha(captchaId, captchaCode);
    if (!isValidCaptcha) {
      return res.status(400).json({ error: '验证码错误或已过期' });
    }

    // 检查用户名是否已存在
    const existingUsers = await db.query('SELECT id FROM users WHERE username = ?', [username]);
    if (existingUsers.length > 0) {
      return res.status(400).json({ error: '用户名已存在' });
    }

    // 加密密码
    const hashedPassword = await bcrypt.hash(password, 10);

    // 从配置表读取新玩家初始体力值
    const configRows = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      ['initial_stamina']
    );
    const initialStamina = configRows.length > 0
      ? parseInt(configRows[0].config_value, 10) || 100
      : 100; // 如果配置不存在，使用默认值100

    // 验证激活码（如果有提供）
    let assignedSkinId = null;
    let skinIdToAssign = null;
    let codeRecordId = null;

    if (activationCode && activationCode.trim()) {
      const code = activationCode.trim().toUpperCase();
      const codeRecords = await db.query(
        'SELECT id, skin_id, user_id, used_at FROM ai_agent_skin_codes WHERE code = ?',
        [code]
      );

      if (codeRecords.length === 0) {
        return res.status(400).json({ error: '激活码无效' });
      }

      const codeRecord = codeRecords[0];

      // 检查是否已使用（used_at 不为 NULL 表示已使用）
      if (codeRecord.used_at) {
        return res.status(400).json({ error: '该激活码已被使用' });
      }

      // 检查是否已被他人绑定并使用（如果 user_id 不为 NULL，且不是当前用户）
      // 这里简化逻辑：只要激活码未使用，就可以用于注册
      // 皮肤商店购买后虽然绑定了 user_id，但受赠者注册时可以直接使用
      // （因为激活时会重新绑定 user_id 到新用户）

      // 保存皮肤ID和激活码记录ID，待用户初始化AI智能体后激活
      skinIdToAssign = codeRecord.skin_id;
      codeRecordId = codeRecord.id;
    }

    // 创建用户（在事务中处理激活码）
    let result;
    if (skinIdToAssign) {
      // 使用事务：创建用户并标记激活码已使用
      result = await db.transaction(async (conn) => {
        // 创建用户
        const [insertResult] = await conn.query(
          'INSERT INTO users (username, password, energy, stamina) VALUES (?, ?, 0, ?)',
          [username, hashedPassword, initialStamina]
        );

        const newUserId = insertResult.insertId;

        // 标记激活码已使用
        await conn.query(
          'UPDATE ai_agent_skin_codes SET user_id = ?, used_at = NOW() WHERE id = ?',
          [newUserId, codeRecordId]
        );

        // 添加到用户拥有皮肤表
        await conn.query(
          'INSERT INTO user_ai_agent_skins (user_id, skin_id, source, code_id) VALUES (?, ?, ?, ?)',
          [newUserId, skinIdToAssign, 'activation_code', codeRecordId]
        );

        return { insertId: newUserId };
      });

      assignedSkinId = skinIdToAssign;
    } else {
      // 无激活码，普通注册
      result = await db.query(
        'INSERT INTO users (username, password, energy, stamina) VALUES (?, ?, 0, ?)',
        [username, hashedPassword, initialStamina]
      );
    }

    const newUserId = result.insertId;

    // 处理推荐人绑定
    if (referrer_code && referrer_code.trim()) {
      const referrerCode = referrer_code.trim().toUpperCase();
      const referrers = await db.query(
        'SELECT id, referral_code FROM users WHERE referral_code = ?',
        [referrerCode]
      );

      if (referrers.length > 0) {
        const referrerId = referrers[0].id;
        // 不能自己推荐自己
        if (referrerId !== newUserId) {
          // 在事务中绑定推荐关系
          await db.transaction(async (conn) => {
            // 设置推荐人
            await conn.query(
              'UPDATE users SET referrer_id = ? WHERE id = ?',
              [referrerId, newUserId]
            );
            // 增加推荐人的直推计数
            await conn.query(
              'UPDATE users SET referral_count = referral_count + 1 WHERE id = ?',
              [referrerId]
            );
          });
          console.log(`[注册] 用户 ${newUserId} 通过推荐码 ${referrerCode} 绑定推荐人 ${referrerId}`);
        }
      }
    }

    // 为新用户生成推荐码
    await ensureReferralCode(newUserId);

    // 生成JWT Token
    const token = jwt.sign(
      { userId: result.insertId, username },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    // 新注册用户需要初始化AI智能体
    res.json({
      success: true,
      message: '注册成功',
      token,
      user: {
        id: result.insertId,
        username,
        energy: 0,
        stamina: initialStamina
      },
      needsAgentInitialization: true,
      assignedSkinId: assignedSkinId
    });
  } catch (error) {
    console.error('注册失败:', error);
    res.status(500).json({ error: '注册失败，请稍后重试' });
  }
});

// 用户登录
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password, captchaId, captchaCode } = req.body;

    if (!username || !password || !captchaId || !captchaCode) {
      return res.status(400).json({ error: '请填写所有必填项' });
    }

    // 验证验证码
    const isValidCaptcha = await captcha.verifyCaptcha(captchaId, captchaCode);
    if (!isValidCaptcha) {
      return res.status(400).json({ error: '验证码错误或已过期' });
    }

    // 查找用户
    const users = await db.query('SELECT * FROM users WHERE username = ?', [username]);
    if (users.length === 0) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const user = users[0];

    // 检查账户状态
    if (user.status !== 'active') {
      return res.status(403).json({ error: '账户已被封禁' });
    }

    // 验证密码
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 更新最后登录时间
    await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    // 清理遗留的节点占据（如果用户异常断开，可能遗留节点占据）
    try {
      const releasedCount = await releaseUserNodes(user.id, true);
      if (releasedCount > 0) {
        console.log(`[登录] 用户 ${user.username} (${user.id}) 登录时清理了 ${releasedCount} 个遗留节点占据`);
      }
    } catch (error) {
      // 清理节点失败不影响登录流程，只记录日志
      console.error(`[登录] 用户 ${user.username} (${user.id}) 清理遗留节点失败:`, error);
    }

    // 检查用户是否已有AI智能体
    const agents = await db.query(
      'SELECT id, is_initialized FROM ai_agents WHERE user_id = ?',
      [user.id]
    );
    
    const needsAgentInitialization = agents.length === 0 || (agents.length > 0 && agents[0].is_initialized === 0);

    // 生成JWT Token
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    res.json({
      success: true,
      message: '登录成功',
      token,
      user: {
        id: user.id,
        username: user.username,
        energy: parseInt(user.energy, 10) || 0,
        stamina: user.stamina !== null ? parseInt(user.stamina, 10) : 0,  // 使用数据库真实值，不设置默认值
        is_admin: user.is_admin === 1
      },
      needsAgentInitialization
    });
  } catch (error) {
    console.error('登录失败:', error);
    res.status(500).json({ error: '登录失败，请稍后重试' });
  }
});

// 用户登出
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    // 释放用户占据的所有节点
    try {
      const releasedCount = await releaseUserNodes(req.user.id, true);
      if (releasedCount > 0) {
        console.log(`[登出] 用户 ${req.user.username} (${req.user.id}) 登出时释放了 ${releasedCount} 个节点`);
      }
    } catch (error) {
      // 释放节点失败不影响登出流程，只记录日志
      console.error(`[登出] 用户 ${req.user.username} (${req.user.id}) 释放节点失败:`, error);
    }
    try {
      await clearChallengesForUser(req.user.id);
    } catch (error) {
      console.error(`[登出] 用户 ${req.user.username} (${req.user.id}) 清理待处理PK挑战失败:`, error);
    }

    res.json({
      success: true,
      message: '登出成功'
    });
  } catch (error) {
    console.error('登出失败:', error);
    res.status(500).json({ error: '登出失败，请稍后重试' });
  }
});

// 获取当前用户信息
router.get('/me', authenticateToken, async (req, res) => {
  try {
    // 先确保avatar_image字段存在（兼容老用户）
    try {
      await db.query('SELECT avatar_image FROM users WHERE id = 0');
    } catch (e) {
      // 字段不存在，添加
      await db.query(
        'ALTER TABLE users ADD COLUMN avatar_image VARCHAR(255) DEFAULT NULL COMMENT \'用户头像图片路径\' AFTER current_skin_id'
      );
    }

    const users = await db.query(
      'SELECT id, username, energy, stamina, total_energy, wins, losses, draws, is_admin, created_at, avatar_image FROM users WHERE id = ?',
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const user = users[0];
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        energy: parseInt(user.energy, 10) || 0,
        stamina: user.stamina !== null ? parseInt(user.stamina, 10) : 0,  // 使用数据库真实值，不设置默认值
        total_energy: parseInt(user.total_energy, 10) || 0,
        wins: parseInt(user.wins, 10) || 0,
        losses: parseInt(user.losses, 10) || 0,
        draws: parseInt(user.draws, 10) || 0,
        is_admin: user.is_admin === 1,
        created_at: user.created_at,
        avatar_image: user.avatar_image || null
      }
    });
  } catch (error) {
    console.error('获取用户信息失败:', error);
    res.status(500).json({ error: '获取用户信息失败' });
  }
});

// 更新用户资料（用户名、密码、头像颜色）
router.put('/me', authenticateToken, async (req, res) => {
  try {
    const { username, oldPassword, newPassword, avatarColor } = req.body;
    const userId = req.user.id;

    // 获取当前用户信息
    const users = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    const user = users[0];

    // 如果要修改密码，先验证旧密码
    if (newPassword) {
      if (!oldPassword) {
        return res.status(400).json({ error: '请输入当前密码' });
      }
      const isValidPassword = await bcrypt.compare(oldPassword, user.password);
      if (!isValidPassword) {
        return res.status(401).json({ error: '当前密码错误' });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ error: '新密码至少需要6位' });
      }
    }

    // 构建更新语句
    const updates = [];
    const params = [];

    if (username && username !== user.username) {
      // 检查用户名是否已存在
      const existing = await db.query('SELECT id FROM users WHERE username = ? AND id != ?', [username, userId]);
      if (existing.length > 0) {
        return res.status(400).json({ error: '用户名已被占用' });
      }
      updates.push('username = ?');
      params.push(username);
    }

    if (newPassword) {
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      updates.push('password = ?');
      params.push(hashedPassword);
    }

    if (avatarColor) {
      updates.push('avatar_color = ?');
      params.push(avatarColor);
    }

    if (updates.length > 0) {
      params.push(userId);
      await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    res.json({ success: true, message: '更新成功' });
  } catch (error) {
    console.error('更新用户信息失败:', error);
    res.status(500).json({ error: '更新用户信息失败' });
  }
});

// 兑换能量/体力激活码
router.post('/redeem-game-code', authenticateToken, async (req, res) => {
  try {
    const code = (req.body.code != null && String(req.body.code).trim()) ? String(req.body.code).trim() : '';
    if (!code) {
      return res.status(400).json({ error: '请输入激活码' });
    }

    const rows = await db.query(
      'SELECT id, type, amount, is_disabled, user_id, created_by_user_id FROM game_activation_codes WHERE code = ?',
      [code]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: '激活码无效' });
    }
    const row = rows[0];
    const codeId = row.id;
    const codeType = row.type;
    const amount = Math.max(0, parseInt(row.amount, 10) || 0);

    if (row.is_disabled) {
      return res.status(400).json({ error: '该激活码已禁用' });
    }
    if (row.user_id != null) {
      return res.status(400).json({ error: '该激活码已被使用' });
    }
    // 管理员可以兑换任何激活码（包括自己生成的）
    if (row.created_by_user_id != null && row.created_by_user_id === req.user.id && !req.user.is_admin) {
      return res.status(400).json({ error: '不能兑换自己生成的激活码' });
    }

    const users = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [req.user.id]);
    if (users.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    let energy = parseInt(users[0].energy, 10) || 0;
    let stamina = users[0].stamina !== null ? parseInt(users[0].stamina, 10) : 0;

    if (codeType === 'energy') {
      energy = Math.max(0, energy + amount);
      await db.query('UPDATE users SET energy = ? WHERE id = ?', [energy, req.user.id]);
    } else {
      stamina = Math.max(0, stamina + amount);
      await db.query('UPDATE users SET stamina = ? WHERE id = ?', [stamina, req.user.id]);
    }

    await db.query(
      'UPDATE game_activation_codes SET user_id = ?, used_at = NOW() WHERE id = ?',
      [req.user.id, codeId]
    );

    try {
      await mongo.insertUserGameRecord({
        userId: req.user.id,
        recordType: 'activation_code',
        codeType,
        amount,
        createdAt: new Date()
      });
    } catch (ugrErr) {
      console.error('MongoDB user_game_records (activation_code) 写入失败:', ugrErr);
    }

    const updated = await db.query('SELECT energy, stamina FROM users WHERE id = ?', [req.user.id]);
    const dataEnergy = updated.length > 0 && updated[0].energy != null ? parseInt(updated[0].energy, 10) : energy;
    const dataStamina = updated.length > 0 && updated[0].stamina != null ? parseInt(updated[0].stamina, 10) : stamina;

    const typeLabel = codeType === 'energy' ? '能量' : '体力';
    res.json({
      success: true,
      message: `兑换成功，已增加 ${amount} 点${typeLabel}`,
      data: { energy: dataEnergy, stamina: dataStamina }
    });
  } catch (error) {
    console.error('兑换激活码失败:', error);
    res.status(500).json({ error: '兑换失败，请稍后重试' });
  }
});

// 能量室：用户消耗自身能量生成能量棒激活码（可赠与他人兑换）
router.post('/generate-energy-code', authenticateToken, async (req, res) => {
  const MIN_AMOUNT = 10;
  const DEFAULT_AMOUNT = 30;

  try {
    let amount = req.body.amount != null ? parseInt(req.body.amount, 10) : DEFAULT_AMOUNT;
    if (isNaN(amount) || amount < MIN_AMOUNT) {
      amount = DEFAULT_AMOUNT;
    }

    const users = await db.query('SELECT energy FROM users WHERE id = ?', [req.user.id]);
    if (!users || users.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    const currentEnergy = parseInt(users[0].energy, 10) || 0;
    if (currentEnergy < amount) {
      return res.status(400).json({ error: `能量不足，当前能量 ${currentEnergy}，需要 ${amount}` });
    }

    const existing = await db.query('SELECT code FROM game_activation_codes');
    const existingSet = new Set(existing.map(r => r.code));
    let code = '';
    for (let i = 0; i < 50; i++) {
      const c = generateCode(12);
      if (!existingSet.has(c)) {
        code = c;
        break;
      }
    }
    if (!code) {
      return res.status(500).json({ error: '生成激活码失败，请重试' });
    }

    await db.transaction(async (conn) => {
      await conn.query('UPDATE users SET energy = GREATEST(0, energy - ?) WHERE id = ?', [amount, req.user.id]);
      await conn.query(
        'INSERT INTO game_activation_codes (code, type, amount, remark, created_by_user_id) VALUES (?, ?, ?, ?, ?)',
        [code, 'energy', amount, '用户生成', req.user.id]
      );
    });

    const updated = await db.query('SELECT energy FROM users WHERE id = ?', [req.user.id]);
    const newEnergy = updated && updated.length > 0 && updated[0].energy != null
      ? parseInt(updated[0].energy, 10) : currentEnergy - amount;

    res.json({
      success: true,
      data: { code, amount, energy: newEnergy },
      message: `已生成能量棒激活码，消耗 ${amount} 点能量`
    });
  } catch (error) {
    console.error('生成能量棒激活码失败:', error);
    res.status(500).json({ error: '生成失败，请稍后重试' });
  }
});

// 获取当前用户生成的能量棒激活码历史
router.get('/my-energy-codes', authenticateToken, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const rows = await db.query(
      `SELECT id, code, amount, user_id, used_at, created_at
       FROM game_activation_codes
       WHERE created_by_user_id = ? AND type = 'energy'
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );

    const countResult = await db.query(
      `SELECT COUNT(*) AS total FROM game_activation_codes
       WHERE created_by_user_id = ? AND type = 'energy'`,
      [req.user.id]
    );
    const total = countResult[0]?.total || 0;

    const data = rows.map(r => ({
      id: r.id,
      code: r.code,
      amount: r.amount,
      status: r.user_id != null ? 'used' : 'unused',
      usedAt: r.used_at,
      createdAt: r.created_at
    }));

    res.json({ success: true, data, total, page, limit });
  } catch (error) {
    console.error('获取能量棒激活码历史失败:', error);
    res.status(500).json({ error: '获取历史记录失败' });
  }
});

// 获取公开的配置信息（注册配置）
router.get('/public-config', async (req, res) => {
  try {
    // 只获取公开的配置信息
    const [requireActivationCodeConfig] = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      ['require_activation_code']
    );

    res.json({
      success: true,
      data: {
        require_activation_code: requireActivationCodeConfig?.config_value !== 'false'
      }
    });
  } catch (error) {
    console.error('获取公开配置失败:', error);
    res.status(500).json({ error: '获取配置失败' });
  }
});

// 检查推荐码是否存在（注册页面使用）
router.get('/check-referrer', async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.json({ success: true, data: { exists: false } });
    }

    const codeUpper = code.toUpperCase();
    const users = await db.query(
      'SELECT id, username FROM users WHERE referral_code = ?',
      [codeUpper]
    );

    if (users.length > 0) {
      res.json({
        success: true,
        data: {
          exists: true,
          user_id: users[0].id,
          username: users[0].username
        }
      });
    } else {
      res.json({
        success: true,
        data: {
          exists: false
        }
      });
    }
  } catch (error) {
    console.error('检查推荐码失败:', error);
    res.status(500).json({ error: '检查推荐码失败' });
  }
});

// 获取当前用户的推荐码和推广链接
router.get('/my-referral-code', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 确保用户有推荐码
    const referralCode = await ensureReferralCode(userId);

    // 获取用户信息（兼容老用户，可能没有 referral_count 字段）
    let referralCount = 0;
    try {
      const users = await db.query(
        'SELECT referral_count FROM users WHERE id = ?',
        [userId]
      );
      if (users.length > 0) {
        referralCount = users[0].referral_count || 0;
      }
    } catch (e) {
      console.log('获取referral_count失败:', e.message);
    }

    // 计算团队总人数（3级下线）
    let teamTotalCount = 0;
    try {
      // 一级下线
      const level1 = await db.query(
        'SELECT COUNT(*) as count FROM users WHERE referrer_id = ?',
        [userId]
      );
      const level1Count = level1[0]?.count || 0;

      // 二级下线
      const level2Users = await db.query(
        'SELECT id FROM users WHERE referrer_id = ?',
        [userId]
      );
      let level2Count = 0;
      if (level2Users.length > 0) {
        const level2Ids = level2Users.map(u => u.id);
        const level2 = await db.query(
          'SELECT COUNT(*) as count FROM users WHERE referrer_id IN (?)',
          [level2Ids]
        );
        level2Count = level2[0]?.count || 0;
      }

      // 三级下线
      let level3Count = 0;
      if (level2Users.length > 0) {
        const level2Ids = level2Users.map(u => u.id);
        const level3Users = await db.query(
          'SELECT id FROM users WHERE referrer_id IN (?)',
          [level2Ids]
        );
        if (level3Users.length > 0) {
          const level3Ids = level3Users.map(u => u.id);
          const level3 = await db.query(
            'SELECT COUNT(*) as count FROM users WHERE referrer_id IN (?)',
            [level3Ids]
          );
          level3Count = level3[0]?.count || 0;
        }
      }

      teamTotalCount = level1Count + level2Count + level3Count;
    } catch (err) {
      console.error('计算团队人数失败:', err.message);
    }

    // 获取服务器地址构建推广链接（优先使用X-Forwarded-Proto，支持HTTPS反向代理）
    let protocol = req.get('X-Forwarded-Proto') || req.protocol;
    let host = req.get('X-Forwarded-Host') || req.get('host') || req.get('host');

    // 如果 host 包含端口号，去掉端口
    if (host && host.includes(':')) {
      host = host.split(':')[0];
    }

    // 如果端口是 443 或者无法确定协议，默认使用 https
    if (!protocol || protocol === 'http') {
      const port = req.get('X-Forwarded-Port') || req.get('Port');
      if (port === '443' || !port) {
        protocol = 'https';
      }
    }

    const referralUrl = `${protocol}://${host}/register.html?code=${referralCode}`;

    res.json({
      success: true,
      data: {
        referral_code: referralCode,
        referral_url: referralUrl,
        referral_count: referralCount,
        team_total_count: teamTotalCount
      }
    });
  } catch (error) {
    console.error('获取推荐码失败:', error);
    res.status(500).json({ error: '获取推荐码失败' });
  }
});

// 获取我的团队成员
router.get('/my-team', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const level = Math.min(3, Math.max(1, parseInt(req.query.level, 10) || 3));

    const teamMembers = [];

    // 递归获取指定层级的团队成员
    async function getTeamMembers(parentId, currentLevel, maxLevel) {
      if (currentLevel > maxLevel) return;

      try {
        const members = await db.query(
          `SELECT id, username, referral_count, created_at
           FROM users
           WHERE referrer_id = ?
           ORDER BY created_at DESC`,
          [parentId]
        );

        for (const member of members) {
          teamMembers.push({
            user_id: member.id,
            username: member.username,
            referral_count: member.referral_count || 0,
            joined_at: member.created_at,
            level: currentLevel
          });

          // 递归获取下一级
          await getTeamMembers(member.id, currentLevel + 1, maxLevel);
        }
      } catch (e) {
        console.log('获取团队成员失败，可能referrer_id字段不存在:', e.message);
      }
    }

    await getTeamMembers(userId, 1, level);

    res.json({
      success: true,
      data: teamMembers
    });
  } catch (error) {
    console.error('获取团队成员失败:', error);
    res.status(500).json({ error: '获取团队成员失败' });
  }
});

// 获取团队统计数据
router.get('/team-stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 尝试查询直推人数（如果字段不存在会返回0）
    let directCount = 0;
    try {
      const level1 = await db.query(
        'SELECT COUNT(*) as count FROM users WHERE referrer_id = ?',
        [userId]
      );
      directCount = level1[0]?.count || 0;
    } catch (e) {
      console.log('referrer_id字段可能不存在:', e.message);
    }

    // 获取二级人数
    let level2Users = [];
    try {
      level2Users = await db.query(
        'SELECT id FROM users WHERE referrer_id = ?',
        [userId]
      );
    } catch (e) {
      console.log('referrer_id字段查询失败:', e.message);
    }

    let level2Count = 0;
    if (level2Users.length > 0) {
      try {
        const level2Ids = level2Users.map(u => u.id);
        const level2 = await db.query(
          'SELECT COUNT(*) as count FROM users WHERE referrer_id IN (?)',
          [level2Ids]
        );
        level2Count = level2[0]?.count || 0;
      } catch (e) {
        console.log('二级人数查询失败:', e.message);
      }
    }

    // 获取三级人数
    let level3Count = 0;
    let level3Users = [];
    if (level2Users.length > 0) {
      try {
        const level2Ids = level2Users.map(u => u.id);
        level3Users = await db.query(
          'SELECT id FROM users WHERE referrer_id IN (?)',
          [level2Ids]
        );
        if (level3Users.length > 0) {
          const level3Ids = level3Users.map(u => u.id);
          const level3 = await db.query(
            'SELECT COUNT(*) as count FROM users WHERE referrer_id IN (?)',
            [level3Ids]
          );
          level3Count = level3[0]?.count || 0;
        }
      } catch (e) {
        console.log('三级人数查询失败:', e.message);
      }
    }

    // 计算活跃人数（30天内有登录的）
    const allTeamIds = [
      userId,
      ...level2Users.map(u => u.id),
      ...level3Users.map(u => u.id)
    ];

    let activeCount = 0;
    if (allTeamIds.length > 0) {
      try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const active = await db.query(
          `SELECT COUNT(DISTINCT id) as count FROM users
           WHERE id IN (?) AND last_login >= ?`,
          [allTeamIds, thirtyDaysAgo]
        );
        activeCount = active[0]?.count || 0;
      } catch (e) {
        console.log('活跃人数查询失败:', e.message);
      }
    }

    res.json({
      success: true,
      data: {
        direct_count: directCount,
        level2_count: level2Count,
        level3_count: level3Count,
        team_total_count: directCount + level2Count + level3Count,
        active_count: activeCount
      }
    });
  } catch (error) {
    console.error('获取团队统计失败:', error);
    res.status(500).json({ error: '获取团队统计失败' });
  }
});

// 查询是否已设置支付密码
router.get('/has-pay-password', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 尝试查询支付密码字段
    let hasPayPassword = false;
    try {
      const [user] = await db.query(
        'SELECT pay_password FROM users WHERE id = ?',
        [userId]
      );
      hasPayPassword = !!user?.pay_password;
    } catch (e) {
      console.log('pay_password字段可能不存在:', e.message);
      hasPayPassword = false;
    }

    res.json({
      success: true,
      data: {
        has_pay_password: hasPayPassword
      }
    });
  } catch (error) {
    console.error('查询支付密码状态失败:', error);
    res.status(500).json({ error: '查询支付密码状态失败' });
  }
});

// 设置或修改支付密码
router.post('/set-pay-password', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { pay_password, current_password } = req.body;

    // 验证必填参数
    if (!pay_password) {
      return res.status(400).json({ error: '请输入支付密码' });
    }
    if (!current_password) {
      return res.status(400).json({ error: '请输入当前登录密码' });
    }

    // 验证支付密码格式（6位数字）
    if (!/^\d{6}$/.test(pay_password)) {
      return res.status(400).json({ error: '支付密码必须是6位数字' });
    }

    // 验证登录密码
    const [user] = await db.query('SELECT password FROM users WHERE id = ?', [userId]);
    if (!bcrypt.compareSync(current_password, user.password)) {
      return res.status(400).json({ error: '登录密码验证失败' });
    }

    // 加密并保存支付密码
    const hash = bcrypt.hashSync(pay_password, 10);

    // 尝试更新支付密码字段
    try {
      await db.query(
        'UPDATE users SET pay_password = ?, pay_password_set_at = NOW() WHERE id = ?',
        [hash, userId]
      );
    } catch (e) {
      console.log('pay_password字段更新失败:', e.message);
      return res.status(500).json({ error: '数据库字段不存在，请先执行迁移脚本' });
    }

    res.json({ success: true, message: '支付密码设置成功' });
  } catch (error) {
    console.error('设置支付密码失败:', error);
    res.status(500).json({ error: '设置支付密码失败' });
  }
});

// 验证支付密码（通用接口）
router.post('/verify-pay-password', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { pay_password } = req.body;

    if (!pay_password) {
      return res.status(400).json({ error: '请输入支付密码' });
    }

    // 查询支付密码
    let user;
    try {
      [user] = await db.query('SELECT pay_password FROM users WHERE id = ?', [userId]);
    } catch (e) {
      console.log('pay_password字段查询失败:', e.message);
      return res.status(500).json({ error: '数据库字段不存在，请先执行迁移脚本' });
    }

    if (!user?.pay_password) {
      return res.status(400).json({
        error: '未设置支付密码',
        need_pay_password: true
      });
    }

    if (!bcrypt.compareSync(pay_password, user.pay_password)) {
      return res.status(400).json({ error: '支付密码错误' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('验证支付密码失败:', error);
    res.status(500).json({ error: '验证支付密码失败' });
  }
});

module.exports = router;
