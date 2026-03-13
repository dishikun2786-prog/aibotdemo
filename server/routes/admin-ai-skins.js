/**
 * @file admin-ai-skins.js
 * @module routes/admin-ai-skins
 * @description 管理员后台：AI智能体皮肤管理（CRUD、激活码、指定用户授权、导入）
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../utils/db');
const { authenticateToken, requireAdmin, logAdminAction } = require('../middleware/auth');

const SKINS_UPLOAD_DIR = path.join(__dirname, '../../public/bg/skins');
const SKIN_IMAGE_PATH_PREFIX = '/bg/skins/';
const DEFAULT_SKIN_IMAGE = '/bg/180.png';
const PLACEHOLDER_IMAGE = '/bg/180.png'; // 导入时未上传图片使用的占位

// 确保上传目录存在
if (!fs.existsSync(SKINS_UPLOAD_DIR)) {
  fs.mkdirSync(SKINS_UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SKINS_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const name = 'skin_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + '.png';
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'image/png') {
      return cb(new Error('仅支持 PNG 格式'), false);
    }
    cb(null, true);
  }
});

router.use(authenticateToken);
router.use(requireAdmin);

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

// GET / - 列表（分页可选）
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const [rows, totalResult] = await Promise.all([
      db.query(
        `SELECT id, name, description, image_path, energy_price, pk_attack, pk_defense, sort_order, is_active, shop_limit, created_at, updated_at
         FROM ai_agent_skins ORDER BY sort_order ASC, id ASC LIMIT ? OFFSET ?`,
        [limit, offset]
      ),
      db.query('SELECT COUNT(*) AS total FROM ai_agent_skins')
    ]);

    const total = totalResult[0]?.total || 0;
    await logAdminAction(req.user.id, 'list_ai_skins', null, { page, limit });
    res.json({ success: true, data: rows, total, page, limit });
  } catch (error) {
    console.error('列表AI皮肤失败:', error);
    res.status(500).json({ error: '获取皮肤列表失败' });
  }
});

// POST /import - 批量导入皮肤元数据（JSON）
router.post('/import', async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : (req.body.items || req.body.list || []);
    if (list.length === 0) {
      return res.status(400).json({ error: '请提供至少一条皮肤数据（数组）' });
    }
    const inserted = [];
    for (const item of list) {
      const name = (item.name || '').trim();
      if (!name) continue;
      const description = (item.description || '').trim();
      const energyPrice = Math.max(0, parseInt(item.energy_price, 10) || 0);
      const pkAttack = parseInt(item.pk_attack, 10) || 0;
      const pkDefense = parseInt(item.pk_defense, 10) || 0;
      const sortOrder = parseInt(item.sort_order, 10) || 0;
      const result = await db.query(
        `INSERT INTO ai_agent_skins (name, description, image_path, energy_price, pk_attack, pk_defense, sort_order, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [name, description, PLACEHOLDER_IMAGE, energyPrice, pkAttack, pkDefense, sortOrder]
      );
      inserted.push({ id: result.insertId, name });
    }
    await logAdminAction(req.user.id, 'import_ai_skins', null, { count: inserted.length });
    res.status(201).json({ success: true, data: inserted, message: `成功导入 ${inserted.length} 条皮肤` });
  } catch (error) {
    console.error('导入皮肤失败:', error);
    res.status(500).json({ error: '导入皮肤失败' });
  }
});

// GET /:id - 单条详情（含激活码数量）
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: '无效的皮肤ID' });
    }
    const skins = await db.query(
      'SELECT id, name, description, image_path, energy_price, pk_attack, pk_defense, sort_order, is_active, shop_limit, created_at, updated_at FROM ai_agent_skins WHERE id = ?',
      [id]
    );
    if (skins.length === 0) {
      return res.status(404).json({ error: '皮肤不存在' });
    }
    const codeCountRows = await db.query(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN user_id IS NOT NULL THEN 1 ELSE 0 END) AS used
       FROM ai_agent_skin_codes WHERE skin_id = ?`,
      [id]
    );
    const skin = skins[0];
    skin.codeTotal = Number(codeCountRows[0]?.total) || 0;
    skin.codeUsed = Number(codeCountRows[0]?.used) || 0;
    res.json({ success: true, data: skin });
  } catch (error) {
    console.error('获取皮肤详情失败:', error);
    res.status(500).json({ error: '获取皮肤详情失败' });
  }
});

// POST / - 新增（multipart: name, description, energy_price, pk_attack, pk_defense, image）
router.post('/', upload.single('image'), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: '皮肤名称不能为空' });
    }
    const description = (req.body.description || '').trim();
    const energyPrice = Math.max(0, parseInt(req.body.energy_price, 10) || 0);
    const pkAttack = parseInt(req.body.pk_attack, 10) || 0;
    const pkDefense = parseInt(req.body.pk_defense, 10) || 0;
    const sortOrder = parseInt(req.body.sort_order, 10) || 0;

    let imagePath = PLACEHOLDER_IMAGE;
    if (req.file && req.file.filename) {
      imagePath = SKIN_IMAGE_PATH_PREFIX + req.file.filename;
    }

    const result = await db.query(
      `INSERT INTO ai_agent_skins (name, description, image_path, energy_price, pk_attack, pk_defense, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [name, description, imagePath, energyPrice, pkAttack, pkDefense, sortOrder]
    );
    const insertId = result.insertId;
    await logAdminAction(req.user.id, 'create_ai_skin', insertId, { name, energyPrice });
    const rows = await db.query('SELECT * FROM ai_agent_skins WHERE id = ?', [insertId]);
    res.status(201).json({ success: true, data: rows[0], message: '创建成功' });
  } catch (error) {
    console.error('创建皮肤失败:', error);
    res.status(500).json({ error: '创建皮肤失败' });
  }
});

// PUT /:id - 编辑（可选 multipart image）
router.put('/:id', upload.single('image'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: '无效的皮肤ID' });
    }
    const skins = await db.query('SELECT id, image_path FROM ai_agent_skins WHERE id = ?', [id]);
    if (skins.length === 0) {
      return res.status(404).json({ error: '皮肤不存在' });
    }

    const name = (req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: '皮肤名称不能为空' });
    }
    const description = (req.body.description || '').trim();
    const energyPrice = Math.max(0, parseInt(req.body.energy_price, 10) || 0);
    const pkAttack = parseInt(req.body.pk_attack, 10) || 0;
    const pkDefense = parseInt(req.body.pk_defense, 10) || 0;
    const sortOrder = parseInt(req.body.sort_order, 10) || 0;
    const isActive = req.body.is_active !== undefined
      ? (req.body.is_active === '1' || req.body.is_active === true)
      : skins[0].is_active;

    let imagePath = skins[0].image_path;
    if (req.file && req.file.filename) {
      imagePath = SKIN_IMAGE_PATH_PREFIX + req.file.filename;
      // 可选：删除旧文件（非默认、非占位时）
      const oldPath = skins[0].image_path;
      if (oldPath && oldPath.startsWith(SKIN_IMAGE_PATH_PREFIX)) {
        const oldFile = path.join(__dirname, '../../public', oldPath);
        if (fs.existsSync(oldFile)) {
          try { fs.unlinkSync(oldFile); } catch (e) { /* ignore */ }
        }
      }
    }

    await db.query(
      `UPDATE ai_agent_skins SET name=?, description=?, image_path=?, energy_price=?, pk_attack=?, pk_defense=?, sort_order=?, is_active=? WHERE id=?`,
      [name, description, imagePath, energyPrice, pkAttack, pkDefense, sortOrder, isActive ? 1 : 0, id]
    );
    await logAdminAction(req.user.id, 'update_ai_skin', id, { name });
    const rows = await db.query('SELECT * FROM ai_agent_skins WHERE id = ?', [id]);
    res.json({ success: true, data: rows[0], message: '更新成功' });
  } catch (error) {
    console.error('更新皮肤失败:', error);
    res.status(500).json({ error: '更新皮肤失败' });
  }
});

