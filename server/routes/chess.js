/**
 * @file chess.js
 * @module routes/chess
 * @description 象棋房间API - 房间管理、对战、观战功能
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const mongo = require('../utils/mongo');
const db = require('../utils/db');
const redis = require('../utils/redis');
const chessValidate = require('../utils/chess-validate');
const { authenticateToken, optionalAuth } = require('../middleware/auth');

// 默认配置
const DEFAULT_ENERGY_PER_GAME = 10;
const DEFAULT_TOTAL_GAMES = 3;
const MAX_ENERGY_PER_GAME = 100;
const MAX_TOTAL_GAMES = 11;
const MIN_ENERGY_PER_GAME = 1;

// 分布式锁超时时间（毫秒）
const LOCK_TIMEOUT = 5000;

/**
 * 恒定时间比较字符串，防止时序攻击
 * @param {string} a - 第一个字符串
 * @param {string} b - 第二个字符串
 * @returns {boolean} 是否相等
 */
function timingSafeEqual(a, b) {
  if (!a || !b) return a === b;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 辅助函数：处理房间数据转换为API响应格式
 */
function processRoomForAPI(room, currentUserId = null, createdRooms = []) {
  if (!room) return null;

  const roomId = room._id.toString();

  // 判断是否是创建者：已登录用户通过userId判断，未登录用户通过createdRooms数组判断
  const isCreator = currentUserId
    ? room.creatorId === currentUserId
    : createdRooms.includes(roomId);

  return {
    id: roomId,
    room_name: room.roomName,
    creator_id: room.creatorId,
    creator_name: room.creatorName,
    energy_per_game: room.energyPerGame || DEFAULT_ENERGY_PER_GAME,
    total_games: room.totalGames || DEFAULT_TOTAL_GAMES,
    current_games: room.currentGames || 0,
    red_player_id: room.redPlayerId,
    red_player_name: room.redPlayerName || '',
    black_player_id: room.blackPlayerId,
    black_player_name: room.blackPlayerName || '',
    current_turn: room.currentTurn || 'red',
    game_status: room.gameStatus || 'waiting',
    red_score: room.redScore || 0,
    black_score: room.blackScore || 0,
    viewer_count: room.viewerCount || 0,
    is_public: room.isPublic !== false,
    password: room.password ? '***' : '',
    // 游戏时长配置
    game_time_type: room.gameTimeType || 10,
    game_time: room.gameTime || 600,
    thinking_time: room.thinkingTime || 15,
    timeout: room.timeout || 10,
    game_start_time: room.gameStartTime,
    last_move_time: room.lastMoveTime,
    created_at: room.createdAt,
    updated_at: room.updatedAt,
    is_creator: isCreator,
    is_red_player: currentUserId ? room.redPlayerId === currentUserId : false,
    is_black_player: currentUserId ? room.blackPlayerId === currentUserId : false,
    is_viewer: currentUserId ? !room.redPlayerId && !room.blackPlayerId : false
  };
}

/**
 * 辅助函数：初始化棋盘
 */
function initBoard() {
  // 棋盘布局：null表示空位，{type, color}表示棋子
  // 颜色：red(红方)、black(黑方)
  // 棋子：帥(将)、仕(士)、相(象)、車、马、炮、兵(卒)
  const board = Array(10).fill(null).map(() => Array(9).fill(null));

  // 黑方棋子 (上方)
  board[0] = [
    { type: '車', color: 'black' }, { type: '馬', color: 'black' },
    { type: '相', color: 'black' }, { type: '士', color: 'black' },
    { type: '将', color: 'black' }, { type: '士', color: 'black' },
    { type: '相', color: 'black' }, { type: '馬', color: 'black' },
    { type: '車', color: 'black' }
  ];
  board[2][1] = { type: '炮', color: 'black' };
  board[2][7] = { type: '炮', color: 'black' };
  board[3][0] = { type: '卒', color: 'black' };
  board[3][2] = { type: '卒', color: 'black' };
  board[3][4] = { type: '卒', color: 'black' };
  board[3][6] = { type: '卒', color: 'black' };
  board[3][8] = { type: '卒', color: 'black' };

  // 红方棋子 (下方)
  board[9] = [
    { type: '車', color: 'red' }, { type: '馬', color: 'red' },
    { type: '相', color: 'red' }, { type: '仕', color: 'red' },
    { type: '帥', color: 'red' }, { type: '仕', color: 'red' },
    { type: '相', color: 'red' }, { type: '馬', color: 'red' },
    { type: '車', color: 'red' }
  ];
  board[7][1] = { type: '炮', color: 'red' };
  board[7][7] = { type: '炮', color: 'red' };
  board[6][0] = { type: '兵', color: 'red' };
  board[6][2] = { type: '兵', color: 'red' };
  board[6][4] = { type: '兵', color: 'red' };
  board[6][6] = { type: '兵', color: 'red' };
  board[6][8] = { type: '兵', color: 'red' };

  return board;
}

/**
 * 获取象棋房间列表
 * GET /api/chess/rooms
 */
router.get('/rooms', optionalAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const status = req.query.status; // waiting, playing, finished
    const myRooms = req.query.my === '1'; // 我的房间

    // 解析 created_rooms 参数（用于未登录时识别创建者身份）
    let createdRooms = [];
    if (req.query.created_rooms) {
      try {
        createdRooms = JSON.parse(req.query.created_rooms);
      } catch (e) {
        createdRooms = [];
      }
    }

    const query = { isDeleted: { $ne: true } };

    if (status) {
      query.gameStatus = status;
    }

    // 获取当前用户ID（如果已登录）
    // 使用req.user（由optionalAuth中间件设置）而不是重复解析token
    let currentUserId = null;
    if (req.user) {
      currentUserId = req.user.id;

      if (myRooms) {
        query.$or = [
          { creatorId: currentUserId },
          { redPlayerId: currentUserId },
          { blackPlayerId: currentUserId }
        ];
      }
    }

    const coll = await mongo.getChessRoomsCollection();
    const rooms = await coll
      .find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    const total = await coll.countDocuments(query);

    const processedRooms = rooms.map(room => processRoomForAPI(room, currentUserId, createdRooms));

    res.json({
      success: true,
      data: {
        rooms: processedRooms,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('获取象棋房间列表失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取象棋房间详情
 * GET /api/chess/rooms/:id
 */
router.get('/rooms/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // 使用req.user（由optionalAuth中间件设置）获取当前用户ID
    const currentUserId = req.user ? req.user.id : null;

    const room = await mongo.getChessRoom(id);

    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }

    if (room.isDeleted) {
      return res.status(404).json({ error: '房间已删除' });
    }

    // 返回棋盘状态（如果在对战中）
    const response = processRoomForAPI(room, currentUserId);

    // 如果是对战中的玩家或观战者，返回棋盘状态
    if (room.gameStatus === 'playing' && room.boardState) {
      response.board_state = JSON.parse(room.boardState);
    }

    res.json({ success: true, data: response });
  } catch (err) {
    console.error('获取象棋房间详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 创建象棋房间
 * POST /api/chess/rooms
 */
router.post('/rooms', authenticateToken, async (req, res) => {
  try {
    const { room_name, energy_per_game, total_games, is_public, password, game_time_type } = req.body;
    const userId = req.user.id;
    const username = req.user.username;

    // 验证房间名
    if (!room_name || room_name.trim().length === 0) {
      return res.status(400).json({ error: '请输入房间名称' });
    }

    if (room_name.length > 30) {
      return res.status(400).json({ error: '房间名称不能超过30个字符' });
    }

    // 验证能量设置
    const energyPerGame = Math.max(MIN_ENERGY_PER_GAME, Math.min(MAX_ENERGY_PER_GAME, parseInt(energy_per_game) || DEFAULT_ENERGY_PER_GAME));

    // 验证局数设置
    const totalGames = Math.max(1, Math.min(MAX_TOTAL_GAMES, parseInt(total_games) || DEFAULT_TOTAL_GAMES));

    // 游戏时长配置
    // 10分钟场：思考15秒，超时10秒后判负
    // 20分钟场：思考30秒，超时15秒后判负
    const gameTimeType = parseInt(game_time_type) || 10;
    let gameTimeConfig = {
      gameTime: 10 * 60, // 总时长（秒）
      thinkingTime: 15,  // 思考时长（秒）
      timeout: 10        // 超时时间（秒）
    };

    if (gameTimeType === 20) {
      gameTimeConfig = {
        gameTime: 20 * 60,
        thinkingTime: 30,
        timeout: 15
      };
    }

    // 检查用户能量是否充足
    const [user] = await db.query('SELECT energy FROM users WHERE id = ?', [userId]);
    if (!user || user.energy < energyPerGame) {
      return res.status(400).json({ error: `创建房间需要 ${energyPerGame} 点能量，当前能量不足` });
    }

    // 密码处理
    const roomPassword = password && password.trim() ? password.trim() : '';
    const isPublic = is_public !== false;

    // 创建房间 - 冻结能量（不是预扣）
    // 能量在对手加入时正式扣除，离开时解冻
    const roomData = {
      roomName: room_name.trim(),
      creatorId: userId,
      creatorName: username,
      energyPerGame,
      totalGames,
      currentGames: 0,
      redPlayerId: userId,
      redPlayerName: username,
      blackPlayerId: null,
      blackPlayerName: null,
      currentTurn: 'red',
      gameStatus: 'waiting',
      redScore: 0,
      blackScore: 0,
      viewerCount: 0,
      isPublic,
      password: roomPassword,
      isDeleted: false,
      frozenEnergy: energyPerGame,  // 冻结能量
      // 游戏时长配置
      gameTimeType: gameTimeType,
      gameTime: gameTimeConfig.gameTime,
      thinkingTime: gameTimeConfig.thinkingTime,
      timeout: gameTimeConfig.timeout,
      // 游戏开始时间（每局开始时更新）
      gameStartTime: null,
      // 上一步走棋时间
      lastMoveTime: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await mongo.createChessRoom(roomData);

    // 不再预扣能量，改为冻结（用户能量不受影响，只是锁定）
    // 实际扣除在对局开始时进行

    res.json({
      success: true,
      data: {
        room_id: result.insertedId.toString(),
        message: '房间创建成功，能量已冻结'
      }
    });
  } catch (err) {
    console.error('创建象棋房间失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 更新象棋房间设置
 * PUT /api/chess/rooms/:id
 */
router.put('/rooms/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { energy_per_game, total_games, is_public, password } = req.body;
    const userId = req.user.id;

    const room = await mongo.getChessRoom(id);

    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }

    if (room.creatorId !== userId) {
      return res.status(403).json({ error: '只有房主可以修改房间设置' });
    }

    if (room.gameStatus !== 'waiting') {
      return res.status(400).json({ error: '房间已开始游戏，无法修改设置' });
    }

    const updateData = {};

    if (energy_per_game !== undefined) {
      const energyPerGame = Math.max(MIN_ENERGY_PER_GAME, Math.min(MAX_ENERGY_PER_GAME, parseInt(energy_per_game)));
      updateData.energyPerGame = energyPerGame;
    }

    if (total_games !== undefined) {
      const totalGames = Math.max(1, Math.min(MAX_TOTAL_GAMES, parseInt(total_games)));
      updateData.totalGames = totalGames;
    }

    if (is_public !== undefined) {
      updateData.isPublic = is_public === true;
    }

    if (password !== undefined) {
      updateData.password = password && password.trim() ? password.trim() : '';
    }

    await mongo.updateChessRoom(id, updateData);

    res.json({ success: true, message: '房间设置已更新' });
  } catch (err) {
    console.error('更新象棋房间失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 删除象棋房间
 * DELETE /api/chess/rooms/:id
 */
router.delete('/rooms/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const room = await mongo.getChessRoom(id);

    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }

    if (room.creatorId !== userId) {
      return res.status(403).json({ error: '只有房主可以删除房间' });
    }

    // 软删除
    await mongo.updateChessRoom(id, { isDeleted: true });

    // 如果房间还在等待中，退还创建者冻结的能量
    if (room.gameStatus === 'waiting' && room.redPlayerId === userId) {
      // 退还冻结能量
      await db.execute(
        'UPDATE users SET energy = energy + ? WHERE id = ?',
        [room.energyPerGame, userId]
      );
    }

    res.json({ success: true, message: '房间已删除' });
  } catch (err) {
    console.error('删除象棋房间失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 加入象棋房间
 * POST /api/chess/rooms/:id/join
 */
router.post('/rooms/:id/join', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;
    const userId = req.user.id;
    const username = req.user.username;

    // 获取分布式锁防止并发加入
    const lockKey = `chess:join:${id}`;
    const lockAcquired = await redis.acquireLock(lockKey, String(userId), Math.ceil(LOCK_TIMEOUT / 1000));

    if (!lockAcquired) {
      return res.status(409).json({ error: '房间操作中，请稍后重试' });
    }

    try {
      const room = await mongo.getChessRoom(id);

      if (!room) {
        return res.status(404).json({ error: '房间不存在' });
      }

      if (room.isDeleted) {
        return res.status(404).json({ error: '房间已删除' });
      }

      // 验证密码 - 只有私密房间才需要验证密码
      // 使用恒定时间比较防止时序攻击
      if (!room.isPublic && room.password && room.password !== '') {
        if (!password || !timingSafeEqual(password, room.password)) {
          return res.status(403).json({ error: '房间密码错误' });
        }
      }

      // 检查用户是否已经在房间中
      if (room.redPlayerId === userId || room.blackPlayerId === userId) {
        // 如果游戏已结束，允许重新加入（重置房间）
        if (room.gameStatus === 'finished') {
          await mongo.updateChessRoom(id, {
            redPlayerId: null,
            redPlayerName: null,
            blackPlayerId: null,
            blackPlayerName: null,
            gameStatus: 'waiting',
            boardState: null,
            currentTurn: 'red',
            frozenEnergy: room.energyPerGame
          });
        } else if (room.gameStatus === 'waiting') {
          // 等待中只能以黑方加入，如果已经是红方则不能重复加入
          if (room.redPlayerId === userId) {
            return res.status(400).json({ error: '您已经在房间中' });
          }
          // 黑方不在，可以加入
        } else {
          // playing 状态，不能重复加入
          return res.status(400).json({ error: '您已经在房间中' });
        }
      }

      // 重新获取房间状态（如果刚刚重置了）
      const updatedRoom = await mongo.getChessRoom(id);
      const currentRoom = updatedRoom || room;

      // 检查房间状态
      if (currentRoom.gameStatus !== 'waiting') {
        return res.status(400).json({ error: '房间已开始游戏，请观战' });
      }

      // 检查用户能量（使用更新后的房间信息）
      const [user] = await db.query('SELECT energy FROM users WHERE id = ?', [userId]);
      if (!user || user.energy < currentRoom.energyPerGame) {
        return res.status(400).json({ error: `加入房间需要 ${currentRoom.energyPerGame} 点能量，当前能量不足` });
      }

      // 扣除双方能量（创建者的冻结能量解冻并扣除 + 加入者的能量扣除）
      await db.transaction(async (conn) => {
        // 解冻并扣除创建者的冻结能量
        await conn.execute(
          'UPDATE users SET energy = GREATEST(0, energy - ?) WHERE id = ?',
          [currentRoom.energyPerGame, currentRoom.creatorId]
        );

        // 扣除加入者的能量
        await conn.execute(
          'UPDATE users SET energy = GREATEST(0, energy - ?) WHERE id = ?',
          [currentRoom.energyPerGame, userId]
        );
      });

      // 加入房间作为黑方，同时开始游戏计时
      const gameStartTime = new Date();
      await mongo.updateChessRoom(id, {
        blackPlayerId: userId,
        blackPlayerName: username,
        gameStatus: 'playing',
        boardState: JSON.stringify(initBoard()),
        frozenEnergy: 0,  // 清除冻结能量标记
        gameStartTime: gameStartTime,  // 开始游戏计时
        lastMoveTime: gameStartTime   // 记录最后走棋时间
      });

      res.json({
        success: true,
        data: {
          color: 'black',
          message: '加入成功，请开始对战'
        }
      });
    } finally {
      // 释放分布式锁
      await redis.releaseLock(lockKey, String(userId));
    }
  } catch (err) {
    console.error('加入象棋房间失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 离开象棋房间
 * POST /api/chess/rooms/:id/leave
 */
router.post('/rooms/:id/leave', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // 获取分布式锁
    const lockKey = `chess:leave:${id}`;
    const lockAcquired = await redis.acquireLock(lockKey, String(userId), Math.ceil(LOCK_TIMEOUT / 1000));

    if (!lockAcquired) {
      return res.status(409).json({ error: '房间操作中，请稍后重试' });
    }

    try {
      const room = await mongo.getChessRoom(id);

      if (!room) {
        return res.status(404).json({ error: '房间不存在' });
      }

      // 检查用户是否是房间玩家
      let playerColor = null;
      if (room.redPlayerId === userId) {
        playerColor = 'red';
      } else if (room.blackPlayerId === userId) {
        playerColor = 'black';
      }

      if (!playerColor) {
        return res.status(400).json({ error: '您不在这个房间中' });
      }

      // 如果游戏已开始，玩家离开视为认输
      if (room.gameStatus === 'playing') {
        const winner = playerColor === 'red' ? 'black' : 'red';
        const winnerId = playerColor === 'red' ? room.blackPlayerId : room.redPlayerId;
        const loserId = playerColor === 'red' ? room.redPlayerId : room.blackPlayerId;

        // 能量结算 - 失败方能量转给获胜方
        if (winnerId && loserId) {
          await db.transaction(async (conn) => {
            await conn.execute(
              'UPDATE users SET energy = GREATEST(0, energy - ?) WHERE id = ?',
              [room.energyPerGame, loserId]
            );
            await conn.execute(
              'UPDATE users SET energy = energy + ? WHERE id = ?',
              [room.energyPerGame, winnerId]
            );
          });
        }

        // 更新房间状态 - 游戏结束
        await mongo.updateChessRoom(id, {
          gameStatus: 'finished',
          blackScore: winner === 'black' ? room.blackScore + 1 : room.blackScore,
          redScore: winner === 'red' ? room.redScore + 1 : room.redScore,
          currentGames: room.currentGames + 1
        });
      } else if (room.gameStatus === 'waiting') {
        // 等待中离开 - 退还创建者能量
        if (room.redPlayerId === userId) {
          await db.execute(
            'UPDATE users SET energy = energy + ? WHERE id = ?',
            [room.energyPerGame, userId]
          );
        }

        // 重置房间
        await mongo.updateChessRoom(id, {
          blackPlayerId: null,
          blackPlayerName: null,
          gameStatus: 'waiting',
          frozenEnergy: room.energyPerGame  // 恢复冻结能量
        });
      }

      res.json({ success: true, message: '已离开房间' });
    } finally {
      await redis.releaseLock(lockKey, String(userId));
    }
  } catch (err) {
    console.error('离开象棋房间失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取房间对局历史
 * GET /api/chess/rooms/:id/games
 */
router.get('/rooms/:id/games', async (req, res) => {
  try {
    const { id } = req.params;

    const room = await mongo.getChessRoom(id);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }

    const games = await mongo.getChessGamesByRoom(id);

    const processedGames = games.map(game => ({
      id: game._id.toString(),
      game_number: game.gameNumber,
      winner: game.winner,
      red_score: game.redScore || 0,
      black_score: game.blackScore || 0,
      moves_count: game.moves ? game.moves.length : 0,
      energy_exchanged: game.energyExchanged || 0,
      duration: game.duration || 0,
      started_at: game.startedAt,
      ended_at: game.endedAt
    }));

    res.json({ success: true, data: processedGames });
  } catch (err) {
    console.error('获取对局历史失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
