/**
 * @file podcast.js
 * @module routes/podcast
 * @description 播客功能 - 播客、剧集、订阅、评论、点赞功能 (MongoDB + Redis)
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const QRCode = require('qrcode');
const mongo = require('../utils/mongo');
const redis = require('../utils/redis');
const db = require('../utils/db');
const messageQueue = require('../services/message-queue');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const socketServer = require('../socket');
const oss = require('../utils/oss');

// 确保上传目录存在
const PODCAST_AUDIO_DIR = path.join(__dirname, '../../public/uploads/podcast-audio');
const PODCAST_COVER_DIR = path.join(__dirname, '../../public/uploads/podcast-covers');

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log('创建目录:', dirPath);
    }
}

// 确保目录存在
ensureDir(PODCAST_AUDIO_DIR);
ensureDir(PODCAST_COVER_DIR);

/**
 * 获取服务器基础URL（用于生成代理URL）
 */
async function getServerBaseUrl() {
  let baseUrl = '';
  try {
    const [configRow] = await db.query(
      "SELECT config_value FROM game_config WHERE config_key = 'client_socket_url'"
    );
    if (configRow && configRow.config_value) {
      baseUrl = configRow.config_value.replace(/\/$/, '');
    }
  } catch (err) {
    console.error('获取client_socket_url配置失败:', err.message);
  }
  return baseUrl || 'https://aibotdemo.skym178.com';
}

/**
 * 将 OSS 音频 URL 转换为后端代理路径（用于解决跨域问题）
 * 原始: https://boke.skym178.com/podcast-audio/xxx.mp3
 * 转换后: /api/podcast/audio-proxy/podcast-audio/xxx.mp3
 * 
 * 也支持相对路径格式：
 * 原始: /podcast-audio/xxx.mp3
 * 转换后: /api/podcast/audio-proxy/podcast-audio/xxx.mp3
 */
function convertAudioUrlToProxy(audioUrl) {
  if (!audioUrl) return '';
  
  // 如果已经是相对路径，直接转换为代理路径
  if (audioUrl.startsWith('/podcast-audio/')) {
    return '/api/podcast/audio-proxy' + audioUrl;
  }
  
  // 如果包含 OSS 域名，提取路径并转换
  if (audioUrl.includes('boke.skym178.com')) {
    const urlObj = new URL(audioUrl);
    return '/api/podcast/audio-proxy' + urlObj.pathname;
  }
  
  return audioUrl;
}

// 音频文件存储配置
const audioStorage = multer.diskStorage({
    destination: PODCAST_AUDIO_DIR,
    filename: (req, file, cb) => {
        cb(null, `podcast_${Date.now()}${path.extname(file.originalname)}`);
    }
});
const uploadAudio = multer({
    storage: audioStorage,
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/m4a', 'audio/ogg'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('不支持的音频格式'));
        }
    }
});

// Redis Key 常量
const REDIS_KEYS = {
  PODCAST_LIST: (page, category, keyword) => `podcast:list:${page}:${category || 'all'}:${keyword || 'all'}`,
  PODCAST_DETAIL: (id) => `podcast:detail:${id}`,
  PODCAST_HOT: 'podcast:hot',
  // 高并发计数键
  PODCAST_PLAYS: (episodeId) => `podcast:plays:${episodeId}`,
  PODCAST_LIKES: (targetId, targetType) => `podcast:likes:${targetType}:${targetId}`,
  PODCAST_SUBS: (podcastId) => `podcast:subs:${podcastId}`
};

// 缓存时间（秒）
const CACHE_TTL = {
  PODCAST_LIST: 30,
  PODCAST_DETAIL: 60,
  PODCAST_HOT: 300
};

// 频率限制配置
const RATE_LIMIT = {
  CREATE_PODCAST: { max: 5, window: 3600 },    // 每小时5个播客
  CREATE_EPISODE: { max: 10, window: 3600 },   // 每小时10集
  COMMENT: { max: 30, window: 600 },           // 每10分钟30条
  LIKE: { max: 60, window: 60 }                // 每分钟60次
};

// 播客分类
const PODCAST_CATEGORIES = [
  '科技', '生活', '游戏', '音乐', '教育', '娱乐', '新闻', '健康', '体育', '其他'
];

/**
 * Redis原子递增播放次数（高并发优化）
 */
async function incrementPlayCount(episodeId) {
  try {
    const key = REDIS_KEYS.PODCAST_PLAYS(episodeId);
    const count = await redis.incr(key);
    // 每100次同步到MongoDB
    if (count % 100 === 0) {
      await syncPlayCountToMongo(episodeId, count);
    }
    return count;
  } catch (err) {
    console.error('播放计数失败:', err);
    return 0;
  }
}

/**
 * 同步播放次数到MongoDB
 */
async function syncPlayCountToMongo(episodeId, count) {
  try {
    const episodesColl = await mongo.getPodcastEpisodesCollection();
    await episodesColl.updateOne(
      { episode_id: episodeId },
      { $set: { plays_count: count } }
    );
    console.log(`[Podcast] 播放次数已同步: episode=${episodeId}, count=${count}`);
  } catch (err) {
    console.error('同步播放次数失败:', err);
  }
}

/**
 * 获取播放次数（优先从Redis获取）
 */
async function getPlayCount(episodeId) {
  try {
    const key = REDIS_KEYS.PODCAST_PLAYS(episodeId);
    const count = await redis.get(key);
    return count ? parseInt(count) : null;
  } catch (err) {
    return null;
  }
}

/**
 * 检查频率限制
 */