// DELETE /:id - 删除（禁止删除默认皮肤 id=1）
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: '无效的皮肤ID' });
    }
    if (id === 1) {
      return res.status(400).json({ error: '不能删除默认皮肤' });
    }
    const skins = await db.query('SELECT id, image_path FROM ai_agent_skins WHERE id = ?', [id]);
    if (skins.length === 0) {
      return res.status(404).json({ error: '皮肤不存在' });
    }
    const imagePath = skins[0].image_path;
    await db.query('DELETE FROM ai_agent_skin_codes WHERE skin_id = ?', [id]);
    await db.query('DELETE FROM user_ai_agent_skins WHERE skin_id = ?', [id]);
    await db.query('UPDATE users SET current_skin_id = NULL WHERE current_skin_id = ?', [id]);
    await db.query('DELETE FROM ai_agent_skins WHERE id = ?', [id]);
    if (imagePath && imagePath.startsWith(SKIN_IMAGE_PATH_PREFIX)) {
      const filePath = path.join(__dirname, '../../public', imagePath);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
      }
    }
    await logAdminAction(req.user.id, 'delete_ai_skin', id);
    res.json({ success: true, message: '删除成功' });
  } catch (error) {
    console.error('删除皮肤失败:', error);
    res.status(500).json({ error: '删除皮肤失败' });
  }
});

