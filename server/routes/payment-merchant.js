/**
 * @file payment-merchant.js
 * @module routes/payment-merchant
 * @description 支付商户API - 商户管理、收款名目、订单管理、统计
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../utils/db');
const redis = require('../utils/redis');
const mongo = require('../utils/payment-mongo');
const oss = require('../utils/oss');
const QRCode = require('qrcode');
const { authenticateToken } = require('../middleware/auth');
const { CACHE_KEYS, CACHE_TTL } = require('../utils/cache-keys');

// ============================================
// 辅助函数
// ============================================

/** 生成API秘钥 */
function generateApiKey() {
  return crypto.randomBytes(32).toString('hex'); // 64位16进制
}

/** 生成订单号 */
function generateOrderNo() {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `PAY${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${timestamp}${random}`;
}

/** 生成备注码 */
function generateRemarkCode(orderNo) {
  const suffix = orderNo.slice(-4);
  const random = Math.floor(1000 + Math.random() * 9000);
  return `${suffix}-${random}`;
}

/** 验证金额 */
function validateAmount(amount, item) {
  const num = parseFloat(amount);
  if (isNaN(num) || num <= 0) {
    throw new Error('金额必须是大于0的数字');
  }
  const validated = Math.round(num * 100) / 100;

  if (validated < parseFloat(item.min_amount)) {
    throw new Error(`金额不能小于${item.min_amount}`);
  }
  if (validated > parseFloat(item.max_amount)) {
    throw new Error(`金额不能大于${item.max_amount}`);
  }
  return validated;
}

/** 清除商户相关缓存 */
async function clearMerchantCache(merchantId, userId = null) {
  await redis.del(CACHE_KEYS.PAYMENT_MERCHANT_INFO(merchantId));
  if (userId) {
    await redis.del(CACHE_KEYS.PAYMENT_MERCHANT_BY_USER(userId));
  }
  await redis.del(CACHE_KEYS.PAYMENT_MERCHANT_SUMMARY(merchantId));
}

/** 清除名目缓存 */
async function clearItemCache(itemId, merchantId) {
  await redis.del(CACHE_KEYS.PAYMENT_ITEM_DETAIL(itemId));
  await redis.del(CACHE_KEYS.PAYMENT_ITEM_LIST(merchantId));
}

/** 清除订单缓存 */
async function clearOrderCache(orderNo, orderId, merchantId) {
  await redis.del(CACHE_KEYS.PAYMENT_ORDER_DETAIL(orderNo));
  if (orderId) {
    await redis.del(CACHE_KEYS.PAYMENT_ORDER_BY_ID(orderId));
  }
  // 清除统计缓存
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  await redis.del(CACHE_KEYS.PAYMENT_DAILY_STATS(merchantId, today));
  const yearMonth = new Date().toISOString().slice(0, 7).replace('-', '');
  await redis.del(CACHE_KEYS.PAYMENT_MONTHLY_STATS(merchantId, yearMonth));
  await redis.del(CACHE_KEYS.PAYMENT_MERCHANT_SUMMARY(merchantId));
}

/**
 * 获取轮询收款账户
 * @param {number} merchantId - 商户ID
 * @param {string} accountType - 账户类型 (alipay/wechat/bank)
 * @returns {object|null} 轮询到的账户或null
 */
async function getRoundRobinAccount(merchantId, accountType) {
  try {
    // 获取所有启用的账户，按sort_order排序
    const accounts = await db.query(
      `SELECT * FROM payment_accounts
       WHERE merchant_id = ? AND account_type = ? AND is_enabled = 1
       ORDER BY sort_order, id`,
      [merchantId, accountType]
    );

    if (accounts.length === 0) {
      return null;
    }

    if (accounts.length === 1) {
      return accounts[0];
    }

    // 使用Redis计数器实现轮询
    const counterKey = `payment:round_robin:${merchantId}:${accountType}`;
    let currentIndex = 0;

    try {
      // 使用Redis INCR实现原子计数
      const redisClient = redis.client;
      if (redisClient && redisClient.isReady) {
        currentIndex = await redisClient.incr(counterKey);
        // 设置过期时间（24小时），防止计数器无限增长
        await redisClient.expire(counterKey, 86400);
        currentIndex = (currentIndex - 1) % accounts.length;
      } else {
        // Redis不可用时使用本地计数器
        if (!getRoundRobinAccount.counters) {
          getRoundRobinAccount.counters = {};
        }
        const counter = (getRoundRobinAccount.counters[counterKey] || 0) + 1;
        getRoundRobinAccount.counters[counterKey] = counter;
        currentIndex = (counter - 1) % accounts.length;
      }
    } catch (e) {
      console.error('Redis计数器错误，使用随机选择:', e.message);
      currentIndex = Math.floor(Math.random() * accounts.length);
    }

    return accounts[currentIndex];
  } catch (err) {
    console.error('获取轮询账户失败:', err);
    return null;
  }
}

/**
 * 获取账户的完整信息（包含真实银行卡号）
 * @param {number} accountId - 账户ID
 * @returns {object|null}
 */
async function getAccountById(accountId) {
  try {
    const accounts = await db.query(
      'SELECT * FROM payment_accounts WHERE id = ?',
      [accountId]
    );
    return accounts.length > 0 ? accounts[0] : null;
  } catch (err) {
    console.error('获取账户详情失败:', err);
    return null;
  }
}

// ============================================
// 商户管理接口（需认证）
// ============================================

/**
 * GET /api/payment/merchant
 * 获取商户信息
 */
