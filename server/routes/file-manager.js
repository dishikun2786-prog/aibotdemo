/**
 * @file file-manager.js
 * @module routes/file-manager
 * @description 网盘功能 - 用户文件管理
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../utils/db');
const oss = require('../utils/oss');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// 生成分享码
function generateShareCode() {
  return crypto.randomBytes(4).toString('hex');
}

// 获取文件类型
function getFileType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'];
  const videoExts = ['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm'];
  const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'];
  const docExts = ['doc', 'docx', 'pdf', 'txt', 'xls', 'xlsx', 'ppt', 'pptx'];
  const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz'];

  if (imageExts.includes(ext)) return 'image';
  if (videoExts.includes(ext)) return 'video';
  if (audioExts.includes(ext)) return 'audio';
  if (docExts.includes(ext)) return 'document';
  if (archiveExts.includes(ext)) return 'archive';
  return 'other';
}

// ============================================================
// 文件夹管理
// ============================================================

/**
 * 获取文件夹列表
 * GET /api/file-manager/folders
 */
router.get('/folders', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { parent_id = 0 } = req.query;

    const folders = await db.query(
      'SELECT * FROM user_folders WHERE user_id = ? AND parent_id = ? ORDER BY folder_name ASC',
      [userId, parent_id]
    );

    res.json({
      success: true,
      data: folders
    });
  } catch (error) {
    console.error('获取文件夹列表失败:', error);
    res.status(500).json({ error: '获取文件夹列表失败' });
  }
});

/**
 * 创建文件夹
 * POST /api/file-manager/folders
 */
router.post('/folders', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { folder_name, parent_id = 0 } = req.body;

    if (!folder_name || folder_name.trim() === '') {
      return res.status(400).json({ error: '文件夹名称不能为空' });
    }

    // 检查同名文件夹是否已存在
    const existing = await db.query(
      'SELECT id FROM user_folders WHERE user_id = ? AND folder_name = ? AND parent_id = ?',
      [userId, folder_name.trim(), parent_id]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: '文件夹已存在' });
    }

    const result = await db.query(
      'INSERT INTO user_folders (user_id, folder_name, parent_id) VALUES (?, ?, ?)',
      [userId, folder_name.trim(), parent_id]
    );

    res.json({
      success: true,
      data: {
        id: result.insertId,
        folder_name: folder_name.trim(),
        parent_id: parent_id
      }
    });
  } catch (error) {
    console.error('创建文件夹失败:', error);
    res.status(500).json({ error: '创建文件夹失败' });
  }
});

/**
 * 删除文件夹
 * DELETE /api/file-manager/folders/:id
 */
router.delete('/folders/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    // 验证文件夹属于当前用户
    const [folder] = await db.query(
      'SELECT * FROM user_folders WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (!folder) {
      return res.status(404).json({ error: '文件夹不存在' });
    }

    // 检查文件夹是否为空（无子文件夹和无文件）
    const [files] = await db.query(
      'SELECT COUNT(*) as count FROM user_files WHERE folder_id = ? AND user_id = ?',
      [id, userId]
    );
    const [subfolders] = await db.query(
      'SELECT COUNT(*) as count FROM user_folders WHERE parent_id = ? AND user_id = ?',
      [id, userId]
    );

    if (files.count > 0 || subfolders.count > 0) {
      return res.status(400).json({ error: '文件夹不为空，无法删除' });
    }

    await db.query('DELETE FROM user_folders WHERE id = ?', [id]);

    res.json({
      success: true,
      message: '文件夹删除成功'
    });
  } catch (error) {
    console.error('删除文件夹失败:', error);
    res.status(500).json({ error: '删除文件夹失败' });
  }
});

/**
 * 重命名文件夹
 * PUT /api/file-manager/folders/:id
 */
