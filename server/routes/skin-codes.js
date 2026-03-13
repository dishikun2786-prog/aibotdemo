/**
 * @file skin-codes.js
 * @module routes/skin-codes
 * @description 皮肤激活码商店API
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');

/**
 * 生成随机激活码（8-16 位字母数字）
 */
function generateCode(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * GET /api/skin-codes/shop - 获取激活码商店皮肤列表（含库存）
 */
router.get('/shop', authenticateToken, async (req, res) => {
  try {
    // 获取所有激活的皮肤列表，含激活码库存（考虑shop_limit）
    const skins = await db.query(
      `SELECT s.id, s.name, s.description, s.image_path, s.energy_price, s.pk_attack, s.pk_defense,
              s.energy_price as code_price, s.shop_limit,
              (SELECT COUNT(*) FROM ai_agent_skin_codes c WHERE c.skin_id = s.id AND c.user_id IS NULL) as code_stock,
              (SELECT COUNT(*) FROM ai_agent_skin_codes c WHERE c.skin_id = s.id AND c.user_id IS NOT NULL AND c.used_at IS NULL) as sold_count
       FROM ai_agent_skins s
       WHERE s.is_active = 1
       ORDER BY s.sort_order ASC, s.id ASC`
    );

    // 获取当前用户信息
    const userId = req.user.id;
    const users = await db.query('SELECT energy FROM users WHERE id = ?', [userId]);
    const userEnergy = Math.max(0, users[0]?.energy || 0);

    res.json({
      success: true,
      data: {
        skins: skins.map(s => {
          const shopLimit = s.shop_limit || 0;
          const totalStock = Number(s.code_stock) || 0;
          const soldCount = Number(s.sold_count) || 0;

          // 计算商店可用数量
          let availableStock;
          if (shopLimit <= 0) {
            // 0或不设置表示不限制
            availableStock = totalStock;
          } else {
            // 有上限限制
            availableStock = Math.max(0, shopLimit - soldCount);
          }

          return {
            id: s.id,
            name: s.name,
            description: s.description,
            image_path: s.image_path,
            energy_price: s.energy_price,
            code_price: s.code_price || s.energy_price,
            code_stock: availableStock,
            pk_attack: s.pk_attack,
            pk_defense: s.pk_defense
          };
        }),
        user_energy: userEnergy
      }
    });
  } catch (error) {
    console.error('获取商店列表失败:', error);
    res.status(500).json({ error: '获取商店列表失败' });
  }
});

/**
 * POST /api/skin-codes/buy - 能量购买激活码
 */
router.post('/buy', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const skinId = parseInt(req.body.skin_id, 10);
    const { pay_password } = req.body;

    if (isNaN(skinId)) {
      return res.status(400).json({ error: '请选择要购买激活码的皮肤' });
    }

    // 获取皮肤信息（含shop_limit）
    const skins = await db.query(
      'SELECT id, name, energy_price, shop_limit FROM ai_agent_skins WHERE id = ? AND is_active = 1',
      [skinId]
    );
    if (skins.length === 0) {
      return res.status(404).json({ error: '皮肤不存在或已下架' });
    }

    const skin = skins[0];
    const price = skin.energy_price || 0;
    const shopLimit = skin.shop_limit || 0;

    // 检查是否已达到商店上限
    if (shopLimit > 0) {
      const soldCountResult = await db.query(
        'SELECT COUNT(*) as count FROM ai_agent_skin_codes WHERE skin_id = ? AND user_id IS NOT NULL AND used_at IS NULL',
        [skinId]
      );
      const soldCount = Number(soldCountResult[0]?.count) || 0;
      if (soldCount >= shopLimit) {
        return res.status(400).json({ error: '该皮肤激活码已达到商店出售上限' });
      }
    }

    // 检查是否有可用的激活码
    const availableCodes = await db.query(
      'SELECT id FROM ai_agent_skin_codes WHERE skin_id = ? AND user_id IS NULL LIMIT 1',
      [skinId]
    );
    if (availableCodes.length === 0) {
      return res.status(400).json({ error: '该皮肤激活码已售罄' });
    }

    // 检查用户能量
    const users = await db.query('SELECT energy, pay_password FROM users WHERE id = ?', [userId]);
    const currentEnergy = Math.max(0, users[0]?.energy || 0);

    if (currentEnergy < price) {
      return res.status(400).json({
        error: `能量不足，需要 ${price} 点能量`,
        energy: currentEnergy,
        required: price
      });
    }

    // 检查是否设置了支付密码
    if (!users[0]?.pay_password) {
      return res.status(400).json({
        error: '请先设置支付密码',
        need_pay_password: true
      });
    }

    // 验证支付密码
    if (!pay_password) {
      return res.status(400).json({
        error: '请输入支付密码',
        require_pay_password: true
      });
    }

    if (!bcrypt.compareSync(pay_password, users[0].pay_password)) {
      return res.status(400).json({ error: '支付密码错误' });
    }

    // 分配激活码并绑定用户ID
    const codeId = availableCodes[0].id;
    await db.transaction(async (conn) => {
      // 扣减能量
      await conn.query(
        'UPDATE users SET energy = GREATEST(0, energy - ?) WHERE id = ?',
        [price, userId]
      );
      // 绑定激活码到购买者（这样购买者可以在"我的激活码"里看到并激活）
      // 注意：如果要赠送给他人，需要先解绑或由受赠者在注册时使用
      await conn.query(
        'UPDATE ai_agent_skin_codes SET user_id = ? WHERE id = ?',
        [userId, codeId]
      );
    });

    // 获取分配后的激活码
    const assignedCode = await db.query(
      'SELECT id, code, skin_id FROM ai_agent_skin_codes WHERE id = ?',
      [codeId]
    );

    res.json({
      success: true,
      data: {
        code_id: assignedCode[0].id,
        code: assignedCode[0].code,
        skin_id: skinId,
        skin_name: skin.name,
        price: price
      },
      message: '购买成功'
    });
  } catch (error) {
    console.error('购买激活码失败:', error);
    res.status(500).json({ error: '购买失败，请稍后重试' });
  }
});

