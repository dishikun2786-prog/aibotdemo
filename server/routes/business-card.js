/**
 * @file business-card.js
 * @module routes/business-card
 * @description 名片网页系统API - 保存、发布、访问名片
 */
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const mongo = require('../utils/mongo');
const redis = require('../utils/redis');
const oss = require('../utils/oss');
const { authenticateToken } = require('../middleware/auth');
const { withFallback } = require('../utils/mongo-fallback');
const { toSnakeCase } = require('../utils/field-converter');
const { CACHE_KEYS, CACHE_TTL } = require('../utils/cache-keys');
const {
  getCardFromCache,
  setCardToCache,
  clearCardCaches,
  clearUserCardListCache
} = require('../utils/card-cache');
const {
  publicAccessLimiter,
  saveLimiter,
  ossTokenLimiter,
  layoutUpdateLimiter
} = require('../middleware/rate-limit');
const {
  validateCardSave,
  validateLayoutSave,
  validatePublish,
  validateCreateBlank,
  validateCardId,
  validateCardToken
} = require('../middleware/card-validator');
const { sanitizeObject } = require('../utils/sanitizer');
const {
  asyncHandler,
  NotFoundError,
  ValidationError,
  UnauthorizedError
} = require('../middleware/error-handler');
const crypto = require('crypto');

/**
 * 生成名片访问令牌
 * @returns {string} 32位随机令牌
 */
function generateCardToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 从MongoDB获取名片模板内容（带降级处理）
 * @param {number} cardId - 名片ID
 * @returns {Promise<Object|null>} 模板数据或null
 */
async function getCardTemplateData(cardId) {
  const mongoContent = await withFallback(
    () => mongo.getBusinessCardContent(parseInt(cardId)),
    null,
    `获取名片${cardId}的模板内容`
  );
  
  if (!mongoContent) {
    return null;
  }
  
  return {
    shop_name: mongoContent.shop_name || '',
    subtitle: mongoContent.subtitle || '',
    intro: mongoContent.intro || '',
    phone: mongoContent.phone || '',
    email: mongoContent.email || '',
    address: mongoContent.address || '',
    bg_image: mongoContent.bg_image || '',
    // 百姓饭店扩展字段
    boss_message: mongoContent.boss_message || '',
    menu_images: mongoContent.menu_images || [],
    wechat_qr: mongoContent.wechat_qr || '',
    map_lat: mongoContent.map_lat || '',
    map_lng: mongoContent.map_lng || '',
    service_link: mongoContent.service_link || ''
  };
}

/**
 * 获取默认名片模板数据
 * @returns {Object} GrapesJS默认模板
 */
function getDefaultTemplateData() {
  return {
    pages: [
      {
        component: {
          type: 'wrapper',
          style: { minHeight: '100vh', padding: '20px' },
          components: [
            {
              type: 'wrapper',
              style: {
                maxWidth: '400px',
                margin: '0 auto',
                padding: '30px',
                backgroundColor: '#ffffff',
                borderRadius: '16px',
                boxShadow: '0 4px 20px rgba(0,0,0,0.1)'
              },
              components: [
                {
                  type: 'image',
                  style: {
                    width: '100px',
                    height: '100px',
                    borderRadius: '50%',
                    margin: '0 auto 20px',
                    objectFit: 'cover'
                  },
                  attributes: {
                    src: '/images/default-avatar.png',
                    alt: '头像'
                  }
                },
                {
                  type: 'text',
                  attributes: {
                    content: '请输入姓名'
                  },
                  style: {
                    textAlign: 'center',
                    fontSize: '24px',
                    fontWeight: 'bold',
                    marginBottom: '8px',
                    color: '#333'
                  }
                },
                {
                  type: 'text',
                  attributes: {
                    content: '请输入职位'
                  },
                  style: {
                    textAlign: 'center',
                    fontSize: '14px',
                    color: '#666',
                    marginBottom: '20px'
                  }
                },
                {
                  type: 'div',
                  style: {
                    borderTop: '1px solid #eee',
                    paddingTop: '20px',
                    marginTop: '20px'
                  },
                  components: [
                    {
                      type: 'text',
                      attributes: {
                        content: '📱 手机：点击编辑'
                      },
                      style: {
                        fontSize: '14px',
                        color: '#666',
                        marginBottom: '10px'
                      }
                    },
                    {
                      type: 'text',
                      attributes: {
                        content: '✉️ 邮箱：点击编辑'
                      },
                      style: {
                        fontSize: '14px',
                        color: '#666',
                        marginBottom: '10px'
                      }
                    },
                    {
                      type: 'text',
                      attributes: {
                        content: '🌐 网址：点击编辑'
                      },
                      style: {
                        fontSize: '14px',
                        color: '#666'
                      }
                    }
                  ]
                }
              ]
            }
          ]
        }
      }
    ],
    styles: `
      body {
        margin: 0;
        padding: 0;
        font-family: 'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        min-height: 100vh;
      }
    `
  };
}