router.put('/folders/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { folder_name } = req.body;

    if (!folder_name || folder_name.trim() === '') {
      return res.status(400).json({ error: '文件夹名称不能为空' });
    }

    // 验证文件夹属于当前用户
    const [folder] = await db.query(
      'SELECT * FROM user_folders WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (!folder) {
      return res.status(404).json({ error: '文件夹不存在' });
    }

    await db.query(
      'UPDATE user_folders SET folder_name = ? WHERE id = ?',
      [folder_name.trim(), id]
    );

    res.json({
      success: true,
      message: '文件夹重命名成功'
    });
  } catch (error) {
    console.error('重命名文件夹失败:', error);
    res.status(500).json({ error: '重命名文件夹失败' });
  }
});

// ============================================================
// 文件管理
// ============================================================

/**
 * 获取文件列表
 * GET /api/file-manager/files
 */
router.get('/files', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { folder_id = 0, page = 1, limit = 50 } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const files = await db.query(
      'SELECT * FROM user_files WHERE user_id = ? AND folder_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [userId, folder_id, parseInt(limit), offset]
    );

    // 获取文件总数
    const countResult = await db.query(
      'SELECT COUNT(*) as total FROM user_files WHERE user_id = ? AND folder_id = ?',
      [userId, folder_id]
    );
    const total = countResult[0].total;

    // 计算存储空间
    const sizeResult = await db.query(
      'SELECT COALESCE(SUM(file_size), 0) as totalSize FROM user_files WHERE user_id = ?',
      [userId]
    );
    const totalSize = sizeResult[0].totalSize;

    res.json({
      success: true,
      data: files,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total,
        total_pages: Math.ceil(total / parseInt(limit))
      },
      storage: {
        used: totalSize,
        used_mb: Math.round(totalSize / 1024 / 1024 * 100) / 100
      }
    });
  } catch (error) {
    console.error('获取文件列表失败:', error);
    res.status(500).json({ error: '获取文件列表失败' });
  }
});

/**
 * 获取OSS上传凭证（STS）
 * GET /api/file-manager/upload-token
 */
router.get('/upload-token', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 获取用户存储配额
    const userResult = await db.query(
      'SELECT COALESCE(storage_quota, 1073741824) as storage_quota FROM users WHERE id = ?',
      [userId]
    );
    const storageQuota = userResult[0]?.storage_quota || 1073741824; // 默认1GB

    // 计算已用空间
    const usedResult = await db.query(
      'SELECT COALESCE(SUM(file_size), 0) as usedSize FROM user_files WHERE user_id = ?',
      [userId]
    );
    const usedSize = usedResult[0]?.usedSize || 0;
    const availableSize = Math.max(0, storageQuota - usedSize);

    const token = await oss.getSTSToken(3600);
    res.json({
      success: true,
      data: {
        ...token,
        storage_quota: storageQuota,
        storage_used: usedSize,
        storage_available: availableSize
      }
    });
  } catch (error) {
    console.error('获取上传凭证失败:', error);
    res.status(500).json({ error: '获取上传凭证失败' });
  }
});

/**
 * 注册文件（前端上传完成后调用）
 * POST /api/file-manager/files
 */
