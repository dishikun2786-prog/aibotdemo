/**
 * @file admin-game-codes.js
 * @module routes/admin-game-codes
 * @description 管理员后台：能量/体力激活码管理（生成、列表、导出CSV、批量禁用）
 */
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { authenticateToken, requireAdmin, logAdminAction } = require('../middleware/auth');

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

/**
 * 构建列表查询的 WHERE 与 params
 */
function buildListWhere(query) {
  const { type, status } = query;
  let where = '1=1';
  const params = [];
  if (type === 'energy' || type === 'stamina') {
    where += ' AND type = ?';
    params.push(type);
  }
  if (status === 'used') {
    where += ' AND user_id IS NOT NULL';
  } else if (status === 'unused') {
    where += ' AND user_id IS NULL AND is_disabled = 0';
  } else if (status === 'disabled') {
    where += ' AND is_disabled = 1';
  }
  return { where, params };
}

// POST /generate - 一键生成
router.post('/generate', async (req, res) => {
  try {
    const { type, amount, count, remark } = req.body;
    const typeVal = type === 'stamina' ? 'stamina' : 'energy';
    const amountVal = Math.max(1, parseInt(amount, 10) || 0);
    const countVal = Math.min(200, Math.max(1, parseInt(count, 10) || 1));
    const remarkVal = (remark != null && String(remark).trim()) ? String(remark).trim() : '';

    if (!remarkVal) {
      return res.status(400).json({ error: '请填写激活码备注' });
    }

    const existing = await db.query('SELECT code FROM game_activation_codes');
    const existingSet = new Set(existing.map(r => r.code));
    const codes = [];
    let generated = 0;

    while (generated < countVal) {
      const code = generateCode(12);
      if (existingSet.has(code)) continue;
      existingSet.add(code);
      await db.query(
        'INSERT INTO game_activation_codes (code, type, amount, remark, created_by_user_id) VALUES (?, ?, ?, ?, ?)',
        [code, typeVal, amountVal, remarkVal, req.user.id]
      );
      codes.push(code);
      generated++;
    }

    await logAdminAction(req.user.id, 'generate_game_codes', null, {
      type: typeVal,
      amount: amountVal,
      count: codes.length,
      remark: remarkVal
    });

    res.status(201).json({
      success: true,
      data: { codes },
      message: `已生成 ${codes.length} 个激活码`
    });
  } catch (error) {
    console.error('生成能量/体力激活码失败:', error);
    res.status(500).json({ error: '生成激活码失败' });
  }
});

// GET / - 分页列表
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const { where, params } = buildListWhere(req.query);

    const listParams = [...params, limit, offset];
    const rows = await db.query(
      `SELECT g.id, g.code, g.type, g.amount, g.remark, g.is_disabled, g.user_id, g.used_at, g.created_at, g.created_by_user_id,
              u.username AS created_by_username
       FROM game_activation_codes g
       LEFT JOIN users u ON g.created_by_user_id = u.id
       WHERE ${where}
       ORDER BY g.id DESC
       LIMIT ? OFFSET ?`,
      listParams
    );

    const countResult = await db.query(
      `SELECT COUNT(*) AS total FROM game_activation_codes WHERE ${where}`,
      params
    );
    const total = countResult[0]?.total || 0;

    res.json({ success: true, data: rows, total, page, limit });
  } catch (error) {
    console.error('获取激活码列表失败:', error);
    res.status(500).json({ error: '获取激活码列表失败' });
  }
});

// GET /export - 导出 CSV
router.get('/export', async (req, res) => {
  try {
    const { ids } = req.query;
    let rows;
    if (ids && String(ids).trim()) {
      const idList = String(ids).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (idList.length === 0) {
        return res.status(400).json({ error: '请选择要导出的记录' });
      }
      const placeholders = idList.map(() => '?').join(',');
      rows = await db.query(
        `SELECT g.id, g.code, g.type, g.amount, g.remark, g.is_disabled, g.user_id, g.used_at, g.created_at, g.created_by_user_id,
                u.username AS created_by_username
         FROM game_activation_codes g
         LEFT JOIN users u ON g.created_by_user_id = u.id
         WHERE g.id IN (${placeholders}) ORDER BY g.id DESC`,
        idList
      );
    } else {
      const { where, params } = buildListWhere(req.query);
      rows = await db.query(
        `SELECT g.id, g.code, g.type, g.amount, g.remark, g.is_disabled, g.user_id, g.used_at, g.created_at, g.created_by_user_id,
                u.username AS created_by_username
         FROM game_activation_codes g
         LEFT JOIN users u ON g.created_by_user_id = u.id
         WHERE ${where} ORDER BY g.id DESC`,
        params
      );
    }

    const typeLabel = (t) => (t === 'energy' ? '能量' : '体力');
    const statusLabel = (row) => {
      if (row.is_disabled) return '已禁用';
      if (row.user_id) return '已使用';
      return '未使用';
    };

    const header = ['激活码', '类型', '数值', '备注', '创建者', '状态', '使用用户ID', '使用时间', '创建时间'];
    const csvRows = [header.join(',')];
    for (const row of rows) {
      const usedAt = row.used_at ? String(row.used_at) : '';
      const createdAt = row.created_at ? String(row.created_at) : '';
      const escape = (v) => {
        const s = v == null ? '' : String(v);
        if (/[,"\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      };
      const createdBy = row.created_by_user_id ? (row.created_by_username || '用户') : '管理员';
      csvRows.push([
        escape(row.code),
        escape(typeLabel(row.type)),
        escape(row.amount),
        escape(row.remark),
        escape(createdBy),
        escape(statusLabel(row)),
        escape(row.user_id),
        escape(usedAt),
        escape(createdAt)
      ].join(','));
    }

    const BOM = '\uFEFF';
    const csv = BOM + csvRows.join('\r\n');
    const filename = `game-codes-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send(csv);
  } catch (error) {
    console.error('导出激活码CSV失败:', error);
    res.status(500).json({ error: '导出失败' });
  }
});

// PUT /batch-disable - 批量禁用
router.put('/batch-disable', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const idList = ids.map(id => parseInt(id, 10)).filter(n => !isNaN(n) && n > 0);
    if (idList.length === 0) {
      return res.status(400).json({ error: '请选择要禁用的激活码' });
    }

    const placeholders = idList.map(() => '?').join(',');
    const result = await db.query(
      `UPDATE game_activation_codes SET is_disabled = 1
       WHERE id IN (${placeholders}) AND user_id IS NULL`,
      idList
    );

    await logAdminAction(req.user.id, 'batch_disable_game_codes', null, {
      ids: idList,
      affected: result.affectedRows
    });

    res.json({
      success: true,
      message: `已禁用 ${result.affectedRows} 个激活码`,
      data: { affected: result.affectedRows }
    });
  } catch (error) {
    console.error('批量禁用激活码失败:', error);
    res.status(500).json({ error: '批量禁用失败' });
  }
});

module.exports = router;
