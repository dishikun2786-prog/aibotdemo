/**
 * @file user-avatar.js
 * @module routes/user-avatar
 * @description 用户头像管理：上传、获取用户自定义头像
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');
const { getIO } = require('../socket');

// 用户头像上传目录
const USER_AVATARS_DIR = path.join(__dirname, '../../public/uploads/user-avatars');
const USER_AVATAR_PATH_PREFIX = '/uploads/user-avatars/';

// 确保上传目录存在
if (!fs.existsSync(USER_AVATARS_DIR)) {
  fs.mkdirSync(USER_AVATARS_DIR, { recursive: true });
}

// 头像上传配置：限制1MB
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, USER_AVATARS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (!allowedExts.includes(ext)) {
      return cb(new Error('不支持的图片格式'), false);
    }
    // 使用用户ID作为文件名，便于管理和查找
    const userId = req.user ? req.user.id : 'unknown';
    const name = `avatar_${userId}_${Date.now()}${ext}`;
    cb(null, name);
  }
});

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 1 * 1024 * 1024 }, // 1MB限制
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('仅支持 JPG、PNG、GIF、WebP 格式图片'), false);
    }
    cb(null, true);
  }
});

// 迁移：确保avatar_image字段存在
async function ensureAvatarColumn() {
  try {
    const result = await db.query('DESCRIBE users');
    // db.query 直接返回结果数组，不需要 result[0]
    const columns = Array.isArray(result) ? result : [];
    const hasAvatarField = columns.some(col => col.Field === 'avatar_image');
    if (!hasAvatarField) {
      await db.query(
        'ALTER TABLE users ADD COLUMN avatar_image VARCHAR(255) DEFAULT NULL COMMENT \'用户头像图片路径\' AFTER current_skin_id'
      );
      console.log('[迁移] users表添加avatar_image字段成功');
    }
  } catch (error) {
    console.error('[迁移] 检查/添加avatar_image字段失败:', error.message);
  }
}

// 启动时执行迁移
ensureAvatarColumn();

/**
 * POST /api/user/avatar-upload
 * 上传用户头像
 */
router.post('/avatar-upload', authenticateToken, uploadAvatar.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择图片文件' });
    }

    const userId = req.user.id;
    const avatarPath = USER_AVATAR_PATH_PREFIX + req.file.filename;

    // 删除旧头像（如果存在且不是默认目录下的文件）
    const [users] = await db.query('SELECT avatar_image FROM users WHERE id = ?', [userId]);
    if (users.length > 0 && users[0].avatar_image) {
      const oldPath = path.join(__dirname, '../../public', users[0].avatar_image);
      if (fs.existsSync(oldPath) && oldPath.includes('user-avatars')) {
        try {
          fs.unlinkSync(oldPath);
        } catch (e) {
          console.error('删除旧头像失败:', e.message);
        }
      }
    }

    // 保存新头像路径到数据库
    await db.query(
      'UPDATE users SET avatar_image = ? WHERE id = ?',
      [avatarPath, userId]
    );

    // 清除用户缓存（如果有）- 头像更新后客户端会重新获取
    // const cache = require('../utils/cache');
    // await cache.del(`user:${userId}`);

    // 广播头像更新给房间内所有用户
    try {
      const io = getIO();
      if (io) {
        // 获取用户当前所在的房间（通过查询game_nodes）
        const [userNodes] = await db.query(
          'SELECT room_id FROM game_nodes WHERE owner_id = ?',
          [userId]
        );

        if (userNodes.length > 0) {
          const roomId = userNodes[0].room_id;
          // 广播给房间内所有用户
          io.to(`room_${roomId}`).emit('game_state', {
            type: 'player_avatar_update',
            userId: userId,
            avatarImage: avatarPath
          });
        }
      }
    } catch (broadcastError) {
      console.error('广播头像更新失败:', broadcastError.message);
    }

    res.json({
      success: true,
      data: {
        avatar_url: avatarPath,
        filename: req.file.filename
      },
      message: '头像上传成功'
    });
  } catch (error) {
    console.error('上传头像失败:', error);
    res.status(500).json({ error: '上传失败: ' + error.message });
  }
});

/**
 * GET /api/user/avatar
 * 获取当前用户头像
 */
router.get('/avatar', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const [users] = await db.query('SELECT avatar_image, username FROM users WHERE id = ?', [userId]);

    if (users.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const user = users[0];
    res.json({
      success: true,
      data: {
        avatar_image: user.avatar_image,
        username: user.username
      }
    });
  } catch (error) {
    console.error('获取头像失败:', error);
    res.status(500).json({ error: '获取头像失败' });
  }
});

/**
 * DELETE /api/user/avatar
 * 删除用户头像（恢复默认）
 */
router.delete('/avatar', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 获取当前头像路径
    const [users] = await db.query('SELECT avatar_image FROM users WHERE id = ?', [userId]);
    if (users.length > 0 && users[0].avatar_image) {
      const oldPath = path.join(__dirname, '../../public', users[0].avatar_image);
      // 只删除user-avatars目录下的文件
      if (oldPath.includes('user-avatars') && fs.existsSync(oldPath)) {
        try {
          fs.unlinkSync(oldPath);
        } catch (e) {
          console.error('删除头像文件失败:', e.message);
        }
      }
    }

    // 清空数据库中的头像路径
    await db.query(
      'UPDATE users SET avatar_image = NULL WHERE id = ?',
      [userId]
    );

    // 广播头像删除给房间内所有用户
    try {
      const io = getIO();
      if (io) {
        const [userNodes] = await db.query(
          'SELECT room_id FROM game_nodes WHERE owner_id = ?',
          [userId]
        );

        if (userNodes.length > 0) {
          const roomId = userNodes[0].room_id;
          io.to(`room_${roomId}`).emit('game_state', {
            type: 'player_avatar_update',
            userId: userId,
            avatarImage: null
          });
        }
      }
    } catch (broadcastError) {
      console.error('广播头像删除失败:', broadcastError.message);
    }

    res.json({
      success: true,
      message: '头像已删除'
    });
  } catch (error) {
    console.error('删除头像失败:', error);
    res.status(500).json({ error: '删除头像失败' });
  }
});

module.exports = router;