router.post('/files', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { file_name, file_size, file_type, oss_key, folder_id = 0 } = req.body;

    if (!file_name || !oss_key) {
      return res.status(400).json({ error: '文件名和OSS路径不能为空' });
    }

    // 检查存储配额
    const userResult = await db.query(
      'SELECT COALESCE(storage_quota, 1073741824) as storage_quota FROM users WHERE id = ?',
      [userId]
    );
    const storageQuota = userResult[0]?.storage_quota ? Number(userResult[0].storage_quota) : 1073741824; // 默认1GB

    // 计算当前已用空间
    const usedResult = await db.query(
      'SELECT COALESCE(SUM(file_size), 0) as usedSize FROM user_files WHERE user_id = ?',
      [userId]
    );
    const usedSize = usedResult[0]?.usedSize ? Number(usedResult[0].usedSize) : 0;
    const newFileSize = file_size ? Number(file_size) : 0;

    // 检查是否超出配额
    if (usedSize + newFileSize > storageQuota) {
      const availableMB = Math.round((storageQuota - usedSize) / 1024 / 1024 * 100) / 100;
      return res.status(400).json({
        error: '存储空间不足',
        details: {
          quota_mb: Math.round(storageQuota / 1024 / 1024),
          used_mb: Math.round(usedSize / 1024 / 1024 * 100) / 100,
          available_mb: availableMB,
          file_size_mb: Math.round(newFileSize / 1024 / 1024 * 100) / 100
        }
      });
    }

    // 生成唯一OSS key
    const uniqueKey = `user-files/${userId}/${Date.now()}_${file_name}`;
    const finalFileType = file_type || getFileType(file_name);

    const result = await db.query(
      `INSERT INTO user_files (user_id, file_name, file_size, file_type, oss_key, folder_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, file_name, newFileSize, finalFileType, oss_key, folder_id]
    );

    res.json({
      success: true,
      data: {
        id: result.insertId,
        file_name: file_name,
        file_type: finalFileType,
        oss_key: oss_key
      }
    });
  } catch (error) {
    console.error('注册文件失败:', error);
    res.status(500).json({ error: '注册文件失败' });
  }
});

/**
 * 获取文件详情
 * GET /api/file-manager/files/:id
 */
router.get('/files/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const [file] = await db.query(
      'SELECT * FROM user_files WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }

    // 生成访问URL
    const fileUrl = await oss.getPublicUrl(file.oss_key);

    res.json({
      success: true,
      data: {
        ...file,
        file_url: fileUrl
      }
    });
  } catch (error) {
    console.error('获取文件详情失败:', error);
    res.status(500).json({ error: '获取文件详情失败' });
  }
});

/**
 * 删除文件
 * DELETE /api/file-manager/files/:id
 */
router.delete('/files/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    // 验证文件属于当前用户
    const [file] = await db.query(
      'SELECT * FROM user_files WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }

    // 删除OSS文件
    try {
      await oss.deleteFile(file.oss_key);
    } catch (err) {
      console.error('删除OSS文件失败:', err.message);
    }

    // 删除数据库记录
    await db.query('DELETE FROM user_files WHERE id = ?', [id]);

    res.json({
      success: true,
      message: '文件删除成功'
    });
  } catch (error) {
    console.error('删除文件失败:', error);
    res.status(500).json({ error: '删除文件失败' });
  }
});

/**
 * 重命名/移动文件
 * PUT /api/file-manager/files/:id
 */
router.put('/files/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { file_name, folder_id } = req.body;

    // 验证文件属于当前用户
    const [file] = await db.query(
      'SELECT * FROM user_files WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }

    const updates = [];
    const params = [];

    if (file_name) {
      updates.push('file_name = ?');
      params.push(file_name);
    }

    if (folder_id !== undefined) {
      updates.push('folder_id = ?');
      params.push(folder_id);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: '没有要更新的内容' });
    }

    params.push(id);
    await db.query(
      `UPDATE user_files SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    res.json({
      success: true,
      message: '文件更新成功'
    });
  } catch (error) {
    console.error('更新文件失败:', error);
    res.status(500).json({ error: '更新文件失败' });
  }
});

// ============================================================
// 文件分享
// ============================================================

/**
 * 生成分享链接
 * POST /api/file-manager/files/:id/share
 */
router.post('/files/:id/share', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { expires_hours = 24 } = req.body;

    // 验证文件属于当前用户
    const [file] = await db.query(
      'SELECT * FROM user_files WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }

    // 生成新的分享码
    const shareCode = generateShareCode();
    const expiresAt = new Date(Date.now() + expires_hours * 60 * 60 * 1000);

    await db.query(
      'UPDATE user_files SET is_shared = TRUE, share_code = ?, share_expires_at = ? WHERE id = ?',
      [shareCode, expiresAt, id]
    );

    // 生成访问URL（使用前端展示页面，强制使用https协议）
    const shareUrl = `https://${req.get('host')}/file-share.html?code=${shareCode}`;

    res.json({
      success: true,
      data: {
        share_code: shareCode,
        share_url: shareUrl,
        expires_at: expiresAt
      }
    });
  } catch (error) {
    console.error('生成分享链接失败:', error);
    res.status(500).json({ error: '生成分享链接失败' });
  }
});