/**
 * GET /api/skin-codes/my-codes - 获取我的激活码列表
 */
router.get('/my-codes', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const codes = await db.query(
      `SELECT c.id, c.code, c.skin_id, c.user_id, c.used_at, c.created_at,
              s.name as skin_name, s.image_path as skin_image
       FROM ai_agent_skin_codes c
       LEFT JOIN ai_agent_skins s ON c.skin_id = s.id
       WHERE c.user_id = ?
       ORDER BY c.id DESC`,
      [userId]
    );

    res.json({
      success: true,
      data: codes.map(c => ({
        id: c.id,
        code: c.code,
        skin_id: c.skin_id,
        skin_name: c.skin_name,
        skin_image: c.skin_image,
        is_used: c.used_at !== null,
        used_at: c.used_at,
        created_at: c.created_at
      }))
    });
  } catch (error) {
    console.error('获取我的激活码列表失败:', error);
    res.status(500).json({ error: '获取列表失败' });
  }
});

/**
 * POST /api/skin-codes/activate - 使用激活码激活皮肤
 */
router.post('/activate', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const codeId = parseInt(req.body.code_id, 10);

    if (isNaN(codeId)) {
      return res.status(400).json({ error: '请选择要使用的激活码' });
    }

    // 获取激活码信息
    const codes = await db.query(
      'SELECT id, code, skin_id, user_id, used_at FROM ai_agent_skin_codes WHERE id = ?',
      [codeId]
    );
    if (codes.length === 0) {
      return res.status(404).json({ error: '激活码不存在' });
    }

    const codeInfo = codes[0];

    // 检查是否已使用（不再检查 user_id，因为激活码可以转让给他人）
    if (codeInfo.used_at) {
      return res.status(400).json({ error: '该激活码已使用' });
    }

    // 检查是否已拥有该皮肤
    const owned = await db.query(
      'SELECT id FROM user_ai_agent_skins WHERE user_id = ? AND skin_id = ?',
      [userId, codeInfo.skin_id]
    );
    if (owned.length > 0) {
      return res.status(400).json({ error: '您已拥有该皮肤' });
    }

    // 激活皮肤（同时绑定 user_id 到当前用户，防止被他人使用）
    await db.transaction(async (conn) => {
      // 绑定用户ID并标记激活码已使用
      await conn.query(
        'UPDATE ai_agent_skin_codes SET user_id = ?, used_at = NOW() WHERE id = ?',
        [userId, codeId]
      );
      // 添加用户皮肤
      await conn.query(
        'INSERT INTO user_ai_agent_skins (user_id, skin_id, source, code_id) VALUES (?, ?, ?, ?)',
        [userId, codeInfo.skin_id, 'activation_code', codeId]
      );
    });

    // 获取皮肤详情
    const skin = await db.query(
      'SELECT id, name, description, image_path, pk_attack, pk_defense FROM ai_agent_skins WHERE id = ?',
      [codeInfo.skin_id]
    );

    res.json({
      success: true,
      data: skin[0],
      message: '激活成功'
    });
  } catch (error) {
    console.error('激活皮肤失败:', error);
    res.status(500).json({ error: '激活失败，请稍后重试' });
  }
});

module.exports = router;