/**
 * GET /api/business-card/my
 * 获取当前用户的名片列表（带缓存）
 */
router.get('/my', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. 先查缓存
    const cacheKey = CACHE_KEYS.CARD_LIST(userId);
    const cached = await getCardFromCache(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        from_cache: true
      });
    }

    // 2. 缓存未命中，查询数据库
    const cards = await db.query(
      `SELECT id, user_id, card_token, template_name, preview_image, is_published, visit_count, created_at, updated_at
       FROM business_cards WHERE user_id = ? ORDER BY updated_at DESC`,
      [userId]
    );

    // 转换字段名为下划线格式
    const formattedCards = cards.map(card => toSnakeCase(card));

    // 3. 写入缓存
    await setCardToCache(cacheKey, formattedCards, CACHE_TTL.CARD_LIST);

    res.json({
      success: true,
      data: formattedCards,
      from_cache: false
    });
  } catch (error) {
    console.error('获取名片列表失败:', error);
    res.status(500).json({ success: false, error: '服务器内部错误' });
  }
});

/**
 * GET /api/business-card/:id
 * 获取名片详情（带缓存）
 * 安全防护：ID验证
 */
router.get('/:id', authenticateToken, validateCardId, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  // 1. 先查缓存
  const cacheKey = CACHE_KEYS.CARD_DETAIL(id);
  const cached = await getCardFromCache(cacheKey);
  if (cached && cached.user_id === userId) {
    return res.json({
      success: true,
      data: cached,
      from_cache: true
    });
  }

  // 2. 缓存未命中，查询数据库
  const [card] = await db.query(
    `SELECT id, user_id, card_token, template_name, is_published, visit_count, created_at, updated_at FROM business_cards WHERE id = ? AND user_id = ?`,
    [id, userId]
  );

  if (!card) {
    throw new NotFoundError('名片不存在');
  }

  // 从MongoDB获取模板内容（带降级处理）
  const templateData = await getCardTemplateData(id);

  // 转换字段名为下划线格式
  const formattedCard = toSnakeCase(card);
  const result = {
    ...formattedCard,
    template_data: templateData
  };

  // 3. 写入缓存
  await setCardToCache(cacheKey, result, CACHE_TTL.CARD_DETAIL);

  res.json({
    success: true,
    data: result,
    from_cache: false
  });
}));

/**
 * POST /api/business-card/save
 * 保存名片模板（保存后清除缓存）
 * 安全防护：频率限制 + 输入验证 + XSS防护
 */