/**
 * 取消分享
 * DELETE /api/file-manager/files/:id/share
 */
router.delete('/files/:id/share', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    // 验证文件属于当前用户
    const [file] = await db.query(
      'SELECT * FROM user_files WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }

    await db.query(
      'UPDATE user_files SET is_shared = FALSE, share_code = NULL, share_expires_at = NULL WHERE id = ?',
      [id]
    );

    res.json({
      success: true,
      message: '取消分享成功'
    });
  } catch (error) {
    console.error('取消分享失败:', error);
    res.status(500).json({ error: '取消分享失败' });
  }
});

/**
 * 通过分享码下载文件（公开接口）
 * GET /api/file-manager/shared/:code
 */
router.get('/shared/:code', async (req, res) => {
  try {
    const { code } = req.params;

    const [file] = await db.query(
      `SELECT * FROM user_files
       WHERE share_code = ? AND is_shared = TRUE
       AND (share_expires_at IS NULL OR share_expires_at > NOW())`,
      [code]
    );

    if (!file) {
      return res.status(404).json({ error: '分享链接无效或已过期' });
    }

    // 更新浏览次数
    await db.query(
      'UPDATE user_files SET view_count = view_count + 1 WHERE id = ?',
      [file.id]
    );

    // 生成访问URL
    const fileUrl = await oss.getPublicUrl(file.oss_key);

    res.json({
      success: true,
      data: {
        file_name: file.file_name,
        file_size: file.file_size,
        file_type: file.file_type,
        file_url: fileUrl,
        view_count: file.view_count + 1
      }
    });
  } catch (error) {
    console.error('获取分享文件失败:', error);
    res.status(500).json({ error: '获取分享文件失败' });
  }
});

// ============================================================
// 管理员接口
// ============================================================

/**
 * 获取所有用户文件列表（管理员）
 * GET /api/file-manager/admin/files
 */
router.get('/admin/files', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, user_id, keyword } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let sql = `SELECT f.*, u.username,
     (SELECT COUNT(*) FROM user_files s WHERE s.user_id = f.user_id AND s.is_shared = TRUE) as user_share_count,
     (SELECT SUM(view_count) FROM user_files v WHERE v.user_id = f.user_id) as user_view_count
     FROM user_files f LEFT JOIN users u ON f.user_id = u.id WHERE 1=1`;
    const params = [];

    if (user_id) {
      sql += ' AND f.user_id = ?';
      params.push(user_id);
    }

    if (keyword) {
      sql += ' AND f.file_name LIKE ?';
      params.push(`%${keyword}%`);
    }

    sql += ' ORDER BY f.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const files = await db.query(sql, params);

    const countResult = await db.query(
      'SELECT COUNT(*) as total FROM user_files f WHERE 1=1',
      []
    );
    const total = countResult[0].total;

    // 获取总体统计
    const statsResult = await db.query(
      `SELECT
       COUNT(*) as total_files,
       COALESCE(SUM(file_size), 0) as total_size,
       SUM(CASE WHEN is_shared = TRUE THEN 1 ELSE 0 END) as total_shared,
       COALESCE(SUM(view_count), 0) as total_views,
       COALESCE(SUM(download_count), 0) as total_downloads,
       COUNT(DISTINCT user_id) as total_users
       FROM user_files`
    );
    const stats = statsResult[0];

    res.json({
      success: true,
      data: files,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total,
        total_pages: Math.ceil(total / parseInt(limit))
      },
      stats: {
        total_files: stats.total_files,
        total_size: stats.total_size,
        total_size_mb: Math.round(stats.total_size / 1024 / 1024 * 100) / 100,
        total_shared: stats.total_shared,
        total_views: stats.total_views,
        total_downloads: stats.total_downloads,
        total_users: stats.total_users
      }
    });
  } catch (error) {
    console.error('获取文件列表失败:', error);
    res.status(500).json({ error: '获取文件列表失败' });
  }
});

