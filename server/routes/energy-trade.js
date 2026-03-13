/**
 * @file energy-trade.js
 * @module routes/energy-trade
 * @description 能量交易担保API
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../utils/db');
const mongo = require('../utils/mongo');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// 获取手续费配置
async function getFeeRate() {
  try {
    const configs = await db.query(
      "SELECT config_value FROM game_config WHERE config_key = 'energy_trade_fee_rate'"
    );
    if (configs.length > 0 && configs[0].config_value) {
      const rate = parseFloat(configs[0].config_value);
      if (!isNaN(rate) && rate >= 0 && rate <= 100) {
        return rate;
      }
    }
  } catch (err) {
    console.error('获取手续费配置失败:', err.message);
  }
  return 5; // 默认5%
}

// 图片上传处理
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// 获取Socket.IO实例用于广播
let energyTradeIO = null;
const getEnergyTradeIO = () => {
  if (!energyTradeIO) {
    try {
      const socketModule = require('../socket');
      energyTradeIO = socketModule.getEnergyTradeIO();
    } catch (err) {
      console.error('获取energy-trade socket失败:', err);
    }
  }
  return energyTradeIO;
};

const uploadDir = path.join(__dirname, '../../public/uploads/energy-trade');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error('仅支持图片文件'));
  }
});

// ============================================================
// 用户能量信息API
// ============================================================

/**
 * GET /api/energy-trade/user/energy
 * 获取当前用户的能量信息
 */