router.post('/save', authenticateToken, saveLimiter, validateCardSave, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  let { id, template_name, template_data } = req.body;

  // XSS防护：清理用户输入
  template_name = sanitizeObject({ name: template_name }).name;
  if (template_data) {
    template_data = sanitizeObject(template_data);
  }

  console.log('[business-card/save] template_data:', JSON.stringify(template_data).substring(0, 200));

  if (!template_name) {
    throw new ValidationError('参数不完整：缺少模板名称');
  }

  // 如果没有指定ID，创建新名片
  if (!id) {
    const cardToken = generateCardToken();

    const result = await db.query(
      `INSERT INTO business_cards (user_id, card_token, template_name, template_data) VALUES (?, ?, ?, ?)`,
      [userId, cardToken, template_name, JSON.stringify({})]
    );

    const cardId = result.insertId;

    // 将模板内容保存到MongoDB（带降级处理）
    if (template_data) {
      await withFallback(
        () => mongo.saveBusinessCardContent(cardId, template_data),
        null,
        `保存新名片${cardId}的模板内容`
      );
    }

    // 清除用户名片列表缓存
    await clearUserCardListCache(userId);

    res.json({
      success: true,
      data: {
        id: cardId,
        card_token: cardToken,
        template_name
      }
    });
  } else {
    // 更新现有名片（只更新MongoDB，带降级处理）
    if (template_data) {
      await withFallback(
        () => mongo.saveBusinessCardContent(parseInt(id), template_data),
        null,
        `保存名片${id}的模板内容`
      );
    }

    // 获取名片信息用于清除缓存
    const [card] = await db.query(
      'SELECT card_token FROM business_cards WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    // 清除相关缓存
    if (card) {
      await clearCardCaches(parseInt(id), userId, card.card_token);
    }

    res.json({
      success: true,
      data: {
        id: parseInt(id),
        card_token: null,
        template_name
      }
    });
  }
}));

/**
 * GET /api/business-card/public/:token
 * 公开访问名片（无需登录，带缓存）
 * 安全防护：频率限制 + Token验证
 */
router.get('/public/:token', publicAccessLimiter, validateCardToken, asyncHandler(async (req, res) => {
  const { token } = req.params;

  // 1. 先查缓存
  const cacheKey = CACHE_KEYS.CARD_PUBLIC(token);
  const cached = await getCardFromCache(cacheKey);
  if (cached) {
    // 增加访问次数（异步，不阻塞响应）
    setImmediate(async () => {
      await db.query(
        `UPDATE business_cards SET visit_count = visit_count + 1 WHERE id = ?`,
        [cached.id]
      );
    });

    return res.json({
      success: true,
      data: {
        ...cached,
        visit_count: cached.visit_count + 1
      },
      from_cache: true
    });
  }

  // 2. 缓存未命中，查询数据库
  const [card] = await db.query(
    `SELECT bc.id, bc.user_id, bc.card_token, bc.template_name, bc.is_published, bc.visit_count, bc.created_at, u.username 
     FROM business_cards bc
     LEFT JOIN users u ON bc.user_id = u.id
     WHERE bc.card_token = ? AND bc.is_published = 1`,
    [token]
  );

  if (!card) {
    throw new NotFoundError('名片不存在或未发布');
  }

  // 增加访问次数
  await db.query(
    `UPDATE business_cards SET visit_count = visit_count + 1 WHERE id = ?`,
    [card.id]
  );

  // 从MongoDB获取模板内容（带降级处理）
  const templateData = await getCardTemplateData(card.id);

  const result = {
    id: card.id,
    template_name: card.template_name,
    template_data: templateData,
    username: card.username,
    visit_count: card.visit_count + 1
  };

  // 3. 写入缓存（公开访问缓存时间更长）
  await setCardToCache(cacheKey, result, CACHE_TTL.CARD_PUBLIC);

  res.json({
    success: true,
    data: result,
    from_cache: false
  });
}));

/**
 * PUT /api/business-card/publish/:id
 * 发布名片（发布后清除缓存）
 * 安全防护：输入验证
 */
router.put('/publish/:id', authenticateToken, validatePublish, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const { is_published } = req.body;

  const [card] = await db.query(
    `SELECT * FROM business_cards WHERE id = ? AND user_id = ?`,
    [id, userId]
  );

  if (!card) {
    throw new NotFoundError('名片不存在');
  }

  await db.query(
    `UPDATE business_cards SET is_published = ? WHERE id = ?`,
    [is_published ? 1 : 0, id]
  );

  // 清除相关缓存（包括公开访问缓存）
  await clearCardCaches(parseInt(id), userId, card.card_token);

  res.json({
    success: true,
    data: {
      id: parseInt(id),
      is_published: is_published ? 1 : 0,
      card_token: card.card_token,  // 添加此字段，前端需要用于生成分享链接
      public_url: is_published ? (process.env.API_BASE_URL || '') + `/card/${card.card_token}` : null
    }
  });
}));

/**
 * GET /api/business-card/stats/:id
 * 获取名片访问统计（带缓存）
 * 安全防护：ID验证
 */