/**
 * 删除任意用户文件（管理员）
 * DELETE /api/file-manager/admin/files/:id
 */
router.delete('/admin/files/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const [file] = await db.query('SELECT * FROM user_files WHERE id = ?', [id]);

    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }

    // 删除OSS文件
    try {
      await oss.deleteFile(file.oss_key);
    } catch (err) {
      console.error('删除OSS文件失败:', err.message);
    }

    // 删除数据库记录
    await db.query('DELETE FROM user_files WHERE id = ?', [id]);

    res.json({
      success: true,
      message: '文件删除成功'
    });
  } catch (error) {
    console.error('删除文件失败:', error);
    res.status(500).json({ error: '删除文件失败' });
  }
});

/**
 * 获取文件访问URL（管理员）
 * GET /api/file-manager/admin/files/:id/url
 */
router.get('/admin/files/:id/url', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const [file] = await db.query('SELECT * FROM user_files WHERE id = ?', [id]);

    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }

    // 生成访问URL
    const fileUrl = await oss.getPublicUrl(file.oss_key);

    res.json({
      success: true,
      data: {
        url: fileUrl,
        file_name: file.file_name,
        file_size: file.file_size,
        file_type: file.file_type
      }
    });
  } catch (error) {
    console.error('获取文件URL失败:', error);
    res.status(500).json({ error: '获取文件URL失败' });
  }
});

/**
 * 获取存储统计（管理员）
 * GET /api/file-manager/admin/stats
 */
router.get('/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // 用户存储用量统计
    const stats = await db.query(
      `SELECT f.user_id, u.username,
       SUM(f.file_size) as total_size,
       COUNT(f.id) as file_count,
       COALESCE(u.storage_quota, 1073741824) as storage_quota
       FROM user_files f
       LEFT JOIN users u ON f.user_id = u.id
       GROUP BY f.user_id
       ORDER BY total_size DESC
       LIMIT 20`
    );

    // 总存储用量
    const statsResult = await db.query(
      'SELECT COALESCE(SUM(file_size), 0) as totalSize, COUNT(*) as totalFiles FROM user_files'
    );
    const totalSize = statsResult[0].totalSize;
    const totalFiles = statsResult[0].totalFiles;

    res.json({
      success: true,
      data: {
        total_size: totalSize,
        total_size_mb: Math.round(totalSize / 1024 / 1024 * 100) / 100,
        total_files: totalFiles,
        user_stats: stats.map(s => ({
          user_id: s.user_id,
          username: s.username || '未知',
          total_size: s.total_size || 0,
          total_size_mb: Math.round((s.total_size || 0) / 1024 / 1024 * 100) / 100,
          storage_quota: s.storage_quota || 1073741824,
          storage_quota_mb: Math.round((s.storage_quota || 1073741824) / 1024 / 1024),
          file_count: s.file_count
        }))
      }
    });
  } catch (error) {
    console.error('获取存储统计失败:', error);
    res.status(500).json({ error: '获取存储统计失败' });
  }
});

/**
 * 设置用户存储配额（管理员）
 * PUT /api/file-manager/admin/user/:userId/quota
 */
router.put('/admin/user/:userId/quota', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { storage_quota } = req.body;

    if (!storage_quota || storage_quota < 0) {
      return res.status(400).json({ error: '请输入有效的存储配额（单位：MB）' });
    }

    // 转换为字节
    const quotaInBytes = BigInt(storage_quota) * BigInt(1024) * BigInt(1024);

    // 检查用户是否存在
    const [user] = await db.query('SELECT id FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // 更新配额
    await db.query(
      'UPDATE users SET storage_quota = ? WHERE id = ?',
      [Number(quotaInBytes), userId]
    );

    res.json({
      success: true,
      message: '存储配额设置成功'
    });
  } catch (error) {
    console.error('设置存储配额失败:', error);
    res.status(500).json({ error: '设置存储配额失败' });
  }
});

module.exports = router;