// POST /:id/codes - 生成激活码
router.post('/:id/codes', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const count = Math.min(100, Math.max(1, parseInt(req.body.count, 10) || 1));
    if (isNaN(id)) {
      return res.status(400).json({ error: '无效的皮肤ID' });
    }
    const skins = await db.query('SELECT id FROM ai_agent_skins WHERE id = ?', [id]);
    if (skins.length === 0) {
      return res.status(404).json({ error: '皮肤不存在' });
    }
    const codes = [];
    const existing = await db.query('SELECT code FROM ai_agent_skin_codes');
    const existingSet = new Set(existing.map(r => r.code));
    let generated = 0;
    while (generated < count) {
      const code = generateCode(12);
      if (existingSet.has(code)) continue;
      existingSet.add(code);
      await db.query('INSERT INTO ai_agent_skin_codes (skin_id, code) VALUES (?, ?)', [id, code]);
      codes.push(code);
      generated++;
    }
    await logAdminAction(req.user.id, 'generate_skin_codes', id, { count: codes.length });
    res.status(201).json({ success: true, data: { codes }, message: `已生成 ${codes.length} 个激活码` });
  } catch (error) {
    console.error('生成激活码失败:', error);
    res.status(500).json({ error: '生成激活码失败' });
  }
});

// GET /:id/codes - 该皮肤激活码列表（分页）
router.get('/:id/codes', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    if (isNaN(id)) {
      return res.status(400).json({ error: '无效的皮肤ID' });
    }
    const [rows, totalResult] = await Promise.all([
      db.query(
        'SELECT id, code, user_id, used_at, created_at FROM ai_agent_skin_codes WHERE skin_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
        [id, limit, offset]
      ),
      db.query('SELECT COUNT(*) AS total FROM ai_agent_skin_codes WHERE skin_id = ?', [id])
    ]);
    const total = totalResult[0]?.total || 0;
    res.json({ success: true, data: rows, total, page, limit });
  } catch (error) {
    console.error('获取激活码列表失败:', error);
    res.status(500).json({ error: '获取激活码列表失败' });
  }
});

// POST /:id/grant - 指定用户ID授权
router.post('/:id/grant', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const userId = parseInt(req.body.user_id, 10);
    if (isNaN(id) || isNaN(userId)) {
      return res.status(400).json({ error: '皮肤ID和用户ID均为必填且有效数字' });
    }
    const skins = await db.query('SELECT id FROM ai_agent_skins WHERE id = ?', [id]);
    if (skins.length === 0) {
      return res.status(404).json({ error: '皮肤不存在' });
    }
    const users = await db.query('SELECT id FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    try {
      await db.query(
        'INSERT INTO user_ai_agent_skins (user_id, skin_id, source) VALUES (?, ?, ?)',
        [userId, id, 'admin_grant']
      );
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ error: '该用户已拥有此皮肤' });
      }
      throw e;
    }
    await logAdminAction(req.user.id, 'grant_ai_skin', userId, { skinId: id });
    res.json({ success: true, message: '授权成功' });
  } catch (error) {
    console.error('授权皮肤失败:', error);
    res.status(500).json({ error: '授权皮肤失败' });
  }
});

// ========== 会员中心商店相关API ==========

// 检查并添加shop_limit字段（如果不存在）
async function ensureShopLimitColumn() {
  try {
    await db.query('SELECT shop_limit FROM ai_agent_skins LIMIT 1');
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      await db.query('ALTER TABLE ai_agent_skins ADD COLUMN shop_limit INT DEFAULT 0 COMMENT "商店激活码数量上限，0表示不限"');
    }
  }
}
// 启动时检查
ensureShopLimitColumn();

