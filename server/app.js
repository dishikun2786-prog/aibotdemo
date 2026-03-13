/**
 * @file app.js
 * @module app
 * @description Express 主服务入口，挂载路由、中间件，初始化 Socket.io
 */
require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config/database');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const adminPublicRoutes = require('./routes/admin-public');
const adminVirtualAgentsRoutes = require('./routes/admin-virtual-agents');
const adminAiSkinsRoutes = require('./routes/admin-ai-skins');
const adminGameCodesRoutes = require('./routes/admin-game-codes');
const adminChessRoutes = require('./routes/admin-chess');
const battlesRoutes = require('./routes/battles');
const aiAgentsRoutes = require('./routes/ai-agents');
const energyRecordsRoutes = require('./routes/energy-records');
const storyRoutes = require('./routes/story');
const agentAvatarsRoutes = require('./routes/agent-avatars');
const agentKnowledgeRoutes = require('./routes/agent-knowledge');
const agentChatRoutes = require('./routes/agent-chat');
const agentChatAdminRoutes = require('./routes/agent-chat-admin');
const agentChatSocketRoutes = require('./routes/agent-chat-socket');
const leaderboardRoutes = require('./routes/leaderboard');
const plazaRoutes = require('./routes/plaza');
const podcastRoutes = require('./routes/podcast');
const chessRoutes = require('./routes/chess');
const userAvatarRoutes = require('./routes/user-avatar');
const novelRoutes = require('./routes/novel');
const pdf2textRoutes = require('./routes/pdf2text');
const energyTradeRoutes = require('./routes/energy-trade');
const skinCodesRoutes = require('./routes/skin-codes');
const visitorRoutes = require('./routes/visitor');
const visitorAdminRoutes = require('./routes/visitor-admin');
const db = require('./utils/db');
const socketServer = require('./socket');

const app = express();
const server = http.createServer(app);

// 配置信任代理（用于反向代理环境，如 Nginx）
// 设置为 1 表示信任第一个代理（通常是 Nginx）
// 这样可以避免 express-rate-limit 的安全警告
app.set('trust proxy', 1);

// 初始化Socket.io
socketServer.init(server);

// 启动消息队列Worker（异步任务处理）
const messageQueue = require('./services/message-queue');
messageQueue.startWorker().catch(err => {
  console.error('[App] 消息队列Worker启动失败:', err.message);
});

// 启动PK队列处理器
const pkQueue = require('./services/pk-queue');
pkQueue.startQueueProcessor();