router.get('/user/energy', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    
    const users = await db.query(
      'SELECT energy, COALESCE(frozen_energy, 0) as frozen_energy FROM users WHERE id = ?',
      [user.id]
    );
    
    if (!users.length) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    const userInfo = users[0];
    const availableEnergy = Math.max(0, userInfo.energy - userInfo.frozen_energy);
    
    res.json({
      success: true,
      data: {
        total_energy: userInfo.energy,
        frozen_energy: userInfo.frozen_energy,
        available_energy: availableEnergy
      }
    });
  } catch (err) {
    console.error('获取用户能量信息失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * GET /api/energy-trade/ads/my
 * 获取当前用户发布的广告
 */
router.get('/ads/my', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    // 查询总数
    const countResult = await db.query(
      'SELECT COUNT(*) as total FROM energy_ads WHERE user_id = ?',
      [user.id]
    );
    const total = countResult[0].total;
    
    // 查询列表
    const ads = await db.query(
      'SELECT * FROM energy_ads WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [user.id, parseInt(limit), offset]
    );
    
    res.json({
      success: true,
      data: {
        list: ads,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('获取我的广告失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ============================================================
// 能量广告API
// ============================================================

/**
 * GET /api/energy-trade/ads
 * 获取广告列表（支持分页、排序、筛选）
 */
router.get('/ads', async (req, res) => {
  try {
    const { page = 1, limit = 20, sort = 'created_at', order = 'desc', status = 'active', keyword = '' } = req.query;
    const offset = (page - 1) * limit;
    
    let whereClause = "WHERE status = 'active'";
    const params = [];
    
    if (status && status !== 'all') {
      whereClause = "WHERE status = ?";
      params.push(status);
    }
    
    if (keyword) {
      whereClause += params.length ? " AND username LIKE ?" : "WHERE username LIKE ?";
      params.push(`%${keyword}%`);
    }
    
    // 过滤已过期的广告
    whereClause += " AND (expires_at IS NULL OR expires_at > NOW())";
    
    // 排序
    const validSorts = ['created_at', 'price_per_energy', 'energy_amount', 'view_count'];
    const sortField = validSorts.includes(sort) ? sort : 'created_at';
    const sortOrder = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    
    // 查询总数
    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM energy_ads ${whereClause}`,
      params
    );
    const total = countResult[0].total;
    
    // 查询列表（过滤过期广告）
    const ads = await db.query(
      `SELECT * FROM energy_ads ${whereClause} ORDER BY ${sortField} ${sortOrder} LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    
    res.json({
      success: true,
      data: {
        list: ads,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('获取广告列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * GET /api/energy-trade/ads/:id
 * 获取广告详情
 */
router.get('/ads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const ads = await db.query('SELECT * FROM energy_ads WHERE id = ?', [id]);
    if (!ads.length) {
      return res.status(404).json({ error: '广告不存在' });
    }
    
    // 增加浏览次数
    await db.execute('UPDATE energy_ads SET view_count = view_count + 1 WHERE id = ?', [id]);
    
    res.json({
      success: true,
      data: ads[0]
    });
  } catch (err) {
    console.error('获取广告详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * POST /api/energy-trade/ads
 * 发布能量广告
 */
router.post('/ads', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { energy_amount, price_per_energy, payment_qr_code, description = '', expires_hours = 24 } = req.body;
    
    // 参数验证
    if (!energy_amount || energy_amount <= 0) {
      return res.status(400).json({ error: '请输入有效的能量数量' });
    }
    if (!price_per_energy || price_per_energy <= 0) {
      return res.status(400).json({ error: '请输入有效的单价' });
    }
    if (!payment_qr_code) {
      return res.status(400).json({ error: '请上传收款码' });
    }
    
    // 计算总价
    const total_price = parseFloat((energy_amount * price_per_energy).toFixed(2));

    // 获取手续费比例（在事务外获取）
    const feeRate = await getFeeRate();

    // 计算手续费能量
    const feeEnergy = Math.floor(energy_amount * feeRate / 100); // 手续费能量（向下取整）
    const totalFreezeEnergy = energy_amount + feeEnergy; // 需要冻结的总能量

    // 计算手续费（从卖家收入中扣除）
    const fee = parseFloat((total_price * feeRate / 100).toFixed(2));
    const net_income = parseFloat((total_price - fee).toFixed(2));

    // 使用事务确保能量检查和冻结的原子性
    await db.transaction(async (conn) => {
      // 1. 检查用户能量是否充足（带行锁）
      const [users] = await conn.execute(
        'SELECT energy, COALESCE(frozen_energy, 0) as frozen_energy FROM users WHERE id = ? FOR UPDATE',
        [user.id]
      );

      if (!users.length) {
        throw new Error('用户不存在');
      }

      const userInfo = users[0];
      const availableEnergy = userInfo.energy - userInfo.frozen_energy;

      // 需要检查是否有足够的能量冻结（销售+手续费）
      if (availableEnergy < totalFreezeEnergy) {
        throw new Error(`能量不足，当前可用能量: ${availableEnergy}，发布广告需要冻结: ${totalFreezeEnergy}能量（销售${energy_amount} + 手续费${feeEnergy}）`);
      }

      // 2. 创建广告
      const [result] = await conn.execute(
        `INSERT INTO energy_ads (user_id, username, avatar, energy_amount, price_per_energy, total_price, payment_qr_code, description, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
        [user.id, user.username, user.avatar || '', energy_amount, price_per_energy, total_price, payment_qr_code, description, expires_hours]
      );

      // 3. 冻结能量（销售能量 + 手续费能量）
      await conn.execute(
        'UPDATE users SET frozen_energy = frozen_energy + ? WHERE id = ?',
        [totalFreezeEnergy, user.id]
      );

      // 4. 验证冻结是否成功
      const [updated] = await conn.execute(
        'SELECT COALESCE(frozen_energy, 0) as frozen_energy FROM users WHERE id = ?',
        [user.id]
      );

      if (updated[0].frozen_energy < totalFreezeEnergy) {
        throw new Error('能量冻结失败，请重试');
      }

      res.json({
        success: true,
        data: {
          ad_id: result.insertId,
          energy_amount,
          price_per_energy,
          total_price,
          fee,
          net_income
        },
        message: `广告发布成功，已冻结${totalFreezeEnergy}能量作为担保（销售${energy_amount} + 手续费${feeEnergy}）`
      });
    });
  } catch (err) {
    console.error('发布广告失败:', err);
    res.status(400).json({ error: err.message || '服务器内部错误' });
  }
});

/**
 * PUT /api/energy-trade/ads/:id
 * 修改广告（只能修改未售出的广告）
 */
router.put('/ads/:id', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { price_per_energy, description, expires_hours } = req.body;
    
    // 查询广告
    const ads = await db.query('SELECT * FROM energy_ads WHERE id = ?', [id]);
    if (!ads.length) {
      return res.status(404).json({ error: '广告不存在' });
    }
    
    const ad = ads[0];
    
    // 验证所有权
    if (ad.user_id !== user.id) {
      return res.status(403).json({ error: '无权限修改此广告' });
    }
    
    // 检查状态
    if (ad.status !== 'active') {
      return res.status(400).json({ error: '只能修改进行中的广告' });
    }
    
    // 更新广告
    const updates = [];
    const params = [];
    
    if (price_per_energy) {
      const total_price = parseFloat((ad.energy_amount * price_per_energy).toFixed(2));
      updates.push('price_per_energy = ?', 'total_price = ?');
      params.push(price_per_energy, total_price);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      params.push(description);
    }
    if (expires_hours) {
      updates.push('expires_at = DATE_ADD(NOW(), INTERVAL ? HOUR)');
      params.push(expires_hours);
    }
    
    if (updates.length) {
      params.push(id);
      await db.execute(
        `UPDATE energy_ads SET ${updates.join(', ')} WHERE id = ?`,
        params
      );
    }
    
    res.json({ success: true, message: '广告修改成功' });
  } catch (err) {
    console.error('修改广告失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * DELETE /api/energy-trade/ads/:id
 * 删除广告
 */
router.delete('/ads/:id', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    
    // 使用事务确保原子性
    await db.transaction(async (conn) => {
      // 查询广告（带行锁）
      const [ads] = await conn.execute(
        'SELECT * FROM energy_ads WHERE id = ? FOR UPDATE',
        [id]
      );
      if (!ads.length) {
        throw new Error('广告不存在');
      }
      
      const ad = ads[0];
      
      // 验证所有权
      if (ad.user_id !== user.id) {
        throw new Error('无权限删除此广告');
      }
      
      // 检查状态
      if (ad.status === 'sold') {
        throw new Error('广告已售出，无法删除');
      }
      
      // 如果是进行中的广告，解冻全部能量（销售能量 + 手续费能量）
      if (ad.status === 'active') {
        // 获取当前手续费率，计算原始手续费能量
        const feeRate = await getFeeRate();
        const feeEnergy = Math.floor(ad.energy_amount * feeRate / 100);
        const totalUnfreeze = ad.energy_amount + feeEnergy;

        const [frozenCheck] = await conn.execute(
          'SELECT COALESCE(frozen_energy, 0) as frozen_energy FROM users WHERE id = ?',
          [user.id]
        );

        if (frozenCheck[0].frozen_energy >= totalUnfreeze) {
          await conn.execute(
            'UPDATE users SET frozen_energy = GREATEST(0, COALESCE(frozen_energy, 0) - ?) WHERE id = ?',
            [totalUnfreeze, user.id]
          );
        }
      }

      // 更新状态为取消
      await conn.execute("UPDATE energy_ads SET status = 'cancelled' WHERE id = ?", [id]);
    });
    
    res.json({ success: true, message: '广告已删除，能量已解冻' });
  } catch (err) {
    console.error('删除广告失败:', err);
    res.status(400).json({ error: err.message || '服务器内部错误' });
  }
});

/**
 * POST /api/energy-trade/ads/:id/purchase
 * 购买广告（创建担保交易）
 */
router.post('/ads/:id/purchase', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { pay_password } = req.body;

    // 检查是否设置了支付密码
    let userInfo;
    try {
      const [u] = await db.query('SELECT pay_password FROM users WHERE id = ?', [user.id]);
      userInfo = u;
    } catch (e) {
      console.log('pay_password字段查询失败:', e.message);
    }

    if (!userInfo?.pay_password) {
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

    if (!bcrypt.compareSync(pay_password, userInfo.pay_password)) {
      return res.status(400).json({ error: '支付密码错误' });
    }

    // 使用事务确保原子性
    await db.transaction(async (conn) => {
      // 1. 获取广告信息并锁定（防止并发购买）
      const [ads] = await conn.execute(
        "SELECT * FROM energy_ads WHERE id = ? AND status = 'active' FOR UPDATE",
        [id]
      );
      
      if (!ads.length) {
        throw new Error('广告不存在或已下架');
      }
      
      const ad = ads[0];
      
      // 不能购买自己的广告
      if (ad.user_id === user.id) {
        throw new Error('不能购买自己的广告');
      }
      
      // 检查广告是否过期
      if (ad.expires_at && new Date(ad.expires_at) < new Date()) {
        await conn.execute("UPDATE energy_ads SET status = 'expired' WHERE id = ?", [id]);
        throw new Error('广告已过期');
      }
      
      // 生成交易编号
      const trade_no = 'ET' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();

      // 交易超时时间（5分钟）
      const payment_deadline = new Date(Date.now() + 5 * 60 * 1000);

      // 2. 创建交易记录
      const [result] = await conn.execute(
        `INSERT INTO energy_trades (trade_no, ad_id, seller_id, seller_username, buyer_id, buyer_username, energy_amount, price, status, payment_deadline)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?)`,
        [trade_no, ad.id, ad.user_id, ad.username, user.id, user.username, ad.energy_amount, ad.total_price, payment_deadline]
      );
      
      // 3. 更新广告状态为已锁定（原子操作）
      const [updateResult] = await conn.execute(
        "UPDATE energy_ads SET status = 'sold' WHERE id = ? AND status = 'active'",
        [id]
      );
      
      // 检查是否更新成功（防止并发问题）
      if (updateResult.affectedRows === 0) {
        throw new Error('广告已被其他买家购买，请刷新后重试');
      }
      
      // 4. 记录系统消息
      await conn.execute(
        `INSERT INTO energy_trade_messages (trade_id, sender_id, sender_username, sender_role, message_type, content)
         VALUES (?, ?, ?, 'system', 'text', ?)`,
        [result.insertId, 0, '系统', `交易已创建，请买家在24小时内完成付款。交易编号: ${trade_no}`]
      );

      // 5. 为卖家创建通知
      try {
        await mongo.createEnergyTradeNotification(
          ad.user_id,
          result.insertId,
          'new_trade',
          '新交易提醒',
          `买家 ${user.username} 购买了您的广告，交易编号: ${trade_no}`,
          { trade_id: result.insertId, trade_no, buyer_username: user.username, energy_amount: ad.energy_amount }
        );
      } catch (err) {
        console.error('创建交易通知失败:', err.message);
      }

      // 返回结果
      res.json({
        success: true,
        data: {
          trade_id: result.insertId,
          trade_no,
          energy_amount: ad.energy_amount,
          price: ad.total_price,
          seller_username: ad.username,
          payment_qr_code: ad.payment_qr_code
        }
      });
    });
  } catch (err) {
    console.error('购买广告失败:', err);
    res.status(400).json({ error: err.message || '购买失败' });
  }
});

// ============================================================
// 交易管理API
// ============================================================

/**
 * GET /api/energy-trade/trades
 * 获取我的交易列表
 */
router.get('/trades', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { page = 1, limit = 20, role = 'all', status = 'all' } = req.query;
    const offset = (page - 1) * limit;
    
    let whereClause = '';
    const params = [];
    
    if (role === 'seller') {
      whereClause = 'WHERE seller_id = ?';
      params.push(user.id);
    } else if (role === 'buyer') {
      whereClause = 'WHERE buyer_id = ?';
      params.push(user.id);
    } else {
      whereClause = 'WHERE seller_id = ? OR buyer_id = ?';
      params.push(user.id, user.id);
    }
    
    if (status && status !== 'all') {
      whereClause += ` AND status = ?`;
      params.push(status);
    }
    
    // 查询总数
    const countResult_trades = await db.query(
      `SELECT COUNT(*) as total FROM energy_trades ${whereClause}`,
      params
    );
    const total = countResult_trades[0].total;
    
    // 查询列表
    const trades = await db.query(
      `SELECT * FROM energy_trades ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    
    res.json({
      success: true,
      data: {
        list: trades,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('获取交易列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * GET /api/energy-trade/trades/:id
 * 获取交易详情
 */
router.get('/trades/:id', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    
    const trades = await db.query('SELECT * FROM energy_trades WHERE id = ?', [id]);
    if (!trades.length) {
      return res.status(404).json({ error: '交易不存在' });
    }

    const trade = trades[0];

    // 计算剩余时间（秒）
    let remainingSeconds = 0;
    if (trade.status === 'pending_payment' && trade.payment_deadline) {
      const deadline = new Date(trade.payment_deadline);
      remainingSeconds = Math.max(0, Math.floor((deadline - new Date()) / 1000));
    } else if (trade.status === 'payment_submitted' && trade.confirm_deadline) {
      const deadline = new Date(trade.confirm_deadline);
      remainingSeconds = Math.max(0, Math.floor((deadline - new Date()) / 1000));
    }

    // 验证权限（交易双方或管理员）
    if (trade.seller_id !== user.id && trade.buyer_id !== user.id && user.role !== 'admin') {
      return res.status(403).json({ error: '无权限查看此交易' });
    }
    
    // 获取广告信息
    const ads = await db.query('SELECT * FROM energy_ads WHERE id = ?', [trade.ad_id]);
    
    res.json({
      success: true,
      data: {
        ...trade,
        remaining_seconds: remainingSeconds,
        ad: ads[0] || null
      }
    });
  } catch (err) {
    console.error('获取交易详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * POST /api/energy-trade/trades/:id/payment
 * 买家上传付款凭证
 */
router.post('/trades/:id/payment', authenticateToken, upload.single('payment_image'), async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { payment_image } = req.body;
    
    // 使用事务 + 行锁确保并发安全
    await db.transaction(async (conn) => {
      // 1. 获取交易信息并锁定
      const [trades] = await conn.execute(
        "SELECT * FROM energy_trades WHERE id = ? AND buyer_id = ? AND status = 'pending_payment' FOR UPDATE",
        [id, user.id]
      );
      
      if (!trades.length) {
        // 检查是否存在交易
        const [existingTrades] = await conn.execute(
          'SELECT * FROM energy_trades WHERE id = ?',
          [id]
        );
        
        if (!existingTrades.length) {
          throw new Error('交易不存在');
        }
        
        const trade = existingTrades[0];
        
        if (trade.buyer_id !== user.id) {
          throw new Error('只有买家可以上传付款凭证');
        }
        
        if (trade.status !== 'pending_payment') {
          throw new Error('当前状态不允许上传付款凭证');
        }
        
        throw new Error('交易状态已变更，请刷新后重试');
      }
      
      const trade = trades[0];
      
      // 2. 如果有文件上传，使用文件路径；否则使用URL
      let paymentImageUrl = payment_image;
      if (req.file) {
        paymentImageUrl = '/uploads/energy-trade/' + req.file.filename;
      }
      
      if (!paymentImageUrl) {
        throw new Error('请上传付款凭证');
      }
      
      // 确认收款超时时间（5分钟）
      const confirm_deadline = new Date(Date.now() + 5 * 60 * 1000);

      // 3. 更新交易状态
      await conn.execute(
        "UPDATE energy_trades SET status = 'payment_submitted', payment_image = ?, payment_time = NOW(), confirm_deadline = ? WHERE id = ?",
        [paymentImageUrl, confirm_deadline, id]
      );
      
      // 4. 记录系统消息
      await conn.execute(
        `INSERT INTO energy_trade_messages (trade_id, sender_id, sender_username, sender_role, message_type, content)
         VALUES (?, ?, ?, 'system', 'text', ?)`,
        [id, 0, '系统', '买家已上传付款凭证，请卖家确认收款后释放能量']
      );

      // 5. 通过Socket广播交易更新
      const io = getEnergyTradeIO();
      if (io) {
        io.to(`trade:${id}`).emit('trade_update', {
          trade_id: id,
          status: 'payment_submitted',
          message: '买家已上传付款凭证'
        });
      }
    });
    
    res.json({
      success: true,
      message: '付款凭证已上传，请等待卖家确认'
    });
  } catch (err) {
    console.error('上传付款凭证失败:', err);
    res.status(400).json({ error: err.message || '服务器内部错误' });
  }
});

/**
 * POST /api/energy-trade/trades/:id/confirm
 * 卖家确认收款并释放能量
 */
router.post('/trades/:id/confirm', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;

    // 在事务外获取手续费比例
    const feeRate = await getFeeRate();

    // 使用事务 + 行锁确保并发安全
    await db.transaction(async (conn) => {
      // 1. 获取交易信息并锁定（防止重复确认）
      const [trades] = await conn.execute(
        "SELECT * FROM energy_trades WHERE id = ? AND seller_id = ? AND status = 'payment_submitted' FOR UPDATE",
        [id, user.id]
      );

      if (!trades.length) {
        // 检查是否存在交易
        const [existingTrades] = await conn.execute(
          'SELECT * FROM energy_trades WHERE id = ?',
          [id]
        );

        if (!existingTrades.length) {
          throw new Error('交易不存在');
        }

        const trade = existingTrades[0];

        if (trade.seller_id !== user.id) {
          throw new Error('只有卖家可以确认收款');
        }

        if (trade.status !== 'payment_submitted') {
          throw new Error('当前状态不能确认收款');
        }

        throw new Error('交易状态已变更，请刷新后重试');
      }

      const trade = trades[0];

      // 计算手续费能量
      const feeEnergy = Math.floor(trade.energy_amount * feeRate / 100); // 手续费能量（向下取整）
      const totalDeduction = trade.energy_amount + feeEnergy; // 卖家总扣除能量

      // 2. 锁定卖家账户并检查冻结能量（应冻结了销售+手续费）
      const [sellers] = await conn.execute(
        'SELECT COALESCE(frozen_energy, 0) as frozen_energy FROM users WHERE id = ? FOR UPDATE',
        [trade.seller_id]
      );

      if (sellers[0].frozen_energy < totalDeduction) {
        throw new Error('卖家冻结能量不足，请联系管理员');
      }

      // 3. 扣除卖家全部冻结能量（销售能量+手续费能量）
      await conn.execute(
        'UPDATE users SET frozen_energy = GREATEST(0, frozen_energy - ?) WHERE id = ?',
        [totalDeduction, trade.seller_id]
      );

      // 4. 释放全部销售能量给买家
      await conn.execute(
        'UPDATE users SET energy = energy + ? WHERE id = ?',
        [trade.energy_amount, trade.buyer_id]
      );

      // 5. 更新交易状态
      await conn.execute(
        "UPDATE energy_trades SET status = 'energy_released', confirm_time = NOW(), complete_time = NOW() WHERE id = ?",
        [id]
      );

      // 6. 记录系统消息
      const message = `交易完成！买家获得${trade.energy_amount}能量，卖家扣除${totalDeduction}能量（销售${trade.energy_amount} + 手续费${feeEnergy}）`;
      await conn.execute(
        `INSERT INTO energy_trade_messages (trade_id, sender_id, sender_username, sender_role, message_type, content)
         VALUES (?, ?, ?, 'system', 'text', ?)`,
        [id, 0, '系统', message]
      );

      // 7. 通过Socket广播交易更新
      const io = getEnergyTradeIO();
      if (io) {
        io.to(`trade:${id}`).emit('trade_update', {
          trade_id: id,
          status: 'energy_released',
          message: '交易已完成'
        });
      }

      res.json({
        success: true,
        message: '收款确认成功，能量已释放给买家'
      });
    });
  } catch (err) {
    console.error('确认收款失败:', err);
    res.status(400).json({ error: err.message || '服务器内部错误' });
  }
});

/**
 * POST /api/energy-trade/trades/:id/reject
 * 卖家拒绝交易（买家上传付款凭证后，卖家怀疑凭证为假）
 */
router.post('/trades/:id/reject', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { reason = '' } = req.body;

    // 使用事务 + 行锁确保并发安全
    await db.transaction(async (conn) => {
      // 1. 获取交易信息并锁定
      const [trades] = await conn.execute(
        "SELECT * FROM energy_trades WHERE id = ? AND seller_id = ? AND status = 'payment_submitted' FOR UPDATE",
        [id, user.id]
      );

      if (!trades.length) {
        // 检查是否存在
        const [existingTrades] = await conn.execute(
          'SELECT * FROM energy_trades WHERE id = ?',
          [id]
        );

        if (!existingTrades.length) {
          throw new Error('交易不存在');
        }

        const trade = existingTrades[0];

        if (trade.seller_id !== user.id) {
          throw new Error('只有卖家可以拒绝交易');
        }

        if (trade.status !== 'payment_submitted') {
          throw new Error('当前状态不能拒绝交易');
        }

        throw new Error('交易状态已变更，请刷新后重试');
      }

      const trade = trades[0];

      // 2. 更新交易状态为拒绝
      await conn.execute(
        "UPDATE energy_trades SET status = 'cancelled', admin_handle_note = ? WHERE id = ?",
        [`卖家拒绝交易：${reason || '怀疑付款凭证为假'}`, id]
      );

      // 3. 解冻卖家能量（需要解冻销售能量+手续费能量）
      const feeRate = await getFeeRate();
      const feeEnergy = Math.floor(trade.energy_amount * feeRate / 100);
      const totalDeduction = trade.energy_amount + feeEnergy;

      const [seller] = await conn.execute(
        'SELECT COALESCE(frozen_energy, 0) as frozen_energy FROM users WHERE id = ?',
        [trade.seller_id]
      );

      if (seller[0].frozen_energy >= totalDeduction) {
        await conn.execute(
          'UPDATE users SET frozen_energy = GREATEST(0, frozen_energy - ?) WHERE id = ?',
          [totalDeduction, trade.seller_id]
        );
      }

      // 4. 恢复广告状态（如果广告还存在）
      const [ads] = await conn.execute(
        'SELECT * FROM energy_ads WHERE id = ?',
        [trade.ad_id]
      );
      if (ads.length > 0 && ads[0].status === 'sold') {
        await conn.execute(
          "UPDATE energy_ads SET status = 'active' WHERE id = ?",
          [trade.ad_id]
        );
      }

      // 5. 记录系统消息
      await conn.execute(
        `INSERT INTO energy_trade_messages (trade_id, sender_id, sender_username, sender_role, message_type, content)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, user.id, user.username, 'system', 'text', `交易已拒绝。拒绝原因: ${reason || '怀疑付款凭证为假'}`]
      );

      // 6. 通过Socket广播交易更新
      const io = getEnergyTradeIO();
      if (io) {
        io.to(`trade:${trade.trade_no}`).emit('trade_update', {
          trade_id: id,
          trade_no: trade.trade_no,
          status: 'cancelled',
          message: '交易已拒绝：' + (reason || '怀疑付款凭证为假')
        });
      }

      res.json({
        success: true,
        message: '已拒绝交易，能量已解冻，广告已恢复'
      });
    });
  } catch (err) {
    console.error('拒绝交易失败:', err);
    res.status(400).json({ error: err.message || '服务器内部错误' });
  }
});

/**
 * POST /api/energy-trade/trades/:id/cancel
 * 买家取消交易
 */
router.post('/trades/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { reason = '' } = req.body;
    
    // 使用事务 + 行锁确保并发安全
    await db.transaction(async (conn) => {
      // 1. 获取交易信息并锁定
      const [trades] = await conn.execute(
        "SELECT * FROM energy_trades WHERE id = ? AND buyer_id = ? AND status IN ('pending_payment', 'payment_submitted') FOR UPDATE",
        [id, user.id]
      );
      
      if (!trades.length) {
        // 检查是否存在
        const [existingTrades] = await conn.execute(
          'SELECT * FROM energy_trades WHERE id = ?',
          [id]
        );
        
        if (!existingTrades.length) {
          throw new Error('交易不存在');
        }
        
        const trade = existingTrades[0];
        
        if (trade.buyer_id !== user.id) {
          throw new Error('只有买家可以取消交易');
        }
        
        throw new Error('当前状态不能取消交易');
      }
      
      const trade = trades[0];
      
      // 2. 更新交易状态
      await conn.execute(
        "UPDATE energy_trades SET status = 'cancelled', admin_handle_note = ? WHERE id = ?",
        [reason || '买家主动取消', id]
      );
      
      // 3. 解冻卖家能量（检查冻结能量）
      const [seller] = await conn.execute(
        'SELECT COALESCE(frozen_energy, 0) as frozen_energy FROM users WHERE id = ?',
        [trade.seller_id]
      );
      
      if (seller[0].frozen_energy >= trade.energy_amount) {
        await conn.execute(
          'UPDATE users SET frozen_energy = GREATEST(0, frozen_energy - ?) WHERE id = ?',
          [trade.energy_amount, trade.seller_id]
        );
      }
      
      // 4. 恢复广告状态（如果广告还存在）
      const [ads] = await conn.execute(
        'SELECT * FROM energy_ads WHERE id = ?',
        [trade.ad_id]
      );
      if (ads.length > 0 && ads[0].status === 'sold') {
        // 只有当广告状态为sold时才恢复（防止广告已被删除或被其他买家购买）
        await conn.execute(
          "UPDATE energy_ads SET status = 'active' WHERE id = ?",
          [trade.ad_id]
        );
      }
      
      // 5. 记录系统消息
      await conn.execute(
        `INSERT INTO energy_trade_messages (trade_id, sender_id, sender_username, sender_role, message_type, content)
         VALUES (?, ?, ?, 'system', 'text', ?)`,
        [id, user.id, user.username, 'buyer', `交易已取消。取消原因: ${reason || '买家主动取消'}`]
      );

      // 6. 通过Socket广播交易更新
      const io = getEnergyTradeIO();
      if (io) {
        io.to(`trade:${id}`).emit('trade_update', {
          trade_id: id,
          status: 'cancelled',
          message: '交易已取消'
        });
      }

      res.json({
        success: true,
        message: '交易已取消'
      });
    });
  } catch (err) {
    console.error('取消交易失败:', err);
    res.status(400).json({ error: err.message || '服务器内部错误' });
  }
});

/**
 * POST /api/energy-trade/trades/:id/dispute
 * 发起纠纷
 */
router.post('/trades/:id/dispute', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { dispute_type, description, evidence_images } = req.body;
    
    // 获取交易信息
    const trades = await db.query('SELECT * FROM energy_trades WHERE id = ?', [id]);
    if (!trades.length) {
      return res.status(404).json({ error: '交易不存在' });
    }
    
    const trade = trades[0];
    
    // 验证买家身份
    if (trade.buyer_id !== user.id) {
      return res.status(403).json({ error: '只有买家可以发起纠纷' });
    }
    
    // 检查状态
    if (trade.status !== 'payment_submitted') {
      return res.status(400).json({ error: '当前状态不能发起纠纷' });
    }
    
    if (!dispute_type || !description) {
      return res.status(400).json({ error: '请填写纠纷类型和描述' });
    }
    
    // 创建纠纷记录
    const result = await db.execute(
      `INSERT INTO energy_disputes (trade_id, complainant_id, complainant_username, dispute_type, description, evidence_images, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [id, user.id, user.username, dispute_type, description, JSON.stringify(evidence_images || [])]
    );
    
    // 更新交易状态为纠纷中
    await db.execute(
      "UPDATE energy_trades SET status = 'disputed', dispute_reason = ? WHERE id = ?",
      [description, id]
    );
    
    // 记录系统消息
    await db.execute(
      `INSERT INTO energy_trade_messages (trade_id, sender_id, sender_username, sender_role, message_type, content)
       VALUES (?, ?, ?, 'system', 'text', ?)`,
      [id, user.id, user.username, 'buyer', `买家已发起纠纷，请等待平台处理。纠纷类型: ${dispute_type}`]
    );

    // 6. 通过Socket广播交易更新
    const io = getEnergyTradeIO();
    if (io) {
      io.to(`trade:${id}`).emit('trade_update', {
        trade_id: id,
        status: 'disputed',
        message: '已发起纠纷，请等待平台处理'
      });
    }

    res.json({
      success: true,
      message: '纠纷已发起，平台将尽快处理',
      data: { dispute_id: result.insertId }
    });
  } catch (err) {
    console.error('发起纠纷失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ============================================================
// 交易消息API
// ============================================================

/**
 * GET /api/energy-trade/trades/:id/chat
 * 获取交易聊天记录
 */
router.get('/trades/:id/chat', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { limit = 50 } = req.query;
    
    // 获取交易信息
    const trades = await db.query('SELECT * FROM energy_trades WHERE id = ?', [id]);
    if (!trades.length) {
      return res.status(404).json({ error: '交易不存在' });
    }
    
    const trade = trades[0];
    
    // 验证权限
    if (trade.seller_id !== user.id && trade.buyer_id !== user.id) {
      return res.status(403).json({ error: '无权限查看此交易聊天' });
    }
    
    // 从MongoDB获取聊天记录
    let messages = [];
    try {
      messages = await mongo.getEnergyTradeMessages(id, parseInt(limit));
      // 反转顺序使最早的在前
      messages = messages.reverse();
    } catch (err) {
      console.error('MongoDB获取消息失败，降级到MySQL:', err.message);
      // 降级：从MySQL获取
      const mysqlMessages = await db.query(
        'SELECT * FROM energy_trade_messages WHERE trade_id = ? ORDER BY created_at ASC',
        [id]
      );
      messages = mysqlMessages;
    }

    // 标记消息为已读
    try {
      await mongo.markEnergyTradeMessagesAsRead(id, user.id);
    } catch (err) {
      console.error('标记已读失败:', err.message);
    }

    // 获取未读数量
    let unreadCount = 0;
    try {
      unreadCount = await mongo.getUnreadEnergyTradeMessageCount(id, user.id);
    } catch (err) {
      console.error('获取未读数失败:', err.message);
    }
    
    res.json({
      success: true,
      data: messages,
      unread_count: unreadCount
    });
  } catch (err) {
    console.error('获取聊天记录失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * POST /api/energy-trade/trades/:id/chat
 * 发送交易消息
 */
router.post('/trades/:id/chat', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { content, message_type = 'text' } = req.body;
    
    if (!content) {
      return res.status(400).json({ error: '消息内容不能为空' });
    }
    
    // 获取交易信息
    const trades = await db.query('SELECT * FROM energy_trades WHERE id = ?', [id]);
    if (!trades.length) {
      return res.status(404).json({ error: '交易不存在' });
    }
    
    const trade = trades[0];
    
    // 验证权限
    if (trade.seller_id !== user.id && trade.buyer_id !== user.id) {
      return res.status(403).json({ error: '无权限发送消息' });
    }
    
    // 确定发送者角色
    const senderRole = user.id === trade.seller_id ? 'seller' : 'buyer';
    
    // 保存消息到MongoDB
    let messageId = null;
    let createdAt = new Date();
    
    try {
      const mongoId = await mongo.saveEnergyTradeMessage(
        id, user.id, user.username, senderRole, content, message_type
      );
      messageId = mongoId.toString();
    } catch (err) {
      console.error('MongoDB保存消息失败，降级到MySQL:', err.message);
      // 降级：保存到MySQL
      const result = await db.execute(
        `INSERT INTO energy_trade_messages (trade_id, sender_id, sender_username, sender_role, message_type, content)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, user.id, user.username, senderRole, message_type, content]
      );
      messageId = result.insertId;
    }
    
    // 获取接收者ID
    const receiverId = user.id === trade.seller_id ? trade.buyer_id : trade.seller_id;
    
    // 创建通知（用于离线用户上线后获取未读消息提醒）
    try {
      await mongo.createEnergyTradeNotification(
        receiverId,
        id,
        'new_message',
        '新交易消息',
        `${user.username} 发送了新消息`,
        { sender_id: user.id, sender_username: user.username, sender_role: senderRole }
      );
    } catch (err) {
      console.error('创建通知失败:', err.message);
    }
    
    // 通过Socket广播（如果在线）
    const io = getEnergyTradeIO();
    if (io) {
      io.to(`trade:${id}`).emit('new_message', {
        id: messageId,
        trade_id: parseInt(id),
        sender_id: user.id,
        sender_username: user.username,
        sender_role: senderRole,
        content: content,
        message_type: message_type,
        created_at: createdAt.toISOString()
      });
    }
    
    res.json({
      success: true,
      data: {
        id: messageId,
        sender_username: user.username,
        sender_role: senderRole,
        content,
        created_at: createdAt
      }
    });
  } catch (err) {
    console.error('发送消息失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ============================================================
// 管理员能量广告API
// ============================================================

/**
 * GET /api/energy-trade/admin/ads
 * 获取所有广告列表（管理员）
 */
router.get('/admin/ads', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, status = 'all', keyword = '' } = req.query;
    const offset = (page - 1) * limit;
    
    let whereClause = '';
    const params = [];
    
    if (status && status !== 'all') {
      whereClause = 'WHERE status = ?';
      params.push(status);
    }
    
    if (keyword) {
      whereClause += params.length ? ' AND username LIKE ?' : 'WHERE username LIKE ?';
      params.push(`%${keyword}%`);
    }
    
    // 查询总数
    const countResult_ads = await db.query(
      `SELECT COUNT(*) as total FROM energy_ads ${whereClause}`,
      params
    );
    const total = countResult_ads[0].total;
    
    // 查询列表（过滤过期广告）
    const ads = await db.query(
      `SELECT * FROM energy_ads ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    
    res.json({
      success: true,
      data: {
        list: ads,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('获取广告列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * GET /api/energy-trade/admin/ads/:id
 * 获取广告详情（管理员）
 */
router.get('/admin/ads/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const ads = await db.query('SELECT * FROM energy_ads WHERE id = ?', [id]);
    if (!ads.length) {
      return res.status(404).json({ error: '广告不存在' });
    }
    
    res.json({
      success: true,
      data: ads[0]
    });
  } catch (err) {
    console.error('获取广告详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * DELETE /api/energy-trade/admin/ads/:id
 * 删除广告（管理员）
 */
router.delete('/admin/ads/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // 使用事务
    await db.transaction(async (conn) => {
      // 查询广告
      const [ads] = await conn.execute(
        'SELECT * FROM energy_ads WHERE id = ? FOR UPDATE',
        [id]
      );
      
      if (!ads.length) {
        throw new Error('广告不存在');
      }
      
      const ad = ads[0];
      
      // 如果是进行中的广告，解冻全部能量（销售能量 + 手续费能量）
      if (ad.status === 'active') {
        // 获取当前手续费率，计算原始手续费能量
        const feeRate = await getFeeRate();
        const feeEnergy = Math.floor(ad.energy_amount * feeRate / 100);
        const totalUnfreeze = ad.energy_amount + feeEnergy;

        await conn.execute(
          'UPDATE users SET frozen_energy = GREATEST(0, COALESCE(frozen_energy, 0) - ?) WHERE id = ?',
          [totalUnfreeze, ad.user_id]
        );
      }

      // 删除广告
      await conn.execute('DELETE FROM energy_ads WHERE id = ?', [id]);
    });
    
    res.json({ success: true, message: '广告已删除，能量已解冻' });
  } catch (err) {
    console.error('删除广告失败:', err);
    res.status(400).json({ error: err.message || '服务器内部错误' });
  }
});

// ============================================================
// 管理后台API
// ============================================================

/**
 * GET /api/energy-trade/admin/trades
 * 获取所有交易列表（管理员）
 */
router.get('/admin/trades', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, status = 'all', keyword = '' } = req.query;
    const offset = (page - 1) * limit;
    
    let whereClause = '';
    const params = [];
    
    if (status && status !== 'all') {
      whereClause = 'WHERE status = ?';
      params.push(status);
    }
    
    if (keyword) {
      whereClause += params.length ? ' AND (seller_username LIKE ? OR buyer_username LIKE ? OR trade_no LIKE ?)' : 'WHERE (seller_username LIKE ? OR buyer_username LIKE ? OR trade_no LIKE ?)';
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw);
    }
    
    // 查询总数
    const countResult_admin_trades = await db.query(
      `SELECT COUNT(*) as total FROM energy_trades ${whereClause}`,
      params
    );
    const total = countResult_admin_trades[0].total;
    
    // 查询列表
    const trades = await db.query(
      `SELECT * FROM energy_trades ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    
    res.json({
      success: true,
      data: {
        list: trades,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('获取交易列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * GET /api/energy-trade/admin/trades/:id
 * 获取交易详情（管理员）
 */
router.get('/admin/trades/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const trades = await db.query('SELECT * FROM energy_trades WHERE id = ?', [id]);
    if (!trades.length) {
      return res.status(404).json({ error: '交易不存在' });
    }
    
    const trade = trades[0];
    
    // 获取聊天记录
    const messages = await db.query(
      'SELECT * FROM energy_trade_messages WHERE trade_id = ? ORDER BY created_at ASC',
      [id]
    );
    
    // 获取纠纷记录
    const disputes = await db.query(
      'SELECT * FROM energy_disputes WHERE trade_id = ?',
      [id]
    );
    
    res.json({
      success: true,
      data: {
        ...trade,
        messages,
        dispute: disputes[0] || null
      }
    });
  } catch (err) {
    console.error('获取交易详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * POST /api/energy-trade/admin/trades/:id/resolve
 * 管理员介入处理交易
 */
router.post('/admin/trades/:id/resolve', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { resolution, note } = req.body;
    
    if (!resolution || !['seller_wins', 'buyer_wins', 'cancel'].includes(resolution)) {
      return res.status(400).json({ error: '请选择正确的处理方案' });
    }
    
    // 使用事务 + 行锁确保并发安全
    await db.transaction(async (conn) => {
      // 1. 获取交易信息并锁定
      const [trades] = await conn.execute(
        "SELECT * FROM energy_trades WHERE id = ? AND status IN ('disputed', 'payment_submitted', 'pending_payment') FOR UPDATE",
        [id]
      );
      
      if (!trades.length) {
        throw new Error('交易不存在或状态不可处理');
      }
      
      const trade = trades[0];
      let newStatus = '';
      
      // 2. 能量处理根据判定结果
      if (resolution === 'seller_wins') {
        // 判卖家胜：扣除卖家冻结能量给买家
        newStatus = 'resolved_seller';
        
        // 先检查冻结能量是否足够
        const [seller] = await conn.execute(
          'SELECT COALESCE(frozen_energy, 0) as frozen_energy FROM users WHERE id = ?',
          [trade.seller_id]
        );
        
        if (seller[0].frozen_energy >= trade.energy_amount) {
          await conn.execute(
            'UPDATE users SET frozen_energy = GREATEST(0, frozen_energy - ?) WHERE id = ?',
            [trade.energy_amount, trade.seller_id]
          );
        }
        
        await conn.execute(
          'UPDATE users SET energy = energy + ? WHERE id = ?',
          [trade.energy_amount, trade.buyer_id]
        );
        
      } else if (resolution === 'buyer_wins') {
        // 判买家胜：解冻卖家能量
        newStatus = 'resolved_buyer';
        
        const [seller] = await conn.execute(
          'SELECT COALESCE(frozen_energy, 0) as frozen_energy FROM users WHERE id = ?',
          [trade.seller_id]
        );
        
        if (seller[0].frozen_energy >= trade.energy_amount) {
          await conn.execute(
            'UPDATE users SET frozen_energy = GREATEST(0, frozen_energy - ?) WHERE id = ?',
            [trade.energy_amount, trade.seller_id]
          );
        }
        
      } else if (resolution === 'cancel') {
        // 取消交易
        newStatus = 'cancelled';
        
        const [seller] = await conn.execute(
          'SELECT COALESCE(frozen_energy, 0) as frozen_energy FROM users WHERE id = ?',
          [trade.seller_id]
        );
        
        if (seller[0].frozen_energy >= trade.energy_amount) {
          await conn.execute(
            'UPDATE users SET frozen_energy = GREATEST(0, frozen_energy - ?) WHERE id = ?',
            [trade.energy_amount, trade.seller_id]
          );
        }
        
        await conn.execute(
          "UPDATE energy_ads SET status = 'active' WHERE id = ?",
          [trade.ad_id]
        );
      }
      
      // 3. 更新交易状态
      await conn.execute(
        `UPDATE energy_trades SET status = ?, admin_handle_note = ?, handled_by = ?, complete_time = NOW() WHERE id = ?`,
        [newStatus, note || '', user.id, id]
      );
      
      // 4. 更新纠纷状态
      if (trade.status === 'disputed') {
        await conn.execute(
          `UPDATE energy_disputes SET status = ?, admin_note = ?, admin_result = ?, handled_by = ?, handled_at = NOW() WHERE trade_id = ?`,
          [resolution === 'seller_wins' ? 'resolved_seller' : resolution === 'buyer_wins' ? 'resolved_buyer' : 'rejected', note, resolution, user.id, id]
        );
      }
      
      // 5. 记录系统消息
      const resolutionText = {
        'seller_wins': '平台判定：卖家胜诉，能量已释放给买家',
        'buyer_wins': '平台判定：买家胜诉，卖家能量已解冻',
        'cancel': '平台判定：交易取消，卖家能量已解冻'
      };
      
      await conn.execute(
        `INSERT INTO energy_trade_messages (trade_id, sender_id, sender_username, sender_role, message_type, content)
         VALUES (?, ?, ?, 'admin', 'text', ?)`,
        [id, user.id, '管理员', resolutionText[resolution] + (note ? `。处理说明: ${note}` : '')]
      );

      // 6. 通过Socket广播交易更新
      const io = getEnergyTradeIO();
      if (io) {
        io.to(`trade:${id}`).emit('trade_update', {
          trade_id: id,
          status: newStatus,
          message: resolutionText[resolution]
        });
      }
    });
    
    res.json({
      success: true,
      message: '交易处理完成'
    });
  } catch (err) {
    console.error('处理交易失败:', err);
    res.status(400).json({ error: err.message || '服务器内部错误' });
  }
});

/**
 * GET /api/energy-trade/admin/disputes
 * 获取纠纷列表（管理员）
 */
router.get('/admin/disputes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, status = 'all' } = req.query;
    const offset = (page - 1) * limit;
    
    let whereClause = '';
    const params = [];
    
    if (status && status !== 'all') {
      whereClause = 'WHERE status = ?';
      params.push(status);
    }
    
    // 查询总数
    const countResult_disputes = await db.query(
      `SELECT COUNT(*) as total FROM energy_disputes ${whereClause}`,
      params
    );
    const total = countResult_disputes[0].total;
    
    // 查询列表
    const disputes = await db.query(
      `SELECT d.*, t.trade_no, t.energy_amount, t.price, t.seller_username, t.buyer_username
       FROM energy_disputes d
       LEFT JOIN energy_trades t ON d.trade_id = t.id
       ${whereClause}
       ORDER BY d.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    
    res.json({
      success: true,
      data: {
        list: disputes,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('获取纠纷列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * GET /api/energy-trade/admin/disputes/:id
 * 获取纠纷详情（管理员）
 */
router.get('/admin/disputes/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const disputes = await db.query('SELECT * FROM energy_disputes WHERE id = ?', [id]);
    if (!disputes.length) {
      return res.status(404).json({ error: '纠纷不存在' });
    }
    
    const dispute = disputes[0];
    
    // 获取关联的交易信息
    const trades = await db.query('SELECT * FROM energy_trades WHERE id = ?', [dispute.trade_id]);
    
    // 获取聊天记录
    const messages = await db.query(
      'SELECT * FROM energy_trade_messages WHERE trade_id = ? ORDER BY created_at ASC',
      [dispute.trade_id]
    );
    
    res.json({
      success: true,
      data: {
        ...dispute,
        trade: trades[0] || null,
        messages
      }
    });
  } catch (err) {
    console.error('获取纠纷详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * POST /api/energy-trade/admin/disputes/:id/handle
 * 处理纠纷（管理员）
 */
router.post('/admin/disputes/:id/handle', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { result, note } = req.body;
    
    if (!result || !['seller_wins', 'buyer_wins', 'cancelled'].includes(result)) {
      return res.status(400).json({ error: '请选择正确的处理结果' });
    }
    
    // 使用事务 + 行锁确保并发安全
    await db.transaction(async (conn) => {
      // 1. 获取纠纷信息并锁定
      const [disputes] = await conn.execute(
        "SELECT * FROM energy_disputes WHERE id = ? FOR UPDATE",
        [id]
      );
      
      if (!disputes.length) {
        throw new Error('纠纷不存在');
      }
      
      const dispute = disputes[0];
      const tradeId = dispute.trade_id;
      
      // 2. 获取交易信息并锁定
      const [trades] = await conn.execute(
        "SELECT * FROM energy_trades WHERE id = ? FOR UPDATE",
        [tradeId]
      );
      
      if (!trades.length) {
        throw new Error('关联交易不存在');
      }
      
      const trade = trades[0];
      let newStatus = '';
      
      // 3. 根据处理结果处理能量
      if (result === 'seller_wins') {
        newStatus = 'resolved_seller';
        
        // 检查冻结能量
        const [seller] = await conn.execute(
          'SELECT COALESCE(frozen_energy, 0) as frozen_energy FROM users WHERE id = ?',
          [trade.seller_id]
        );
        
        if (seller[0].frozen_energy >= trade.energy_amount) {
          await conn.execute(
            'UPDATE users SET frozen_energy = GREATEST(0, frozen_energy - ?) WHERE id = ?',
            [trade.energy_amount, trade.seller_id]
          );
        }
        
        await conn.execute(
          'UPDATE users SET energy = energy + ? WHERE id = ?',
          [trade.energy_amount, trade.buyer_id]
        );
        
      } else if (result === 'buyer_wins') {
        newStatus = 'resolved_buyer';
        
        const [seller] = await conn.execute(
          'SELECT COALESCE(frozen_energy, 0) as frozen_energy FROM users WHERE id = ?',
          [trade.seller_id]
        );
        
        if (seller[0].frozen_energy >= trade.energy_amount) {
          await conn.execute(
            'UPDATE users SET frozen_energy = GREATEST(0, frozen_energy - ?) WHERE id = ?',
            [trade.energy_amount, trade.seller_id]
          );
        }
        
      } else if (result === 'cancelled') {
        newStatus = 'cancelled';
        
        const [seller] = await conn.execute(
          'SELECT COALESCE(frozen_energy, 0) as frozen_energy FROM users WHERE id = ?',
          [trade.seller_id]
        );
        
        if (seller[0].frozen_energy >= trade.energy_amount) {
          await conn.execute(
            'UPDATE users SET frozen_energy = GREATEST(0, frozen_energy - ?) WHERE id = ?',
            [trade.energy_amount, trade.seller_id]
          );
        }
        
        await conn.execute(
          "UPDATE energy_ads SET status = 'active' WHERE id = ?",
          [trade.ad_id]
        );
      }
      
      // 4. 更新纠纷状态
      await conn.execute(
        `UPDATE energy_disputes SET status = ?, admin_note = ?, admin_result = ?, handled_by = ?, handled_at = NOW() WHERE id = ?`,
        [result === 'seller_wins' ? 'resolved_seller' : result === 'buyer_wins' ? 'resolved_buyer' : 'rejected', note, result, user.id, id]
      );
      
      // 5. 更新交易状态
      await conn.execute(
        `UPDATE energy_trades SET status = ?, admin_handle_note = ?, handled_by = ?, complete_time = NOW() WHERE id = ?`,
        [newStatus, note || '', user.id, tradeId]
      );
    });
    
    res.json({
      success: true,
      message: '纠纷处理完成'
    });
  } catch (err) {
    console.error('处理纠纷失败:', err);
    res.status(400).json({ error: err.message || '服务器内部错误' });
  }
});

/**
 * POST /api/energy-trade/upload/image
 * 上传图片
 */
router.post('/upload/image', authenticateToken, upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请选择图片文件' });
  }

  const imageUrl = '/uploads/energy-trade/' + req.file.filename;
  res.json({
    success: true,
    data: {
      url: imageUrl
    }
  });
});

/**
 * GET /api/energy-trade/admin/stats
 * 获取交易统计数据（管理员）
 */
router.get('/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let dateFilter = '';
    const params = [];

    if (start_date && end_date) {
      dateFilter = 'WHERE created_at >= ? AND created_at <= ?';
      params.push(start_date, end_date + ' 23:59:59');
    } else if (start_date) {
      dateFilter = 'WHERE created_at >= ?';
      params.push(start_date);
    } else if (end_date) {
      dateFilter = 'WHERE created_at <= ?';
      params.push(end_date + ' 23:59:59');
    }

    // 获取手续费率
    const feeRate = await getFeeRate();

    // 统计已完成交易
    const completedTrades = await db.query(
      `SELECT COUNT(*) as total_count, COALESCE(SUM(energy_amount), 0) as total_energy FROM energy_trades ${dateFilter ? dateFilter + ' AND status = ?' : 'WHERE status = ?'}`,
      [...params, 'energy_released']
    );

    // 统计所有交易（包括手续费）
    const allTrades = await db.query(
      `SELECT COUNT(*) as total_count FROM energy_trades ${dateFilter}`,
      params
    );

    // 统计进行中的交易
    const activeTrades = await db.query(
      `SELECT COUNT(*) as total_count FROM energy_trades ${dateFilter ? dateFilter + ' AND status IN (?, ?)' : 'WHERE status IN (?, ?)'}`,
      [...params, 'pending_payment', 'payment_submitted']
    );

    // 统计纠纷中交易
    const disputedTrades = await db.query(
      `SELECT COUNT(*) as total_count FROM energy_trades ${dateFilter ? dateFilter + ' AND status = ?' : 'WHERE status = ?'}`,
      [...params, 'disputed']
    );

    // 计算总收入（手续费能量 = 能量 * 手续费率）
    const totalEnergy = parseInt(completedTrades[0].total_energy) || 0;
    const totalFeeEnergy = Math.floor(totalEnergy * feeRate / 100);

    res.json({
      success: true,
      data: {
        total_trades: allTrades[0].total_count || 0,
        completed_trades: completedTrades[0].total_count || 0,
        active_trades: activeTrades[0].total_count || 0,
        disputed_trades: disputedTrades[0].total_count || 0,
        total_energy_traded: totalEnergy,
        total_fee_energy: totalFeeEnergy,
        fee_rate: feeRate
      }
    });
  } catch (err) {
    console.error('获取交易统计失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;

/**
 * 处理超时的待付款交易（买家未在规定时间内上传付款凭证）
 */
async function processPaymentTimeout() {
  try {
    // 查找超时的待付款交易
    const timeoutTrades = await db.query(
      "SELECT * FROM energy_trades WHERE status = 'pending_payment' AND payment_deadline <= NOW()"
    );

    if (timeoutTrades.length === 0) return;

    console.log(`[能量交易超时] 发现 ${timeoutTrades.length} 个超时待付款交易`);

    for (const trade of timeoutTrades) {
      try {
        await db.transaction(async (conn) => {
          // 获取交易锁
          const [trades] = await conn.execute(
            "SELECT * FROM energy_trades WHERE id = ? AND status = 'pending_payment' FOR UPDATE",
            [trade.id]
          );

          if (!trades.length) return; // 已被处理
          const t = trades[0];

          // 更新交易状态为取消
          await conn.execute(
            "UPDATE energy_trades SET status = 'cancelled', admin_handle_note = '系统超时自动取消：买家未在规定时间内上传付款凭证' WHERE id = ?",
            [t.id]
          );

          // 恢复广告状态（如果广告还存在）
          const [ads] = await conn.execute(
            'SELECT * FROM energy_ads WHERE id = ?',
            [t.ad_id]
          );
          if (ads.length > 0 && ads[0].status === 'sold') {
            // 只有当广告状态为sold时才恢复
            await conn.execute(
              "UPDATE energy_ads SET status = 'active' WHERE id = ?",
              [t.ad_id]
            );
          }

          // 记录系统消息
          await conn.execute(
            `INSERT INTO energy_trade_messages (trade_id, sender_id, sender_username, sender_role, message_type, content)
             VALUES (?, ?, ?, 'system', 'text', ?)`,
            [t.id, 0, '系统', '交易超时取消：买家未在规定时间内上传付款凭证']
          );

          // 通知卖家
          const io = getEnergyTradeIO();
          if (io) {
            io.to(`trade:${t.trade_no}`).emit('trade_update', {
              trade_id: t.id,
              trade_no: t.trade_no,
              status: 'cancelled',
              message: '交易超时取消：买家未在规定时间内上传付款凭证'
            });
          }
        });

        console.log(`[能量交易超时] 交易 ${trade.trade_no} 已超时取消`);
      } catch (err) {
        console.error(`[能量交易超时] 处理交易 ${trade.trade_no} 失败:`, err);
      }
    }
  } catch (err) {
    console.error('[能量交易超时] 查询超时交易失败:', err);
  }
}

/**
 * 处理超时的待确认交易（卖家未在规定时间内确认收款）
 */
async function processConfirmTimeout() {
  try {
    // 获取手续费率
    let feeRate = 5;
    try {
      const configs = await db.query(
        "SELECT config_value FROM game_config WHERE config_key = 'energy_trade_fee_rate'"
      );
      if (configs.length > 0 && configs[0].config_value) {
        feeRate = parseFloat(configs[0].config_value);
      }
    } catch (e) {}

    // 查找超时的待确认交易
    const timeoutTrades = await db.query(
      "SELECT * FROM energy_trades WHERE status = 'payment_submitted' AND confirm_deadline <= NOW()"
    );

    if (timeoutTrades.length === 0) return;

    console.log(`[能量交易超时] 发现 ${timeoutTrades.length} 个超时待确认交易`);

    for (const trade of timeoutTrades) {
      try {
        await db.transaction(async (conn) => {
          // 获取交易锁
          const [trades] = await conn.execute(
            "SELECT * FROM energy_trades WHERE id = ? AND status = 'payment_submitted' FOR UPDATE",
            [trade.id]
          );

          if (!trades.length) return; // 已被处理
          const t = trades[0];

          // 计算手续费能量
          const feeEnergy = Math.floor(t.energy_amount * feeRate / 100);
          const totalDeduction = t.energy_amount + feeEnergy;

          // 扣除卖家全部冻结能量
          await conn.execute(
            'UPDATE users SET frozen_energy = GREATEST(0, frozen_energy - ?) WHERE id = ?',
            [totalDeduction, t.seller_id]
          );

          // 释放全部销售能量给买家
          await conn.execute(
            'UPDATE users SET energy = energy + ? WHERE id = ?',
            [t.energy_amount, t.buyer_id]
          );

          // 更新交易状态为已完成
          await conn.execute(
            "UPDATE energy_trades SET status = 'energy_released', confirm_time = NOW(), complete_time = NOW(), admin_handle_note = '系统超时自动完成：卖家未在规定时间内确认收款' WHERE id = ?",
            [t.id]
          );

          // 记录系统消息
          const message = `交易超时自动完成！买家获得${t.energy_amount}能量，卖家扣除${totalDeduction}能量（销售${t.energy_amount} + 手续费${feeEnergy}）`;
          await conn.execute(
            `INSERT INTO energy_trade_messages (trade_id, sender_id, sender_username, sender_role, message_type, content)
             VALUES (?, ?, ?, 'system', 'text', ?)`,
            [t.id, 0, '系统', message]
          );

          // 通知双方
          const io = getEnergyTradeIO();
          if (io) {
            io.to(`trade:${t.trade_no}`).emit('trade_update', {
              trade_id: t.id,
              trade_no: t.trade_no,
              status: 'energy_released',
              message: '交易超时自动完成'
            });
          }
        });

        console.log(`[能量交易超时] 交易 ${trade.trade_no} 已超时自动完成`);
      } catch (err) {
        console.error(`[能量交易超时] 处理交易 ${trade.trade_no} 失败:`, err);
      }
    }
  } catch (err) {
    console.error('[能量交易超时] 查询超时确认交易失败:', err);
  }
}

// 导出超时处理函数供外部调用
module.exports.processPaymentTimeout = processPaymentTimeout;
module.exports.processConfirmTimeout = processConfirmTimeout;