// PUT /:id/shop-limit - 设置商店激活码数量上限
router.put('/:id/shop-limit', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const shopLimit = Math.max(0, parseInt(req.body.shop_limit, 10) || 0);

    if (isNaN(id)) {
      return res.status(400).json({ error: '无效的皮肤ID' });
    }

    const skins = await db.query('SELECT id FROM ai_agent_skins WHERE id = ?', [id]);
    if (skins.length === 0) {
      return res.status(404).json({ error: '皮肤不存在' });
    }

    await db.query('UPDATE ai_agent_skins SET shop_limit = ? WHERE id = ?', [shopLimit, id]);
    await logAdminAction(req.user.id, 'set_skin_shop_limit', id, { shop_limit: shopLimit });

    res.json({ success: true, message: '商店数量上限已设置' });
  } catch (error) {
    console.error('设置商店上限失败:', error);
    res.status(500).json({ error: '设置失败' });
  }
});

// GET /:id/shop-stats - 获取商店激活码统计
router.get('/:id/shop-stats', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ error: '无效的皮肤ID' });
    }

    // 获取皮肤信息和商店上限
    const skins = await db.query('SELECT id, name, shop_limit FROM ai_agent_skins WHERE id = ?', [id]);
    if (skins.length === 0) {
      return res.status(404).json({ error: '皮肤不存在' });
    }

    // 统计该皮肤的所有激活码
    const stats = await db.query(
      `SELECT
        COUNT(*) as total_codes,
        SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END) as admin_codes,
        SUM(CASE WHEN user_id IS NOT NULL AND used_at IS NULL THEN 1 ELSE 0 END) as sold_codes,
        SUM(CASE WHEN user_id IS NOT NULL AND used_at IS NOT NULL THEN 1 ELSE 0 END) as used_codes
       FROM ai_agent_skin_codes WHERE skin_id = ?`,
      [id]
    );

    const s = stats[0] || {};
    const shopLimit = skins[0].shop_limit || 0;

    // 计算商店可用数量（已售+未售，但不能超过上限）
    const soldCount = Number(s.sold_codes) || 0;
    const usedCount = Number(s.used_codes) || 0;
    const adminCount = Number(s.admin_codes) || 0;
    const totalAvailable = soldCount + adminCount;
    const shopAvailable = shopLimit > 0 ? Math.max(0, shopLimit - soldCount) : totalAvailable;

    res.json({
      success: true,
      data: {
        skin_id: id,
        skin_name: skins[0].name,
        shop_limit: shopLimit,
        total_codes: Number(s.total_codes) || 0,
        admin_codes: adminCount,
        sold_codes: soldCount,
        used_codes: usedCount,
        shop_available: shopAvailable
      }
    });
  } catch (error) {
    console.error('获取商店统计失败:', error);
    res.status(500).json({ error: '获取统计失败' });
  }
});

// GET /:id/shop-records - 获取商店激活码购买/使用记录
router.get('/:id/shop-records', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    if (isNaN(id)) {
      return res.status(400).json({ error: '无效的皮肤ID' });
    }

    const skins = await db.query('SELECT id FROM ai_agent_skins WHERE id = ?', [id]);
    if (skins.length === 0) {
      return res.status(404).json({ error: '皮肤不存在' });
    }

    // 只查询用户购买/使用的激活码（user_id IS NOT NULL）
    const [rows, totalResult] = await Promise.all([
      db.query(
        `SELECT c.id, c.code, c.user_id, c.used_at, c.created_at,
                u.username as buyer_username
         FROM ai_agent_skin_codes c
         LEFT JOIN users u ON c.user_id = u.id
         WHERE c.skin_id = ? AND c.user_id IS NOT NULL
         ORDER BY c.id DESC
         LIMIT ? OFFSET ?`,
        [id, limit, offset]
      ),
      db.query(
        'SELECT COUNT(*) as total FROM ai_agent_skin_codes WHERE skin_id = ? AND user_id IS NOT NULL',
        [id]
      )
    ]);

    const total = totalResult[0]?.total || 0;

    res.json({
      success: true,
      data: rows.map(r => ({
        id: r.id,
        code: r.code,
        buyer_id: r.user_id,
        buyer_username: r.buyer_username,
        is_used: r.used_at !== null,
        bought_at: r.created_at,
        used_at: r.used_at
      })),
      total,
      page,
      limit
    });
  } catch (error) {
    console.error('获取购买记录失败:', error);
    res.status(500).json({ error: '获取记录失败' });
  }
});

module.exports = router;