router.get('/merchant', authenticateToken, async (req, res) => {
  try {
    const { user } = req;

    // 先从缓存获取
    const cached = await redis.get(CACHE_KEYS.PAYMENT_MERCHANT_BY_USER(user.id));
    if (cached) {
      return res.json({ success: true, data: cached });
    }

    // 查询商户信息
    const merchants = await db.query(
      'SELECT * FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.json({
        success: true,
        data: {
          is_merchant: false,
          merchant_id: null,
          merchant_name: '',
          status: null
        }
      });
    }

    const merchant = merchants[0];

    // 获取收款账户列表
    const accounts = await db.query(
      'SELECT * FROM payment_accounts WHERE merchant_id = ? ORDER BY account_type, sort_order, id',
      [merchant.id]
    );

    // 按类型分组
    const alipayAccounts = [];
    const wechatAccounts = [];
    const bankAccounts = [];

    for (const account of accounts) {
      const acc = {
        id: account.id,
        account_name: account.account_name,
        qrcode_url: account.qrcode_url || '',
        bank_account: account.bank_account ? '****' + account.bank_account.slice(-4) : '',
        bank_name: account.bank_name || '',
        bank_username: account.bank_username || '',
        is_enabled: !!account.is_enabled,
        sort_order: account.sort_order,
        created_at: account.created_at
      };

      if (account.account_type === 'alipay') {
        alipayAccounts.push(acc);
      } else if (account.account_type === 'wechat') {
        wechatAccounts.push(acc);
      } else if (account.account_type === 'bank') {
        bankAccounts.push(acc);
      }
    }

    // 检查是否有启用的账户
    const hasAlipay = alipayAccounts.some(a => a.is_enabled);
    const hasWechat = wechatAccounts.some(a => a.is_enabled);
    const hasBank = bankAccounts.some(a => a.is_enabled);

    const result = {
      is_merchant: true,
      merchant_id: merchant.id,
      user_id: merchant.user_id,
      merchant_name: merchant.merchant_name || '',
      // 保留旧字段兼容
      alipay_qrcode: merchant.alipay_qrcode || '',
      wechat_qrcode: merchant.wechat_qrcode || '',
      has_alipay: hasAlipay,
      has_wechat: hasWechat,
      has_bank: hasBank,
      bank_account: merchant.bank_account ? '****' + merchant.bank_account.slice(-4) : '',
      bank_name: merchant.bank_name || '',
      bank_username: merchant.bank_username || '',
      // 新多账户字段
      accounts: accounts.map(a => ({
        id: a.id,
        account_type: a.account_type,
        account_name: a.account_name,
        qrcode_url: a.qrcode_url || '',
        bank_account: a.bank_account ? '****' + a.bank_account.slice(-4) : '',
        bank_name: a.bank_name || '',
        bank_username: a.bank_username || '',
        bank_branch: a.bank_branch || '',
        is_enabled: !!a.is_enabled,
        sort_order: a.sort_order
      })),
      alipay_accounts: alipayAccounts,
      wechat_accounts: wechatAccounts,
      bank_accounts: bankAccounts,
      api_key: merchant.api_key,
      status: merchant.status,
      created_at: merchant.created_at,
      updated_at: merchant.updated_at
    };

    // 缓存结果
    await redis.set(
      CACHE_KEYS.PAYMENT_MERCHANT_BY_USER(user.id),
      result,
      CACHE_TTL.PAYMENT_MERCHANT_INFO
    );

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('获取商户信息失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * POST /api/payment/merchant
 * 开通/更新商户
 */
router.post('/merchant', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { merchant_name } = req.body;

    // 检查是否已存在商户
    const existing = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    let merchantId;
    if (existing.length === 0) {
      // 开通新商户
      const apiKey = generateApiKey();
      const result = await db.query(
        `INSERT INTO payment_merchants (user_id, merchant_name, api_key, status) VALUES (?, ?, ?, ?)`,
        [user.id, merchant_name || user.username, apiKey, 'active']
      );
      merchantId = result.insertId;
    } else {
      // 更新商户信息
      merchantId = existing[0].id;
      await db.query(
        'UPDATE payment_merchants SET merchant_name = ? WHERE id = ?',
        [merchant_name, merchantId]
      );
    }

    // 清除缓存
    await clearMerchantCache(merchantId, user.id);

    res.json({ success: true, message: '商户信息已更新', data: { merchant_id: merchantId } });
  } catch (err) {
    console.error('更新商户信息失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * PUT /api/payment/merchant/qrcodes
 * 上传收款码
 */
router.put('/merchant/qrcodes', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { type, image } = req.body; // type: alipay | wechat

    if (!type || !['alipay', 'wechat'].includes(type)) {
      return res.status(400).json({ error: '无效的收款码类型' });
    }

    if (!image) {
      return res.status(400).json({ error: '请上传收款码图片' });
    }

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(400).json({ error: '请先开通商户' });
    }

    const merchantId = merchants[0].id;

    // 处理base64图片并上传到OSS
    let imageUrl = image;
    if (image.startsWith('data:image')) {
      // 提取base64数据
      const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      // 生成唯一文件名
      const fileName = `payment/${type}_${merchantId}_${Date.now()}.png`;

      try {
        const ossClient = await oss.getOSSClient();
        const uploadResult = await oss.client.put(fileName, buffer);
        imageUrl = uploadResult.url;
      } catch (ossErr) {
        console.error('OSS上传失败:', ossErr);
        // OSS失败时使用本地存储（降级）
        imageUrl = `/uploads/payment/${type}_${merchantId}_${Date.now()}.png`;
      }
    }

    // 更新数据库
    const field = type === 'alipay' ? 'alipay_qrcode' : 'wechat_qrcode';
    await db.query(
      `UPDATE payment_merchants SET ${field} = ? WHERE id = ?`,
      [imageUrl, merchantId]
    );

    // 清除缓存
    await clearMerchantCache(merchantId, user.id);

    res.json({ success: true, message: '收款码已上传', data: { url: imageUrl } });
  } catch (err) {
    console.error('上传收款码失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * PUT /api/payment/merchant/bank
 * 设置银行卡
 */
router.put('/merchant/bank', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { bank_account, bank_name, bank_username } = req.body;

    if (!bank_account || !bank_name || !bank_username) {
      return res.status(400).json({ error: '请填写完整的银行卡信息' });
    }

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(400).json({ error: '请先开通商户' });
    }

    const merchantId = merchants[0].id;

    // 更新银行卡信息
    await db.query(
      'UPDATE payment_merchants SET bank_account = ?, bank_name = ?, bank_username = ? WHERE id = ?',
      [bank_account, bank_name, bank_username, merchantId]
    );

    // 清除缓存
    await clearMerchantCache(merchantId, user.id);

    res.json({ success: true, message: '银行卡信息已保存' });
  } catch (err) {
    console.error('保存银行卡信息失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * POST /api/payment/merchant/regenerate-key
 * 重置API秘钥
 */
router.post('/merchant/regenerate-key', authenticateToken, async (req, res) => {
  try {
    const { user } = req;

    // 获取商户
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(400).json({ error: '请先开通商户' });
    }

    const merchantId = merchants[0].id;
    const newApiKey = generateApiKey();

    await db.query(
      'UPDATE payment_merchants SET api_key = ? WHERE id = ?',
      [newApiKey, merchantId]
    );

    // 清除缓存
    await clearMerchantCache(merchantId, user.id);

    res.json({ success: true, message: 'API秘钥已重置', data: { api_key: newApiKey } });
  } catch (err) {
    console.error('重置API秘钥失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * PUT /api/payment/merchant/status
 * 商户状态开关
 */
router.put('/merchant/status', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { status } = req.body;

    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ error: '无效的状态' });
    }

    // 获取商户
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(400).json({ error: '请先开通商户' });
    }

    const merchantId = merchants[0].id;

    await db.query(
      'UPDATE payment_merchants SET status = ? WHERE id = ?',
      [status, merchantId]
    );

    // 清除缓存
    await clearMerchantCache(merchantId, user.id);

    res.json({ success: true, message: `商户已${status === 'active' ? '启用' : '停用'}` });
  } catch (err) {
    console.error('更新商户状态失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ============================================
// 收款账户管理接口（需认证）
// ============================================

/**
 * GET /api/payment/accounts
 * 获取收款账户列表
 */
router.get('/accounts', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { account_type } = req.query;

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const merchantId = merchants[0].id;

    // 构建查询
    let whereClause = 'WHERE merchant_id = ?';
    const params = [merchantId];

    if (account_type) {
      whereClause += ' AND account_type = ?';
      params.push(account_type);
    }

    // 查询账户列表
    const accounts = await db.query(
      `SELECT * FROM payment_accounts ${whereClause} ORDER BY account_type, sort_order, id`,
      params
    );

    // 格式化返回数据
    const result = accounts.map(account => ({
      id: account.id,
      merchant_id: account.merchant_id,
      account_type: account.account_type,
      account_name: account.account_name,
      qrcode_url: account.qrcode_url || '',
      bank_account: account.bank_account ? '****' + account.bank_account.slice(-4) : '',
      bank_name: account.bank_name || '',
      bank_username: account.bank_username || '',
      bank_branch: account.bank_branch || '',
      is_enabled: !!account.is_enabled,
      sort_order: account.sort_order,
      created_at: account.created_at,
      updated_at: account.updated_at
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('获取账户列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * POST /api/payment/accounts
 * 添加收款账户
 */
router.post('/accounts', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const {
      account_type,
      account_name,
      qrcode_url,
      bank_account,
      bank_name,
      bank_username,
      bank_branch,
      is_enabled = true
    } = req.body;

    // 验证必填字段
    if (!account_type || !['alipay', 'wechat', 'bank'].includes(account_type)) {
      return res.status(400).json({ error: '请选择账户类型' });
    }

    if (!account_name) {
      return res.status(400).json({ error: '请输入账户名称' });
    }

    // 验证账户类型特定字段
    if (account_type === 'alipay' || account_type === 'wechat') {
      if (!qrcode_url) {
        return res.status(400).json({ error: '请上传收款码图片' });
      }
    } else if (account_type === 'bank') {
      if (!bank_account || !bank_name || !bank_username) {
        return res.status(400).json({ error: '请填写完整的银行卡信息' });
      }
    }

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(400).json({ error: '请先开通商户' });
    }

    const merchantId = merchants[0].id;

    // 获取当前最大排序值
    const maxSort = await db.query(
      'SELECT COALESCE(MAX(sort_order), 0) as max_sort FROM payment_accounts WHERE merchant_id = ? AND account_type = ?',
      [merchantId, account_type]
    );

    // 插入账户
    const result = await db.query(
      `INSERT INTO payment_accounts
       (merchant_id, account_type, account_name, qrcode_url, bank_account, bank_name, bank_username, bank_branch, is_enabled, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        merchantId,
        account_type,
        account_name,
        qrcode_url || '',
        bank_account || '',
        bank_name || '',
        bank_username || '',
        bank_branch || '',
        is_enabled ? 1 : 0,
        maxSort[0].max_sort + 1
      ]
    );

    const accountId = result.insertId;

    // 清除缓存
    await clearMerchantCache(merchantId, user.id);

    res.json({
      success: true,
      message: '收款账户已添加',
      data: { account_id: accountId }
    });
  } catch (err) {
    console.error('添加账户失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * PUT /api/payment/accounts/:id
 * 更新收款账户
 */
router.put('/accounts/:id', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const {
      account_name,
      qrcode_url,
      bank_account,
      bank_name,
      bank_username,
      bank_branch,
      is_enabled,
      sort_order
    } = req.body;

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(403).json({ error: '无权访问' });
    }

    const merchantId = merchants[0].id;

    // 验证账户归属
    const accounts = await db.query(
      'SELECT id FROM payment_accounts WHERE id = ? AND merchant_id = ?',
      [id, merchantId]
    );

    if (accounts.length === 0) {
      return res.status(404).json({ error: '账户不存在' });
    }

    // 构建更新语句
    const updates = [];
    const params = [];

    if (account_name !== undefined) { updates.push('account_name = ?'); params.push(account_name); }
    if (qrcode_url !== undefined) { updates.push('qrcode_url = ?'); params.push(qrcode_url); }
    if (bank_account !== undefined) { updates.push('bank_account = ?'); params.push(bank_account); }
    if (bank_name !== undefined) { updates.push('bank_name = ?'); params.push(bank_name); }
    if (bank_username !== undefined) { updates.push('bank_username = ?'); params.push(bank_username); }
    if (bank_branch !== undefined) { updates.push('bank_branch = ?'); params.push(bank_branch); }
    if (is_enabled !== undefined) { updates.push('is_enabled = ?'); params.push(is_enabled ? 1 : 0); }
    if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(sort_order); }

    if (updates.length > 0) {
      params.push(id);
      await db.query(
        `UPDATE payment_accounts SET ${updates.join(', ')} WHERE id = ?`,
        params
      );
    }

    // 清除缓存
    await clearMerchantCache(merchantId, user.id);

    res.json({ success: true, message: '账户已更新' });
  } catch (err) {
    console.error('更新账户失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * PUT /api/payment/accounts/:id/toggle
 * 启用/禁用收款账户
 */
router.put('/accounts/:id/toggle', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { is_enabled } = req.body;

    if (is_enabled === undefined) {
      return res.status(400).json({ error: '请指定启用状态' });
    }

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(403).json({ error: '无权访问' });
    }

    const merchantId = merchants[0].id;

    // 验证账户归属
    const accounts = await db.query(
      'SELECT id FROM payment_accounts WHERE id = ? AND merchant_id = ?',
      [id, merchantId]
    );

    if (accounts.length === 0) {
      return res.status(404).json({ error: '账户不存在' });
    }

    // 更新状态
    await db.query(
      'UPDATE payment_accounts SET is_enabled = ? WHERE id = ?',
      [is_enabled ? 1 : 0, id]
    );

    // 清除缓存
    await clearMerchantCache(merchantId, user.id);

    res.json({
      success: true,
      message: is_enabled ? '账户已启用' : '账户已禁用'
    });
  } catch (err) {
    console.error('切换账户状态失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * DELETE /api/payment/accounts/:id
 * 删除收款账户
 */
router.delete('/accounts/:id', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(403).json({ error: '无权访问' });
    }

    const merchantId = merchants[0].id;

    // 验证账户归属
    const accounts = await db.query(
      'SELECT id FROM payment_accounts WHERE id = ? AND merchant_id = ?',
      [id, merchantId]
    );

    if (accounts.length === 0) {
      return res.status(404).json({ error: '账户不存在' });
    }

    // 删除账户
    await db.query('DELETE FROM payment_accounts WHERE id = ?', [id]);

    // 清除缓存
    await clearMerchantCache(merchantId, user.id);

    res.json({ success: true, message: '账户已删除' });
  } catch (err) {
    console.error('删除账户失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ============================================
// 收款名目接口（需认证）
// ============================================

/**
 * GET /api/payment/items
 * 获取名目列表
 */
router.get('/items', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.json({ success: true, data: { list: [], pagination: { page: 1, limit: 20, total: 0 } } });
    }

    const merchantId = merchants[0].id;

    // 构建查询
    let whereClause = 'WHERE merchant_id = ?';
    const params = [merchantId];

    if (status) {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    // 查询总数
    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM payment_items ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    // 查询列表
    const items = await db.query(
      `SELECT * FROM payment_items ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    // 处理图片JSON
    const list = items.map(item => {
      const paymentMode = item.payment_mode || 'flexible';
      return {
        ...item,
        images: item.images ? (typeof item.images === 'string' ? JSON.parse(item.images) : item.images) : [],
        expense_items: item.expense_items ? (typeof item.expense_items === 'string' ? JSON.parse(item.expense_items) : item.expense_items) : [],
        payment_mode: paymentMode,
        default_amount: parseFloat(item.default_amount) || 0,
        min_amount: parseFloat(item.min_amount) || 0.01,
        max_amount: parseFloat(item.max_amount) || 99999.99
      };
    });

    res.json({
      success: true,
      data: {
        list,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          total_pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('获取名目列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * GET /api/payment/items/:id
 * 获取名目详情
 */
router.get('/items/:id', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;

    // 先从缓存获取
    const cached = await redis.get(CACHE_KEYS.PAYMENT_ITEM_DETAIL(id));
    if (cached) {
      // 验证权限
      if (cached.merchant_id) {
        const merchants = await db.query('SELECT id FROM payment_merchants WHERE user_id = ?', [user.id]);
        if (merchants.length > 0 && merchants[0].id === cached.merchant_id) {
          return res.json({ success: true, data: cached });
        }
      }
    }

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(403).json({ error: '无权访问' });
    }

    const merchantId = merchants[0].id;

    // 查询名目
    const items = await db.query(
      'SELECT * FROM payment_items WHERE id = ? AND merchant_id = ?',
      [id, merchantId]
    );

    if (items.length === 0) {
      return res.status(404).json({ error: '名目不存在' });
    }

    const item = items[0];
    const result = {
      ...item,
      images: item.images ? JSON.parse(item.images) : [],
      expense_items: item.expense_items ? (typeof item.expense_items === 'string' ? JSON.parse(item.expense_items) : item.expense_items) : [],
      default_amount: parseFloat(item.default_amount) || 0,
      min_amount: parseFloat(item.min_amount) || 0.01,
      max_amount: parseFloat(item.max_amount) || 99999.99
    };

    // 缓存结果
    await redis.set(
      CACHE_KEYS.PAYMENT_ITEM_DETAIL(id),
      result,
      CACHE_TTL.PAYMENT_ITEM_DETAIL
    );

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('获取名目详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * POST /api/payment/items
 * 创建收款名目
 */
router.post('/items', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const {
      item_name,
      item_description,
      images,
      video_url,
      video_cover,
      payment_mode,  // 新增：收款模式
      default_amount,
      min_amount,
      max_amount,
      enable_custom_amount,
      payment_note,
      expense_items  // 计算器模式：费用清单
    } = req.body;

    if (!item_name) {
      return res.status(400).json({ error: '请填写名目名称' });
    }

    // 验证收款模式
    const mode = payment_mode || 'flexible';
    if (!['fixed', 'flexible', 'calculator'].includes(mode)) {
      return res.status(400).json({ error: '无效的收款模式' });
    }

    // 固定金额模式验证
    if (mode === 'fixed') {
      if (!default_amount || parseFloat(default_amount) <= 0) {
        return res.status(400).json({ error: '固定金额模式必须填写收款金额' });
      }
    }

    // 计算器模式验证
    if (mode === 'calculator') {
      if (!expense_items || !Array.isArray(expense_items) || expense_items.length === 0) {
        return res.status(400).json({ error: '计算器模式必须添加费用清单' });
      }
      // 计算总金额
      const totalAmount = expense_items.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
      if (totalAmount <= 0) {
        return res.status(400).json({ error: '费用清单总金额必须大于0' });
      }
    }

    // 随意金额模式验证
    if (mode === 'flexible') {
      const min = parseFloat(min_amount) || 0.01;
      const max = parseFloat(max_amount) || 99999.99;
      if (min > max) {
        return res.status(400).json({ error: '最小金额不能大于最大金额' });
      }
    }

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id, status FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(400).json({ error: '请先开通商户' });
    }

    if (merchants[0].status !== 'active') {
      return res.status(400).json({ error: '商户已停用，无法创建名目' });
    }

    const merchantId = merchants[0].id;

    // 处理图片JSON
    const imagesJson = Array.isArray(images) ? JSON.stringify(images) : '[]';

    // 金额设置
    let finalDefaultAmount = 0;
    let finalMinAmount = 0.01;
    let finalMaxAmount = 99999.99;
    let finalExpenseItems = null;

    if (mode === 'fixed') {
      finalDefaultAmount = parseFloat(default_amount) || 0;
    } else if (mode === 'flexible') {
      finalMinAmount = parseFloat(min_amount) || 0.01;
      finalMaxAmount = parseFloat(max_amount) || 99999.99;
    } else if (mode === 'calculator') {
      // 计算器模式：总金额为各项之和
      finalDefaultAmount = expense_items.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
      finalExpenseItems = JSON.stringify(expense_items);
    }

    // 插入数据库
    const result = await db.query(
      `INSERT INTO payment_items
       (merchant_id, item_name, item_description, images, video_url, video_cover,
        payment_mode, default_amount, min_amount, max_amount, enable_custom_amount, expense_items, payment_note, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        merchantId,
        item_name,
        item_description || '',
        imagesJson,
        video_url || '',
        video_cover || '',
        mode,
        finalDefaultAmount,
        finalMinAmount,
        finalMaxAmount,
        mode === 'flexible' ? (enable_custom_amount !== false ? 1 : 0) : 0,
        finalExpenseItems,
        payment_note || '',
        'active'
      ]
    );

    const itemId = result.insertId;

    // 生成收款链接
    const domain = process.env.PUBLIC_DOMAIN || 'https://aibotdemo.skym178.com';
    const paymentUrl = `${domain}/payment-pay.html?item=${itemId}`;

    // 清除名目列表缓存
    await clearItemCache(itemId, merchantId);

    res.json({ 
      success: true, 
      message: '收款名目已创建', 
      data: { 
        item_id: itemId,
        payment_url: paymentUrl
      } 
    });
  } catch (err) {
    console.error('创建名目失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * PUT /api/payment/items/:id
 * 更新名目
 */
router.put('/items/:id', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const {
      item_name,
      item_description,
      images,
      video_url,
      video_cover,
      default_amount,
      min_amount,
      max_amount,
      enable_custom_amount,
      payment_note,
      status
    } = req.body;

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(403).json({ error: '无权访问' });
    }

    const merchantId = merchants[0].id;

    // 验证名目归属
    const items = await db.query(
      'SELECT id FROM payment_items WHERE id = ? AND merchant_id = ?',
      [id, merchantId]
    );

    if (items.length === 0) {
      return res.status(404).json({ error: '名目不存在' });
    }

    // 处理图片JSON
    let imagesJson;
    if (images !== undefined) {
      imagesJson = Array.isArray(images) ? JSON.stringify(images) : '[]';
    }

    // 构建更新语句
    const updates = [];
    const params = [];

    if (item_name !== undefined) { updates.push('item_name = ?'); params.push(item_name); }
    if (item_description !== undefined) { updates.push('item_description = ?'); params.push(item_description); }
    if (imagesJson !== undefined) { updates.push('images = ?'); params.push(imagesJson); }
    if (video_url !== undefined) { updates.push('video_url = ?'); params.push(video_url); }
    if (video_cover !== undefined) { updates.push('video_cover = ?'); params.push(video_cover); }
    if (default_amount !== undefined) { updates.push('default_amount = ?'); params.push(default_amount); }
    if (min_amount !== undefined) { updates.push('min_amount = ?'); params.push(min_amount); }
    if (max_amount !== undefined) { updates.push('max_amount = ?'); params.push(max_amount); }
    if (enable_custom_amount !== undefined) { updates.push('enable_custom_amount = ?'); params.push(enable_custom_amount ? 1 : 0); }
    if (payment_note !== undefined) { updates.push('payment_note = ?'); params.push(payment_note); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }

    if (updates.length > 0) {
      params.push(id);
      await db.query(
        `UPDATE payment_items SET ${updates.join(', ')} WHERE id = ?`,
        params
      );
    }

    // 清除缓存
    await clearItemCache(id, merchantId);

    res.json({ success: true, message: '名目已更新' });
  } catch (err) {
    console.error('更新名目失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * DELETE /api/payment/items/:id
 * 删除名目（软删除）
 */
router.delete('/items/:id', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(403).json({ error: '无权访问' });
    }

    const merchantId = merchants[0].id;

    // 软删除
    await db.query(
      'UPDATE payment_items SET status = ? WHERE id = ? AND merchant_id = ?',
      ['inactive', id, merchantId]
    );

    // 清除缓存
    await clearItemCache(id, merchantId);

    res.json({ success: true, message: '名目已删除' });
  } catch (err) {
    console.error('删除名目失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ============================================
// 订单管理接口（需认证）
// ============================================

/**
 * GET /api/payment/orders
 * 获取订单列表
 */
router.get('/orders', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { page = 1, limit = 20, status, start_date, end_date } = req.query;
    const offset = (page - 1) * limit;

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.json({ success: true, data: { list: [], pagination: { page: 1, limit: 20, total: 0 } } });
    }

    const merchantId = merchants[0].id;

    // 构建查询
    let whereClause = 'WHERE merchant_id = ?';
    const params = [merchantId];

    if (status) {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    if (start_date) {
      whereClause += ' AND created_at >= ?';
      params.push(start_date);
    }

    if (end_date) {
      whereClause += ' AND created_at <= ?';
      params.push(end_date + ' 23:59:59');
    }

    // 查询总数
    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM payment_orders ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    // 查询列表 - 简化查询，先查询订单基本信息
    const orders = await db.query(
      `SELECT * FROM payment_orders ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    // 格式化金额
    const list = orders.map(order => {
      return {
        ...order,
        amount: parseFloat(order.amount) || 0,
        original_amount: parseFloat(order.original_amount) || null,
        remark_code: order.remark_code || '',
        payment_mode: 'flexible',
        expense_items: []
      };
    });

    res.json({
      success: true,
      data: {
        list,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          total_pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('获取订单列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * GET /api/payment/orders/:id
 * 订单详情
 */
router.get('/orders/:id', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(403).json({ error: '无权访问' });
    }

    const merchantId = merchants[0].id;

    // 查询订单
    const orders = await db.query(
      'SELECT * FROM payment_orders WHERE id = ? AND merchant_id = ?',
      [id, merchantId]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: '订单不存在' });
    }

    const order = orders[0];

    // 获取名目信息
    const items = await db.query(
      'SELECT id, item_name, payment_mode, default_amount, expense_items FROM payment_items WHERE id = ?',
      [order.item_id]
    );

    const itemInfo = items.length > 0 ? items[0] : null;

    // 处理expense_items
    let expenseItems = [];
    if (itemInfo && itemInfo.expense_items) {
      try {
        expenseItems = typeof itemInfo.expense_items === 'string' 
          ? JSON.parse(itemInfo.expense_items) 
          : itemInfo.expense_items;
      } catch (e) {
        console.error('解析expense_items失败:', e);
        expenseItems = [];
      }
    }
    
    // 获取操作日志 - 简化处理
    let logs = [];
    
    const result = {
      id: order.id,
      order_no: order.order_no,
      item_id: order.item_id,
      item_name: itemInfo ? itemInfo.item_name : '',
      payment_mode: itemInfo ? (itemInfo.payment_mode || 'flexible') : 'flexible',
      expense_items: expenseItems,
      default_amount: itemInfo ? (parseFloat(itemInfo.default_amount) || 0) : 0,
      merchant_id: order.merchant_id,
      payer_id: order.payer_id,
      payer_username: order.payer_username,
      amount: parseFloat(order.amount) || 0,
      original_amount: parseFloat(order.original_amount) || null,
      payment_method: order.payment_method,
      remark_code: order.remark_code || '',
      status: order.status,
      note: order.note || '',
      payment_screenshot: order.payment_screenshot || '',
      payer_note: order.payer_note || '',
      created_at: order.created_at,
      paid_at: order.paid_at,
      confirmed_at: order.confirmed_at,
      logs: logs
    };

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('获取订单详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * POST /api/payment/orders/:id/confirm
 * 确认收款
 */
router.post('/orders/:id/confirm', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { note } = req.body;

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(403).json({ error: '无权访问' });
    }

    const merchantId = merchants[0].id;

    // 验证订单
    const orders = await db.query(
      'SELECT * FROM payment_orders WHERE id = ? AND merchant_id = ?',
      [id, merchantId]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: '订单不存在' });
    }

    const order = orders[0];

    if (order.status !== 'paid') {
      return res.status(400).json({ error: '只能确认已付款的订单' });
    }

    // 更新订单状态
    await db.query(
      `UPDATE payment_orders
       SET status = ?, confirmed_by = ?, confirmed_at = ?, merchant_note = ?
       WHERE id = ?`,
      ['confirmed', user.id, new Date(), note || '', id]
    );

    // 记录操作日志
    try {
      await mongo.logPaymentOrderAction(parseInt(id), order.order_no, 'confirmed', {
        operator_type: 'merchant',
        operator_id: user.id,
        operator_name: user.username,
        details: { note }
      });
    } catch (e) {
      console.error('记录日志失败:', e);
    }

    // 清除缓存
    await clearOrderCache(order.order_no, parseInt(id), merchantId);

    res.json({ success: true, message: '订单已确认' });
  } catch (err) {
    console.error('确认订单失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * POST /api/payment/orders/:id/reject
 * 拒绝收款
 */
router.post('/orders/:id/reject', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: '请填写拒绝原因' });
    }

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(403).json({ error: '无权访问' });
    }

    const merchantId = merchants[0].id;

    // 验证订单
    const orders = await db.query(
      'SELECT * FROM payment_orders WHERE id = ? AND merchant_id = ?',
      [id, merchantId]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: '订单不存在' });
    }

    const order = orders[0];

    if (order.status !== 'paid') {
      return res.status(400).json({ error: '只能拒绝已付款的订单' });
    }

    // 更新订单状态
    await db.query(
      `UPDATE payment_orders
       SET status = ?, merchant_note = ?
       WHERE id = ?`,
      ['cancelled', reason, id]
    );

    // 记录操作日志
    try {
      await mongo.logPaymentOrderAction(parseInt(id), order.order_no, 'rejected', {
        operator_type: 'merchant',
        operator_id: user.id,
        operator_name: user.username,
        details: { reason }
      });
    } catch (e) {
      console.error('记录日志失败:', e);
    }

    // 清除缓存
    await clearOrderCache(order.order_no, parseInt(id), merchantId);

    res.json({ success: true, message: '订单已拒绝' });
  } catch (err) {
    console.error('拒绝订单失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * POST /api/payment/orders/:id/cancel
 * 取消订单
 */
router.post('/orders/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { reason } = req.body;

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(403).json({ error: '无权访问' });
    }

    const merchantId = merchants[0].id;

    // 验证订单
    const orders = await db.query(
      'SELECT * FROM payment_orders WHERE id = ? AND merchant_id = ?',
      [id, merchantId]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: '订单不存在' });
    }

    const order = orders[0];

    if (!['pending', 'paid'].includes(order.status)) {
      return res.status(400).json({ error: '该订单无法取消' });
    }

    // 更新订单状态
    await db.query(
      `UPDATE payment_orders
       SET status = ?, cancelled_by = ?, cancelled_at = ?, cancelled_reason = ?
       WHERE id = ?`,
      ['cancelled', user.id, new Date(), reason || '', id]
    );

    // 记录操作日志
    try {
      await mongo.logPaymentOrderAction(parseInt(id), order.order_no, 'cancelled', {
        operator_type: 'merchant',
        operator_id: user.id,
        operator_name: user.username,
        details: { reason }
      });
    } catch (e) {
      console.error('记录日志失败:', e);
    }

    // 清除缓存
    await clearOrderCache(order.order_no, parseInt(id), merchantId);

    res.json({ success: true, message: '订单已取消' });
  } catch (err) {
    console.error('取消订单失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ============================================
// 统计接口（需认证）
// ============================================

/**
 * GET /api/payment/stats/summary
 * 汇总统计
 */
router.get('/stats/summary', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { start_date, end_date } = req.query;

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.json({
        success: true,
        data: {
          total_orders: 0,
          total_amount: 0,
          today_orders: 0,
          today_amount: 0,
          pending_orders: 0,
          confirmed_orders: 0
        }
      });
    }

    const merchantId = merchants[0].id;

    // 构建日期筛选条件
    let dateCondition = '';
    const dateParams = [];
    
    if (start_date) {
      dateCondition += ' AND created_at >= ?';
      dateParams.push(start_date);
    }
    if (end_date) {
      dateCondition += ' AND created_at <= ?';
      dateParams.push(end_date + ' 23:59:59');
    }

    // 只有无条件时才使用缓存
    if (!start_date && !end_date) {
      const cached = await redis.get(CACHE_KEYS.PAYMENT_MERCHANT_SUMMARY(merchantId));
      if (cached) {
        return res.json({ success: true, data: cached });
      }
    }

    // 汇总统计
    const summary = await db.query(
      `SELECT
         COUNT(*) as total_orders,
         COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.amount ELSE 0 END), 0) as total_amount,
         COUNT(CASE WHEN DATE(o.created_at) = CURDATE() THEN 1 END) as today_orders,
         COALESCE(SUM(CASE WHEN DATE(o.created_at) = CURDATE() AND o.status = 'confirmed' THEN o.amount ELSE 0 END), 0) as today_amount,
         COUNT(CASE WHEN o.status = 'pending' THEN 1 END) as pending_orders,
         COUNT(CASE WHEN o.status = 'paid' THEN 1 END) as paid_orders,
         COUNT(CASE WHEN o.status = 'confirmed' THEN 1 END) as confirmed_orders
       FROM payment_orders o WHERE o.merchant_id = ?${dateCondition}`,
      [merchantId, ...dateParams]
    );

    const result = {
      total_orders: summary[0].total_orders || 0,
      total_amount: parseFloat(summary[0].total_amount) || 0,
      today_orders: summary[0].today_orders || 0,
      today_amount: parseFloat(summary[0].today_amount) || 0,
      pending_orders: summary[0].pending_orders || 0,
      paid_orders: summary[0].paid_orders || 0,
      confirmed_orders: summary[0].confirmed_orders || 0
    };

    // 只有无条件时才缓存结果
    if (!start_date && !end_date) {
      await redis.set(
        CACHE_KEYS.PAYMENT_MERCHANT_SUMMARY(merchantId),
        result,
        CACHE_TTL.PAYMENT_MERCHANT_SUMMARY
      );
    }

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('获取统计失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * GET /api/payment/stats/daily
 * 每日统计
 */
router.get('/stats/daily', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { days = 30 } = req.query;

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const merchantId = merchants[0].id;

    // 每日统计
    const stats = await db.query(
      `SELECT
         DATE(created_at) as date,
         COUNT(*) as orders,
         SUM(CASE WHEN status = 'confirmed' THEN amount ELSE 0 END) as amount
       FROM payment_orders
       WHERE merchant_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
      [merchantId, parseInt(days)]
    );

    const result = stats.map(s => ({
      date: s.date,
      orders: s.orders || 0,
      amount: parseFloat(s.amount) || 0
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('获取每日统计失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * GET /api/payment/stats/by-item
 * 按名目统计
 */
router.get('/stats/by-item', authenticateToken, async (req, res) => {
  try {
    const { user } = req;

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const merchantId = merchants[0].id;

    // 按名目统计
    const stats = await db.query(
      `SELECT
         pi.id,
         pi.item_name,
         COUNT(po.id) as orders,
         SUM(CASE WHEN po.status = 'confirmed' THEN po.amount ELSE 0 END) as amount
       FROM payment_items pi
       LEFT JOIN payment_orders po ON pi.id = po.item_id
       WHERE pi.merchant_id = ?
       GROUP BY pi.id
       ORDER BY amount DESC`,
      [merchantId]
    );

    const result = stats.map(s => ({
      item_id: s.id,
      item_name: s.item_name,
      orders: s.orders || 0,
      amount: parseFloat(s.amount) || 0
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('获取名目统计失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ============================================
// 公开接口（无需认证）
// ============================================

/**
 * GET /api/payment/public/item/:id
 * 获取名目公开信息（支持多账户轮询）
 */
router.get('/public/item/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // 查询名目
    const items = await db.query(
      `SELECT pi.*, pm.merchant_name
       FROM payment_items pi
       JOIN payment_merchants pm ON pi.merchant_id = pm.id
       WHERE pi.id = ? AND pi.status = 'active' AND pm.status = 'active'`,
      [id]
    );

    if (items.length === 0) {
      return res.status(404).json({ error: '收款名目不存在或已停用' });
    }

    const item = items[0];
    const merchantId = item.merchant_id;

    // 记录访问日志
    try {
      const paymentMongo = require('../utils/payment-mongo');
      await paymentMongo.logPaymentVisit({
        merchantId: item.merchant_id,
        itemId: parseInt(id),
        ipAddress: req.ip || req.connection?.remoteAddress || '',
        userAgent: req.headers['user-agent'] || '',
        referer: req.headers['referer'] || '',
        createdAt: new Date()
      });
    } catch (logErr) {
      console.error('记录访问日志失败:', logErr);
    }

    // 获取启用的收款账户（支持轮询）
    let alipayAccount = await getRoundRobinAccount(merchantId, 'alipay');
    let wechatAccount = await getRoundRobinAccount(merchantId, 'wechat');
    let bankAccount = await getRoundRobinAccount(merchantId, 'bank');

    // 兼容旧表：如果新表没有账户，检查旧表的字段
    // 查询旧表字段
    const [merchant] = await db.query(
      'SELECT alipay_qrcode, wechat_qrcode, bank_account, bank_name, bank_username FROM payment_merchants WHERE id = ?',
      [merchantId]
    );

    // 如果新表没有支付宝账户但旧表有，创建临时兼容账户
    if (!alipayAccount && merchant.alipay_qrcode) {
      alipayAccount = {
        id: 0,
        account_type: 'alipay',
        qrcode_url: merchant.alipay_qrcode,
        account_name: '默认账户(旧)'
      };
    }
    if (!wechatAccount && merchant.wechat_qrcode) {
      wechatAccount = {
        id: 0,
        account_type: 'wechat',
        qrcode_url: merchant.wechat_qrcode,
        account_name: '默认账户(旧)'
      };
    }
    if (!bankAccount && merchant.bank_account) {
      bankAccount = {
        id: 0,
        account_type: 'bank',
        bank_account: merchant.bank_account,
        bank_name: merchant.bank_name,
        bank_username: merchant.bank_username,
        account_name: '默认账户(旧)'
      };
    }

    // 获取所有账户列表（用于展示）
    const allAccounts = await db.query(
      `SELECT account_type, COUNT(*) as count,
        SUM(CASE WHEN is_enabled = 1 THEN 1 ELSE 0 END) as enabled_count
       FROM payment_accounts
       WHERE merchant_id = ? AND is_enabled = 1
       GROUP BY account_type`,
      [merchantId]
    );

    const accountStats = {};
    for (const stat of allAccounts) {
      accountStats[stat.account_type] = {
        total: stat.count,
        enabled: stat.enabled_count
      };
    }

    const result = {
      item_id: item.id,
      item_name: item.item_name,
      item_description: item.item_description,
      images: item.images ? JSON.parse(item.images) : [],
      video_url: item.video_url || '',
      video_cover: item.video_cover || '',
      payment_mode: item.payment_mode || 'flexible',
      default_amount: parseFloat(item.default_amount) || 0,
      min_amount: parseFloat(item.min_amount) || 0.01,
      max_amount: parseFloat(item.max_amount) || 99999.99,
      enable_custom_amount: !!item.enable_custom_amount,
      expense_items: item.expense_items ? (typeof item.expense_items === 'string' ? JSON.parse(item.expense_items) : item.expense_items) : [],
      payment_note: item.payment_note || '',
      merchant_name: item.merchant_name,
      // 轮询账户信息
      alipay_qrcode: alipayAccount ? (alipayAccount.qrcode_url || '') : '',
      wechat_qrcode: wechatAccount ? (wechatAccount.qrcode_url || '') : '',
      bank_account: bankAccount ? (bankAccount.bank_account ? '****' + bankAccount.bank_account.slice(-4) : '') : '',
      bank_name: bankAccount ? (bankAccount.bank_name || '') : '',
      bank_username: bankAccount ? (bankAccount.bank_username || '') : '',
      // 是否有启用账户
      has_alipay: !!alipayAccount,
      has_wechat: !!wechatAccount,
      has_bank: !!bankAccount,
      // 账户统计
      account_stats: accountStats,
      // 轮询账户ID（用于订单记录）
      active_alipay_id: alipayAccount ? alipayAccount.id : null,
      active_wechat_id: wechatAccount ? wechatAccount.id : null,
      active_bank_id: bankAccount ? bankAccount.id : null
    };

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('获取名目公开信息失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * POST /api/payment/public/create-order
 * 创建付款订单
 */
router.post('/public/create-order', async (req, res) => {
  try {
    const { item_id, amount, payment_method } = req.body;

    if (!item_id || !payment_method) {
      return res.status(400).json({ error: '参数不完整' });
    }

    // 获取用户信息（如果已登录）
    let payerId = null;
    let payerUsername = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const config = require('../config/database');
        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, config.jwt.secret);
        const users = await db.query('SELECT id, username FROM users WHERE id = ?', [decoded.userId]);
        if (users.length > 0) {
          payerId = users[0].id;
          payerUsername = users[0].username;
        }
      } catch (e) {
        // 未登录，继续作为游客
      }
    }

    // 查询名目和商户
    const items = await db.query(
      `SELECT pi.*, pm.id as merchant_id, pm.status as merchant_status
       FROM payment_items pi
       JOIN payment_merchants pm ON pi.id = ?
       WHERE pi.id = ?`,
      [item_id, item_id]
    );

    if (items.length === 0) {
      return res.status(404).json({ error: '收款名目不存在' });
    }

    const item = items[0];

    if (item.status !== 'active' || item.merchant_status !== 'active') {
      return res.status(400).json({ error: '该收款名目已停用' });
    }

    // 验证金额
    let validatedAmount;
    try {
      validatedAmount = validateAmount(amount || item.default_amount, item);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    if (!item.enable_custom_amount && !amount) {
      validatedAmount = parseFloat(item.default_amount) || 0;
    }

    // 生成订单号和备注码
    const orderNo = generateOrderNo();
    const remarkCode = generateRemarkCode(orderNo);

    // 计算订单过期时间（默认30分钟）
    const expiredAt = new Date(Date.now() + 30 * 60 * 1000);

    // 获取当前启用的收款账户ID
    let accountId = null;
    if (payment_method === 'alipay' && item.active_alipay_id) {
      accountId = item.active_alipay_id;
    } else if (payment_method === 'wechat' && item.active_wechat_id) {
      accountId = item.active_wechat_id;
    } else if (payment_method === 'bank' && item.active_bank_id) {
      accountId = item.active_bank_id;
    }

    // 插入订单
    const result = await db.query(
      `INSERT INTO payment_orders
       (order_no, item_id, merchant_id, payer_id, payer_username, amount, original_amount, payment_method, account_id, remark_code, status, expired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderNo,
        item_id,
        item.merchant_id,
        payerId,
        payerUsername,
        validatedAmount,
        amount ? validatedAmount : null,
        payment_method,
        accountId,
        remarkCode,
        'pending',
        expiredAt
      ]
    );

    const orderId = result.insertId;

    // 记录操作日志
    try {
      await mongo.logPaymentOrderAction(orderId, orderNo, 'created', {
        operator_type: payerId ? 'user' : 'guest',
        operator_id: payerId,
        operator_name: payerUsername || '游客',
        details: { payment_method, amount: validatedAmount }
      });
    } catch (e) {
      console.error('记录日志失败:', e);
    }

    // 记录访问日志（创建订单也算一次访问）
    try {
      await mongo.logPaymentVisit({
        merchantId: item.merchant_id,
        itemId: parseInt(item_id),
        ipAddress: req.ip || req.connection?.remoteAddress || '',
        userAgent: req.headers['user-agent'] || '',
        referer: req.headers['referer'] || '',
        createdAt: new Date()
      });
    } catch (e) {
      console.error('记录访问日志失败:', e);
    }

    res.json({
      success: true,
      data: {
        order_id: orderId,
        order_no: orderNo,
        amount: validatedAmount,
        remark_code: remarkCode,
        payment_method,
        expired_at: expiredAt.toISOString()
      }
    });
  } catch (err) {
    console.error('创建订单失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * GET /api/payment/public/order/:orderNo
 * 获取订单状态（付款方查看）
 */
router.get('/public/order/:orderNo', async (req, res) => {
  try {
    const { orderNo } = req.params;

    const orders = await db.query(
      `SELECT po.*, pi.item_name
       FROM payment_orders po
       JOIN payment_items pi ON po.item_id = pi.id
       WHERE po.order_no = ?`,
      [orderNo]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: '订单不存在' });
    }

    const order = orders[0];

    const result = {
      order_no: order.order_no,
      item_id: order.item_id,
      item_name: order.item_name,
      amount: parseFloat(order.amount) || 0,
      remark_code: order.remark_code,
      status: order.status,
      payment_method: order.payment_method,
      screenshot_url: order.payment_screenshot || '',
      expired_at: order.expired_at,
      created_at: order.created_at
    };

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('获取订单状态失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * POST /api/payment/public/upload-screenshot
 * 上传付款截图
 */
router.post('/public/upload-screenshot', async (req, res) => {
  try {
    const { order_no, image, note } = req.body;

    if (!order_no) {
      return res.status(400).json({ error: '订单号不能为空' });
    }

    // 查询订单
    const orders = await db.query(
      'SELECT * FROM payment_orders WHERE order_no = ?',
      [order_no]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: '订单不存在' });
    }

    const order = orders[0];

    // 检查订单是否已过期
    if (order.expired_at && new Date(order.expired_at) < new Date()) {
      return res.status(400).json({ error: '订单已超时，请重新下单' });
    }

    if (order.status !== 'pending') {
      return res.status(400).json({ error: '该订单状态不允许上传截图' });
    }

    // 处理图片 - 支持OSS URL或Base64
    let screenshotUrl = '';
    
    // 情况1: 已经是完整的OSS URL（CDN域名开头）
    if (image && image.startsWith('http')) {
      screenshotUrl = image;
    } 
    // 情况2: Base64格式
    else if (image && image.startsWith('data:image')) {
      const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const fileName = `payment/screenshot_${order_no}_${Date.now()}.png`;

      try {
        const ossClient = await oss.getOSSClient();
        const uploadResult = await oss.client.put(fileName, buffer);
        screenshotUrl = uploadResult.url;
      } catch (ossErr) {
        console.error('OSS上传失败:', ossErr);
        screenshotUrl = `/uploads/payment/screenshot_${order_no}_${Date.now()}.png`;
      }
    }

    // 更新订单
    await db.query(
      `UPDATE payment_orders
       SET status = ?, payment_screenshot = ?, payer_note = ?, paid_at = ?
       WHERE order_no = ?`,
      ['paid', screenshotUrl, note || '', new Date(), order_no]
    );

    // 记录操作日志
    try {
      await mongo.logPaymentOrderAction(order.id, order.order_no, 'paid', {
        operator_type: order.payer_id ? 'user' : 'guest',
        operator_id: order.payer_id,
        operator_name: order.payer_username || '游客',
        details: { screenshot: !!screenshotUrl, note }
      });
    } catch (e) {
      console.error('记录日志失败:', e);
    }

    // 清除商户缓存
    await clearOrderCache(order_no, order.id, order.merchant_id);

    res.json({ success: true, message: '付款凭证已提交，等待商户确认' });
  } catch (err) {
    console.error('上传截图失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * GET /api/payment/public/oss-token
 * 获取OSS上传STS临时凭证（公开接口，用户上传付款凭证使用）
 */
router.get('/public/oss-token', async (req, res) => {
  try {
    const token = await oss.getSTSToken();
    res.json({
      success: true,
      data: {
        accessKeyId: token.accessKeyId,
        accessKeySecret: token.accessKeySecret,
        stsToken: token.stsToken,
        region: process.env.OSS_REGION || 'oss-cn-shenzhen',
        bucket: process.env.OSS_BUCKET || 'aibotboke',
        cdnUrl: 'https://boke.skym178.com'
      }
    });
  } catch (err) {
    console.error('获取STS凭证失败:', err);
    res.status(500).json({ error: '获取上传凭证失败' });
  }
});

/**
 * GET /api/payment/public/generate-poster/:itemId
 * 生成收款海报数据
 */
router.get('/public/generate-poster/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;

    // 生成付款页面URL
    const baseUrl = req.protocol + '://' + req.get('host');
    const paymentUrl = baseUrl + '/payment-pay.html?item=' + itemId;

    // 查询名目信息
    const items = await db.query(
      `SELECT pi.*, pm.merchant_name
       FROM payment_items pi
       JOIN payment_merchants pm ON pi.merchant_id = pm.id
       WHERE pi.id = ? AND pi.status = 'active'`,
      [itemId]
    );

    if (items.length === 0) {
      return res.status(404).json({ error: '名目不存在' });
    }

    const item = items[0];
    const merchantId = item.merchant_id;

    // 获取启用的收款账户（支持轮询）
    const alipayAccount = await getRoundRobinAccount(merchantId, 'alipay');
    const wechatAccount = await getRoundRobinAccount(merchantId, 'wechat');
    const bankAccount = await getRoundRobinAccount(merchantId, 'bank');

    // 兼容旧表
    const [merchant] = await db.query(
      'SELECT alipay_qrcode, wechat_qrcode, bank_account, bank_name, bank_username FROM payment_merchants WHERE id = ?',
      [merchantId]
    );

    const finalAlipay = alipayAccount || (merchant.alipay_qrcode ? { qrcode_url: merchant.alipay_qrcode } : null);
    const finalWechat = wechatAccount || (merchant.wechat_qrcode ? { qrcode_url: merchant.wechat_qrcode } : null);
    const finalBank = bankAccount || (merchant.bank_account ? { bank_account: merchant.bank_account, bank_name: merchant.bank_name, bank_username: merchant.bank_username } : null);

    // 收集支付方式
    const paymentMethods = [];
    if (finalAlipay) paymentMethods.push({ type: 'alipay', name: '支付宝' });
    if (finalWechat) paymentMethods.push({ type: 'wechat', name: '微信' });
    if (finalBank) paymentMethods.push({ type: 'bank', name: '银行卡' });

    // 在服务器端生成二维码DataURL
    const qrcodeDataURL = await QRCode.toDataURL(paymentUrl, {
      width: 200,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });

    // 生成海报数据
    const posterData = {
      merchantName: item.merchant_name,
      title: item.item_name,
      description: item.item_description || '',
      amount: item.default_amount,
      paymentMode: item.payment_mode,
      minAmount: item.min_amount,
      maxAmount: item.max_amount,
      paymentMethods: paymentMethods,
      qrcodeDataURL: qrcodeDataURL,
      paymentUrl: paymentUrl
    };

    res.json({
      success: true,
      data: posterData
    });
  } catch (err) {
    console.error('生成海报数据失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * POST /api/payment/public/verify-remark
 * 验证备注码
 */
router.post('/public/verify-remark', async (req, res) => {
  try {
    const { order_no, remark_code } = req.body;

    if (!order_no || !remark_code) {
      return res.status(400).json({ error: '参数不完整' });
    }

    const orders = await db.query(
      'SELECT id, remark_code, status FROM payment_orders WHERE order_no = ?',
      [order_no]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: '订单不存在' });
    }

    const order = orders[0];

    if (order.remark_code !== remark_code) {
      return res.json({ success: true, valid: false, message: '备注码错误' });
    }

    res.json({ success: true, valid: true, status: order.status });
  } catch (err) {
    console.error('验证备注码失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * GET /api/payment/public/lookup-by-remark/:remarkCode
 * 通过备注码查询订单（无需登录，用户找回订单用）
 */
router.get('/public/lookup-by-remark/:remarkCode', async (req, res) => {
  try {
    const { remarkCode } = req.params;

    if (!remarkCode || remarkCode.length < 4) {
      return res.status(400).json({ error: '备注码格式不正确' });
    }

    // 查询所有状态的订单（返回所有查询结果，让前端判断是否过期）
    const orders = await db.query(
      `SELECT po.order_no, po.item_id, po.remark_code, po.status, po.amount,
              po.payment_method, po.created_at, po.expired_at, pi.item_name
       FROM payment_orders po
       JOIN payment_items pi ON po.item_id = pi.id
       WHERE po.remark_code = ?
       ORDER BY po.created_at DESC
       LIMIT 10`,
      [remarkCode]
    );

    if (orders.length === 0) {
      return res.json({
        success: true,
        found: false,
        message: '未找到任何订单，请检查备注码是否正确'
      });
    }

    // 返回订单列表，包含过期时间
    res.json({
      success: true,
      found: true,
      data: orders.map(o => ({
        order_no: o.order_no,
        item_id: o.item_id,
        item_name: o.item_name,
        amount: parseFloat(o.amount),
        status: o.status,
        payment_method: o.payment_method,
        created_at: o.created_at,
        expired_at: o.expired_at,
        is_expired: o.expired_at && new Date(o.expired_at) < new Date()
      }))
    });
  } catch (err) {
    console.error('通过备注码查询订单失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * GET /api/payment/export
 * 导出订单CSV
 */
router.get('/export', authenticateToken, async (req, res) => {
  try {
    const { user } = req;
    const { status, start_date, end_date } = req.query;

    // 获取商户ID
    const merchants = await db.query(
      'SELECT id FROM payment_merchants WHERE user_id = ?',
      [user.id]
    );

    if (merchants.length === 0) {
      return res.status(403).json({ error: '商户不存在' });
    }

    const merchantId = merchants[0].id;

    // 构建查询
    let whereClause = 'WHERE o.merchant_id = ?';
    const params = [merchantId];

    if (status) {
      whereClause += ' AND o.status = ?';
      params.push(status);
    }

    if (start_date) {
      whereClause += ' AND o.created_at >= ?';
      params.push(start_date);
    }

    if (end_date) {
      whereClause += ' AND o.created_at <= ?';
      params.push(end_date + ' 23:59:59');
    }

    // 查询所有订单（不分页）
    const orders = await db.query(
      `SELECT o.*, i.item_name 
       FROM payment_orders o 
       LEFT JOIN payment_items i ON o.item_id = i.id 
       ${whereClause} 
       ORDER BY o.created_at DESC`,
      params
    );

    // 状态映射
    const statusMap = {
      'pending': '待付款',
      'paid': '已付款',
      'confirmed': '已完成',
      'rejected': '已拒绝',
      'cancelled': '已取消'
    };

    // 支付方式映射
    const methodMap = {
      'alipay': '支付宝',
      'wechat': '微信',
      'bank': '银行卡'
    };

    // 生成CSV内容
    const headers = ['订单号', '名目', '金额', '支付方式', '状态', '付款号码', '付款人', '创建时间', '付款时间', '完成时间'];
    const rows = orders.map(order => [
      order.order_no || '',
      order.item_name || '',
      order.amount || '0',
      methodMap[order.payment_method] || order.payment_method || '',
      statusMap[order.status] || order.status || '',
      order.remark_code || '',
      order.payer_username || '游客',
      order.created_at ? new Date(order.created_at).toLocaleString('zh-CN') : '',
      order.paid_at ? new Date(order.paid_at).toLocaleString('zh-CN') : '',
      order.confirmed_at ? new Date(order.confirmed_at).toLocaleString('zh-CN') : ''
    ]);

    // 转义CSV特殊字符
    const escapeCSV = (val) => {
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(escapeCSV).join(','))
    ].join('\n');

    // 设置响应头
    const filename = `订单数据_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv;charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send('\ufeff' + csvContent); // BOM for Excel
  } catch (err) {
    console.error('导出CSV失败:', err);
    const errorMessage = err.message || err.stack || '未知错误';
    res.status(500).json({ error: errorMessage });
  }
});

/**
 * GET /api/payment/merchant/oss-token
 * 获取OSS上传STS临时凭证
 */
router.get('/merchant/oss-token', authenticateToken, async (req, res) => {
  try {
    const token = await oss.getSTSToken();
    res.json({
      success: true,
      data: {
        accessKeyId: token.accessKeyId,
        accessKeySecret: token.accessKeySecret,
        stsToken: token.stsToken,
        region: process.env.OSS_REGION || 'oss-cn-shenzhen',
        bucket: process.env.OSS_BUCKET || 'aibotboke',
        cdnUrl: 'https://boke.skym178.com'
      }
    });
  } catch (err) {
    console.error('获取STS凭证失败:', err);
    res.status(500).json({ error: '获取上传凭证失败' });
  }
});

module.exports = router;