router.get('/stats/:id', authenticateToken, validateCardId, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // 1. 先查缓存
    const cacheKey = CACHE_KEYS.CARD_STATS(id);
    const cached = await getCardFromCache(cacheKey);
    if (cached && cached.user_id === userId) {
      return res.json({
        success: true,
        data: cached,
        from_cache: true
      });
    }

    // 2. 缓存未命中，查询数据库
    const [card] = await db.query(
      `SELECT visit_count, is_published, created_at, updated_at FROM business_cards WHERE id = ? AND user_id = ?`,
      [id, userId]
    );

    if (!card) {
      return res.status(404).json({ success: false, error: '名片不存在' });
    }

    // 转换字段名为下划线格式
    const formattedStats = toSnakeCase(card);

    // 3. 写入缓存（统计数据缓存时间较短）
    await setCardToCache(cacheKey, formattedStats, CACHE_TTL.CARD_STATS);

    res.json({
      success: true,
      data: formattedStats,
      from_cache: false
    });
  } catch (error) {
    console.error('获取统计失败:', error);
    res.status(500).json({ success: false, error: '服务器内部错误' });
  }
});

/**
 * DELETE /api/business-card/:id
 * 删除名片（删除后清除缓存）
 * 安全防护：ID验证
 */
router.delete('/:id', authenticateToken, validateCardId, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // 先获取名片信息用于清除缓存
    const [card] = await db.query(
      'SELECT card_token FROM business_cards WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (!card) {
      return res.status(404).json({ success: false, error: '名片不存在' });
    }

    const result = await db.query(
      `DELETE FROM business_cards WHERE id = ? AND user_id = ?`,
      [id, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: '名片不存在' });
    }

    // 删除MongoDB中的模板内容（带降级处理）
    await withFallback(
      () => mongo.deleteBusinessCardContent(parseInt(id)),
      null,
      `删除名片${id}的模板内容`
    );

    // 清除所有相关缓存
    await clearCardCaches(parseInt(id), userId, card.card_token);

    res.json({
      success: true,
      message: '删除成功'
    });
  } catch (error) {
    console.error('删除名片失败:', error);
    res.status(500).json({ success: false, error: '服务器内部错误' });
  }
});

/**
 * POST /api/business-card/create-default
 * 创建默认名片
 */
router.post('/create-default', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const cardToken = generateCardToken();
    const defaultData = getDefaultTemplateData();

    const result = await db.query(
      `INSERT INTO business_cards (user_id, card_token, template_name, template_data) VALUES (?, ?, ?, ?)`,
      [userId, cardToken, '我的名片', JSON.stringify(defaultData)]
    );

    res.json({
      success: true,
      data: {
        id: result.insertId,
        card_token: cardToken,
        template_name: '我的名片'
      }
    });
  } catch (error) {
    console.error('创建默认名片失败:', error);
    res.status(500).json({ success: false, error: '服务器内部错误' });
  }
});

// ============================================================
// 管理员接口
// ============================================================

/**
 * GET /api/business-card/admin/list
 * 获取所有名片列表（管理员）
 */
const { requireAdmin } = require('../middleware/auth');

router.get('/admin/list', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, user_id, is_published, search } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = '1=1';
    const params = [];

    if (user_id) {
      whereClause += ' AND bc.user_id = ?';
      params.push(parseInt(user_id));
    }

    if (is_published !== undefined) {
      whereClause += ' AND bc.is_published = ?';
      params.push(parseInt(is_published));
    }

    if (search) {
      whereClause += ' AND (u.username LIKE ? OR bc.template_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    // 查询总数
    const [countResult] = await db.query(
      `SELECT COUNT(*) as total FROM business_cards bc
       LEFT JOIN users u ON bc.user_id = u.id
       WHERE ${whereClause}`,
      params
    );

    // 查询列表
    params.push(parseInt(limit), offset);
    const cards = await db.query(
      `SELECT bc.*, u.username FROM business_cards bc
       LEFT JOIN users u ON bc.user_id = u.id
       WHERE ${whereClause}
       ORDER BY bc.updated_at DESC
       LIMIT ? OFFSET ?`,
      params
    );

    // 转换字段名为下划线格式
    const formattedCards = cards.map(card => toSnakeCase(card));

    res.json({
      success: true,
      data: formattedCards,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult.total,
        total_pages: Math.ceil(countResult.total / limit)
      }
    });
  } catch (error) {
    console.error('获取名片列表失败:', error);
    res.status(500).json({ success: false, error: '服务器内部错误' });
  }
});

