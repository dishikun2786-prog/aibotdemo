/**
 * @file plaza.js
 * @module routes/plaza
 * @description 玩家广场 - 帖子、评论、点赞功能 (MongoDB + Redis)
 */
const express = require('express');
const router = express.Router();
const mongo = require('../utils/mongo');
const redis = require('../utils/redis');
const captcha = require('../utils/captcha');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const socketServer = require('../socket');

// Redis Key 常量
const REDIS_KEYS = {
  POST_LIST: (page, kw) => `plaza:posts:${page}:${kw || 'all'}`,
  POST_DETAIL: (id) => `plaza:post:${id}`,
  POST_COUNT: (id) => `plaza:post:${id}:count`
};

// 缓存时间（秒）
const CACHE_TTL = {
  POST_LIST: 30,
  POST_DETAIL: 60
};

// 频率限制配置
const RATE_LIMIT = {
  POST: { max: 10, window: 3600 },    // 每小时10篇
  COMMENT: { max: 30, window: 600 },   // 每10分钟30条
  LIKE: { max: 60, window: 60 }        // 每分钟60次
};

/**
 * 检查频率限制
 */
async function checkRateLimit(userId, type) {
  const config = RATE_LIMIT[type];
  const key = `plaza:rate:${type}:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, config.window);
  }
  return count <= config.max;
}

/**
 * 清除帖子缓存
 */
async function clearPostCache(postId, page = null) {
  // 清除详情页缓存
  await redis.del(REDIS_KEYS.POST_DETAIL(postId));

  // 清除列表缓存 - 使用通配符清理所有可能的缓存
  try {
    // 获取所有 plaza:posts:* 开头的键并删除
    const listKeys = await redis.keys('plaza:posts:*');
    for (const key of listKeys) {
      await redis.del(key);
    }
  } catch (err) {
    console.error('清理帖子列表缓存失败:', err);
    // 备用方案：清理固定的缓存键
    for (let i = 1; i <= 50; i++) {
      await redis.del(REDIS_KEYS.POST_LIST(i, ''));
      await redis.del(REDIS_KEYS.POST_LIST(i, 'all'));
      await redis.del(REDIS_KEYS.POST_LIST(i, 'keyword'));
    }
  }
}

/**
 * 获取帖子列表（分页）
 * GET /api/plaza/posts?page=1&limit=20&keyword=xxx
 */
router.get('/posts', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const keyword = req.query.keyword || '';
    const skip = (page - 1) * limit;

    const isAuthenticated = req.headers.authorization && (() => {
      try {
        const token = req.headers.authorization.replace('Bearer ', '');
        const jwt = require('jsonwebtoken');
        jwt.verify(token, require('../config/database').JWT_SECRET);
        return true;
      } catch (e) {
        return false;
      }
    })();

    // 不使用缓存，确保每次获取最新数据
    // if (!isAuthenticated && page === 1) {
    //   const cached = await redis.get(cacheKey);
    //   if (cached) {
    //     let data = cached;
    //     if (typeof cached === 'string') {
    //       try {
    //         data = JSON.parse(cached);
    //       } catch (e) {
    //         console.error('缓存数据解析失败:', e);
    //       }
    //     }
    //     if (data.success) {
    //       return res.json(data);
    //     }
    //   }
    // }

    // 构建查询条件
    const query = { isDeleted: false };
    if (keyword) {
      query.$or = [
        { title: { $regex: keyword, $options: 'i' } },
        { content: { $regex: keyword, $options: 'i' } }
      ];
    }

    // 查询数据库
    const coll = await mongo.getPlazaPostsCollection();
    const posts = await coll
      .find(query)
      .sort({ isPinned: -1, sortOrder: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    // 获取总数
    const total = await coll.countDocuments(query);

    // 处理用户信息
    const db = require('../utils/db');

    // 获取当前用户的点赞状态
    let likedPostIds = new Set();
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.replace('Bearer ', '');
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, require('../config/database').JWT_SECRET);
        const likesColl = await mongo.getPlazaLikesCollection();
        const likedPosts = await likesColl.find({
          userId: parseInt(decoded.userId),
          targetType: 'post'
        }).toArray();
        likedPostIds = new Set(likedPosts.map(l => l.targetId.toString()));
      } catch (e) {
        // 未登录或token无效，忽略
      }
    }

    const processedPosts = await Promise.all(posts.map(async (post) => {
      let username = post.username;
      if (!username) {
        const [user] = await db.query('SELECT username FROM users WHERE id = ?', [post.userId]);
        username = user ? user.username : '未知用户';
      }
      return {
        id: post._id.toString(),
        user_id: post.userId,
        title: post.title,
        content: post.content,
        images: post.images || [],
        menus: post.menus || [],
        likes_count: post.likesCount || 0,
        comments_count: post.commentsCount || 0,
        views_count: post.viewsCount || 0,
        created_at: post.createdAt,
        updated_at: post.updatedAt,
        username,
        isLiked: likedPostIds.has(post._id.toString()),
        hasFreePKGroup: post.hasFreePKGroup || false,
        freePKGroupId: post.freePKGroupId ? post.freePKGroupId.toString() : null
      };
    }));

    const result = {
      success: true,
      data: {
        posts: processedPosts,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    };

    // 不使用缓存，确保每次获取最新数据（包括点赞状态）
    // if (page === 1 && !isAuthenticated) {
    //   await redis.set(cacheKey, JSON.stringify(result), CACHE_TTL.POST_LIST);
    // }

    res.json(result);
  } catch (err) {
    console.error('获取帖子列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取帖子详情
 * GET /api/plaza/posts/:id
 */
router.get('/posts/:id', async (req, res) => {
  try {
    const postId = req.params.id;

    // 检查用户是否已认证（用于缓存策略）
    const isAuthenticated = req.headers.authorization && (() => {
      try {
        const token = req.headers.authorization.replace('Bearer ', '');
        const jwt = require('jsonwebtoken');
        jwt.verify(token, require('../config/database').JWT_SECRET);
        return true;
      } catch (e) {
        return false;
      }
    })();

    // 不使用缓存，确保每次获取最新数据
    // const cacheKey = REDIS_KEYS.POST_DETAIL(postId);
    // if (!isAuthenticated) {
    //   const cached = await redis.get(cacheKey);
    //   if (cached) {
    //     let cachedData = cached;
    //     if (typeof cached === 'string') {
    //       cachedData = JSON.parse(cached);
    //     }
    //     // 增加浏览数
    //     const coll = await mongo.getPlazaPostsCollection();
    //     await coll.updateOne(
    //       { _id: require('mongodb').ObjectId.createFromHexString(postId) },
    //       { $inc: { viewsCount: 1 } }
    //     );
    //     cachedData.data.viewsCount = (cachedData.data.viewsCount || 0) + 1;
    //     return res.json(cachedData);
    //   }
    // }

    // 查询数据库
    const coll = await mongo.getPlazaPostsCollection();
    const post = await coll.findOne({
      _id: require('mongodb').ObjectId.createFromHexString(postId),
      isDeleted: false
    });

    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    // 增加浏览数
    await coll.updateOne(
      { _id: post._id },
      { $inc: { viewsCount: 1 } }
    );

    // 获取用户名
    const db = require('../utils/db');
    let username = post.username;
    if (!username) {
      const [user] = await db.query('SELECT username FROM users WHERE id = ?', [post.userId]);
      username = user ? user.username : '未知用户';
    }

    // 获取用户能量
    const [userInfo] = await db.query(
      'SELECT energy FROM users WHERE id = ?',
      [post.userId]
    );

    // 从Redis获取贡献值和福力值
    const LEADERBOARD_KEYS = {
      CONTRIBUTION_ZS: 'leaderboard:contribution:zs',
      FORTUNE_ZS: 'leaderboard:fortune:zs'
    };

    let contributionScore = 0;
    let fortuneScore = 0;

    try {
      // 尝试从Redis获取贡献值
      const contribScore = await redis.zScore(LEADERBOARD_KEYS.CONTRIBUTION_ZS, post.userId.toString());
      contributionScore = contribScore ? Math.abs(Math.round(contribScore)) : 0;

      // 尝试从Redis获取福力值
      const fortuneScoreVal = await redis.zScore(LEADERBOARD_KEYS.FORTUNE_ZS, post.userId.toString());
      fortuneScore = fortuneScoreVal ? Math.round(fortuneScoreVal) : 0;
    } catch (err) {
      // Redis获取失败时不阻塞，降级返回0
      console.error('获取贡献值/福力值失败:', err.message);
    }

    // 检查当前用户是否已点赞
    let isLiked = false;
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.replace('Bearer ', '');
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, require('../config/database').JWT_SECRET);
        const likesColl = await mongo.getPlazaLikesCollection();
        const like = await likesColl.findOne({
          userId: parseInt(decoded.userId),
          targetId: post._id,
          targetType: 'post'
        });
        isLiked = !!like;
      } catch (e) {
        // 未登录或token无效
      }
    }

    const result = {
      success: true,
      data: {
        id: post._id.toString(),
        user_id: post.userId,
        title: post.title,
        content: post.content,
        images: post.images || [],
        menus: post.menus || [],
        likes_count: post.likesCount || 0,
        comments_count: post.commentsCount || 0,
        views_count: post.viewsCount || 0,
        created_at: post.createdAt,
        updated_at: post.updatedAt,
        username,
        isLiked,
        user_energy: Math.max(0, userInfo?.energy || 0),
        contribution_score: contributionScore,
        fortune_score: fortuneScore,
        hasFreePKGroup: post.hasFreePKGroup || false,
        freePKGroupId: post.freePKGroupId ? post.freePKGroupId.toString() : null
      }
    };

    // 不使用缓存，确保每次获取最新数据（包括点赞状态）
    // if (!isAuthenticated) {
    //   await redis.set(cacheKey, JSON.stringify(result), CACHE_TTL.POST_DETAIL);
    // }

    res.json(result);
  } catch (err) {
    console.error('获取帖子详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 发布帖子
 * POST /api/plaza/posts
 * 需要验证码 + 频率限制
 */
router.post('/posts', authenticateToken, async (req, res) => {
  try {
    const { title, content, images, captchaId, captchaCode, menus } = req.body;
    const userId = req.user.id;
    const username = req.user.username;

    // 验证必填项
    if (!title || !title.trim()) {
      return res.status(400).json({ error: '请输入帖子标题' });
    }
    if (!content || !content.trim()) {
      return res.status(400).json({ error: '请输入帖子内容' });
    }
    if (title.length > 100) {
      return res.status(400).json({ error: '标题不能超过100个字符' });
    }

    // 验证菜单数据
    let validMenus = [];
    if (menus && Array.isArray(menus)) {
      if (menus.length > 6) {
        return res.status(400).json({ error: '最多只能添加6个菜单' });
      }
      for (const menu of menus) {
        if (!menu.name || !menu.name.trim()) {
          return res.status(400).json({ error: '菜单名称不能为空' });
        }
        if (menu.name.length > 20) {
          return res.status(400).json({ error: '菜单名称不能超过20个字符' });
        }
        if (!menu.url || !menu.url.trim()) {
          return res.status(400).json({ error: '菜单链接不能为空' });
        }
        try {
          new URL(menu.url);
        } catch (e) {
          return res.status(400).json({ error: '菜单链接格式不正确' });
        }
        validMenus.push({
          name: menu.name.trim(),
          url: menu.url.trim()
        });
      }
    }

    // 频率限制检查
    const canPost = await checkRateLimit(userId, 'POST');
    if (!canPost) {
      return res.status(400).json({ error: '发布过于频繁，请稍后再试' });
    }

    // 验证验证码
    if (!captchaId || !captchaCode) {
      return res.status(400).json({ error: '请输入验证码' });
    }
    const isValidCaptcha = await captcha.verifyCaptcha(captchaId, captchaCode);
    if (!isValidCaptcha) {
      return res.status(400).json({ error: '验证码错误或已过期' });
    }

    // 插入帖子
    const coll = await mongo.getPlazaPostsCollection();
    const now = new Date();
    const result = await coll.insertOne({
      userId,
      username,
      title: title.trim(),
      content: content.trim(),
      images: images && Array.isArray(images) ? images.slice(0, 9) : [],
      menus: validMenus,
      likesCount: 0,
      commentsCount: 0,
      viewsCount: 0,
      isDeleted: false,
      createdAt: now,
      updatedAt: now
    });

    const postId = result.insertedId;

    // 清除缓存
    await clearPostCache(postId.toString());

    // 广播新帖子给所有在线用户
    try {
      const plazaIO = socketServer.getPlazaIO();
      if (plazaIO) {
        plazaIO.to('plaza').emit('new_post', {
          id: postId.toString(),
          userId,
          username,
          title: title.trim(),
          content: content.trim(),
          images: images || [],
          menus: validMenus,
          likesCount: 0,
          commentsCount: 0,
          viewsCount: 0,
          createdAt: now
        });
      }
    } catch (e) {
      console.error('广播新帖子失败:', e.message);
    }

    res.json({
      success: true,
      message: '发布成功',
      data: {
        id: postId.toString(),
        userId,
        username,
        title: title.trim(),
        content: content.trim(),
        images: images || [],
        menus: validMenus,
        likesCount: 0,
        commentsCount: 0,
        viewsCount: 0,
        createdAt: now,
        updatedAt: now
      }
    });
  } catch (err) {
    console.error('发布帖子失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 编辑帖子
 * PUT /api/plaza/posts/:id
 * 需要验证码
 */
router.put('/posts/:id', authenticateToken, async (req, res) => {
  try {
    const postId = req.params.id;
    const { title, content, images, menus } = req.body;
    const userId = req.user.id;

    // 查询帖子
    const coll = await mongo.getPlazaPostsCollection();
    const post = await coll.findOne({
      _id: require('mongodb').ObjectId.createFromHexString(postId),
      isDeleted: false
    });

    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    // 检查权限
    if (post.userId !== userId) {
      return res.status(403).json({ error: '无权限编辑此帖子' });
    }

    // 验证验证码
    const { captchaId, captchaCode } = req.body;
    if (!captchaId || !captchaCode) {
      return res.status(400).json({ error: '请输入验证码' });
    }
    const isValidCaptcha = await captcha.verifyCaptcha(captchaId, captchaCode);
    if (!isValidCaptcha) {
      return res.status(400).json({ error: '验证码错误或已过期' });
    }

    // 验证必填项
    if (!title || !title.trim()) {
      return res.status(400).json({ error: '请输入帖子标题' });
    }
    if (!content || !content.trim()) {
      return res.status(400).json({ error: '请输入帖子内容' });
    }

    // 验证菜单数据
    let validMenus = [];
    if (menus !== undefined) {
      if (!Array.isArray(menus)) {
        return res.status(400).json({ error: '菜单数据格式不正确' });
      }
      if (menus.length > 6) {
        return res.status(400).json({ error: '最多只能添加6个菜单' });
      }
      for (const menu of menus) {
        if (!menu.name || !menu.name.trim()) {
          return res.status(400).json({ error: '菜单名称不能为空' });
        }
        if (menu.name.length > 20) {
          return res.status(400).json({ error: '菜单名称不能超过20个字符' });
        }
        if (!menu.url || !menu.url.trim()) {
          return res.status(400).json({ error: '菜单链接不能为空' });
        }
        try {
          new URL(menu.url);
        } catch (e) {
          return res.status(400).json({ error: '菜单链接格式不正确' });
        }
        validMenus.push({
          name: menu.name.trim(),
          url: menu.url.trim()
        });
      }
    }

    // 更新帖子
    const updateData = {
      title: title.trim(),
      content: content.trim(),
      updatedAt: new Date()
    };
    if (images !== undefined) {
      updateData.images = images && Array.isArray(images) ? images.slice(0, 9) : [];
    }
    // 如果帖子有关联PK自由团，不允许修改菜单（PK团信息）
    if (post.hasFreePKGroup) {
      if (menus !== undefined) {
        return res.status(400).json({ error: '该帖子关联了PK自由团，无法修改菜单' });
      }
      console.log(`[Plaza] 帖子 ${postId} 有关联PK团，编辑时保留了原有菜单`);
    } else if (menus !== undefined) {
      updateData.menus = validMenus;
    }

    await coll.updateOne(
      { _id: post._id },
      { $set: updateData }
    );

    // 清除缓存
    await clearPostCache(postId);

    res.json({
      success: true,
      message: '更新成功'
    });
  } catch (err) {
    console.error('编辑帖子失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 删除帖子
 * DELETE /api/plaza/posts/:id
 */
router.delete('/posts/:id', authenticateToken, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    // 查询帖子
    const coll = await mongo.getPlazaPostsCollection();
    const post = await coll.findOne({
      _id: require('mongodb').ObjectId.createFromHexString(postId)
    });

    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    // 检查权限（帖子作者或管理员可删除）
    if (post.userId !== userId && !req.user.is_admin) {
      return res.status(403).json({ error: '无权限删除此帖子' });
    }

    // 软删除
    await coll.updateOne(
      { _id: post._id },
      { $set: { isDeleted: true } }
    );

    // 同时删除相关评论和点赞
    const commentsColl = await mongo.getPlazaCommentsCollection();
    await commentsColl.updateMany(
      { postId: post._id },
      { $set: { isDeleted: true } }
    );

    const likesColl = await mongo.getPlazaLikesCollection();
    await likesColl.deleteMany({
      targetId: post._id,
      targetType: 'post'
    });

    // 清除缓存
    await clearPostCache(postId);

    res.json({
      success: true,
      message: '删除成功'
    });
  } catch (err) {
    console.error('删除帖子失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取帖子评论列表
 * GET /api/plaza/posts/:id/comments
 */
router.get('/posts/:id/comments', async (req, res) => {
  try {
    const postId = req.params.id;

    const commentsColl = await mongo.getPlazaCommentsCollection();
    const comments = await commentsColl
      .find({
        postId: require('mongodb').ObjectId.createFromHexString(postId),
        isDeleted: false
      })
      .sort({ createdAt: 1 })
      .toArray();

    // 构建树形结构
    const commentMap = {};
    const rootComments = [];

    comments.forEach(comment => {
      comment.children = [];
      commentMap[comment._id.toString()] = comment;
    });

    comments.forEach(comment => {
      if (!comment.parentId || comment.parentId.toString() === '000000000000000000000000') {
        rootComments.push(comment);
      } else {
        const parentIdStr = comment.parentId.toString();
        if (commentMap[parentIdStr]) {
          commentMap[parentIdStr].children.push(comment);
        } else {
          rootComments.push(comment);
        }
      }
    });

    // 处理当前用户点赞状态
    let likedComments = new Set();
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.replace('Bearer ', '');
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, require('../config/database').JWT_SECRET);
        const likesColl = await mongo.getPlazaLikesCollection();
        const liked = await likesColl.find({
          userId: parseInt(decoded.userId),
          targetType: 'comment'
        }).toArray();
        likedComments = new Set(liked.map(l => l.targetId.toString()));
      } catch (e) {
        // 未登录
      }
    }

    // 格式化输出
    const formatComment = (comment) => ({
      id: comment._id.toString(),
      postId: comment.postId.toString(),
      userId: comment.userId,
      username: comment.username || '匿名用户',
      parentId: comment.parentId ? comment.parentId.toString() : '0',
      replyTo: comment.replyTo || null, // 被回复人用户名
      content: comment.content,
      likes_count: comment.likesCount || 0,
      isLiked: likedComments.has(comment._id.toString()),
      created_at: comment.createdAt,
      children: comment.children.map(formatComment)
    });

    res.json({
      success: true,
      data: rootComments.map(formatComment)
    });
  } catch (err) {
    console.error('获取评论列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 发布评论
 * POST /api/plaza/comments
 * 需要频率限制
 */
router.post('/comments', authenticateToken, async (req, res) => {
  try {
    const { postId, parentId, content } = req.body;
    const userId = req.user.id;
    const username = req.user.username;

    // 频率限制检查
    const canComment = await checkRateLimit(userId, 'COMMENT');
    if (!canComment) {
      return res.status(400).json({ error: '评论过于频繁，请稍后再试' });
    }

    // 验证必填项
    if (!postId) {
      return res.status(400).json({ error: '帖子ID不能为空' });
    }
    if (!content || !content.trim()) {
      return res.status(400).json({ error: '请输入评论内容' });
    }
    if (content.length > 500) {
      return res.status(400).json({ error: '评论内容不能超过500个字符' });
    }

    // 验证帖子是否存在
    const postsColl = await mongo.getPlazaPostsCollection();
    const post = await postsColl.findOne({
      _id: require('mongodb').ObjectId.createFromHexString(postId),
      isDeleted: false
    });
    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    // 处理父评论ID
    let parentIdValue = null;
    let replyToUsername = null; // 被回复人的用户名
    if (parentId) {
      const commentsColl = await mongo.getPlazaCommentsCollection();
      const parentComment = await commentsColl.findOne({
        _id: require('mongodb').ObjectId.createFromHexString(parentId),
        postId: require('mongodb').ObjectId.createFromHexString(postId),
        isDeleted: false
      });
      if (!parentComment) {
        return res.status(400).json({ error: '父评论不存在' });
      }
      parentIdValue = parentComment._id;
      replyToUsername = parentComment.username; // 保存被回复人的用户名
    }

    // 插入评论
    const commentsColl = await mongo.getPlazaCommentsCollection();
    const now = new Date();
    const result = await commentsColl.insertOne({
      postId: require('mongodb').ObjectId.createFromHexString(postId),
      userId,
      username,
      parentId: parentIdValue,
      replyTo: replyToUsername, // 保存被回复人的用户名
      content: content.trim(),
      likesCount: 0,
      isDeleted: false,
      createdAt: now
    });

    // 更新帖子评论数
    await postsColl.updateOne(
      { _id: post._id },
      { $inc: { commentsCount: 1 } }
    );

    // 清除缓存
    await clearPostCache(postId);

    res.json({
      success: true,
      message: '评论成功',
      data: {
        id: result.insertedId.toString(),
        postId,
        userId,
        username,
        parentId: parentId || '0',
        replyTo: replyToUsername, // 被回复人用户名
        content: content.trim(),
        likes_count: 0,
        isLiked: false,
        created_at: now,
        children: []
      }
    });
  } catch (err) {
    console.error('发布评论失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 删除评论
 * DELETE /api/plaza/comments/:id
 */
router.delete('/comments/:id', authenticateToken, async (req, res) => {
  try {
    const commentId = req.params.id;
    const userId = req.user.id;

    // 查询评论
    const commentsColl = await mongo.getPlazaCommentsCollection();
    const comment = await commentsColl.findOne({
      _id: require('mongodb').ObjectId.createFromHexString(commentId)
    });

    if (!comment) {
      return res.status(404).json({ error: '评论不存在' });
    }

    // 检查权限
    if (comment.userId !== userId && !req.user.is_admin) {
      return res.status(403).json({ error: '无权限删除此评论' });
    }

    // 软删除
    await commentsColl.updateOne(
      { _id: comment._id },
      { $set: { isDeleted: true } }
    );

    // 更新帖子评论数
    const postsColl = await mongo.getPlazaPostsCollection();
    await postsColl.updateOne(
      { _id: comment.postId },
      { $inc: { commentsCount: -1 } }
    );

    // 删除相关点赞
    const likesColl = await mongo.getPlazaLikesCollection();
    await likesColl.deleteMany({
      targetId: comment._id,
      targetType: 'comment'
    });

    // 清除缓存
    await clearPostCache(comment.postId.toString());

    res.json({
      success: true,
      message: '删除成功'
    });
  } catch (err) {
    console.error('删除评论失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 点赞/取消点赞
 * POST /api/plaza/like
 * 需要频率限制
 */
router.post('/like', authenticateToken, async (req, res) => {
  try {
    const { targetId, targetType } = req.body;
    const userId = req.user.id;

    console.log('[点赞API] 收到请求:', { targetId, targetType, userId });

    // 验证参数
    if (!targetId || !targetType) {
      return res.status(400).json({ error: '参数不完整' });
    }
    if (!['post', 'comment'].includes(targetType)) {
      return res.status(400).json({ error: '无效的目标类型' });
    }

    // 验证targetId是否为有效的24位hex字符串
    if (!/^[a-fA-F0-9]{24}$/.test(targetId)) {
      return res.status(400).json({ error: '无效的目标ID' });
    }

    // 频率限制检查
    const canLike = await checkRateLimit(userId, 'LIKE');
    if (!canLike) {
      return res.status(400).json({ error: '操作过于频繁，请稍后再试' });
    }

    const targetObjectId = require('mongodb').ObjectId.createFromHexString(targetId);
    const likesColl = await mongo.getPlazaLikesCollection();

    // 检查是否已点赞
    const existingLike = await likesColl.findOne({
      userId,
      targetId: targetObjectId,
      targetType
    });

    let isLiked;
    if (existingLike) {
      // 取消点赞
      await likesColl.deleteOne({ _id: existingLike._id });

      // 更新点赞数
      if (targetType === 'post') {
        const postsColl = await mongo.getPlazaPostsCollection();
        await postsColl.updateOne(
          { _id: targetObjectId },
          { $inc: { likesCount: -1 } }
        );
      } else {
        const commentsColl = await mongo.getPlazaCommentsCollection();
        await commentsColl.updateOne(
          { _id: targetObjectId },
          { $inc: { likesCount: -1 } }
        );
      }

      isLiked = false;
    } else {
      // 添加点赞
      const insertResult = await likesColl.insertOne({
        userId,
        targetId: targetObjectId,
        targetType,
        createdAt: new Date()
      });
      console.log('[点赞] 插入结果:', insertResult);

      // 验证插入是否成功
      const verifyLike = await likesColl.findOne({ _id: insertResult.insertedId });
      console.log('[点赞] 验证查询结果:', verifyLike);

      // 更新点赞数
      if (targetType === 'post') {
        const postsColl = await mongo.getPlazaPostsCollection();
        await postsColl.updateOne(
          { _id: targetObjectId },
          { $inc: { likesCount: 1 } }
        );
      } else {
        const commentsColl = await mongo.getPlazaCommentsCollection();
        await commentsColl.updateOne(
          { _id: targetObjectId },
          { $inc: { likesCount: 1 } }
        );
      }

      isLiked = true;
    }

    // 获取最新的点赞数
    let likesCount = 0;
    if (targetType === 'post') {
      const postsColl = await mongo.getPlazaPostsCollection();
      const post = await postsColl.findOne({ _id: targetObjectId });
      likesCount = post ? post.likesCount || 0 : 0;
    } else {
      const commentsColl = await mongo.getPlazaCommentsCollection();
      const comment = await commentsColl.findOne({ _id: targetObjectId });
      likesCount = comment ? comment.likesCount || 0 : 0;
    }

    // 清除缓存
    if (targetType === 'post') {
      await clearPostCache(targetId);
    }

    // 广播点赞更新给所有在线用户
    try {
      const plazaIO = socketServer.getPlazaIO();
      if (plazaIO) {
        plazaIO.to('plaza').emit('like_update', {
          targetId,
          targetType,
          likes_count: likesCount,
          isLiked
        });
      }
    } catch (e) {
      console.error('广播点赞更新失败:', e.message);
    }

    res.json({
      success: true,
      data: {
        isLiked,
        likes_count: likesCount
      }
    });
  } catch (err) {
    console.error('点赞操作失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取用户发布的帖子列表
 * GET /api/plaza/user/:id/posts
 */
router.get('/user/:id/posts', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const coll = await mongo.getPlazaPostsCollection();
    const query = { userId, isDeleted: false };

    const posts = await coll
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await coll.countDocuments(query);

    const processedPosts = posts.map(post => ({
      id: post._id.toString(),
      user_id: post.userId,
      title: post.title,
      content: post.content,
      images: post.images || [],
      likesCount: post.likesCount || 0,
      commentsCount: post.commentsCount || 0,
      viewsCount: post.viewsCount || 0,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt
    }));

    res.json({
      success: true,
      data: {
        posts: processedPosts,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('获取用户帖子列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取当前用户信息
 * GET /api/plaza/me
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const db = require('../utils/db');
    const [user] = await db.query(
      'SELECT id, username, energy, wins, losses FROM users WHERE id = ?',
      [userId]
    );

    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // 统计MongoDB中的帖子数、评论数
    const postsColl = await mongo.getPlazaPostsCollection();
    const commentsColl = await mongo.getPlazaCommentsCollection();

    const postCount = await postsColl.countDocuments({ userId, isDeleted: false });
    const commentCount = await commentsColl.countDocuments({ userId, isDeleted: false });

    res.json({
      success: true,
      data: {
        ...user,
        postCount,
        commentCount,
        totalLikes: 0
      }
    });
  } catch (err) {
    console.error('获取用户信息失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ============================================
// 自由PK团相关API
// ============================================

/**
 * 获取用户参与的PK团记录
 * GET /api/plaza/free-pk/my
 */
router.get('/free-pk/my', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const participantsColl = await mongo.getPlazaFreePKParticipantsCollection();
    const groupsColl = await mongo.getPlazaFreePKGroupsCollection();

    // 查询用户参与的PK团
    const participantFilter = { userId };
    const total = await participantsColl.countDocuments(participantFilter);

    const participants = await participantsColl
      .find(participantFilter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    // 获取每个PK团的详细信息
    const groupsMap = new Map();
    const groupIds = [...new Set(participants.map(p => p.groupId.toString()))];

    for (const groupId of groupIds) {
      const group = await mongo.getFreePKGroup(groupId);
      if (group) {
        groupsMap.set(groupId, group);
      }
    }

    const list = participants.map(p => {
      const group = groupsMap.get(p.groupId.toString());
      return {
        participantId: p._id.toString(),
        groupId: p.groupId.toString(),
        postId: group?.postId?.toString(),
        energyCost: group?.energyCost || 0,
        maxParticipants: group?.maxParticipants || 0,
        status: group?.status || 'unknown',
        isWinner: p.status === 'winner',
        isEliminated: p.status === 'eliminated' || p.status === 'pk_lose',
        result: p.status === 'winner' ? 'winner' : (p.status === 'eliminated' || p.status === 'pk_lose' ? 'eliminated' : 'pending'),
        king: p.king,
        assassin: p.assassin,
        energyChange: p.energyChange || 0,
        fortuneChange: p.fortuneChange || 0,
        contributionChange: p.contributionChange || 0,
        createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
        completedAt: group?.completedAt ? new Date(group.completedAt).toISOString() : null
      };
    });

    res.json({
      success: true,
      data: {
        list,
        total,
        page,
        limit
      }
    });
  } catch (err) {
    console.error('获取我的PK团记录失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 创建自由PK团帖子
 * POST /api/plaza/free-pk/create
 */
router.post('/free-pk/create', authenticateToken, async (req, res) => {
  try {
    const { postId, energyCost, maxParticipants, validHours, king, assassin } = req.body;
    const userId = req.user.id;
    const username = req.user.username;

    if (!postId) {
      return res.status(400).json({ error: '帖子ID不能为空' });
    }
    if (!energyCost || energyCost < 10 || energyCost > 1000) {
      return res.status(400).json({ error: '参与能量必须在10-1000之间' });
    }
    if (!maxParticipants || maxParticipants < 2 || maxParticipants > 10) {
      return res.status(400).json({ error: '参与人数必须在2-10之间' });
    }
    if (!validHours || validHours < 1 || validHours > 72) {
      return res.status(400).json({ error: '有效时间必须在1-72小时之间' });
    }
    if (!king || king < 1 || king > 100) {
      return res.status(400).json({ error: '攻击值必须在1-100之间' });
    }
    if (!assassin || assassin < 1 || assassin > 100) {
      return res.status(400).json({ error: '防御值必须在1-100之间' });
    }

    const postsColl = await mongo.getPlazaPostsCollection();
    const post = await postsColl.findOne({
      _id: require('mongodb').ObjectId.createFromHexString(postId),
      isDeleted: false
    });
    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    if (post.userId !== userId) {
      return res.status(403).json({ error: '只有帖子作者才能创建自由PK团' });
    }

    const db = require('../utils/db');
    const [user] = await db.query('SELECT energy FROM users WHERE id = ?', [userId]);
    if (!user || user.energy < energyCost) {
      return res.status(400).json({ error: '能量不足，无法创建PK团' });
    }

    const expiredAt = new Date();
    expiredAt.setHours(expiredAt.getHours() + validHours);

    const groupResult = await mongo.createFreePKGroup({
      postId: require('mongodb').ObjectId.createFromHexString(postId),
      creatorId: userId,
      creatorUsername: username,
      energyCost,
      maxParticipants,
      validHours,
      expiredAt,
      winnerId: null,
      winnerUsername: null,
      totalPrize: 0
    });

    const groupId = groupResult.insertedId;

    await db.transaction(async (conn) => {
      await conn.execute(
        'UPDATE users SET energy = GREATEST(0, energy - ?) WHERE id = ?',
        [energyCost, userId]
      );

      await mongo.addFreePKParticipant({
        groupId,
        userId,
        username,
        king,
        assassin,
        isCreator: true
      });
    });

    await postsColl.updateOne(
      { _id: post._id },
      { $set: { hasFreePKGroup: true, freePKGroupId: groupId } }
    );

    const participants = await mongo.getFreePKParticipants(groupId.toString());

    res.json({
      success: true,
      message: '自由PK团创建成功',
      data: {
        groupId: groupId.toString(),
        energyCost,
        maxParticipants,
        validHours,
        expiredAt,
        participants: participants.map(p => ({
          id: p._id.toString(),
          userId: p.userId,
          username: p.username,
          king: p.king,
          assassin: p.assassin,
          isCreator: p.isCreator,
          status: p.status
        }))
      }
    });
  } catch (err) {
    console.error('创建自由PK团失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 加入自由PK团
 * POST /api/plaza/free-pk/join
 */
router.post('/free-pk/join', authenticateToken, async (req, res) => {
  const lockKey = `lock:free-pk:${req.body.groupId}`;
  const lockValue = `join_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  let lockAcquired = false;

  try {
    const { groupId, king, assassin } = req.body;
    const userId = req.user.id;
    const username = req.user.username;

    if (!groupId) {
      return res.status(400).json({ error: 'PK团ID不能为空' });
    }
    if (!king || king < 1 || king > 100) {
      return res.status(400).json({ error: '攻击值必须在1-100之间' });
    }
    if (!assassin || assassin < 1 || assassin > 100) {
      return res.status(400).json({ error: '防御值必须在1-100之间' });
    }

    // 使用分布式锁防止并发加入
    const redis = require('../utils/redis');
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      lockAcquired = await redis.acquireLock(lockKey, lockValue, 10);
      if (lockAcquired) {
        break;
      }
      retryCount++;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (!lockAcquired) {
      return res.status(429).json({ error: '系统繁忙，请稍后重试' });
    }

    // 在锁内再次检查PK团状态
    const group = await mongo.getFreePKGroup(groupId);
    if (!group) {
      await redis.releaseLock(lockKey, lockValue);
      return res.status(404).json({ error: 'PK团不存在' });
    }

    if (group.status !== 'waiting') {
      await redis.releaseLock(lockKey, lockValue);
      return res.status(400).json({ error: 'PK团已开始或已结束' });
    }

    if (new Date() > group.expiredAt) {
      await mongo.updateFreePKGroup(groupId, { status: 'expired' });
      await redis.releaseLock(lockKey, lockValue);
      return res.status(400).json({ error: 'PK团已过期' });
    }

    const hasJoined = await mongo.hasJoinedFreePK(groupId, userId);
    if (hasJoined) {
      await redis.releaseLock(lockKey, lockValue);
      return res.status(400).json({ error: '您已加入此PK团' });
    }

    const participants = await mongo.getFreePKParticipants(groupId);
    if (participants.length >= group.maxParticipants) {
      await redis.releaseLock(lockKey, lockValue);
      return res.status(400).json({ error: 'PK团已满员' });
    }

    const db = require('../utils/db');
    const [user] = await db.query('SELECT energy FROM users WHERE id = ?', [userId]);
    if (!user || user.energy < group.energyCost) {
      await redis.releaseLock(lockKey, lockValue);
      return res.status(400).json({ error: '能量不足，无法加入PK团' });
    }

    // 使用事务扣减能量并添加参与者
    await db.transaction(async (conn) => {
      await conn.execute(
        'UPDATE users SET energy = GREATEST(0, energy - ?) WHERE id = ?',
        [group.energyCost, userId]
      );

      await mongo.addFreePKParticipant({
        groupId: group._id,
        userId,
        username,
        king,
        assassin,
        isCreator: false
      });
    });

    const updatedParticipants = await mongo.getFreePKParticipants(groupId);
    let pkStarted = false;

    // 在锁内再次检查是否满员
    if (updatedParticipants.length >= group.maxParticipants) {
      // 将PK计算放入队列异步执行（状态更新由队列处理）
      const pkQueue = require('../services/pk-queue');
      await pkQueue.enqueuePKStart(groupId);

      const postsColl = await mongo.getPlazaPostsCollection();
      await postsColl.updateOne(
        { _id: group.postId },
        { $set: { freePKGroupId: group._id } }
      );

      // 注意：不再在这里预先更新状态为 'ongoing'
      // 由队列处理器 startPKGroup 来更新状态

      // 广播PK即将开始
      try {
        const plazaIO = socketServer.getPlazaIO();
        if (plazaIO) {
          plazaIO.emit('free_pk_update', {
            groupId: groupId,
            status: 'ongoing',
            message: 'PK即将开始...',
            timestamp: Date.now()
          });
        }
      } catch (err) {
        console.error('广播PK开始失败:', err);
      }

      pkStarted = true;
    }

    // 释放锁
    await redis.releaseLock(lockKey, lockValue);

    res.json({
      success: true,
      message: pkStarted ? '加入成功，PK已开始！' : '加入成功',
      data: {
        participants: updatedParticipants.map(p => ({
          id: p._id.toString(),
          userId: p.userId,
          username: p.username,
          king: p.king,
          assassin: p.assassin,
          isCreator: p.isCreator,
          status: p.status
        })),
        pkStarted
      }
    });
  } catch (err) {
    console.error('加入自由PK团失败:', err);
    // 确保释放锁
    try {
      const redis = require('../utils/redis');
      await redis.releaseLock(lockKey, lockValue);
    } catch (releaseErr) {
      console.error('释放锁失败:', releaseErr);
    }
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取PK团状态
 * GET /api/plaza/free-pk/:groupId
 */
router.get('/free-pk/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;

    const group = await mongo.getFreePKGroup(groupId);
    if (!group) {
      return res.status(404).json({ error: 'PK团不存在' });
    }

    const participants = await mongo.getFreePKParticipants(groupId);

    res.json({
      success: true,
      data: {
        groupId: group._id.toString(),
        postId: group.postId.toString(),
        creatorId: group.creatorId,
        creatorUsername: group.creatorUsername,
        energyCost: group.energyCost,
        maxParticipants: group.maxParticipants,
        validHours: group.validHours,
        status: group.status,
        createdAt: group.createdAt,
        expiredAt: group.expiredAt,
        completedAt: group.completedAt,
        winnerId: group.winnerId,
        winnerUsername: group.winnerUsername,
        totalPrize: group.totalPrize,
        pkResults: group.pkResults || [],
        participants: participants.map(p => ({
          id: p._id.toString(),
          userId: p.userId,
          username: p.username,
          king: p.king,
          assassin: p.assassin,
          isCreator: p.isCreator,
          status: p.status,
          energyChange: p.energyChange || 0,
          fortuneChange: p.fortuneChange || 0,
          contributionChange: p.contributionChange || 0
        }))
      }
    });
  } catch (err) {
    console.error('获取PK团状态失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 手动开始PK（创建者）
 * POST /api/plaza/free-pk/start
 */
router.post('/free-pk/start', authenticateToken, async (req, res) => {
  const lockKey = `lock:free-pk:start:${req.body.groupId}`;
  const lockValue = `start_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  let lockAcquired = false;

  try {
    const { groupId } = req.body;
    const userId = req.user.id;

    // 使用分布式锁防止并发开始
    const redis = require('../utils/redis');
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      lockAcquired = await redis.acquireLock(lockKey, lockValue, 10);
      if (lockAcquired) {
        break;
      }
      retryCount++;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (!lockAcquired) {
      return res.status(429).json({ error: '系统繁忙，请稍后重试' });
    }

    const group = await mongo.getFreePKGroup(groupId);
    if (!group) {
      await redis.releaseLock(lockKey, lockValue);
      return res.status(404).json({ error: 'PK团不存在' });
    }

    if (group.creatorId !== userId) {
      await redis.releaseLock(lockKey, lockValue);
      return res.status(403).json({ error: '只有创建者才能手动开始PK' });
    }

    if (group.status !== 'waiting') {
      await redis.releaseLock(lockKey, lockValue);
      return res.status(400).json({ error: 'PK团已开始或已结束' });
    }

    const participants = await mongo.getFreePKParticipants(groupId);
    if (participants.length < 2) {
      await redis.releaseLock(lockKey, lockValue);
      return res.status(400).json({ error: '至少需要2人才能开始PK' });
    }

    // 将PK计算放入队列异步执行（状态更新由队列处理）
    const pkQueue = require('../services/pk-queue');
    await pkQueue.enqueuePKStart(groupId);

    // 广播PK即将开始（状态由队列处理器更新）
    try {
      const plazaIO = socketServer.getPlazaIO();
      if (plazaIO) {
        plazaIO.emit('free_pk_update', {
          groupId: groupId,
          status: 'ongoing',
          message: 'PK即将开始...',
          timestamp: Date.now()
        });
      }
    } catch (err) {
      console.error('广播PK开始失败:', err);
    }

    // 释放锁
    await redis.releaseLock(lockKey, lockValue);

    res.json({
      success: true,
      message: 'PK已开始，请稍候...'
    });
  } catch (err) {
    console.error('开始PK失败:', err);
    // 确保释放锁
    try {
      const redis = require('../utils/redis');
      await redis.releaseLock(lockKey, lockValue);
    } catch (releaseErr) {
      console.error('释放锁失败:', releaseErr);
    }
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取PK团详情（管理员）
 * GET /api/plaza/admin/free-pk/:groupId
 */
router.get('/admin/free-pk/:groupId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { groupId } = req.params;

    const group = await mongo.getFreePKGroup(groupId);
    if (!group) {
      return res.status(404).json({ error: 'PK团不存在' });
    }

    const participants = await mongo.getFreePKParticipants(groupId);

    res.json({
      success: true,
      data: {
        groupId: group._id.toString(),
        postId: group.postId?.toString(),
        creatorId: group.creatorId,
        creatorUsername: group.creatorUsername,
        energyCost: group.energyCost,
        maxParticipants: group.maxParticipants,
        validHours: group.validHours,
        status: group.status,
        createdAt: group.createdAt,
        expiredAt: group.expiredAt,
        completedAt: group.completedAt,
        winnerId: group.winnerId,
        winnerUsername: group.winnerUsername,
        totalPrize: group.totalPrize,
        participants: participants.map(p => ({
          id: p._id.toString(),
          userId: p.userId,
          username: p.username,
          king: p.king,
          assassin: p.assassin,
          isCreator: p.isCreator,
          status: p.status,
          energyChange: p.energyChange || 0,
          fortuneChange: p.fortuneChange || 0,
          contributionChange: p.contributionChange || 0
        }))
      }
    });
  } catch (err) {
    console.error('获取PK团详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 修改PK团状态（管理员）
 * PUT /api/plaza/admin/free-pk/:groupId/status
 */
router.put('/admin/free-pk/:groupId/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { status } = req.body;
    const adminId = req.user.id;

    const validStatuses = ['waiting', 'ongoing', 'completed', 'expired'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: '无效的状态' });
    }

    const group = await mongo.getFreePKGroup(groupId);
    if (!group) {
      return res.status(404).json({ error: 'PK团不存在' });
    }

    const oldStatus = group.status;
    await mongo.updateFreePKGroup(groupId, { status });

    // 记录管理员操作（PK团ID放在details中，因为target_id只支持数字ID）
    const db = require('../utils/db');
    await db.query(
      'INSERT INTO admin_logs (admin_id, action, details) VALUES (?, ?, ?)',
      [adminId, 'update_free_pk_status', JSON.stringify({ groupId, oldStatus, newStatus: status })]
    );

    res.json({
      success: true,
      message: `PK团状态已从 ${oldStatus} 更新为 ${status}`
    });
  } catch (err) {
    console.error('修改PK团状态失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 删除PK团（管理员）
 * DELETE /api/plaza/admin/free-pk/:groupId
 */
router.delete('/admin/free-pk/:groupId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { groupId } = req.params;
    const adminId = req.user.id;

    const group = await mongo.getFreePKGroup(groupId);
    if (!group) {
      return res.status(404).json({ error: 'PK团不存在' });
    }

    const participants = await mongo.getFreePKParticipants(groupId);
    const db = require('../utils/db');

    let energyReturned = false;
    let message = 'PK团已删除';

    // 只有waiting和ongoing状态才退回能量
    if (group.status === 'waiting' || group.status === 'ongoing') {
      await db.transaction(async (conn) => {
        for (const p of participants) {
          // 退还能量
          await conn.execute(
            'UPDATE users SET energy = energy + ? WHERE id = ?',
            [group.energyCost, p.userId]
          );
        }
      });
      energyReturned = true;
      message = `PK团已删除，能量已退还（${participants.length}人 x ${group.energyCost}能量）`;
    }

    // 删除PK团和参与者
    await mongo.deleteFreePKGroup(groupId);

    // 记录管理员操作（PK团ID放在details中，因为target_id只支持数字ID）
    await db.query(
      'INSERT INTO admin_logs (admin_id, action, details) VALUES (?, ?, ?)',
      [adminId, 'delete_free_pk_group', JSON.stringify({
        groupId: group._id.toString(),
        status: group.status,
        participantsCount: participants.length,
        energyReturned,
        energyCost: group.energyCost
      })]
    );

    res.json({
      success: true,
      message
    });
  } catch (err) {
    console.error('删除PK团失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;

/**
 * ==========================================
 * 管理后台接口 - 帖子管理
 * ==========================================
 */

/**
 * 获取帖子列表（管理后台）
 * GET /api/plaza/admin/posts?page=1&limit=20&keyword=xxx&includeDeleted=false
 */
router.get('/admin/posts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const keyword = req.query.keyword || '';
    const includeDeleted = req.query.includeDeleted === 'true';
    const skip = (page - 1) * limit;

    // 构建查询条件
    const query = includeDeleted ? {} : { isDeleted: false };
    if (keyword) {
      query.$or = [
        { title: { $regex: keyword, $options: 'i' } },
        { content: { $regex: keyword, $options: 'i' } },
        { username: { $regex: keyword, $options: 'i' } }
      ];
    }

    // 查询数据库
    const coll = await mongo.getPlazaPostsCollection();
    const posts = await coll
      .find(query)
      .sort({ isPinned: -1, sortOrder: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    // 获取总数
    const total = await coll.countDocuments(query);

    // 查询每个帖子的PK团信息
    for (const post of posts) {
      // 使用帖子上的 freePKGroupId 字段来查询PK团
      if (post.freePKGroupId) {
        const pkGroup = await mongo.getFreePKGroup(post.freePKGroupId.toString());
        if (pkGroup) {
          const pkParticipants = await mongo.getFreePKParticipants(pkGroup._id.toString());
          post.freePKGroup = {
            groupId: pkGroup._id.toString(),
            status: pkGroup.status,
            energyCost: pkGroup.energyCost,
            maxParticipants: pkGroup.maxParticipants,
            participantCount: pkParticipants.length,
            winnerUsername: pkGroup.winnerUsername,
            createdAt: pkGroup.createdAt
          };
        }
      }
    }

    // 处理输出格式
    const processedPosts = posts.map(post => {
      const baseData = {
        id: post._id.toString(),
        user_id: post.userId,
        username: post.username || '未知用户',
        title: post.title,
        content: post.content,
        images: post.images || [],
        likes_count: post.likesCount || 0,
        comments_count: post.commentsCount || 0,
        views_count: post.viewsCount || 0,
        is_pinned: post.isPinned || false,
        sort_order: post.sortOrder || 0,
        is_deleted: post.isDeleted || false,
        created_at: post.createdAt,
        updated_at: post.updatedAt
      };

      // 添加PK团信息
      if (post.freePKGroup) {
        baseData.free_pk_group = post.freePKGroup;
      }

      return baseData;
    });

    res.json({
      success: true,
      data: {
        posts: processedPosts,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('获取帖子列表失败(管理后台):', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取帖子详情（管理后台）
 * GET /api/plaza/admin/posts/:id
 */
router.get('/admin/posts/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const postId = req.params.id;

    const coll = await mongo.getPlazaPostsCollection();
    const post = await coll.findOne({
      _id: require('mongodb').ObjectId.createFromHexString(postId)
    });

    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    res.json({
      success: true,
      data: {
        id: post._id.toString(),
        user_id: post.userId,
        username: post.username || '未知用户',
        title: post.title,
        content: post.content,
        images: post.images || [],
        likes_count: post.likesCount || 0,
        comments_count: post.commentsCount || 0,
        views_count: post.viewsCount || 0,
        is_pinned: post.isPinned || false,
        sort_order: post.sortOrder || 0,
        is_deleted: post.isDeleted || false,
        created_at: post.createdAt,
        updated_at: post.updatedAt
      }
    });
  } catch (err) {
    console.error('获取帖子详情失败(管理后台):', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 更新帖子（管理后台）
 * PUT /api/plaza/admin/posts/:id
 */
router.put('/admin/posts/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const postId = req.params.id;
    const { title, content, images } = req.body;

    const coll = await mongo.getPlazaPostsCollection();
    const post = await coll.findOne({
      _id: require('mongodb').ObjectId.createFromHexString(postId)
    });

    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    // 更新数据
    const updateData = { updatedAt: new Date() };
    if (title !== undefined) updateData.title = title.trim();
    if (content !== undefined) updateData.content = content.trim();
    if (images !== undefined) updateData.images = images && Array.isArray(images) ? images.slice(0, 9) : [];

    await coll.updateOne(
      { _id: post._id },
      { $set: updateData }
    );

    // 清除缓存
    await clearPostCache(postId);

    // 记录管理员操作日志
    const { logAdminAction } = require('../middleware/auth');
    await logAdminAction(req.user.id, 'update_plaza_post', post.userId, {
      postId,
      updatedFields: Object.keys(updateData).filter(k => k !== 'updatedAt')
    });

    res.json({
      success: true,
      message: '更新成功'
    });
  } catch (err) {
    console.error('更新帖子失败(管理后台):', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 删除帖子（管理后台 - 软删除）
 * DELETE /api/plaza/admin/posts/:id
 */
router.delete('/admin/posts/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const postId = req.params.id;

    const coll = await mongo.getPlazaPostsCollection();
    const post = await coll.findOne({
      _id: require('mongodb').ObjectId.createFromHexString(postId)
    });

    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    // 软删除
    await coll.updateOne(
      { _id: post._id },
      { $set: { isDeleted: true, updatedAt: new Date() } }
    );

    // 同时删除相关评论和点赞
    const commentsColl = await mongo.getPlazaCommentsCollection();
    await commentsColl.updateMany(
      { postId: post._id },
      { $set: { isDeleted: true } }
    );

    const likesColl = await mongo.getPlazaLikesCollection();
    await likesColl.deleteMany({
      targetId: post._id,
      targetType: 'post'
    });

    // 清除缓存
    await clearPostCache(postId);

    // 记录管理员操作日志
    const { logAdminAction } = require('../middleware/auth');
    await logAdminAction(req.user.id, 'delete_plaza_post', post.userId, { postId });

    res.json({
      success: true,
      message: '删除成功'
    });
  } catch (err) {
    console.error('删除帖子失败(管理后台):', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 置顶/取消置顶帖子
 * POST /api/plaza/admin/posts/:id/pin
 */
router.post('/admin/posts/:id/pin', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const postId = req.params.id;
    const { isPinned } = req.body;

    const coll = await mongo.getPlazaPostsCollection();
    const post = await coll.findOne({
      _id: require('mongodb').ObjectId.createFromHexString(postId)
    });

    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    // 更新置顶状态
    await coll.updateOne(
      { _id: post._id },
      { $set: { isPinned: !!isPinned, updatedAt: new Date() } }
    );

    // 清除缓存
    await clearPostCache(postId);

    // 记录管理员操作日志
    const { logAdminAction } = require('../middleware/auth');
    await logAdminAction(req.user.id, isPinned ? 'pin_plaza_post' : 'unpin_plaza_post', post.userId, { postId });

    res.json({
      success: true,
      message: isPinned ? '置顶成功' : '取消置顶成功'
    });
  } catch (err) {
    console.error('置顶帖子失败(管理后台):', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 更新帖子排序权重
 * PUT /api/plaza/admin/posts/:id/sort-order
 */
router.put('/admin/posts/:id/sort-order', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const postId = req.params.id;
    const { sortOrder } = req.body;

    if (sortOrder === undefined || isNaN(Number(sortOrder))) {
      return res.status(400).json({ error: '请提供有效的排序权重' });
    }

    const coll = await mongo.getPlazaPostsCollection();
    const post = await coll.findOne({
      _id: require('mongodb').ObjectId.createFromHexString(postId)
    });

    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    // 更新排序权重
    await coll.updateOne(
      { _id: post._id },
      { $set: { sortOrder: Number(sortOrder), updatedAt: new Date() } }
    );

    // 清除缓存
    await clearPostCache(postId);

    // 记录管理员操作日志
    const { logAdminAction } = require('../middleware/auth');
    await logAdminAction(req.user.id, 'update_plaza_post_sort_order', post.userId, {
      postId,
      sortOrder: Number(sortOrder)
    });

    res.json({
      success: true,
      message: '排序权重更新成功'
    });
  } catch (err) {
    console.error('更新排序权重失败(管理后台):', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 批量更新帖子排序
 * POST /api/plaza/admin/posts/batch-sort
 */
router.post('/admin/posts/batch-sort', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { posts } = req.body; // [{ id: 'xxx', sortOrder: 1 }, ...]

    if (!posts || !Array.isArray(posts) || posts.length === 0) {
      return res.status(400).json({ error: '请提供要排序的帖子列表' });
    }

    const coll = await mongo.getPlazaPostsCollection();
    const ObjectId = require('mongodb').ObjectId;

    // 批量更新
    for (const item of posts) {
      if (!item.id || !/^[a-fA-F0-9]{24}$/.test(item.id)) continue;

      await coll.updateOne(
        { _id: ObjectId.createFromHexString(item.id) },
        { $set: { sortOrder: Number(item.sortOrder) || 0, updatedAt: new Date() } }
      );
    }

    // 清除所有帖子缓存
    try {
      const listKeys = await redis.keys('plaza:posts:*');
      for (const key of listKeys) {
        await redis.del(key);
      }
    } catch (err) {
      console.error('清理帖子列表缓存失败:', err);
    }

    // 记录管理员操作日志
    const { logAdminAction } = require('../middleware/auth');
    await logAdminAction(req.user.id, 'batch_sort_plaza_posts', null, {
      postCount: posts.length
    });

    res.json({
      success: true,
      message: '批量排序更新成功'
    });
  } catch (err) {
    console.error('批量更新排序失败(管理后台):', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});