async function checkRateLimit(userId, type) {
  const config = RATE_LIMIT[type];
  if (!config) return true;

  const key = `podcast:rate:${type}:${userId}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, config.window);
    }
    return count <= config.max;
  } catch (err) {
    console.error('频率检查失败:', err);
    return true; // Redis失败时允许请求
  }
}

/**
 * 获取播客Socket IO实例
 */
function getPodcastIO() {
  try {
    return socketServer.getPlazaIO();
  } catch (err) {
    console.error('获取播客IO失败:', err);
    return null;
  }
}

/**
 * 广播播客事件
 */
function broadcastPodcastEvent(event, data) {
  const podcastIO = getPodcastIO();
  if (podcastIO) {
    podcastIO.to('podcast').emit(event, data);
  }
}

/**
 * 清除播客缓存
 */
async function clearPodcastCache(podcastId = null) {
  try {
    if (podcastId) {
      await redis.del(REDIS_KEYS.PODCAST_DETAIL(podcastId));
    }
    // 清除列表缓存
    const listKeys = await redis.keys('podcast:list:*');
    for (const key of listKeys) {
      await redis.del(key);
    }
    // 清除热门缓存
    await redis.del(REDIS_KEYS.PODCAST_HOT);
  } catch (err) {
    console.error('清除播客缓存失败:', err);
  }
}

/**
 * 生成播客ID
 */
function generatePodcastId() {
  return 'pod_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * 生成剧集ID
 */
function generateEpisodeId() {
  return 'ep_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * 获取播客列表（分页）
 * GET /api/podcast/podcasts?page=1&limit=20&category=xxx&keyword=xxx
 */
router.get('/podcasts', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const category = req.query.category || '';
    const keyword = req.query.keyword || '';
    const skip = (page - 1) * limit;

    const coll = await mongo.getPodcastPodcastsCollection();

    // 构建查询条件
    const query = { status: 'published' };
    if (category) {
      query.category = category;
    }
    if (keyword) {
      query.$text = { $search: keyword };
    }

    // 获取列表和总数
    const [podcasts, total] = await Promise.all([
      coll.find(query).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      coll.countDocuments(query)
    ]);

    // 获取用户订阅状态（如果已登录）
    let subscribedPodcastIds = new Set();
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.replace('Bearer ', '');
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, require('../config/database').JWT_SECRET);
        const subsColl = await mongo.getPodcastSubscriptionsCollection();
        const subs = await subsColl.find({ user_id: decoded.userId }).toArray();
        subscribedPodcastIds = new Set(subs.map(s => s.podcast_id));
      } catch (e) {
        // 忽略认证错误
      }
    }

    // 格式化返回数据
    const data = podcasts.map(p => ({
      podcast_id: p.podcast_id,
      title: p.title,
      description: p.description,
      cover_image: p.cover_image,
      author_id: p.author_id,
      author_name: p.author_name,
      author_avatar: p.author_avatar,
      category: p.category,
      tags: p.tags || [],
      episode_count: p.episode_count || 0,
      subscriber_count: p.subscriber_count || 0,
      views_count: p.total_plays || 0,
      total_plays: p.total_plays || 0,
      likes_count: p.likes_count || 0,
      is_subscribed: subscribedPodcastIds.has(p.podcast_id),
      created_at: p.created_at,
      updated_at: p.updated_at
    }));

    res.json({
      success: true,
      data: {
        podcasts: data,
        total: total,
        page: page,
        limit: limit,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取播客列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取热门播客
 * GET /api/podcast/podcasts/hot
 */
router.get('/podcasts/hot', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;

    // 尝试从缓存获取
    let hotPodcasts = await redis.get(REDIS_KEYS.PODCAST_HOT);
    if (hotPodcasts) {
      try {
        const data = JSON.parse(hotPodcasts);
        // 验证数据格式
        if (Array.isArray(data)) {
          return res.json({
            success: true,
            data: data
          });
        }
        throw new Error('缓存数据格式错误');
      } catch (e) {
        // 缓存数据损坏，清除缓存，重新获取
        console.error('热门播客缓存数据损坏，清除缓存:', e.message);
        await redis.del(REDIS_KEYS.PODCAST_HOT);
      }
    }

    const coll = await mongo.getPodcastPodcastsCollection();
    hotPodcasts = await coll
      .find({ status: 'published' })
      .sort({ subscriber_count: -1, total_plays: -1 })
      .limit(limit)
      .toArray();

    const data = hotPodcasts.map(p => ({
      podcast_id: p.podcast_id,
      title: p.title,
      description: p.description,
      cover_image: p.cover_image,
      author_name: p.author_name,
      category: p.category,
      episode_count: p.episode_count || 0,
      subscriber_count: p.subscriber_count || 0,
      total_plays: p.total_plays || 0
    }));

    // 缓存结果
    await redis.set(REDIS_KEYS.PODCAST_HOT, JSON.stringify(data), CACHE_TTL.PODCAST_HOT);

    res.json({
      success: true,
      data: data
    });
  } catch (err) {
    console.error('获取热门播客失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取播客详情
 * GET /api/podcast/podcasts/:podcastId
 */
router.get('/podcasts/:podcastId', async (req, res) => {
  try {
    const { podcastId } = req.params;

    const coll = await mongo.getPodcastPodcastsCollection();
    const podcast = await coll.findOne({ podcast_id: podcastId });

    if (!podcast) {
      return res.status(404).json({ error: '播客不存在' });
    }

    // 获取用户订阅状态
    let isSubscribed = false;
    let isLiked = false;
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.replace('Bearer ', '');
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, require('../config/database').JWT_SECRET);

        // 检查订阅状态
        const subsColl = await mongo.getPodcastSubscriptionsCollection();
        const sub = await subsColl.findOne({
          podcast_id: podcastId,
          user_id: decoded.userId
        });
        isSubscribed = !!sub;

        // 检查点赞状态
        const likesColl = await mongo.getPodcastLikesCollection();
        const like = await likesColl.findOne({
          podcast_id: podcastId,
          user_id: decoded.userId,
          target_type: 'podcast'
        });
        isLiked = !!like;
      } catch (e) {
        // 忽略认证错误
      }
    }

    // 获取剧集列表
    const episodesColl = await mongo.getPodcastEpisodesCollection();
    const episodes = await episodesColl
      .find({ podcast_id: podcastId, status: 'published' })
      .sort({ published_at: -1 })
      .limit(50)
      .toArray();

    // 获取服务器基础URL，用于生成音频代理URL
    // 直接使用OSS原始URL，让浏览器直接缓存
    const episodesWithProxyUrl = episodes.map(ep => ({
      episode_id: ep.episode_id,
      podcast_id: ep.podcast_id,
      title: ep.title,
      description: ep.description,
      audio_url: convertAudioUrlToProxy(ep.audio_url) || '',
      duration: ep.duration || 0,
      cover_image: ep.cover_image,
      views_count: ep.plays_count || 0,
      plays_count: ep.plays_count || 0,
      likes_count: ep.likes_count || 0,
      published_at: ep.published_at
    }));

    res.json({
      success: true,
      data: {
        podcast: {
          podcast_id: podcast.podcast_id,
          title: podcast.title,
          description: podcast.description,
          cover_image: podcast.cover_image,
          author_id: podcast.author_id,
          author_name: podcast.author_name,
          author_avatar: podcast.author_avatar,
          category: podcast.category,
          tags: podcast.tags || [],
          episode_count: podcast.episode_count || 0,
          subscriber_count: podcast.subscriber_count || 0,
          views_count: podcast.total_plays || 0,
          total_plays: podcast.total_plays || 0,
          likes_count: podcast.likes_count || 0,
          is_subscribed: isSubscribed,
          is_liked: isLiked,
          created_at: podcast.created_at,
          updated_at: podcast.updated_at
        },
        episodes: episodesWithProxyUrl
      }
    });
  } catch (err) {
    console.error('获取播客详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 创建播客
 * POST /api/podcast/podcasts
 */
router.post('/podcasts', authenticateToken, async (req, res) => {
  try {
    const { title, description, cover_image, category, tags } = req.body;

    // 移除验证码保护（用户已登录）

    // 频率限制
    const rateLimitOk = await checkRateLimit(req.user.id, 'CREATE_PODCAST');
    if (!rateLimitOk) {
      return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
    }

    if (!title || title.trim().length < 2) {
      return res.status(400).json({ error: '播客标题不能少于2个字符' });
    }

    if (!category || !PODCAST_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: '请选择有效的分类' });
    }

    // 获取用户信息（带降级处理）
    let user;
    try {
      const [userRow] = await db.query('SELECT id, username FROM users WHERE id = ?', [req.user.id]);
      user = userRow;
    } catch (err) {
      console.error('获取用户信息失败:', err);
      return res.status(500).json({ error: '获取用户信息失败' });
    }

    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // MongoDB操作（带降级处理）
    let coll;
    try {
      coll = await mongo.getPodcastPodcastsCollection();
    } catch (err) {
      console.error('MongoDB连接失败:', err);
      return res.status(500).json({ error: '数据库服务暂时不可用' });
    }

    const podcastId = generatePodcastId();

    const podcast = {
      podcast_id: podcastId,
      title: title.trim(),
      description: description?.trim() || '',
      cover_image: cover_image || '',
      author_id: req.user.id,
      author_name: user.username,
      author_avatar: '',
      category: category,
      tags: tags || [],
      episode_count: 0,
      subscriber_count: 0,
      total_plays: 0,
      likes_count: 0,
      is_public: true,
      status: 'published',
      created_at: new Date(),
      updated_at: new Date()
    };

    await coll.insertOne(podcast);

    // 清除缓存
    await clearPodcastCache();

    // Socket广播新播客
    broadcastPodcastEvent('podcast_new', {
      podcast_id: podcast.podcast_id,
      title: podcast.title,
      author_name: podcast.author_name,
      category: podcast.category
    });

    res.json({
      success: true,
      data: {
        podcast_id: podcast.podcast_id,
        title: podcast.title,
        message: '播客创建成功'
      }
    });
  } catch (err) {
    console.error('创建播客失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 更新播客
 * PUT /api/podcast/podcasts/:podcastId
 */
router.put('/podcasts/:podcastId', authenticateToken, async (req, res) => {
  try {
    const { podcastId } = req.params;
    const { title, description, cover_image, category, tags } = req.body;

    const coll = await mongo.getPodcastPodcastsCollection();
    const podcast = await coll.findOne({ podcast_id: podcastId });

    if (!podcast) {
      return res.status(404).json({ error: '播客不存在' });
    }

    if (podcast.author_id !== req.user.id) {
      return res.status(403).json({ error: '无权限修改此播客' });
    }

    const updateFields = {
      updated_at: new Date()
    };

    if (title) updateFields.title = title.trim();
    if (description !== undefined) updateFields.description = description.trim();
    if (cover_image !== undefined) updateFields.cover_image = cover_image;
    if (category) {
      if (!PODCAST_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: '无效的分类' });
      }
      updateFields.category = category;
    }
    if (tags) updateFields.tags = tags;

    await coll.updateOne(
      { podcast_id: podcastId },
      { $set: updateFields }
    );

    // 清除缓存
    await clearPodcastCache(podcastId);

    res.json({
      success: true,
      message: '播客更新成功'
    });
  } catch (err) {
    console.error('更新播客失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 删除播客
 * DELETE /api/podcast/podcasts/:podcastId
 */
router.delete('/podcasts/:podcastId', authenticateToken, async (req, res) => {
  try {
    const { podcastId } = req.params;

    const coll = await mongo.getPodcastPodcastsCollection();
    const podcast = await coll.findOne({ podcast_id: podcastId });

    if (!podcast) {
      return res.status(404).json({ error: '播客不存在' });
    }

    if (podcast.author_id !== req.user.id) {
      return res.status(403).json({ error: '无权限删除此播客' });
    }

    // 删除播客
    await coll.deleteOne({ podcast_id: podcastId });

    // 删除相关剧集（包括OSS音频文件）
    const episodesColl = await mongo.getPodcastEpisodesCollection();
    const episodes = await episodesColl.find({ podcast_id: podcastId }).toArray();

    // 删除剧集的OSS音频文件
    for (const episode of episodes) {
      if (episode.audio_url && episode.audio_url.includes('oss-')) {
        try {
          const audioKey = episode.audio_url.split('.com/')[1];
          if (audioKey) await oss.deleteFile(audioKey);
        } catch (err) {
          console.error('删除OSS音频文件失败:', err);
        }
      }
    }
    await episodesColl.deleteMany({ podcast_id: podcastId });

    // 删除相关订阅
    const subsColl = await mongo.getPodcastSubscriptionsCollection();
    await subsColl.deleteMany({ podcast_id: podcastId });

    // 删除相关评论
    const commentsColl = await mongo.getPodcastCommentsCollection();
    await commentsColl.deleteMany({ podcast_id: podcastId });

    // 删除相关点赞
    const likesColl = await mongo.getPodcastLikesCollection();
    await likesColl.deleteMany({ podcast_id: podcastId });

    // 删除播客封面OSS文件
    if (podcast.cover_image && podcast.cover_image.includes('oss-')) {
      try {
        const coverKey = podcast.cover_image.split('.com/')[1];
        if (coverKey) await oss.deleteFile(coverKey);
      } catch (err) {
        console.error('删除OSS封面文件失败:', err);
      }
    }

    // 清除缓存
    await clearPodcastCache(podcastId);

    res.json({
      success: true,
      message: '播客删除成功'
    });
  } catch (err) {
    console.error('删除播客失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取我的播客
 * GET /api/podcast/my-podcasts
 */
router.get('/my-podcasts', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const coll = await mongo.getPodcastPodcastsCollection();
    const [podcasts, total] = await Promise.all([
      coll.find({ author_id: req.user.id }).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      coll.countDocuments({ author_id: req.user.id })
    ]);

    res.json({
      success: true,
      data: {
        podcasts: podcasts.map(p => ({
          podcast_id: p.podcast_id,
          title: p.title,
          description: p.description,
          cover_image: p.cover_image,
          category: p.category,
          episode_count: p.episode_count || 0,
          subscriber_count: p.subscriber_count || 0,
          total_plays: p.total_plays || 0,
          likes_count: p.likes_count || 0,
          status: p.status,
          created_at: p.created_at
        })),
        total: total,
        page: page,
        limit: limit,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取我的播客失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ==================== 剧集相关API ====================

/**
 * 创建剧集
 * POST /api/podcast/episodes
 */
router.post('/episodes', authenticateToken, async (req, res) => {
  try {
    const { podcast_id, title, description, audio_url, duration, cover_image } = req.body;

    if (!podcast_id) {
      return res.status(400).json({ error: '请指定播客ID' });
    }

    if (!title || title.trim().length < 2) {
      return res.status(400).json({ error: '剧集标题不能少于2个字符' });
    }

    if (!audio_url) {
      return res.status(400).json({ error: '请提供音频URL' });
    }

    // 检查播客是否存在且属于当前用户
    const podcastsColl = await mongo.getPodcastPodcastsCollection();
    const podcast = await podcastsColl.findOne({ podcast_id: podcast_id });

    if (!podcast) {
      return res.status(404).json({ error: '播客不存在' });
    }

    if (podcast.author_id !== req.user.id) {
      return res.status(403).json({ error: '无权限为此播客添加剧集' });
    }

    const episodesColl = await mongo.getPodcastEpisodesCollection();
    const episodeId = generateEpisodeId();

    const episode = {
      episode_id: episodeId,
      podcast_id: podcast_id,
      title: title.trim(),
      description: description?.trim() || '',
      audio_url: audio_url,
      duration: parseInt(duration) || 0,
      cover_image: cover_image || podcast.cover_image,
      plays_count: 0,
      likes_count: 0,
      comments_count: 0,
      status: 'published',
      published_at: new Date(),
      created_at: new Date(),
      updated_at: new Date()
    };

    await episodesColl.insertOne(episode);

    // 更新播客的剧集数量
    await podcastsColl.updateOne(
      { podcast_id: podcast_id },
      {
        $inc: { episode_count: 1 },
        $set: { updated_at: new Date() }
      }
    );

    // 清除缓存
    await clearPodcastCache(podcast_id);

    res.json({
      success: true,
      data: {
        episode_id: episode.episode_id,
        title: episode.title,
        message: '剧集创建成功'
      }
    });
  } catch (err) {
    console.error('创建剧集失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取剧集详情
 * GET /api/podcast/episodes/:episodeId
 */
router.get('/episodes/:episodeId', async (req, res) => {
  try {
    const { episodeId } = req.params;

    const episodesColl = await mongo.getPodcastEpisodesCollection();
    const episode = await episodesColl.findOne({ episode_id: episodeId });

    if (!episode) {
      return res.status(404).json({ error: '剧集不存在' });
    }

    // 高并发优化：使用Redis原子计数（立即返回）
    const currentPlays = await incrementPlayCount(episodeId);

    // 异步更新MongoDB（通过消息队列）
    messageQueue.enqueuePodcastTask({
      type: messageQueue.TASK_TYPES.PODCAST_PLAY,
      episode_id: episodeId,
      podcast_id: episode.podcast_id
    });

    // 检查点赞状态
    let isLiked = false;
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.replace('Bearer ', '');
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, require('../config/database').JWT_SECRET);

        const likesColl = await mongo.getPodcastLikesCollection();
        const like = await likesColl.findOne({
          episode_id: episodeId,
          user_id: decoded.userId,
          target_type: 'episode'
        });
        isLiked = !!like;
      } catch (e) {
        // 忽略认证错误
      }
    }

    // 转换为代理URL
    const audioUrl = convertAudioUrlToProxy(episode.audio_url) || '';

    res.json({
      success: true,
      data: {
        episode_id: episode.episode_id,
        podcast_id: episode.podcast_id,
        title: episode.title,
        description: episode.description,
        audio_url: audioUrl,
        duration: episode.duration || 0,
        cover_image: episode.cover_image,
        plays_count: currentPlays || (episode.plays_count || 0) + 1,
        likes_count: episode.likes_count || 0,
        is_liked: isLiked,
        published_at: episode.published_at
      }
    });
  } catch (err) {
    console.error('获取剧集详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 更新剧集
 * PUT /api/podcast/episodes/:episodeId
 */
router.put('/episodes/:episodeId', authenticateToken, async (req, res) => {
  try {
    const { episodeId } = req.params;
    const { title, description, audio_url, duration, cover_image, status } = req.body;

    const episodesColl = await mongo.getPodcastEpisodesCollection();
    const episode = await episodesColl.findOne({ episode_id: episodeId });

    if (!episode) {
      return res.status(404).json({ error: '剧集不存在' });
    }

    // 检查权限
    const podcastsColl = await mongo.getPodcastPodcastsCollection();
    const podcast = await podcastsColl.findOne({ podcast_id: episode.podcast_id });

    if (podcast.author_id !== req.user.id) {
      return res.status(403).json({ error: '无权限修改此剧集' });
    }

    const updateFields = {
      updated_at: new Date()
    };

    if (title) updateFields.title = title.trim();
    if (description !== undefined) updateFields.description = description.trim();
    if (audio_url) updateFields.audio_url = audio_url;
    if (duration) updateFields.duration = parseInt(duration);
    if (cover_image !== undefined) updateFields.cover_image = cover_image;
    if (status) updateFields.status = status;

    await episodesColl.updateOne(
      { episode_id: episodeId },
      { $set: updateFields }
    );

    // 清除缓存
    await clearPodcastCache(episode.podcast_id);

    res.json({
      success: true,
      message: '剧集更新成功'
    });
  } catch (err) {
    console.error('更新剧集失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 删除剧集
 * DELETE /api/podcast/episodes/:episodeId
 */
router.delete('/episodes/:episodeId', authenticateToken, async (req, res) => {
  try {
    const { episodeId } = req.params;

    const episodesColl = await mongo.getPodcastEpisodesCollection();
    const episode = await episodesColl.findOne({ episode_id: episodeId });

    if (!episode) {
      return res.status(404).json({ error: '剧集不存在' });
    }

    // 检查权限
    const podcastsColl = await mongo.getPodcastPodcastsCollection();
    const podcast = await podcastsColl.findOne({ podcast_id: episode.podcast_id });

    if (podcast.author_id !== req.user.id) {
      return res.status(403).json({ error: '无权限删除此剧集' });
    }

    // 删除OSS音频文件
    if (episode.audio_url && episode.audio_url.includes('oss-')) {
      try {
        const audioKey = episode.audio_url.split('.com/')[1];
        if (audioKey) await oss.deleteFile(audioKey);
      } catch (err) {
        console.error('删除OSS音频文件失败:', err);
      }
    }

    // 删除剧集
    await episodesColl.deleteOne({ episode_id: episodeId });

    // 更新播客剧集数量
    await podcastsColl.updateOne(
      { podcast_id: episode.podcast_id },
      { $inc: { episode_count: -1 } }
    );

    // 删除相关评论和点赞
    const commentsColl = await mongo.getPodcastCommentsCollection();
    await commentsColl.deleteMany({ episode_id: episodeId });

    const likesColl = await mongo.getPodcastLikesCollection();
    await likesColl.deleteMany({ episode_id: episodeId });

    // 清除缓存
    await clearPodcastCache(episode.podcast_id);

    res.json({
      success: true,
      message: '剧集删除成功'
    });
  } catch (err) {
    console.error('删除剧集失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ==================== 订阅相关API ====================

/**
 * 订阅/取消订阅播客
 * POST /api/podcast/subscribe
 */
router.post('/subscribe', authenticateToken, async (req, res) => {
  try {
    const { podcast_id, action } = req.body;

    if (!podcast_id) {
      return res.status(400).json({ error: '请指定播客ID' });
    }

    const podcastsColl = await mongo.getPodcastPodcastsCollection();
    const podcast = await podcastsColl.findOne({ podcast_id: podcast_id });

    if (!podcast) {
      return res.status(404).json({ error: '播客不存在' });
    }

    const subsColl = await mongo.getPodcastSubscriptionsCollection();

    if (action === 'subscribe') {
      // 订阅
      const existingSub = await subsColl.findOne({
        podcast_id: podcast_id,
        user_id: req.user.id
      });

      if (!existingSub) {
        await subsColl.insertOne({
          podcast_id: podcast_id,
          user_id: req.user.id,
          subscribed_at: new Date()
        });

        // 高并发优化：通过消息队列异步更新订阅数
        messageQueue.enqueuePodcastTask({
          type: messageQueue.TASK_TYPES.PODCAST_SUBSCRIBE,
          podcast_id: podcast_id,
          action: 'subscriber',
          increment: 1
        });

        // Socket广播订阅更新
        broadcastPodcastEvent('podcast_subscribe_update', {
          podcast_id: podcast_id,
          action: 'subscribe'
        });
      }

      await clearPodcastCache(podcast_id);

      res.json({
        success: true,
        data: { is_subscribed: true },
        message: '订阅成功'
      });
    } else if (action === 'unsubscribe') {
      // 取消订阅
      const result = await subsColl.deleteOne({
        podcast_id: podcast_id,
        user_id: req.user.id
      });

      if (result.deletedCount > 0) {
        // 高并发优化：通过消息队列异步更新订阅数
        messageQueue.enqueuePodcastTask({
          type: messageQueue.TASK_TYPES.PODCAST_SUBSCRIBE,
          podcast_id: podcast_id,
          action: 'subscriber',
          increment: -1
        });

        // Socket广播订阅更新
        broadcastPodcastEvent('podcast_subscribe_update', {
          podcast_id: podcast_id,
          action: 'unsubscribe'
        });
      }

      await clearPodcastCache(podcast_id);

      res.json({
        success: true,
        data: { is_subscribed: false },
        message: '取消订阅成功'
      });
    } else {
      return res.status(400).json({ error: '无效的操作' });
    }
  } catch (err) {
    console.error('订阅操作失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取用户订阅的播客
 * GET /api/podcast/subscribed
 */
router.get('/subscribed', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const subsColl = await mongo.getPodcastSubscriptionsCollection();
    const subs = await subsColl
      .find({ user_id: req.user.id })
      .sort({ subscribed_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const podcastIds = subs.map(s => s.podcast_id);

    if (podcastIds.length === 0) {
      return res.json({
        success: true,
        data: {
          podcasts: [],
          total: 0,
          page: page,
          limit: limit
        }
      });
    }

    const podcastsColl = await mongo.getPodcastPodcastsCollection();
    const podcasts = await podcastsColl
      .find({ podcast_id: { $in: podcastIds }, status: 'published' })
      .toArray();

    // 按订阅顺序排序
    const podcastMap = new Map(podcasts.map(p => [p.podcast_id, p]));
    const sortedPodcasts = podcastIds
      .map(id => podcastMap.get(id))
      .filter(p => p);

    const total = await subsColl.countDocuments({ user_id: req.user.id });

    res.json({
      success: true,
      data: {
        podcasts: sortedPodcasts.map(p => ({
          podcast_id: p.podcast_id,
          title: p.title,
          description: p.description,
          cover_image: p.cover_image,
          author_name: p.author_name,
          category: p.category,
          episode_count: p.episode_count || 0,
          subscriber_count: p.subscriber_count || 0,
          total_plays: p.total_plays || 0,
          is_subscribed: true,
          subscribed_at: subs.find(s => s.podcast_id === p.podcast_id)?.subscribed_at
        })),
        total: total,
        page: page,
        limit: limit,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取订阅播客失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ==================== 点赞相关API ====================

/**
 * 点赞/取消点赞
 * POST /api/podcast/like
 */
router.post('/like', authenticateToken, async (req, res) => {
  try {
    const { target_id, target_type, action } = req.body;

    // 频率限制
    const rateLimitOk = await checkRateLimit(req.user.id, 'LIKE');
    if (!rateLimitOk) {
      return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
    }

    if (!target_id || !target_type) {
      return res.status(400).json({ error: '请指定目标ID和类型' });
    }

    if (!['podcast', 'episode'].includes(target_type)) {
      return res.status(400).json({ error: '无效的目标类型' });
    }

    const likesColl = await mongo.getPodcastLikesCollection();

    if (action === 'like') {
      // 点赞
      const existingLike = await likesColl.findOne({
        target_id: target_id,
        target_type: target_type,
        user_id: req.user.id
      });

      if (!existingLike) {
        await likesColl.insertOne({
          target_id: target_id,
          target_type: target_type,
          user_id: req.user.id,
          created_at: new Date()
        });

        // 高并发优化：通过消息队列异步更新点赞数
        messageQueue.enqueuePodcastTask({
          type: messageQueue.TASK_TYPES.PODCAST_LIKE,
          podcast_id: target_type === 'podcast' ? target_id : undefined,
          episode_id: target_type === 'episode' ? target_id : undefined,
          action: target_type === 'podcast' ? 'like' : 'episode_like',
          increment: 1
        });

        // Socket广播点赞更新
        broadcastPodcastEvent('podcast_like_update', {
          target_id: target_id,
          target_type: target_type,
          action: 'like'
        });

        // 剧集点赞专属事件
        if (target_type === 'episode') {
          const episodesColl = await mongo.getPodcastEpisodesCollection();
          const episode = await episodesColl.findOne({ episode_id: target_id });
          if (episode) {
            broadcastPodcastEvent('podcast_episode_like_update', {
              episode_id: target_id,
              podcast_id: episode.podcast_id,
              action: 'like'
            });
          }
        }
      }

      res.json({
        success: true,
        data: { is_liked: true },
        message: '点赞成功'
      });
    } else if (action === 'unlike') {
      // 取消点赞
      const result = await likesColl.deleteOne({
        target_id: target_id,
        target_type: target_type,
        user_id: req.user.id
      });

      if (result.deletedCount > 0) {
        // 高并发优化：通过消息队列异步更新点赞数
        messageQueue.enqueuePodcastTask({
          type: messageQueue.TASK_TYPES.PODCAST_LIKE,
          podcast_id: target_type === 'podcast' ? target_id : undefined,
          episode_id: target_type === 'episode' ? target_id : undefined,
          action: target_type === 'podcast' ? 'like' : 'episode_like',
          increment: -1
        });

        // Socket广播点赞更新
        broadcastPodcastEvent('podcast_like_update', {
          target_id: target_id,
          target_type: target_type,
          action: 'unlike'
        });

        // 剧集取消点赞专属事件
        if (target_type === 'episode') {
          const episodesColl = await mongo.getPodcastEpisodesCollection();
          const episode = await episodesColl.findOne({ episode_id: target_id });
          if (episode) {
            broadcastPodcastEvent('podcast_episode_like_update', {
              episode_id: target_id,
              podcast_id: episode.podcast_id,
              action: 'unlike'
            });
          }
        }
      }

      res.json({
        success: true,
        data: { is_liked: false },
        message: '取消点赞成功'
      });
    } else {
      return res.status(400).json({ error: '无效的操作' });
    }
  } catch (err) {
    console.error('点赞操作失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ==================== 评论相关API ====================

/**
 * 获取评论列表
 * GET /api/podcast/comments?target_id=xxx&target_type=xxx
 */
router.get('/comments', async (req, res) => {
  try {
    const { target_id, target_type, page = 1, limit = 20 } = req.query;

    if (!target_id || !target_type) {
      return res.status(400).json({ error: '请指定目标ID和类型' });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const commentsColl = await mongo.getPodcastCommentsCollection();

    const query = { target_id, target_type };
    const [comments, total] = await Promise.all([
      commentsColl.find(query).sort({ created_at: -1 }).skip(skip).limit(parseInt(limit)).toArray(),
      commentsColl.countDocuments(query)
    ]);

    // 获取用户信息
    const userIds = [...new Set(comments.map(c => c.user_id))];
    let users = {};
    if (userIds.length > 0) {
      const userRows = await db.query(
        `SELECT id, username FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`,
        userIds
      );
      users = userRows.reduce((acc, u) => {
        acc[u.id] = { username: u.username };
        return acc;
      }, {});
    }

    res.json({
      success: true,
      data: {
        comments: comments.map(c => ({
          comment_id: c.comment_id,
          target_id: c.target_id,
          target_type: c.target_type,
          user_id: c.user_id,
          user_name: users[c.user_id]?.username || '未知用户',
          avatar: '',
          content: c.content,
          created_at: c.created_at
        })),
        total: total,
        page: parseInt(page),
        limit: parseInt(limit),
        total_pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('获取评论列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 发表评论
 * POST /api/podcast/comments
 */
router.post('/comments', authenticateToken, async (req, res) => {
  try {
    const { target_id, target_type, content } = req.body;

    // 频率限制
    const rateLimitOk = await checkRateLimit(req.user.id, 'COMMENT');
    if (!rateLimitOk) {
      return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
    }

    if (!target_id || !target_type) {
      return res.status(400).json({ error: '请指定目标ID和类型' });
    }

    if (!content || content.trim().length < 1) {
      return res.status(400).json({ error: '评论内容不能为空' });
    }

    if (content.length > 500) {
      return res.status(400).json({ error: '评论内容不能超过500个字符' });
    }

    // 获取用户信息
    const [user] = await db.query('SELECT id, username FROM users WHERE id = ?', [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const commentsColl = await mongo.getPodcastCommentsCollection();
    const commentId = 'cmt_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);

    const comment = {
      comment_id: commentId,
      target_id: target_id,
      target_type: target_type,
      user_id: req.user.id,
      username: user.username,
      avatar: '',
      content: content.trim(),
      created_at: new Date()
    };

    await commentsColl.insertOne(comment);

    // 更新评论数
    if (target_type === 'podcast') {
      const podcastsColl = await mongo.getPodcastPodcastsCollection();
      await podcastsColl.updateOne(
        { podcast_id: target_id },
        { $set: { updated_at: new Date() } }
      );
    } else if (target_type === 'episode') {
      const episodesColl = await mongo.getPodcastEpisodesCollection();
      await episodesColl.updateOne(
        { episode_id: target_id },
        { $inc: { comments_count: 1 } }
      );
    }

    // Socket广播新评论
    broadcastPodcastEvent('podcast_comment', {
      target_id: target_id,
      target_type: target_type,
      comment_id: comment.comment_id,
      username: user.username
    });

    res.json({
      success: true,
      data: {
        comment_id: comment.comment_id,
        content: comment.content,
        created_at: comment.created_at
      },
      message: '评论成功'
    });
  } catch (err) {
    console.error('发表评论失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 删除评论
 * DELETE /api/podcast/comments/:commentId
 */
router.delete('/comments/:commentId', authenticateToken, async (req, res) => {
  try {
    const { commentId } = req.params;

    const commentsColl = await mongo.getPodcastCommentsCollection();
    const comment = await commentsColl.findOne({ comment_id: commentId });

    if (!comment) {
      return res.status(404).json({ error: '评论不存在' });
    }

    // 检查权限（评论者或播客作者或管理员可以删除）
    let canDelete = comment.user_id === req.user.id;
    if (!canDelete && comment.target_type === 'podcast') {
      const podcastsColl = await mongo.getPodcastPodcastsCollection();
      const podcast = await podcastsColl.findOne({ podcast_id: comment.target_id });
      canDelete = podcast && podcast.author_id === req.user.id;
    }
    if (!canDelete && comment.target_type === 'episode') {
      const episodesColl = await mongo.getPodcastEpisodesCollection();
      const episode = await episodesColl.findOne({ episode_id: comment.target_id });
      if (episode) {
        const podcastsColl = await mongo.getPodcastPodcastsCollection();
        const podcast = await podcastsColl.findOne({ podcast_id: episode.podcast_id });
        canDelete = podcast && podcast.author_id === req.user.id;
      }
    }

    if (!canDelete) {
      return res.status(403).json({ error: '无权限删除此评论' });
    }

    await commentsColl.deleteOne({ comment_id: commentId });

    // 更新评论数
    if (comment.target_type === 'episode') {
      const episodesColl = await mongo.getPodcastEpisodesCollection();
      await episodesColl.updateOne(
        { episode_id: comment.target_id },
        { $inc: { comments_count: -1 } }
      );
    }

    res.json({
      success: true,
      message: '评论删除成功'
    });
  } catch (err) {
    console.error('删除评论失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ==================== 工具API ====================

/**
 * 获取播客分类列表
 * GET /api/podcast/categories
 */
router.get('/categories', (req, res) => {
  res.json({
    success: true,
    data: PODCAST_CATEGORIES
  });
});

/**
 * 上传音频文件
 * POST /api/podcast/upload-audio
 */
router.post('/upload-audio', authenticateToken, uploadAudio.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择音频文件' });
    }

    console.log('[upload-audio] 收到文件:', req.file);

    // 上传到OSS
    const objectName = `podcast-audio/${req.file.filename}`;
    console.log('[upload-audio] 开始上传到OSS, objectName:', objectName);
    console.log('[upload-audio] 本地文件路径:', req.file.path);

    await oss.uploadFile(objectName, req.file.path);
    console.log('[upload-audio] OSS上传完成');

    // 获取OSS加速域名URL并转换为代理URL
    const audioUrl = convertAudioUrlToProxy(oss.getPublicUrl(objectName));
    console.log('[upload-audio] 生成的URL:', audioUrl);

    // 上传成功后删除本地临时文件
    try {
      fs.unlinkSync(req.file.path);
    } catch (err) {
      console.error('删除本地临时文件失败:', err);
    }

    res.json({
      success: true,
      data: {
        audio_url: audioUrl,
        filename: req.file.filename,
        size: req.file.size,
        mimetype: req.file.mimetype
      },
      message: '音频上传成功'
    });
  } catch (err) {
    console.error('[upload-audio] 音频上传失败:', err);
    console.error('[upload-audio] 错误详情:', err.stack);
    res.status(500).json({ error: '音频上传失败: ' + err.message });
  }
});

/**
 * 分片上传 - 初始化
 * POST /api/podcast/upload-chunk-init
 */
router.post('/upload-chunk-init', authenticateToken, async (req, res) => {
  try {
    const { filename, totalChunks, fileSize, mimetype } = req.body;

    if (!filename || !totalChunks || !fileSize) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    // 生成唯一的上传ID
    const uploadId = Date.now() + '_' + Math.random().toString(36).substring(2, 15);
    const chunkDir = path.join(__dirname, '../../public/uploads/podcast-chunks/' + uploadId);

    // 创建分片目录
    if (!fs.existsSync(chunkDir)) {
      fs.mkdirSync(chunkDir, { recursive: true });
    }

    // 存储上传信息到Redis（1小时后过期）
    try {
      await redis.set('podcast:upload:' + uploadId, JSON.stringify({
        uploadId,
        filename,
        totalChunks: parseInt(totalChunks),
        fileSize: parseInt(fileSize),
        mimetype,
        uploadedChunks: [],
        createdAt: Date.now()
      }), 3600);
    } catch (redisErr) {
      console.error('Redis存储失败:', redisErr.message);
      return res.status(500).json({ error: '服务器内部错误: Redis连接失败' });
    }

    res.json({
      success: true,
      data: { uploadId, chunkDir }
    });
  } catch (err) {
    console.error('初始化分片上传失败:', err);
    res.status(500).json({ error: '初始化上传失败: ' + err.message });
  }
});

/**
 * 分片上传 - 上传单个分片
 * POST /api/podcast/upload-chunk
 */
const uploadChunk = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadId = req.body.uploadId;
      const chunkDir = path.join(__dirname, '../../public/uploads/podcast-chunks/' + uploadId);
      if (!fs.existsSync(chunkDir)) {
        fs.mkdirSync(chunkDir, { recursive: true });
      }
      cb(null, chunkDir);
    },
    filename: (req, file, cb) => {
      const chunkIndex = req.body.chunkIndex;
      cb(null, 'chunk_' + chunkIndex);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 } // 单个分片最大10MB
});

router.post('/upload-chunk', authenticateToken, uploadChunk.single('chunk'), async (req, res) => {
  try {
    const { uploadId, chunkIndex, totalChunks } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: '请选择分片文件' });
    }

    // 获取上传信息
    let uploadInfoStr;
    try {
      uploadInfoStr = await redis.get('podcast:upload:' + uploadId);
    } catch (redisErr) {
      console.error('Redis获取失败:', redisErr.message);
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(500).json({ error: '服务器内部错误: Redis连接失败' });
    }

    if (!uploadInfoStr) {
      // 清理已上传的分片
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ error: '上传已过期，请重新开始' });
    }

    let uploadInfo;
    try {
      uploadInfo = JSON.parse(uploadInfoStr);
    } catch (parseErr) {
      console.error('JSON解析失败:', parseErr.message);
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(500).json({ error: '数据解析错误' });
    }

    const uploadedChunks = uploadInfo.uploadedChunks || [];

    // 检查分片是否已上传
    const chunkIdx = parseInt(chunkIndex);
    if (uploadedChunks.includes(chunkIdx)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.json({
        success: true,
        data: { chunkIndex: chunkIdx, alreadyUploaded: true }
      });
    }

    // 更新上传信息
    uploadedChunks.push(chunkIdx);
    uploadInfo.uploadedChunks = uploadedChunks;
    try {
      await redis.set('podcast:upload:' + uploadId, JSON.stringify(uploadInfo), 3600);
    } catch (redisErr) {
      console.error('Redis更新失败:', redisErr.message);
      return res.status(500).json({ error: '服务器内部错误: Redis更新失败' });
    }

    res.json({
      success: true,
      data: {
        chunkIndex: parseInt(chunkIndex),
        totalChunks: parseInt(totalChunks),
        uploadedCount: uploadedChunks.length
      }
    });
  } catch (err) {
    console.error('分片上传失败:', err);
    res.status(500).json({ error: '分片上传失败: ' + err.message });
  }
});

/**
 * 分片上传 - 合并分片
 * POST /api/podcast/merge-chunks
 */
router.post('/merge-chunks', authenticateToken, async (req, res) => {
  try {
    const { uploadId, filename, mimetype } = req.body;

    // 获取上传信息
    let uploadInfoStr;
    try {
      uploadInfoStr = await redis.get('podcast:upload:' + uploadId);
    } catch (redisErr) {
      console.error('Redis获取失败:', redisErr.message);
      return res.status(500).json({ error: '服务器内部错误: Redis连接失败' });
    }

    if (!uploadInfoStr) {
      return res.status(400).json({ error: '上传信息不存在或已过期' });
    }

    let uploadInfo;
    try {
      uploadInfo = JSON.parse(uploadInfoStr);
    } catch (parseErr) {
      console.error('JSON解析失败:', parseErr.message);
      return res.status(500).json({ error: '数据解析错误' });
    }

    const { totalChunks, uploadedChunks, fileSize } = uploadInfo;

    // 检查是否所有分片都已上传
    if (uploadedChunks.length < totalChunks) {
      return res.status(400).json({
        error: '分片未全部上传，已上传 ' + uploadedChunks.length + '/' + totalChunks
      });
    }

    const chunkDir = path.join(__dirname, '../../public/uploads/podcast-chunks/' + uploadId);
    const finalDir = PODCAST_AUDIO_DIR;
    const finalFilename = 'podcast_' + Date.now() + path.extname(filename);
    const finalPath = path.join(finalDir, finalFilename);

    // 确保目标目录存在
    if (!fs.existsSync(finalDir)) {
      fs.mkdirSync(finalDir, { recursive: true });
    }

    // 合并分片
    const writeStream = fs.createWriteStream(finalPath);
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(chunkDir, 'chunk_' + i);
      if (fs.existsSync(chunkPath)) {
        const chunkData = fs.readFileSync(chunkPath);
        writeStream.write(chunkData);
      }
    }
    writeStream.end();

    // 等待写入完成
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // 上传到OSS
    const objectName = 'podcast-audio/' + finalFilename;
    await oss.uploadFile(objectName, finalPath);

    // 获取OSS加速域名URL并转换为代理URL
    const audioUrl = convertAudioUrlToProxy(oss.getPublicUrl(objectName));

    // 清理临时文件
    try {
      fs.unlinkSync(finalPath); // 删除合并后的临时文件
      // 删除分片目录
      fs.rmSync(chunkDir, { recursive: true, force: true });
      // 删除Redis信息
      await redis.del('podcast:upload:' + uploadId);
    } catch (e) {
      console.error('清理临时文件失败:', e);
    }

    res.json({
      success: true,
      data: {
        audio_url: audioUrl,
        filename: finalFilename,
        size: fileSize,
        mimetype
      },
      message: '音频上传成功'
    });
  } catch (err) {
    console.error('合并分片失败:', err);
    res.status(500).json({ error: '合并分片失败' });
  }
});

/**
 * 分片上传 - 查询上传状态
 * GET /api/podcast/upload-status/:uploadId
 */
router.get('/upload-status/:uploadId', authenticateToken, async (req, res) => {
  try {
    const { uploadId } = req.params;

    let uploadInfoStr;
    try {
      uploadInfoStr = await redis.get('podcast:upload:' + uploadId);
    } catch (redisErr) {
      console.error('Redis获取失败:', redisErr.message);
      return res.status(500).json({ error: '服务器内部错误: Redis连接失败' });
    }

    if (!uploadInfoStr) {
      return res.json({
        success: true,
        data: {
          uploadId,
          uploadedChunks: [],
          totalChunks: 0,
          isComplete: false
        }
      });
    }

    let uploadInfo;
    try {
      uploadInfo = JSON.parse(uploadInfoStr);
    } catch (parseErr) {
      console.error('JSON解析失败:', parseErr.message);
      return res.status(500).json({ error: '数据解析错误' });
    }

    res.json({
      success: true,
      data: {
        uploadId,
        uploadedChunks: uploadInfo.uploadedChunks,
        totalChunks: uploadInfo.totalChunks,
        isComplete: uploadInfo.uploadedChunks.length >= uploadInfo.totalChunks
      }
    });
  } catch (err) {
    console.error('查询上传状态失败:', err);
    res.status(500).json({ error: '查询失败: ' + err.message });
  }
});

/**
 * 获取STS临时访问凭证（用于浏览器直传）
 * GET /api/podcast/get-sts-token
 */
router.get('/get-sts-token', authenticateToken, async (req, res) => {
  try {
    const token = await oss.getSTSToken();
    // 添加自定义域名（用于前端直接播放音频）
    token.customDomain = 'https://boke.skym178.com';
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
 * OSS直传 - 初始化分片上传（返回每个分片的预签名URL）
 * POST /api/podcast/init-oss-upload
 */
router.post('/init-oss-upload', authenticateToken, async (req, res) => {
  try {
    const { filename, totalChunks, fileSize, mimetype } = req.body;

    if (!filename || !totalChunks || !fileSize) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    // 生成OSS存储路径
    const objectName = 'podcast-audio/' + Date.now() + '_' + filename;

    console.log('[init-oss-upload] 开始初始化分片上传, objectName:', objectName);

    // 初始化OSS分片上传
    const multipartInfo = await oss.createMultipartUpload(objectName);
    console.log('[init-oss-upload] 分片上传初始化成功, uploadId:', multipartInfo.uploadId);

    const { uploadId } = multipartInfo;

    // 为每个分片生成预签名URL，传递正确的Content-Type
    const partUrls = [];
    for (let i = 1; i <= totalChunks; i++) {
      const url = await oss.getPartUrl(objectName, uploadId, i, 3600, mimetype || 'audio/mpeg');
      partUrls.push({
        partNumber: i,
        url: url
      });
    }

    // 存储上传信息到Redis（1小时后过期）
    try {
      await redis.set('podcast:oss-upload:' + uploadId, JSON.stringify({
        uploadId,
        objectName,
        filename,
        totalChunks: parseInt(totalChunks),
        fileSize: parseInt(fileSize),
        mimetype,
        uploadedParts: [],
        createdAt: Date.now()
      }), 3600);
    } catch (redisErr) {
      console.error('Redis存储失败:', redisErr.message);
      // 即使Redis失败，也返回预签名URL，客户端可以在本地记录进度
      console.warn('Redis存储失败，但返回预签名URL，客户端需自行记录进度');
    }

    res.json({
      success: true,
      data: {
        uploadId,
        objectName,
        partUrls
      }
    });
  } catch (err) {
    console.error('初始化OSS上传失败:', err);
    res.status(500).json({ error: '初始化上传失败: ' + err.message });
  }
});

/**
 * OSS直传 - 完成分片上传
 * POST /api/podcast/complete-oss-upload
 */
router.post('/complete-oss-upload', authenticateToken, async (req, res) => {
  try {
    const { uploadId, uploadedParts } = req.body;

    if (!uploadId || !uploadedParts || uploadedParts.length === 0) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    // 从Redis获取上传信息
    let uploadInfoStr;
    try {
      uploadInfoStr = await redis.get('podcast:oss-upload:' + uploadId);
    } catch (redisErr) {
      console.error('Redis获取失败:', redisErr.message);
      return res.status(500).json({ error: '服务器内部错误: Redis连接失败' });
    }

    if (!uploadInfoStr) {
      return res.status(400).json({ error: '上传信息不存在或已过期' });
    }

    let uploadInfo;
    try {
      uploadInfo = JSON.parse(uploadInfoStr);
    } catch (parseErr) {
      console.error('JSON解析失败:', parseErr.message);
      return res.status(500).json({ error: '数据解析错误' });
    }

    // 检查是否所有分片都已上传
    if (uploadedParts.length < uploadInfo.totalChunks) {
      return res.status(400).json({
        error: '分片未全部上传，已上传 ' + uploadedParts.length + '/' + uploadInfo.totalChunks
      });
    }

    // 格式化分片列表（按partNumber排序）
    const parts = uploadedParts
      .sort((a, b) => a.partNumber - b.partNumber)
      .map(p => ({
        partNumber: p.partNumber,
        etag: p.etag
      }));

    // 完成OSS分片上传
    await oss.completeMultipartUpload(uploadInfo.objectName, uploadId, parts);

    // 获取OSS加速域名URL并转换为代理URL
    const audioUrl = convertAudioUrlToProxy(oss.getPublicUrl(uploadInfo.objectName));

    // 清理Redis信息
    try {
      await redis.del('podcast:oss-upload:' + uploadId);
    } catch (delErr) {
      console.warn('清理Redis失败:', delErr.message);
    }

    res.json({
      success: true,
      data: {
        url: audioUrl,
        filename: uploadInfo.filename,
        objectName: uploadInfo.objectName,
        size: uploadInfo.fileSize,
        mimetype: uploadInfo.mimetype
      },
      message: '音频上传成功'
    });
  } catch (err) {
    console.error('完成OSS上传失败:', err);
    res.status(500).json({ error: '完成上传失败: ' + err.message });
  }
});

/**
 * OSS直传 - 取消分片上传
 * POST /api/podcast/abort-oss-upload
 */
router.post('/abort-oss-upload', authenticateToken, async (req, res) => {
  try {
    const { uploadId } = req.body;

    if (!uploadId) {
      return res.status(400).json({ error: '缺少uploadId' });
    }

    // 从Redis获取上传信息
    let uploadInfoStr;
    try {
      uploadInfoStr = await redis.get('podcast:oss-upload:' + uploadId);
    } catch (redisErr) {
      console.error('Redis获取失败:', redisErr.message);
    }

    if (uploadInfoStr) {
      try {
        const uploadInfo = JSON.parse(uploadInfoStr);
        // 取消OSS分片上传
        await oss.abortMultipartUpload(uploadInfo.objectName, uploadId);
      } catch (parseErr) {
        console.warn('解析上传信息失败:', parseErr.message);
      }

      // 清理Redis
      try {
        await redis.del('podcast:oss-upload:' + uploadId);
      } catch (delErr) {
        console.warn('清理Redis失败:', delErr.message);
      }
    }

    res.json({
      success: true,
      message: '上传已取消'
    });
  } catch (err) {
    console.error('取消OSS上传失败:', err);
    res.status(500).json({ error: '取消上传失败: ' + err.message });
  }
});

/**
 * 上传播客封面图片
 * POST /api/podcast/upload-cover
 */
const coverStorage = multer.diskStorage({
    destination: PODCAST_COVER_DIR,
    filename: (req, file, cb) => {
        cb(null, `cover_${Date.now()}_${file.originalname}`);
    }
});
const uploadCover = multer({
    storage: coverStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('不支持的图片格式'));
        }
    }
});

router.post('/upload-cover', authenticateToken, uploadCover.single('cover'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择图片文件' });
    }

    // 上传到OSS
    const objectName = `podcast-covers/${req.file.filename}`;
    await oss.uploadFile(objectName, req.file.path);

    // 获取OSS加速域名URL
    const coverUrl = oss.getPublicUrl(objectName);

    // 上传成功后删除本地临时文件
    try {
      fs.unlinkSync(req.file.path);
    } catch (err) {
      console.error('删除本地临时文件失败:', err);
    }

    res.json({
      success: true,
      data: {
        cover_url: coverUrl,
        filename: req.file.filename,
        size: req.file.size
      },
      message: '封面上传成功'
    });
  } catch (err) {
    console.error('封面上传失败:', err);
    res.status(500).json({ error: '封面上传失败' });
  }
});

/**
 * 获取播客管理列表
 * GET /api/podcast/admin/podcasts
 */
router.get('/admin/podcasts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const keyword = req.query.keyword || '';
    const status = req.query.status || '';
    const category = req.query.category || '';
    const skip = (page - 1) * limit;

    const coll = await mongo.getPodcastPodcastsCollection();

    const query = {};
    if (keyword) {
      query.$or = [
        { title: { $regex: keyword, $options: 'i' } },
        { description: { $regex: keyword, $options: 'i' } },
        { author_name: { $regex: keyword, $options: 'i' } }
      ];
    }
    if (status) {
      query.status = status;
    }
    if (category) {
      query.category = category;
    }

    const [podcasts, total] = await Promise.all([
      coll.find(query).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      coll.countDocuments(query)
    ]);

    const data = podcasts.map(p => ({
      podcast_id: p.podcast_id,
      title: p.title,
      description: p.description,
      cover_image: p.cover_image,
      author_id: p.author_id,
      author_name: p.author_name,
      category: p.category,
      tags: p.tags || [],
      episode_count: p.episode_count || 0,
      subscriber_count: p.subscriber_count || 0,
      total_plays: p.total_plays || 0,
      likes_count: p.likes_count || 0,
      status: p.status,
      is_public: p.is_public,
      created_at: p.created_at,
      updated_at: p.updated_at
    }));

    res.json({
      success: true,
      data: {
        podcasts: data,
        total: total,
        page: page,
        limit: limit,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取播客管理列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取播客详情（管理员）
 * GET /api/podcast/admin/podcasts/:podcastId
 */
router.get('/admin/podcasts/:podcastId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { podcastId } = req.params;

    const coll = await mongo.getPodcastPodcastsCollection();
    const podcast = await coll.findOne({ podcast_id: podcastId });

    if (!podcast) {
      return res.status(404).json({ error: '播客不存在' });
    }

    // 获取剧集列表
    const episodesColl = await mongo.getPodcastEpisodesCollection();
    const episodes = await episodesColl
      .find({ podcast_id: podcastId })
      .sort({ published_at: -1 })
      .toArray();

    res.json({
      success: true,
      data: {
        podcast: {
          podcast_id: podcast.podcast_id,
          title: podcast.title,
          description: podcast.description,
          cover_image: podcast.cover_image,
          author_id: podcast.author_id,
          author_name: podcast.author_name,
          author_avatar: podcast.author_avatar,
          category: podcast.category,
          tags: podcast.tags || [],
          episode_count: podcast.episode_count || 0,
          subscriber_count: podcast.subscriber_count || 0,
          total_plays: podcast.total_plays || 0,
          likes_count: podcast.likes_count || 0,
          status: podcast.status,
          is_public: podcast.is_public,
          created_at: podcast.created_at,
          updated_at: podcast.updated_at
        },
        episodes: episodes.map(ep => ({
          episode_id: ep.episode_id,
          podcast_id: ep.podcast_id,
          title: ep.title,
          description: ep.description,
          audio_url: convertAudioUrlToProxy(ep.audio_url) || '',
          duration: ep.duration || 0,
          cover_image: ep.cover_image,
          plays_count: ep.plays_count || 0,
          likes_count: ep.likes_count || 0,
          comments_count: ep.comments_count || 0,
          status: ep.status,
          published_at: ep.published_at,
          created_at: ep.created_at
        }))
      }
    });
  } catch (err) {
    console.error('获取播客详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 更新播客（管理员）
 * PUT /api/podcast/admin/podcasts/:podcastId
 */
router.put('/admin/podcasts/:podcastId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { podcastId } = req.params;
    const { title, description, cover_image, category, tags, status, is_public } = req.body;

    const coll = await mongo.getPodcastPodcastsCollection();
    const podcast = await coll.findOne({ podcast_id: podcastId });

    if (!podcast) {
      return res.status(404).json({ error: '播客不存在' });
    }

    const updateFields = {
      updated_at: new Date()
    };

    if (title !== undefined) updateFields.title = title.trim();
    if (description !== undefined) updateFields.description = description.trim();
    if (cover_image !== undefined) updateFields.cover_image = cover_image;
    if (category !== undefined) {
      if (category && !PODCAST_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: '无效的分类' });
      }
      updateFields.category = category;
    }
    if (tags !== undefined) updateFields.tags = tags;
    if (status !== undefined) updateFields.status = status;
    if (is_public !== undefined) updateFields.is_public = is_public;

    await coll.updateOne(
      { podcast_id: podcastId },
      { $set: updateFields }
    );

    // 清除缓存
    await clearPodcastCache(podcastId);

    // 记录管理员操作日志
    const { logAdminAction } = require('../middleware/auth');
    await logAdminAction(req.user.id, 'update_podcast', podcastId, { title: title || podcast.title });

    res.json({
      success: true,
      message: '播客更新成功'
    });
  } catch (err) {
    console.error('更新播客失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 删除播客（管理员）
 * DELETE /api/podcast/admin/podcasts/:podcastId
 */
router.delete('/admin/podcasts/:podcastId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { podcastId } = req.params;

    const coll = await mongo.getPodcastPodcastsCollection();
    const podcast = await coll.findOne({ podcast_id: podcastId });

    if (!podcast) {
      return res.status(404).json({ error: '播客不存在' });
    }

    // 删除播客
    await coll.deleteOne({ podcast_id: podcastId });

    // 删除相关剧集（包括OSS音频文件）
    const episodesColl = await mongo.getPodcastEpisodesCollection();
    const episodes = await episodesColl.find({ podcast_id: podcastId }).toArray();

    // 删除剧集的OSS音频文件
    for (const episode of episodes) {
      if (episode.audio_url && episode.audio_url.includes('oss-')) {
        try {
          const audioKey = episode.audio_url.split('.com/')[1];
          if (audioKey) await oss.deleteFile(audioKey);
        } catch (err) {
          console.error('删除OSS音频文件失败:', err);
        }
      }
    }
    await episodesColl.deleteMany({ podcast_id: podcastId });

    // 删除相关订阅
    const subsColl = await mongo.getPodcastSubscriptionsCollection();
    await subsColl.deleteMany({ podcast_id: podcastId });

    // 删除相关评论
    const commentsColl = await mongo.getPodcastCommentsCollection();
    await commentsColl.deleteMany({ podcast_id: podcastId });

    // 删除相关点赞
    const likesColl = await mongo.getPodcastLikesCollection();
    await likesColl.deleteMany({ podcast_id: podcastId });

    // 删除播客封面OSS文件
    if (podcast.cover_image && podcast.cover_image.includes('oss-')) {
      try {
        const coverKey = podcast.cover_image.split('.com/')[1];
        if (coverKey) await oss.deleteFile(coverKey);
      } catch (err) {
        console.error('删除OSS封面文件失败:', err);
      }
    }

    // 清除缓存
    await clearPodcastCache(podcastId);

    // 记录管理员操作日志
    const { logAdminAction } = require('../middleware/auth');
    await logAdminAction(req.user.id, 'delete_podcast', podcastId, { title: podcast.title });

    res.json({
      success: true,
      message: '播客删除成功'
    });
  } catch (err) {
    console.error('删除播客失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 创建播客（管理员）
 * POST /api/podcast/admin/podcasts
 */
router.post('/admin/podcasts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, description, cover_image, category, tags, status } = req.body;

    if (!title || title.trim().length < 2) {
      return res.status(400).json({ error: '播客标题不能少于2个字符' });
    }

    if (category && !PODCAST_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: '无效的分类' });
    }

    // 获取管理员用户信息
    const [adminUser] = await db.query('SELECT id, username FROM users WHERE id = ?', [req.user.id]);

    const coll = await mongo.getPodcastPodcastsCollection();
    const podcastId = generatePodcastId();

    const podcast = {
      podcast_id: podcastId,
      title: title.trim(),
      description: description?.trim() || '',
      cover_image: cover_image || '',
      author_id: req.user.id,
      author_name: adminUser?.username || '管理员',
      author_avatar: '',
      category: category || '其他',
      tags: tags || [],
      episode_count: 0,
      subscriber_count: 0,
      total_plays: 0,
      likes_count: 0,
      is_public: true,
      status: status || 'published',
      created_at: new Date(),
      updated_at: new Date()
    };

    await coll.insertOne(podcast);

    // 清除缓存
    await clearPodcastCache();

    // 记录管理员操作日志
    const { logAdminAction } = require('../middleware/auth');
    await logAdminAction(req.user.id, 'create_podcast', podcastId, { title: podcast.title });

    res.json({
      success: true,
      data: {
        podcast_id: podcast.podcast_id,
        title: podcast.title,
        message: '播客创建成功'
      }
    });
  } catch (err) {
    console.error('创建播客失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ==================== 剧集管理API ====================

/**
 * 获取剧集管理列表
 * GET /api/podcast/admin/episodes
 */
router.get('/admin/episodes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const podcast_id = req.query.podcast_id || '';
    const keyword = req.query.keyword || '';
    const status = req.query.status || '';
    const skip = (page - 1) * limit;

    const episodesColl = await mongo.getPodcastEpisodesCollection();
    const podcastsColl = await mongo.getPodcastPodcastsCollection();

    const query = {};
    if (podcast_id) {
      query.podcast_id = podcast_id;
    }
    if (keyword) {
      query.$or = [
        { title: { $regex: keyword, $options: 'i' } },
        { description: { $regex: keyword, $options: 'i' } }
      ];
    }
    if (status) {
      query.status = status;
    }

    const [episodes, total] = await Promise.all([
      episodesColl.find(query).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      episodesColl.countDocuments(query)
    ]);

    // 获取播客信息
    const podcastIds = [...new Set(episodes.map(e => e.podcast_id))];
    const podcasts = await podcastsColl.find({ podcast_id: { $in: podcastIds } }).toArray();
    const podcastMap = new Map(podcasts.map(p => [p.podcast_id, p]));

    const data = episodes.map(ep => {
      const podcast = podcastMap.get(ep.podcast_id);
      return {
        episode_id: ep.episode_id,
        podcast_id: ep.podcast_id,
        podcast_title: podcast?.title || '未知播客',
        title: ep.title,
        description: ep.description,
        audio_url: convertAudioUrlToProxy(ep.audio_url) || '',
        duration: ep.duration || 0,
        cover_image: ep.cover_image,
        plays_count: ep.plays_count || 0,
        likes_count: ep.likes_count || 0,
        comments_count: ep.comments_count || 0,
        status: ep.status,
        published_at: ep.published_at,
        created_at: ep.created_at
      };
    });

    res.json({
      success: true,
      data: {
        episodes: data,
        total: total,
        page: page,
        limit: limit,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取剧集管理列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取剧集详情（管理员）
 * GET /api/podcast/admin/episodes/:episodeId
 */
router.get('/admin/episodes/:episodeId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { episodeId } = req.params;

    const episodesColl = await mongo.getPodcastEpisodesCollection();
    const episode = await episodesColl.findOne({ episode_id: episodeId });

    if (!episode) {
      return res.status(404).json({ error: '剧集不存在' });
    }

    // 获取播客信息
    const podcastsColl = await mongo.getPodcastPodcastsCollection();
    const podcast = await podcastsColl.findOne({ podcast_id: episode.podcast_id });

    res.json({
      success: true,
      data: {
        episode: {
          episode_id: episode.episode_id,
          podcast_id: episode.podcast_id,
          podcast_title: podcast?.title || '未知播客',
          title: episode.title,
          description: episode.description,
          audio_url: convertAudioUrlToProxy(episode.audio_url) || '',
          duration: episode.duration || 0,
          cover_image: episode.cover_image,
          plays_count: episode.plays_count || 0,
          likes_count: episode.likes_count || 0,
          comments_count: episode.comments_count || 0,
          status: episode.status,
          published_at: episode.published_at,
          created_at: episode.created_at,
          updated_at: episode.updated_at
        }
      }
    });
  } catch (err) {
    console.error('获取剧集详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 更新剧集（管理员）
 * PUT /api/podcast/admin/episodes/:episodeId
 */
router.put('/admin/episodes/:episodeId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { episodeId } = req.params;
    const { title, description, audio_url, duration, cover_image, status } = req.body;

    const episodesColl = await mongo.getPodcastEpisodesCollection();
    const episode = await episodesColl.findOne({ episode_id: episodeId });

    if (!episode) {
      return res.status(404).json({ error: '剧集不存在' });
    }

    const updateFields = {
      updated_at: new Date()
    };

    if (title !== undefined) updateFields.title = title.trim();
    if (description !== undefined) updateFields.description = description.trim();
    if (audio_url !== undefined) updateFields.audio_url = audio_url;
    if (duration !== undefined) updateFields.duration = parseInt(duration);
    if (cover_image !== undefined) updateFields.cover_image = cover_image;
    if (status !== undefined) updateFields.status = status;

    await episodesColl.updateOne(
      { episode_id: episodeId },
      { $set: updateFields }
    );

    // 清除缓存
    await clearPodcastCache(episode.podcast_id);

    // 记录管理员操作日志
    const { logAdminAction } = require('../middleware/auth');
    await logAdminAction(req.user.id, 'update_episode', episodeId, { title: title || episode.title });

    res.json({
      success: true,
      message: '剧集更新成功'
    });
  } catch (err) {
    console.error('更新剧集失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 删除剧集（管理员）
 * DELETE /api/podcast/admin/episodes/:episodeId
 */
router.delete('/admin/episodes/:episodeId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { episodeId } = req.params;

    const episodesColl = await mongo.getPodcastEpisodesCollection();
    const episode = await episodesColl.findOne({ episode_id: episodeId });

    if (!episode) {
      return res.status(404).json({ error: '剧集不存在' });
    }

    // 删除OSS音频文件
    if (episode.audio_url && episode.audio_url.includes('oss-')) {
      try {
        const audioKey = episode.audio_url.split('.com/')[1];
        if (audioKey) await oss.deleteFile(audioKey);
      } catch (err) {
        console.error('删除OSS音频文件失败:', err);
      }
    }

    // 删除剧集
    await episodesColl.deleteOne({ episode_id: episodeId });

    // 更新播客剧集数量
    const podcastsColl = await mongo.getPodcastPodcastsCollection();
    await podcastsColl.updateOne(
      { podcast_id: episode.podcast_id },
      { $inc: { episode_count: -1 } }
    );

    // 删除相关评论和点赞
    const commentsColl = await mongo.getPodcastCommentsCollection();
    await commentsColl.deleteMany({ episode_id: episodeId });

    const likesColl = await mongo.getPodcastLikesCollection();
    await likesColl.deleteMany({ episode_id: episodeId });

    // 清除缓存
    await clearPodcastCache(episode.podcast_id);

    // 记录管理员操作日志
    const { logAdminAction } = require('../middleware/auth');
    await logAdminAction(req.user.id, 'delete_episode', episodeId, { title: episode.title });

    res.json({
      success: true,
      message: '剧集删除成功'
    });
  } catch (err) {
    console.error('删除剧集失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 创建剧集（管理员）
 * POST /api/podcast/admin/episodes
 */
router.post('/admin/episodes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { podcast_id, title, description, audio_url, duration, cover_image, status } = req.body;

    if (!podcast_id) {
      return res.status(400).json({ error: '请指定播客ID' });
    }

    if (!title || title.trim().length < 2) {
      return res.status(400).json({ error: '剧集标题不能少于2个字符' });
    }

    if (!audio_url) {
      return res.status(400).json({ error: '请提供音频URL' });
    }

    // 检查播客是否存在
    const podcastsColl = await mongo.getPodcastPodcastsCollection();
    const podcast = await podcastsColl.findOne({ podcast_id: podcast_id });

    if (!podcast) {
      return res.status(404).json({ error: '播客不存在' });
    }

    const episodesColl = await mongo.getPodcastEpisodesCollection();
    const episodeId = generateEpisodeId();

    const episode = {
      episode_id: episodeId,
      podcast_id: podcast_id,
      title: title.trim(),
      description: description?.trim() || '',
      audio_url: audio_url,
      duration: parseInt(duration) || 0,
      cover_image: cover_image || podcast.cover_image,
      plays_count: 0,
      likes_count: 0,
      comments_count: 0,
      status: status || 'published',
      published_at: new Date(),
      created_at: new Date(),
      updated_at: new Date()
    };

    await episodesColl.insertOne(episode);

    // 更新播客的剧集数量
    await podcastsColl.updateOne(
      { podcast_id: podcast_id },
      {
        $inc: { episode_count: 1 },
        $set: { updated_at: new Date() }
      }
    );

    // 清除缓存
    await clearPodcastCache(podcast_id);

    // 记录管理员操作日志
    const { logAdminAction } = require('../middleware/auth');
    await logAdminAction(req.user.id, 'create_episode', episodeId, { title: episode.title, podcast_id });

    res.json({
      success: true,
      data: {
        episode_id: episode.episode_id,
        title: episode.title,
        message: '剧集创建成功'
      }
    });
  } catch (err) {
    console.error('创建剧集失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ==================== 评论管理API ====================

/**
 * 获取评论管理列表
 * GET /api/podcast/admin/comments
 */
router.get('/admin/comments', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const target_type = req.query.target_type || '';
    const target_id = req.query.target_id || '';
    const keyword = req.query.keyword || '';
    const skip = (page - 1) * limit;

    const commentsColl = await mongo.getPodcastCommentsCollection();

    const query = {};
    if (target_type) {
      query.target_type = target_type;
    }
    if (target_id) {
      query.target_id = target_id;
    }
    if (keyword) {
      query.content = { $regex: keyword, $options: 'i' };
    }

    const [comments, total] = await Promise.all([
      commentsColl.find(query).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      commentsColl.countDocuments(query)
    ]);

    // 获取用户信息
    const userIds = [...new Set(comments.map(c => c.user_id))];
    let users = {};
    if (userIds.length > 0) {
      const userRows = await db.query(
        `SELECT id, username FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`,
        userIds
      );
      users = userRows.reduce((acc, u) => {
        acc[u.id] = { username: u.username };
        return acc;
      }, {});
    }

    // 获取目标信息
    const podcastsColl = await mongo.getPodcastPodcastsCollection();
    const episodesColl = await mongo.getPodcastEpisodesCollection();

    const targetIds = [...new Set(comments.map(c => c.target_id))];
    const podcasts = await podcastsColl.find({ podcast_id: { $in: targetIds } }).toArray();
    const episodes = await episodesColl.find({ episode_id: { $in: targetIds } }).toArray();
    const podcastMap = new Map(podcasts.map(p => [p.podcast_id, p]));
    const episodeMap = new Map(episodes.map(e => [e.episode_id, e]));

    const data = comments.map(c => {
      let targetTitle = '';
      if (c.target_type === 'podcast') {
        const podcast = podcastMap.get(c.target_id);
        targetTitle = podcast?.title || '未知播客';
      } else if (c.target_type === 'episode') {
        const episode = episodeMap.get(c.target_id);
        targetTitle = episode?.title || '未知剧集';
      }

      return {
        comment_id: c.comment_id,
        target_id: c.target_id,
        target_type: c.target_type,
        target_title: targetTitle,
        user_id: c.user_id,
        username: users[c.user_id]?.username || '未知用户',
        content: c.content,
        created_at: c.created_at
      };
    });

    res.json({
      success: true,
      data: {
        comments: data,
        total: total,
        page: page,
        limit: limit,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取评论管理列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 删除评论（管理员）
 * DELETE /api/podcast/admin/comments/:commentId
 */
router.delete('/admin/comments/:commentId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { commentId } = req.params;

    const commentsColl = await mongo.getPodcastCommentsCollection();
    const comment = await commentsColl.findOne({ comment_id: commentId });

    if (!comment) {
      return res.status(404).json({ error: '评论不存在' });
    }

    await commentsColl.deleteOne({ comment_id: commentId });

    // 更新评论数
    if (comment.target_type === 'episode') {
      const episodesColl = await mongo.getPodcastEpisodesCollection();
      await episodesColl.updateOne(
        { episode_id: comment.target_id },
        { $inc: { comments_count: -1 } }
      );
    }

    // 记录管理员操作日志
    const { logAdminAction } = require('../middleware/auth');
    await logAdminAction(req.user.id, 'delete_podcast_comment', commentId, {
      content: comment.content.substring(0, 50)
    });

    res.json({
      success: true,
      message: '评论删除成功'
    });
  } catch (err) {
    console.error('删除评论失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取播客分享信息
 * GET /api/podcast/share/:podcastId
 */
router.get('/share/:podcastId', async (req, res) => {
  try {
    const { podcastId } = req.params;

    // 从游戏配置获取客户端URL
    let baseUrl = 'https://aibot1.com';
    try {
      const [configRow] = await db.query(
        "SELECT config_value FROM game_config WHERE config_key = 'client_socket_url'"
      );
      if (configRow && configRow.config_value) {
        // 提取域名部分（去掉http://或https://前缀）
        baseUrl = configRow.config_value.replace(/^https?:\/\//, '');
        // 如果没有协议头，加上https://
        if (!baseUrl.startsWith('http')) {
          baseUrl = 'https://' + baseUrl;
        }
      }
    } catch (err) {
      console.error('获取client_socket_url配置失败，使用默认值:', err.message);
    }

    const coll = await mongo.getPodcastPodcastsCollection();
    const podcast = await coll.findOne({ podcast_id: podcastId });

    if (!podcast) {
      return res.status(404).json({ error: '播客不存在' });
    }

    // 生成分享链接
    const shareUrl = `${baseUrl}/podcast.html#detail/${podcastId}`;

    // 生成二维码
    const qrcodeDataUrl = await QRCode.toDataURL(shareUrl, {
      width: 200,
      margin: 2,
      color: {
        dark: '#e91e63',
        light: '#ffffff'
      }
    });

    res.json({
      success: true,
      data: {
        podcast_id: podcast.podcast_id,
        title: podcast.title,
        description: podcast.description,
        cover_image: podcast.cover_image,
        author_name: podcast.author_name,
        author_avatar: podcast.author_avatar,
        category: podcast.category,
        tags: podcast.tags || [],
        episode_count: podcast.episode_count || 0,
        subscriber_count: podcast.subscriber_count || 0,
        total_plays: podcast.total_plays || 0,
        share_url: shareUrl,
        qrcode_data_url: qrcodeDataUrl
      }
    });
  } catch (err) {
    console.error('获取分享信息失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// 音频代理接口 - 解决跨域问题
// 将 /api/podcast/audio-proxy/podcast-audio/xxx.mp3 代理到 https://boke.skym178.com/podcast-audio/xxx.mp3
router.get('/audio-proxy/*', async (req, res) => {
  const path = req.params[0]; // 获取剩余路径，如 podcast-audio/xxx.mp3
  const ossUrl = `https://boke.skym178.com/${path}`;
  
  console.log('[audio-proxy] 代理请求:', ossUrl);
  
  try {
    const response = await fetch(ossUrl, {
      headers: {
        // 传递原始请求头
        'User-Agent': req.headers['user-agent'] || '',
        'Range': req.headers['range'] || '',
        'If-Range': req.headers['if-range'] || ''
      }
    });
    
    if (!response.ok) {
      console.error('[audio-proxy] OSS返回错误:', response.status, response.statusText);
      return res.status(response.status).json({ error: '获取音频失败: ' + response.statusText });
    }
    
    // 设置必要的响应头
    const contentType = response.headers.get('content-type') || 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    
    // 处理 Range 请求（播放进度跳转）
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    
    // 设置 CORS 头（虽然同域，但明确设置更安全）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    
    // 流式传输
    for await (const chunk of response.body) {
      res.write(chunk);
    }
    res.end();
  } catch (err) {
    console.error('[audio-proxy] 代理失败:', err);
    res.status(500).json({ error: '获取音频失败: ' + err.message });
  }
});

// 重新导出router以确保正确加载
module.exports = router;