/**
 * GET /api/business-card/admin/:id
 * 获取名片详情（管理员）
 * 安全防护：ID验证
 */
router.get('/admin/:id', authenticateToken, requireAdmin, validateCardId, async (req, res) => {
  try {
    const { id } = req.params;

    const [card] = await db.query(
      `SELECT bc.id, bc.user_id, bc.card_token, bc.template_name, bc.is_published, bc.visit_count, bc.created_at, bc.updated_at, u.username 
       FROM business_cards bc
       LEFT JOIN users u ON bc.user_id = u.id
       WHERE bc.id = ?`,
      [id]
    );

    if (!card) {
      return res.status(404).json({ success: false, error: '名片不存在' });
    }

    // 从MongoDB获取模板内容（带降级处理）
    const templateData = await getCardTemplateData(id);

    // 转换字段名为下划线格式
    const formattedCard = toSnakeCase(card);

    res.json({
      success: true,
      data: {
        ...formattedCard,
        template_data: templateData
      }
    });
  } catch (error) {
    console.error('获取名片详情失败:', error);
    res.status(500).json({ success: false, error: '服务器内部错误' });
  }
});

/**
 * DELETE /api/business-card/admin/:id
 * 删除名片（管理员）
 * 安全防护：ID验证
 */
router.delete('/admin/:id', authenticateToken, requireAdmin, validateCardId, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `DELETE FROM business_cards WHERE id = ?`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: '名片不存在' });
    }

    // 删除MongoDB中的模板内容（带降级处理）
    await withFallback(
      () => mongo.deleteBusinessCardContent(parseInt(id)),
      null,
      `删除名片${id}的模板内容`
    );

    res.json({
      success: true,
      message: '删除成功'
    });
  } catch (error) {
    console.error('删除名片失败:', error);
    res.status(500).json({ success: false, error: '服务器内部错误' });
  }
});

/**
 * PUT /api/business-card/admin/:id/toggle-publish
 * 切换发布状态（管理员）
 * 安全防护：ID验证
 */
router.put('/admin/:id/toggle-publish', authenticateToken, requireAdmin, validateCardId, async (req, res) => {
  try {
    const { id } = req.params;

    const [card] = await db.query(`SELECT is_published FROM business_cards WHERE id = ?`, [id]);

    if (!card) {
      return res.status(404).json({ success: false, error: '名片不存在' });
    }

    const newStatus = card.is_published ? 0 : 1;

    await db.query(
      `UPDATE business_cards SET is_published = ? WHERE id = ?`,
      [newStatus, id]
    );

    res.json({
      success: true,
      data: {
        id: parseInt(id),
        is_published: newStatus
      }
    });
  } catch (error) {
    console.error('切换发布状态失败:', error);
    res.status(500).json({ success: false, error: '服务器内部错误' });
  }
});

/**
 * POST /api/business-card/get-oss-token
 * 获取OSS上传凭证
 * 安全防护：频率限制
 */
router.post('/get-oss-token', authenticateToken, ossTokenLimiter, async (req, res) => {
  try {
    const token = await oss.getSTSToken();
    // 添加自定义域名（用于前端直接显示图片）
    token.customDomain = 'https://boke.skym178.com';
    token.accelerateDomain = token.accelerateDomain || 'oss-accelerate.aliyuncs.com';
    token.useAccelerate = token.useAccelerate === true;
    res.json({ success: true, data: token });
  } catch (error) {
    console.error('获取OSS上传凭证失败:', error);
    res.status(500).json({ success: false, error: '获取上传凭证失败' });
  }
});

/**
 * GET /api/business-card/layout/:id
 * 获取名片拖拽布局（Redis缓存 + MongoDB）
 * 安全防护：ID验证
 */
