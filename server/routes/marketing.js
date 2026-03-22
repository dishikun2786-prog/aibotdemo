/**
 * @file marketing.js
 * @module routes/marketing
 * @description 用户营销页面API，支持展示帖子、播客、联系方式等信息
 */
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const mongo = require('../utils/mongo');
const oss = require('../utils/oss');
const { authenticateToken, optionalAuth, requireAdmin } = require('../middleware/auth');
const config = require('../config/database');
const multer = require('multer');
const path = require('path');

// 工具函数：获取客户端IP
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    'unknown';
}

// 工具函数：从HTML内容中提取第一张图片
function extractFirstImageFromContent(content) {
  if (!content) return null;
  const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  return imgMatch ? imgMatch[1] : null;
}

/**
 * 获取当前用户的营销资料
 * GET /api/marketing/profile
 */
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await getMarketingProfile(userId);

    res.json({
      success: true,
      data: profile
    });
  } catch (err) {
    console.error('获取营销资料失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取指定用户的营销资料（公开访问）
 * GET /api/marketing/profile/:userId
 */
router.get('/profile/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!userId || isNaN(userId)) {
      return res.status(400).json({ error: '无效的用户ID' });
    }

    const profile = await getMarketingProfile(userId);

    // 如果用户不存在或未公开
    if (!profile) {
      return res.status(404).json({ error: '用户不存在' });
    }

    if (!profile.is_public) {
      return res.status(403).json({ error: '该用户暂未公开营销页面' });
    }

    // 增加访问次数
    if (profile.profile_id) {
      await db.query(
        'UPDATE marketing_profiles SET visit_count = visit_count + 1 WHERE id = ?',
        [profile.profile_id]
      );
    }

    // 记录访问日志
    try {
      await db.query(
        'INSERT INTO marketing_visits (profile_id, visitor_ip, referer, user_agent) VALUES (?, ?, ?, ?)',
        [profile.profile_id, getClientIp(req), req.get('referer') || '', req.get('user-agent') || '']
      );
    } catch (logErr) {
      console.error('记录访问日志失败:', logErr);
    }

    res.json({
      success: true,
      data: profile
    });
  } catch (err) {
    console.error('获取营销资料失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 更新当前用户的营销资料
 * PUT /api/marketing/profile
 */
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { display_name, bio, avatar_url, cover_image, wechat_qq, phone, email, custom_links, is_public, bound_avatar_id, custom_service_link, custom_menu } = req.body;

    // 验证自定义链接格式
    let parsedLinks = custom_links;
    if (typeof custom_links === 'string') {
      try {
        parsedLinks = JSON.parse(custom_links);
      } catch (e) {
        return res.status(400).json({ error: '自定义链接格式错误' });
      }
    }

    // 验证自定义菜单格式
    let parsedMenu = custom_menu;
    if (typeof custom_menu === 'string') {
      try {
        parsedMenu = JSON.parse(custom_menu);
      } catch (e) {
        parsedMenu = [];
      }
    }

    // 检查是否已存在资料
    const existing = await db.query(
      'SELECT id FROM marketing_profiles WHERE user_id = ?',
      [userId]
    );

    if (existing.length > 0) {
      // 更新
      // 注意：bound_avatar_id 需要特殊处理，允许设置为 null
      let boundAvatarIdValue = bound_avatar_id;
      if (bound_avatar_id === '' || bound_avatar_id === undefined) {
        boundAvatarIdValue = null;
      }

      await db.query(
        `UPDATE marketing_profiles SET
          display_name = COALESCE(?, display_name),
          bio = COALESCE(?, bio),
          avatar_url = COALESCE(?, avatar_url),
          cover_image = COALESCE(?, cover_image),
          wechat_qq = COALESCE(?, wechat_qq),
          phone = COALESCE(?, phone),
          email = COALESCE(?, email),
          custom_links = COALESCE(?, custom_links),
          custom_menu = COALESCE(?, custom_menu),
          is_public = COALESCE(?, is_public),
          bound_avatar_id = ?,
          custom_service_link = ?
        WHERE user_id = ?`,
        [
          display_name || null,
          bio || null,
          avatar_url || null,
          cover_image || null,
          wechat_qq || null,
          phone || null,
          email || null,
          parsedLinks ? JSON.stringify(parsedLinks) : null,
          parsedMenu ? JSON.stringify(parsedMenu) : null,
          is_public !== undefined ? (is_public ? 1 : 0) : null,
          boundAvatarIdValue,
          custom_service_link || null,
          userId
        ]
      );
    } else {
      // 创建
      await db.query(
        `INSERT INTO marketing_profiles (user_id, display_name, bio, avatar_url, cover_image, wechat_qq, phone, email, custom_links, custom_menu, is_public, bound_avatar_id, custom_service_link)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          display_name || req.user.username,
          bio || '',
          avatar_url || '',
          cover_image || '',
          wechat_qq || '',
          phone || '',
          email || '',
          parsedLinks ? JSON.stringify(parsedLinks) : '[]',
          parsedMenu ? JSON.stringify(parsedMenu) : '[]',
          is_public !== undefined ? (is_public ? 1 : 0) : 1,
          bound_avatar_id || null,
          custom_service_link || ''
        ]
      );
    }

    const profile = await getMarketingProfile(userId);
    
    res.json({
      success: true,
      data: profile,
      message: '营销资料已更新'
    });
  } catch (err) {
    console.error('更新营销资料失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 上传营销头像
 * POST /api/marketing/avatar-upload
 */

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的图片格式'));
    }
  }
});

router.post('/avatar-upload', authenticateToken, uploadAvatar.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择图片文件' });
    }

    // 上传到OSS
    const userId = req.user.id;
    const ext = path.extname(req.file.originalname);
    const objectName = `marketing/avatars/${userId}_${Date.now()}${ext}`;

    const result = await oss.uploadBuffer(objectName, req.file.buffer, {
      contentType: req.file.mimetype
    });

    const avatarUrl = (config.oss?.accelerateDomain || 'https://boke.skym178.com') + '/' + objectName;

    res.json({
      success: true,
      data: { avatar_url: avatarUrl },
      message: '头像上传成功'
    });
  } catch (err) {
    console.error('头像上传失败:', err);
    res.status(500).json({ error: '上传失败' });
  }
});

/**
 * 上传营销封面图
 * POST /api/marketing/cover-upload
 */
const uploadCover = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的图片格式'));
    }
  }
});

router.post('/cover-upload', authenticateToken, uploadCover.single('cover'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择图片文件' });
    }

    // 上传到OSS
    const userId = req.user.id;
    const ext = path.extname(req.file.originalname);
    const objectName = `marketing/covers/${userId}_${Date.now()}${ext}`;

    const result = await oss.uploadBuffer(objectName, req.file.buffer, {
      contentType: req.file.mimetype
    });

    const coverUrl = (config.oss?.accelerateDomain || 'https://boke.skym178.com') + '/' + objectName;

    res.json({
      success: true,
      data: { cover_image: coverUrl },
      message: '封面上传成功'
    });
  } catch (err) {
    console.error('封面上传失败:', err);
    res.status(500).json({ error: '上传失败' });
  }
});

/**
 * 上传媒体图片（相册用）
 * POST /api/marketing/media-image-upload
 */
const uploadMediaImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的图片格式'));
    }
  }
});

router.post('/media-image-upload', authenticateToken, uploadMediaImage.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择图片文件' });
    }

    // 上传到OSS
    const userId = req.user.id;
    const ext = path.extname(req.file.originalname);
    const objectName = `marketing/media-images/${userId}_${Date.now()}${ext}`;

    const result = await oss.uploadBuffer(objectName, req.file.buffer, {
      contentType: req.file.mimetype
    });

    const imageUrl = (config.oss?.accelerateDomain || 'https://boke.skym178.com') + '/' + objectName;

    res.json({
      success: true,
      data: { image_url: imageUrl },
      message: '图片上传成功'
    });
  } catch (err) {
    console.error('媒体图片上传失败:', err);
    res.status(500).json({ error: '上传失败' });
  }
});

/**
 * 上传媒体视频（相册用）
 * POST /api/marketing/media-video-upload
 */
const uploadMediaVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.webm', '.ogg', '.mov', '.avi'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的视频格式'));
    }
  }
});

router.post('/media-video-upload', authenticateToken, uploadMediaVideo.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择视频文件' });
    }

    // 上传到OSS
    const userId = req.user.id;
    const ext = path.extname(req.file.originalname);
    const objectName = `marketing/media-videos/${userId}_${Date.now()}${ext}`;

    const result = await oss.uploadBuffer(objectName, req.file.buffer, {
      contentType: req.file.mimetype
    });

    const videoUrl = (config.oss?.accelerateDomain || 'https://boke.skym178.com') + '/' + objectName;

    res.json({
      success: true,
      data: { video_url: videoUrl },
      message: '视频上传成功'
    });
  } catch (err) {
    console.error('媒体视频上传失败:', err);
    res.status(500).json({ error: '上传失败' });
  }
});

/**
 * 获取STS临时访问凭证（用于浏览器直传OSS）
 * GET /api/marketing/get-sts-token
 */
router.get('/get-sts-token', authenticateToken, async (req, res) => {
  try {
    const token = await oss.getSTSToken();
    token.customDomain = 'https://boke.skym178.com';
    token.accelerateDomain = token.accelerateDomain || 'oss-accelerate.aliyuncs.com';
    token.useAccelerate = token.useAccelerate === true;
    res.json({
      success: true,
      data: token
    });
  } catch (err) {
    console.error('获取STS凭证失败:', err);
    res.status(500).json({ error: '获取STS凭证失败: ' + err.message });
  }
});

/**
 * 获取指定用户的帖子列表
 * GET /api/marketing/posts/:userId
 */
router.get('/posts/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const coll = await mongo.getPlazaPostsCollection();
    const query = { userId, isDeleted: false };

    const posts = await coll
      .find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    const total = await coll.countDocuments(query);

    const processedPosts = posts.map(post => {
      // 优先使用images字段的图片，否则从content中提取
      const coverImage = (post.images && post.images.length > 0)
        ? post.images[0]
        : extractFirstImageFromContent(post.content);

      return {
        post_id: post._id.toString(),
        user_id: post.userId,
        username: post.username || '',
        title: post.title,
        content: post.content,
        images: post.images || [],
        cover_image: coverImage, // 封面图：优先使用images，否则从content提取
        likes_count: post.likesCount || 0,
        comments_count: post.commentsCount || 0,
        views_count: post.viewsCount || 0,
        created_at: post.createdAt
      };
    });

    res.json({
      success: true,
      data: {
        posts: processedPosts,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('获取用户帖子失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取指定用户的播客列表
 * GET /api/marketing/podcasts/:userId
 */
router.get('/podcasts/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    const podcastsColl = await mongo.getPodcastPodcastsCollection();
    const query = { author_id: userId, status: { $ne: 'deleted' } };

    const podcasts = await podcastsColl
      .find(query)
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    const total = await podcastsColl.countDocuments(query);

    const processedPodcasts = podcasts.map(podcast => ({
      podcast_id: podcast.podcast_id,
      title: podcast.title,
      description: podcast.description,
      cover_url: podcast.cover_url || podcast.cover_image || '',
      author_id: podcast.author_id,
      author_name: podcast.author_name,
      category: podcast.category || '',
      tags: podcast.tags || [],
      episode_count: podcast.episode_count || podcast.episodes_count || 0,
      subscriber_count: podcast.subscriber_count || 0,
      total_plays: podcast.total_plays || 0,
      likes_count: podcast.likes_count || 0,
      created_at: podcast.created_at
    }));

    res.json({
      success: true,
      data: {
        podcasts: processedPodcasts,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('获取用户播客失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取用户统计数据
 * GET /api/marketing/stats/:userId
 */
router.get('/stats/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);

    // 获取用户基本信息
    const [user] = await db.query(
      'SELECT id, username, energy, total_energy, referral_count, wins, losses, draws FROM users WHERE id = ?',
      [userId]
    );

    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // 获取帖子数量
    const postsColl = await mongo.getPlazaPostsCollection();
    const postsCount = await postsColl.countDocuments({ userId, isDeleted: false });

    // 获取播客数量
    const podcastsColl = await mongo.getPodcastPodcastsCollection();
    const podcastsCount = await podcastsColl.countDocuments({ author_id: userId, status: { $ne: 'deleted' } });

    // 获取评论数量
    const commentsColl = await mongo.getPlazaCommentsCollection();
    const commentsCount = await commentsColl.countDocuments({ userId });

    res.json({
      success: true,
      data: {
        user_id: user.id,
        username: user.username,
        energy: Math.max(0, user.energy || 0),
        total_energy: Math.max(0, user.total_energy || 0),
        referral_count: user.referral_count || 0,
        wins: user.wins || 0,
        losses: user.losses || 0,
        draws: user.draws || 0,
        posts_count: postsCount,
        podcasts_count: podcastsCount,
        comments_count: commentsCount
      }
    });
  } catch (err) {
    console.error('获取用户统计失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 记录访问
 * POST /api/marketing/visit/:profileId
 */
router.post('/visit/:profileId', async (req, res) => {
  try {
    const profileId = parseInt(req.params.profileId);

    await db.query(
      'INSERT INTO marketing_visits (profile_id, visitor_ip, referer, user_agent) VALUES (?, ?, ?, ?)',
      [profileId, getClientIp(req), req.get('referer') || '', req.get('user-agent') || '']
    );

    await db.query(
      'UPDATE marketing_profiles SET visit_count = visit_count + 1 WHERE id = ?',
      [profileId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('记录访问失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取用户的AI分身列表（用于绑定在线客服）
 * GET /api/marketing/avatars
 */
router.get('/avatars', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // AI分身存储在MySQL表 ai_agent_avatars 中
    const avatars = await db.query(
      `SELECT avatar_id, name, avatar_url, status FROM ai_agent_avatars
       WHERE user_id = ? AND status != 'inactive'
       ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );

    const processedAvatars = avatars.map(avatar => ({
      avatar_id: avatar.avatar_id,
      name: avatar.name,
      avatar_url: avatar.avatar_url,
      status: avatar.status
    }));

    res.json({
      success: true,
      data: processedAvatars
    });
  } catch (err) {
    console.error('获取AI分身列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取分身客服链接
 * GET /api/marketing/avatar-link/:avatarId
 */
router.get('/avatar-link/:avatarId', authenticateToken, async (req, res) => {
  try {
    const { avatarId } = req.params;
    const userId = req.user.id;

    // 验证分身归属
    const avatars = await db.query(
      'SELECT * FROM ai_agent_avatars WHERE avatar_id = ? AND user_id = ?',
      [parseInt(avatarId), userId]
    );
    if (avatars.length === 0) {
      return res.status(404).json({ error: '分身不存在' });
    }

    // 查询有效链接
    let links = await db.query(
      'SELECT * FROM ai_agent_links WHERE avatar_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1',
      [parseInt(avatarId)]
    );

    // 如果没有有效链接，自动生成
    if (links.length === 0) {
      const linkToken = require('crypto').randomBytes(16).toString('hex');
      await db.query(
        `INSERT INTO ai_agent_links (avatar_id, link_token, link_name, is_active) VALUES (?, ?, ?, 1)`,
        [parseInt(avatarId), linkToken, '营销页面客服链接']
      );
      links = await db.query(
        'SELECT * FROM ai_agent_links WHERE avatar_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1',
        [parseInt(avatarId)]
      );
    }

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const link = links[0];
    const fullLink = `${baseUrl}/agent/chat/${avatarId}?token=${link.link_token}`;

    res.json({ success: true, data: { link: fullLink } });
  } catch (err) {
    console.error('[marketing] 获取客服链接失败:', err);
    res.status(500).json({ error: '获取客服链接失败' });
  }
});

// ========== 辅助函数 ==========

/**
 * 获取用户营销资料
 * @param {number} userId - 用户ID
 * @returns {Promise<Object>}
 */
async function getMarketingProfile(userId) {
  // 获取MySQL营销资料
  const profiles = await db.query(
    'SELECT * FROM marketing_profiles WHERE user_id = ?',
    [userId]
  );

  const profile = profiles[0] || {};

  // 获取用户基本信息
  const [user] = await db.query(
    'SELECT id, username, avatar_image, avatar_color, referral_code FROM users WHERE id = ?',
    [userId]
  );

  if (!user) {
    return null;
  }

  // 获取帖子数量
  const postsColl = await mongo.getPlazaPostsCollection();
  const postsCount = await postsColl.countDocuments({ userId, isDeleted: false });

  // 获取播客数量
  const podcastsColl = await mongo.getPodcastPodcastsCollection();
  const podcastsCount = await podcastsColl.countDocuments({ author_id: userId, status: { $ne: 'deleted' } });

  // 处理自定义链接
  let customLinks = [];
  if (profile.custom_links) {
    try {
      customLinks = typeof profile.custom_links === 'string'
        ? JSON.parse(profile.custom_links)
        : profile.custom_links;
    } catch (e) {
      customLinks = [];
    }
  }

    // 处理媒体图片
    let mediaImages = [];
    if (profile.media_images) {
      try {
        mediaImages = typeof profile.media_images === 'string'
          ? JSON.parse(profile.media_images)
          : profile.media_images;
      } catch (e) {
        mediaImages = [];
      }
    }

    // 检查是否有AI分身
    let hasAiAgent = false;
    let boundAvatarId = profile.bound_avatar_id || null;
    try {
      const avatarsColl = await mongo.getAgentAvatarsCollection();
      const avatarCount = await avatarsColl.countDocuments({ user_id: userId, status: { $ne: 'inactive' } });
      hasAiAgent = avatarCount > 0;
    } catch (e) {
      hasAiAgent = false;
    }

    return {
      profile_id: profile.id || null,
      user_id: user.id,
      username: user.username,
      display_name: profile.display_name || user.username,
      bio: profile.bio || '',
      avatar_url: profile.avatar_url || user.avatar_image || `/api/user/avatar/${userId}`,
      cover_image: profile.cover_image || '',
      wechat_qq: profile.wechat_qq || '',
      phone: profile.phone || '',
      email: profile.email || '',
      custom_links: customLinks,
      is_public: profile.is_public !== 0,
      visit_count: profile.visit_count || 0,
      has_ai_agent: hasAiAgent,
      bound_avatar_id: boundAvatarId,
      custom_service_link: profile.custom_service_link || '',
      referral_code: user.referral_code || '',
      // 媒体图片和视频
      media_images: mediaImages,
      media_video: profile.media_video || '',
      // 统计数据
      posts_count: postsCount,
      podcasts_count: podcastsCount,
      // 用户头像颜色
      avatar_color: user.avatar_color || '#4F46E5',
      created_at: profile.created_at || user.created_at
    };
  }

/**
 * 生成营销海报（服务端渲染）
 * GET /api/marketing/poster/:userId
 */
router.get('/poster/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!userId || isNaN(userId)) {
      return res.status(400).json({ error: '无效的用户ID' });
    }

    // 获取用户资料
    const profile = await getMarketingProfile(userId);
    if (!profile) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // 生成推广链接
    let link = '';
    if (profile.referral_code) {
      link = `${req.protocol}://${req.get('host')}/m/${profile.referral_code}`;
    } else {
      link = `${req.protocol}://${req.get('host')}/marketing/${userId}`;
    }

    // 使用 QRServer API 生成二维码
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(link)}`;

    // 补全头像和封面URL为完整URL
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    let avatarUrl = profile.avatar_url;
    let coverUrl = profile.cover_image;

    // 如果头像是相对路径，补全为完整URL
    if (avatarUrl && !avatarUrl.startsWith('http')) {
        avatarUrl = avatarUrl.startsWith('/') ? baseUrl + avatarUrl : baseUrl + '/' + avatarUrl;
    }

    // 如果封面是相对路径，补全为完整URL
    if (coverUrl && !coverUrl.startsWith('http')) {
        coverUrl = coverUrl.startsWith('/') ? baseUrl + coverUrl : baseUrl + '/' + coverUrl;
    }

    // 获取头像和封面图片的 Base64
    let avatarBase64 = null;
    let coverBase64 = null;

    try {
      // 获取头像
      if (avatarUrl) {
        const avatarRes = await fetch(avatarUrl);
        if (avatarRes.ok) {
            const avatarBuffer = await avatarRes.arrayBuffer();
            avatarBase64 = Buffer.from(avatarBuffer).toString('base64');
        }
      }
    } catch (e) {
      console.error('获取头像失败:', e.message);
    }

    try {
      // 获取封面图片
      if (coverUrl) {
        const coverRes = await fetch(coverUrl);
        if (coverRes.ok) {
            const coverBuffer = await coverRes.arrayBuffer();
            coverBase64 = Buffer.from(coverBuffer).toString('base64');
        }
      }
    } catch (e) {
      console.error('获取封面失败:', e.message);
    }

    // 返回海报数据
    res.json({
      success: true,
      data: {
        avatar: avatarBase64 ? `data:image/jpeg;base64,${avatarBase64}` : null,
        cover: coverBase64 ? `data:image/jpeg;base64,${coverBase64}` : null,
        display_name: profile.display_name,
        bio: profile.bio,
        qrcode: qrCodeUrl,
        link: link
      }
    });
  } catch (err) {
    console.error('生成海报失败:', err);
    res.status(500).json({ error: '生成海报失败' });
  }
});

// ========== 视频管理API ==========

const cache = require('../utils/cache');

/**
 * 获取当前用户的视频列表
 * GET /api/marketing/videos
 */
router.get('/videos', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 获取用户点赞的视频ID列表
    const likedVideoIds = await mongo.getUserLikedVideoIds(userId);

    const videos = await cache.getUserVideoList(userId, likedVideoIds);

    res.json({
      success: true,
      data: videos
    });
  } catch (err) {
    console.error('获取视频列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取指定用户的公开视频列表
 * GET /api/marketing/videos/user/:userId
 */
router.get('/videos/user/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) {
      return res.status(400).json({ error: '无效的用户ID' });
    }

    // 检查当前用户是否登录，获取点赞状态
    let likedVideoIds = [];
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, JWT_SECRET);
        const currentUserId = decoded.userId;
        likedVideoIds = await mongo.getUserLikedVideoIds(currentUserId);
      } catch (e) {
        // Token无效，继续以游客身份访问
      }
    }

    const videos = await mongo.getMarketingVideosByUser(userId, { limit: 50 });
    const formattedVideos = (videos.videos || []).map(v => {
      const video = {
        video_id: v.video_id,
        user_id: v.user_id,
        title: v.title,
        description: v.description,
        cover_image: v.cover_image,
        video_url: v.video_url,
        duration: v.duration || 0,
        views_count: v.views_count || 0,
        likes_count: v.likes_count || 0,
        comments_count: v.comments_count || 0,
        created_at: v.created_at,
        updated_at: v.updated_at
      };
      // 添加点赞状态
      if (likedVideoIds.length > 0) {
        video.is_liked = likedVideoIds.includes(v.video_id);
      }
      return video;
    });

    res.json({
      success: true,
      data: formattedVideos
    });
  } catch (err) {
    console.error('获取用户视频列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取视频详情
 * GET /api/marketing/videos/:videoId
 */
router.get('/videos/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const authHeader = req.headers.authorization;
    let isLiked = false;
    let isOwner = false;

    // 检查登录状态
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;

        // 获取视频详情
        const video = await cache.getVideoDetail(videoId);

        if (!video) {
          return res.status(404).json({ error: '视频不存在' });
        }

        // 检查是否点赞
        isLiked = await mongo.isVideoLiked(videoId, userId);

        // 检查是否是视频所有者
        isOwner = video.user_id === userId;
      } catch (e) {
        // Token无效，继续以游客身份访问
      }
    }

    const video = await cache.getVideoDetail(videoId);

    if (!video) {
      return res.status(404).json({ error: '视频不存在' });
    }

    // 直接增加观看次数到MongoDB
    try {
      await mongo.incrementVideoViews(videoId, 1);
      // 清除缓存，让下次请求获取最新数据
      await cache.clearVideoCache(videoId, null);
    } catch (err) {
      console.error('增加观看次数失败:', err);
    }

    // 添加点赞状态
    const result = {
      ...video,
      is_liked: isLiked,
      is_owner: isOwner
    };

    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    console.error('获取视频详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取热门视频
 * GET /api/marketing/videos/hot
 */
router.get('/videos/hot', async (req, res) => {
  try {
    const videos = await cache.getHotVideos();

    res.json({
      success: true,
      data: videos
    });
  } catch (err) {
    console.error('获取热门视频失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取相关视频（同一用户的其他视频）
 * GET /api/marketing/videos/:videoId/related
 */
router.get('/videos/:videoId/related', async (req, res) => {
  try {
    const { videoId } = req.params;
    const limit = parseInt(req.query.limit) || 5;

    // 获取视频详情
    const video = await mongo.getMarketingVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: '视频不存在' });
    }

    // 获取同一用户的其他视频
    const result = await mongo.getMarketingVideosByUser(video.user_id, { limit: limit + 1 });

    // 过滤掉当前视频
    const relatedVideos = (result.videos || [])
      .filter(v => v.video_id !== videoId)
      .slice(0, limit);

    const formattedVideos = relatedVideos.map(v => ({
      video_id: v.video_id,
      user_id: v.user_id,
      title: v.title,
      cover_image: v.cover_image,
      video_url: v.video_url,
      duration: v.duration || 0,
      views_count: v.views_count || 0,
      created_at: v.created_at
    }));

    res.json({
      success: true,
      data: formattedVideos
    });
  } catch (err) {
    console.error('获取相关视频失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 发布视频
 * POST /api/marketing/videos
 */
router.post('/videos', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { title, description, cover_image, video_url, duration, custom_menu } = req.body;

    if (!title || !video_url) {
      return res.status(400).json({ error: '标题和视频URL不能为空' });
    }

    // 解析自定义菜单
    let parsedMenu = [];
    if (custom_menu) {
      try {
        parsedMenu = typeof custom_menu === 'string' ? JSON.parse(custom_menu) : custom_menu;
      } catch (e) {
        parsedMenu = [];
      }
    }

    // 从用户信息获取用户名和头像
    const user = req.user;

    // 创建视频
    const videoId = await mongo.createMarketingVideo({
      user_id: userId,
      title,
      description: description || '',
      cover_image: cover_image || '',
      video_url,
      duration: parseInt(duration) || 0,
      custom_menu: parsedMenu
    });

    // 清除用户视频列表缓存
    await cache.clearVideoCache(null, userId);

    res.json({
      success: true,
      data: {
        video_id: videoId,
        message: '视频发布成功'
      }
    });
  } catch (err) {
    console.error('发布视频失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 更新视频
 * PUT /api/marketing/videos/:videoId
 */
router.put('/videos/:videoId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { videoId } = req.params;
    const { title, description, cover_image, video_url, duration, custom_menu } = req.body;

    // 验证视频所有权
    const video = await mongo.getMarketingVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: '视频不存在' });
    }
    if (video.user_id !== userId) {
      return res.status(403).json({ error: '无权限修改此视频' });
    }

    // 解析自定义菜单
    let parsedMenu = null;
    if (custom_menu) {
      try {
        parsedMenu = typeof custom_menu === 'string' ? JSON.parse(custom_menu) : custom_menu;
      } catch (e) {
        parsedMenu = null;
      }
    }

    // 更新视频
    const updates = {};
    if (title) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (cover_image !== undefined) updates.cover_image = cover_image;
    if (video_url) updates.video_url = video_url;
    if (duration) updates.duration = parseInt(duration);
    if (parsedMenu !== null) updates.custom_menu = parsedMenu;

    await mongo.updateMarketingVideo(videoId, updates);

    // 清除缓存
    await cache.clearVideoCache(videoId, userId);

    res.json({
      success: true,
      message: '视频更新成功'
    });
  } catch (err) {
    console.error('更新视频失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 删除视频
 * DELETE /api/marketing/videos/:videoId
 */
router.delete('/videos/:videoId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { videoId } = req.params;

    // 验证视频所有权
    const video = await mongo.getMarketingVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: '视频不存在' });
    }
    if (video.user_id !== userId) {
      return res.status(403).json({ error: '无权限删除此视频' });
    }

    // 软删除视频
    await mongo.deleteMarketingVideo(videoId, userId);

    // 清除缓存
    await cache.clearVideoCache(videoId, userId);

    res.json({
      success: true,
      message: '视频删除成功'
    });
  } catch (err) {
    console.error('删除视频失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 点赞/取消点赞视频
 * POST /api/marketing/videos/:videoId/like
 */
router.post('/videos/:videoId/like', authenticateToken, async (req, res) => {
  try {
    const { videoId } = req.params;
    const userId = req.user.id;

    const video = await mongo.getMarketingVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: '视频不存在' });
    }

    // 检查是否已经点赞
    const alreadyLiked = await mongo.isVideoLiked(videoId, userId);

    if (alreadyLiked) {
      // 取消点赞
      await mongo.unlikeVideo(videoId, userId);
      await mongo.incrementVideoLikes(videoId, -1); // 减少点赞数

      // 清除缓存
      await cache.clearVideoCache(videoId, video.user_id);

      res.json({
        success: true,
        data: { liked: false },
        message: '取消点赞成功'
      });
    } else {
      // 点赞
      await mongo.likeVideo(videoId, userId);
      await mongo.incrementVideoLikes(videoId, 1); // 增加点赞数

      // 清除缓存
      await cache.clearVideoCache(videoId, video.user_id);

      res.json({
        success: true,
        data: { liked: true },
        message: '点赞成功'
      });
    }
  } catch (err) {
    console.error('点赞操作失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ========== 视频评论API ==========

/**
 * 获取视频评论列表
 * GET /api/marketing/videos/:videoId/comments
 */
router.get('/videos/:videoId/comments', async (req, res) => {
  try {
    const { videoId } = req.params;

    const comments = await cache.getVideoCommentList(videoId);

    res.json({
      success: true,
      data: comments
    });
  } catch (err) {
    console.error('获取评论列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 发表评论
 * POST /api/marketing/videos/:videoId/comments
 */
router.post('/videos/:videoId/comments', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { videoId } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: '评论内容不能为空' });
    }

    // 验证视频存在
    const video = await mongo.getMarketingVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: '视频不存在' });
    }

    // 获取用户信息
    const user = req.user;

    // 添加评论
    await mongo.addVideoComment({
      video_id: videoId,
      user_id: userId,
      username: user.username,
      avatar_url: user.avatar_image || '',
      content: content.trim()
    });

    // 清除评论缓存
    await cache.clearVideoCache(videoId, null);

    res.json({
      success: true,
      message: '评论成功'
    });
  } catch (err) {
    console.error('发表评论失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 删除评论
 * DELETE /api/marketing/comments/:commentId
 */
router.delete('/comments/:commentId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { commentId } = req.params;

    const result = await mongo.deleteVideoComment(commentId, userId);

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: '评论不存在或无权限删除' });
    }

    // 清除评论缓存（需要获取视频ID）
    // 这里简化处理，清除所有相关缓存
    await cache.clearVideoCache(null, null);

    res.json({
      success: true,
      message: '评论删除成功'
    });
  } catch (err) {
    console.error('删除评论失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;

// ========== 管理员API（需要导入 requireAdmin） ==========

/**
 * 获取营销页面列表（管理员）
 * GET /api/marketing/admin/list
 */
router.get('/admin/list', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || '';
    const isPublic = req.query.is_public;

    let where = '1=1';
    const params = [];

    if (search) {
      where += ' AND (u.username LIKE ? OR mp.display_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    if (isPublic !== undefined && isPublic !== '') {
      where += ' AND mp.is_public = ?';
      params.push(parseInt(isPublic));
    }

    // 获取总数
    const countSql = `
      SELECT COUNT(*) as total
      FROM marketing_profiles mp
      LEFT JOIN users u ON mp.user_id = u.id
      WHERE ${where}
    `;
    const [countResult] = await db.query(countSql, params);
    const total = countResult.total;

    // 获取列表
    const sql = `
      SELECT mp.*, u.username
      FROM marketing_profiles mp
      LEFT JOIN users u ON mp.user_id = u.id
      WHERE ${where}
      ORDER BY mp.created_at DESC
      LIMIT ? OFFSET ?
    `;

    params.push(limit, (page - 1) * limit);
    const profiles = await db.query(sql, params);

    // 单独获取帖子数和播客数
    for (const profile of profiles) {
      try {
        const postsColl = await mongo.getPlazaPostsCollection();
        profile.posts_count = await postsColl.countDocuments({ userId: profile.user_id, isDeleted: false });
      } catch (e) {
        profile.posts_count = 0;
      }
      try {
        const podcastsColl = await mongo.getPodcastPodcastsCollection();
        profile.podcasts_count = await podcastsColl.countDocuments({ author_id: profile.user_id, status: { $ne: 'deleted' } });
      } catch (e) {
        profile.podcasts_count = 0;
      }
    }

    const processedProfiles = profiles.map(p => {
      // 解析JSON字段
      let mediaImages = [];
      try {
        mediaImages = p.media_images ? JSON.parse(p.media_images) : [];
      } catch (e) {
        mediaImages = [];
      }

      return {
        id: p.id,
        user_id: p.user_id,
        username: p.username || '',
        display_name: p.display_name || p.username || '',
        bio: p.bio || '',
        avatar_url: p.avatar_url || '',
        cover_image: p.cover_image || '',
        wechat_qq: p.wechat_qq || '',
        phone: p.phone || '',
        email: p.email || '',
        is_public: p.is_public === 1,
        visit_count: p.visit_count || 0,
        posts_count: p.posts_count || 0,
        podcasts_count: p.podcasts_count || 0,
        media_images: mediaImages,
        media_video: p.media_video || '',
        custom_service_link: p.custom_service_link || '',
        created_at: p.created_at,
        updated_at: p.updated_at
      };
    });

    res.json({
      success: true,
      data: {
        profiles: processedProfiles,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('获取营销页面列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取营销页面详情（管理员）
 * GET /api/marketing/admin/:id
 */
router.get('/admin/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: '无效的ID' });
    }

    const [profile] = await db.query(
      'SELECT * FROM marketing_profiles WHERE id = ?',
      [id]
    );

    if (!profile) {
      return res.status(404).json({ error: '营销页面不存在' });
    }

    // 获取用户名
    const [user] = await db.query(
      'SELECT username, avatar_color, referral_code FROM users WHERE id = ?',
      [profile.user_id]
    );

    // 解析JSON字段
    let customLinks = [];
    let mediaImages = [];
    try {
      customLinks = profile.custom_links ? JSON.parse(profile.custom_links) : [];
    } catch (e) {
      customLinks = [];
    }
    try {
      mediaImages = profile.media_images ? JSON.parse(profile.media_images) : [];
    } catch (e) {
      mediaImages = [];
    }

    res.json({
      success: true,
      data: {
        id: profile.id,
        user_id: profile.user_id,
        username: user?.username || '',
        display_name: profile.display_name || user?.username || '',
        bio: profile.bio || '',
        avatar_url: profile.avatar_url || '',
        cover_image: profile.cover_image || '',
        wechat_qq: profile.wechat_qq || '',
        phone: profile.phone || '',
        email: profile.email || '',
        custom_links: customLinks,
        is_public: profile.is_public === 1,
        visit_count: profile.visit_count || 0,
        bound_avatar_id: profile.bound_avatar_id,
        custom_service_link: profile.custom_service_link || '',
        referral_code: user?.referral_code || '',
        avatar_color: user?.avatar_color || '#4F46E5',
        media_images: mediaImages,
        media_video: profile.media_video || '',
        created_at: profile.created_at,
        updated_at: profile.updated_at
      }
    });
  } catch (err) {
    console.error('获取营销页面详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 更新营销页面（管理员）
 * PUT /api/marketing/admin/:id
 */
router.put('/admin/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: '无效的ID' });
    }

    const { display_name, bio, avatar_url, cover_image, wechat_qq, phone, email, custom_links, is_public, bound_avatar_id, custom_service_link } = req.body;

    // 验证是否存在
    const [existing] = await db.query('SELECT id FROM marketing_profiles WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: '营销页面不存在' });
    }

    // 更新
    await db.query(
      `UPDATE marketing_profiles SET
        display_name = COALESCE(?, display_name),
        bio = COALESCE(?, bio),
        avatar_url = COALESCE(?, avatar_url),
        cover_image = COALESCE(?, cover_image),
        wechat_qq = COALESCE(?, wechat_qq),
        phone = COALESCE(?, phone),
        email = COALESCE(?, email),
        custom_links = COALESCE(?, custom_links),
        is_public = COALESCE(?, is_public),
        bound_avatar_id = COALESCE(?, bound_avatar_id),
        custom_service_link = COALESCE(?, custom_service_link)
      WHERE id = ?`,
      [
        display_name || null,
        bio || null,
        avatar_url || null,
        cover_image || null,
        wechat_qq || null,
        phone || null,
        email || null,
        custom_links ? JSON.stringify(custom_links) : null,
        is_public !== undefined ? (is_public ? 1 : 0) : null,
        bound_avatar_id || null,
        custom_service_link || null,
        id
      ]
    );

    res.json({
      success: true,
      message: '营销页面已更新'
    });
  } catch (err) {
    console.error('更新营销页面失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 切换营销页面公开状态（管理员）
 * PUT /api/marketing/admin/:id/toggle
 */
router.put('/admin/:id/toggle', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: '无效的ID' });
    }

    const [profile] = await db.query('SELECT is_public FROM marketing_profiles WHERE id = ?', [id]);
    if (!profile) {
      return res.status(404).json({ error: '营销页面不存在' });
    }

    const newStatus = profile.is_public === 1 ? 0 : 1;
    await db.query('UPDATE marketing_profiles SET is_public = ? WHERE id = ?', [newStatus, id]);

    res.json({
      success: true,
      data: { is_public: newStatus === 1 },
      message: newStatus === 1 ? '已公开' : '已禁用'
    });
  } catch (err) {
    console.error('切换公开状态失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 删除营销页面（管理员）
 * DELETE /api/marketing/admin/:id
 */
router.delete('/admin/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: '无效的ID' });
    }

    const result = await db.query('DELETE FROM marketing_profiles WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '营销页面不存在' });
    }

    // 删除访问记录
    await db.query('DELETE FROM marketing_visits WHERE profile_id = ?', [id]);

    res.json({
      success: true,
      message: '营销页面已删除'
    });
  } catch (err) {
    console.error('删除营销页面失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取访问记录（管理员）
 * GET /api/marketing/admin/:id/visits
 */
router.get('/admin/:id/visits', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;

    if (!id || isNaN(id)) {
      return res.status(400).json({ error: '无效的ID' });
    }

    // 验证营销页面存在
    const [profile] = await db.query('SELECT id FROM marketing_profiles WHERE id = ?', [id]);
    if (!profile) {
      return res.status(404).json({ error: '营销页面不存在' });
    }

    // 获取总数
    const [countResult] = await db.query(
      'SELECT COUNT(*) as total FROM marketing_visits WHERE profile_id = ?',
      [id]
    );
    const total = countResult.total;

    // 获取记录
    const visits = await db.query(
      `SELECT * FROM marketing_visits WHERE profile_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [id, limit, (page - 1) * limit]
    );

    res.json({
      success: true,
      data: {
        visits: visits.map(v => ({
          id: v.id,
          visitor_ip: v.visitor_ip || '',
          referer: v.referer || '',
          user_agent: v.user_agent || '',
          created_at: v.created_at
        })),
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('获取访问记录失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});