// 中间件
app.use(cors({
  origin: config.server.corsOrigin,
  credentials: true
}));
// 对话接口支持上传图片（base64），需提高 body 限制（默认 100KB 不足）
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Favicon 处理（避免 404 错误）
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// API路由（必须在静态文件服务之前）
app.use('/api/auth', authRoutes);
app.use('/api/admin/public', adminPublicRoutes); // 公开接口，无需认证
app.use('/api/admin', adminRoutes);
app.use('/api/admin/virtual-agents', adminVirtualAgentsRoutes);
app.use('/api/admin/ai-skins', adminAiSkinsRoutes);
app.use('/api/admin/game-codes', adminGameCodesRoutes);
app.use('/api/admin/chess', adminChessRoutes);
app.use('/api/battles', battlesRoutes);
app.use('/api/ai-agents', aiAgentsRoutes);
app.use('/api/energy-records', energyRecordsRoutes);
app.use('/api/story', storyRoutes);
app.use('/api/agent-avatars', agentAvatarsRoutes);
app.use('/api/agent-knowledge', agentKnowledgeRoutes);
app.use('/api/agent-chat', agentChatRoutes);
app.use('/api/agent-chat-admin', agentChatAdminRoutes);
app.use('/api/agent-chat-socket', agentChatSocketRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/plaza', plazaRoutes);
app.use('/api/podcast', podcastRoutes);
app.use('/api/chess', chessRoutes);
app.use('/api/user', userAvatarRoutes);
app.use('/api/novel', novelRoutes);
app.use('/api/pdf2text', pdf2textRoutes);
app.use('/api/energy-trade', energyTradeRoutes);
app.use('/api/skin-codes', skinCodesRoutes);
app.use('/api/visitor', visitorRoutes);
app.use('/api/admin/visitor', visitorAdminRoutes);

// 初始化小说模块（确保默认小说存在）
const novel = require('./utils/novel');
novel.ensureDefaultBook().then(() => {
  console.log('[App] 小说模块初始化完成');
}).catch(err => {
  console.error('[App] 小说模块初始化失败:', err.message);
});

// 客服聊天页面路由（需要在 /:file 之前匹配）
app.get('/agent/chat/:avatar_id', (req, res) => {
  const filePath = path.resolve(__dirname, '..', 'agent-chat.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: '文件不存在' });
  }
});

// 分身客服后台页面路由
app.get('/agent/admin', (req, res) => {
  const filePath = path.resolve(__dirname, '..', 'agent-chat-admin.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: '文件不存在' });
  }
});

// 根路径路由 - 跳转到 index.html
app.get('/', (req, res) => {
  const filePath = path.resolve(__dirname, '..', 'index.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: '文件不存在' });
  }
});

// HTML 文件路由（安全地提供 HTML 文件）
const allowedHtmlFiles = ['game.html','admin-login.html','pdf2text.html','app.apk', 'landing.html','baixing.html', 'promotion.html', 'admin.html', 'index.html', 'supply-chain.html', 'aiwork.html', 'agent-chat.html', 'knowledge-manage.html', 'agent-chat-admin.html', 'leaderboard.html', 'plaza.html', 'chess-plaza.html', 'chess-room.html', 'login.html', 'register.html', 'energy-market.html', 'energy-my-ads.html', 'energy-my-trades.html', 'energy-trade-chat.html'];
allowedHtmlFiles.forEach(file => {
  app.get(`/${file}`, (req, res) => {
    let filePath = path.resolve(__dirname, '..', file);
    // 如果根目录没有，尝试 public 目录
    if (!fs.existsSync(filePath)) {
      filePath = path.resolve(__dirname, '..', 'public', file);
    }
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).json({ error: '文件不存在' });
    }
  });
});

// 优先处理 public 目录下的播客 HTML 文件
const podcastFiles = ['podcast.html', 'podcast-detail.html', 'podcast-create.html', 'audio-player.html'];
podcastFiles.forEach(file => {
  app.get(`/${file}`, (req, res) => {
    const filePath = path.resolve(__dirname, '..', 'public', file);
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).json({ error: '文件不存在' });
    }
  });
});

// 静态文件服务（用于 public 目录，如果存在）
app.use(express.static('public'));

// 404处理
app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

// 启动服务器
const PORT = config.server.port;
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
  console.log(`健康检查: http://localhost:${PORT}/health`);

  // 定期清理过期广告（每5分钟检查一次）
  setInterval(async () => {
    try {
      const result = await db.query(
        "UPDATE energy_ads SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()"
      );
      if (result.affectedRows > 0) {
        console.log(`[能量广告] 已更新 ${result.affectedRows} 个过期广告状态`);
      }
    } catch (err) {
      console.error('[能量广告] 清理过期广告失败:', err);
    }
  }, 5 * 60 * 1000);

  // 定期检查超时交易（每30秒检查一次）
  const energyTrade = require('./routes/energy-trade');
  setInterval(async () => {
    try {
      await energyTrade.processPaymentTimeout();
      await energyTrade.processConfirmTimeout();
    } catch (err) {
      console.error('[能量交易超时] 检查超时交易失败:', err);
    }
  }, 30 * 1000);
});

// 处理端口占用错误
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n错误: 端口 ${PORT} 已被占用！`);
    console.error(`请执行以下命令之一来释放端口：`);
    console.error(`  1. 查找并终止占用端口的进程:`);
    console.error(`     lsof -ti:${PORT} | xargs kill -9  (Linux/Mac)`);
    console.error(`     或`);
    console.error(`     netstat -ano | findstr :${PORT}  (Windows)`);
    console.error(`  2. 如果之前用 Ctrl+Z 挂起了进程，执行:`);
    console.error(`     jobs  # 查看挂起的任务`);
    console.error(`     kill %1  # 终止第一个挂起的任务`);
    console.error(`     或`);
    console.error(`     fg  # 恢复任务后按 Ctrl+C 终止`);
    process.exit(1);
  } else {
    console.error('服务器启动失败:', err);
    process.exit(1);
  }
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到SIGTERM信号，正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});

module.exports = app;