router.get('/layout/:id', authenticateToken, validateCardId, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // 验证名片归属
    const [card] = await db.query(
      'SELECT * FROM business_cards WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (!card) {
      return res.status(404).json({ success: false, error: '名片不存在' });
    }

    // 1. 先查Redis缓存
    const cacheKey = CACHE_KEYS.CARD_LAYOUT(id);
    const cached = await getCardFromCache(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, from_cache: true });
    }

    // 2. 查MongoDB（带降级处理）
    const layout = await withFallback(
      () => mongo.getBusinessCardLayout(parseInt(id)),
      [],
      `获取名片${id}的布局数据`
    );

    // 3. 缓存到Redis
    if (layout && layout.length > 0) {
      await setCardToCache(cacheKey, layout, CACHE_TTL.CARD_LAYOUT);
    }

    res.json({ success: true, data: layout || [], from_cache: false });
  } catch (error) {
    console.error('获取名片布局失败:', error);
    res.status(500).json({ success: false, error: '服务器内部错误' });
  }
});

/**
 * PUT /api/business-card/layout/:id
 * 保存名片拖拽布局（直接写MongoDB + 清除Redis缓存）
 * 安全防护：频率限制 + 输入验证
 */
router.put('/layout/:id', authenticateToken, layoutUpdateLimiter, validateLayoutSave, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { layout } = req.body;

    // 验证名片归属
    const [card] = await db.query(
      'SELECT card_token FROM business_cards WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (!card) {
      return res.status(404).json({ success: false, error: '名片不存在' });
    }

    // 1. 保存到MongoDB（带降级处理）
    await withFallback(
      () => mongo.saveBusinessCardLayout(parseInt(id), layout || []),
      null,
      `保存名片${id}的布局数据`
    );

    // 2. 清除Redis缓存（主动失效）
    await clearCardCaches(parseInt(id), userId, card.card_token);

    res.json({ success: true, message: '布局保存成功' });
  } catch (error) {
    console.error('保存名片布局失败:', error);
    res.status(500).json({ success: false, error: '服务器内部错误' });
  }
});

/**
 * POST /api/business-card/create-blank
 * 创建空白名片（支持拖拽布局，创建后清除缓存）
 * 安全防护：频率限制 + 输入验证 + XSS防护
 */
router.post('/create-blank', authenticateToken, saveLimiter, validateCreateBlank, async (req, res) => {
  try {
    const userId = req.user.id;
    let { template_name } = req.body;
    
    // XSS防护：清理用户输入
    template_name = sanitizeObject({ name: template_name || '空白名片' }).name;
    const cardToken = generateCardToken();

    // 创建名片记录 - 使用JSON.stringify确保JSON格式正确
    const result = await db.query(
      `INSERT INTO business_cards (user_id, card_token, template_name, template_data) VALUES (?, ?, ?, ?)`,
      [userId, cardToken, template_name || '空白名片', JSON.stringify({})]
    );

    const cardId = result.insertId;

    // 初始化空布局
    const emptyLayout = [
      {
        type: 'header',
        props: {
          content: '我的名片',
          bgColor: '#e63946',
          textColor: '#ffffff'
        }
      },
      {
        type: 'avatar',
        props: {
          src: '/images/default-avatar.png',
          size: 100
        }
      },
      {
        type: 'text',
        props: {
          content: '点击编辑姓名',
          tag: 'h3',
          class: 'text-center fw-bold'
        }
      },
      {
        type: 'text',
        props: {
          content: '点击编辑职位',
          tag: 'p',
          class: 'text-center text-muted'
        }
      },
      {
        type: 'contact',
        props: {
          phone: '点击编辑电话',
          email: '点击编辑邮箱',
          address: '点击编辑地址'
        }
      }
    ];

    // 保存初始布局到MongoDB（带降级处理）
    await withFallback(
      () => mongo.saveBusinessCardLayout(cardId, emptyLayout),
      null,
      `保存新名片${cardId}的初始布局`
    );

    // 清除用户名片列表缓存
    await clearUserCardListCache(userId);

    res.json({
      success: true,
      data: {
        id: cardId,
        card_token: cardToken,
        template_name: template_name || '空白名片',
        layout: emptyLayout
      }
    });
  } catch (error) {
    console.error('创建空白名片失败:', error);
    res.status(500).json({ success: false, error: '服务器内部错误' });
  }
});

module.exports = router;
