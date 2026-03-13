/**
 * @file admin-chess.js
 * @module routes/admin-chess
 * @description 管理员后台：象棋房间和对局记录管理
 */
const express = require('express');
const router = express.Router();
const mongo = require('../utils/mongo');
const { authenticateToken, requireAdmin, logAdminAction } = require('../middleware/auth');

router.use(authenticateToken);
router.use(requireAdmin);

/**
 * 辅助函数：处理房间数据转换为API响应格式
 */
function processRoomForAPI(room) {
  if (!room) return null;

  return {
    id: room._id.toString(),
    room_name: room.roomName,
    creator_id: room.creatorId,
    creator_name: room.creatorName,
    energy_per_game: room.energyPerGame || 10,
    total_games: room.totalGames || 3,
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
    red_ai: room.redAI || false,    // 红方AI接管状态
    black_ai: room.blackAI || false, // 黑方AI接管状态
    created_at: room.createdAt,
    updated_at: room.updatedAt,
    board_state: room.boardState ? JSON.parse(room.boardState) : null,
    moves: room.moves || []
  };
}

/**
 * 辅助函数：处理对局数据转换为API响应格式
 */
function processGameForAPI(game) {
  if (!game) return null;

  return {
    id: game._id.toString(),
    room_id: game.roomId.toString(),
    game_number: game.gameNumber,
    red_player_id: game.redPlayerId,
    black_player_id: game.blackPlayerId,
    winner: game.winner,
    red_score: game.redScore || 0,
    black_score: game.blackScore || 0,
    moves: game.moves || [],
    energy_exchanged: game.energyExchanged || 0,
    started_at: game.startedAt,
    ended_at: game.endedAt
  };
}

// ==================== 象棋房间管理 ====================

/**
 * 获取象棋房间列表
 * GET /api/admin/chess/rooms
 */
router.get('/rooms', async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', status = '' } = req.query;

    const filter = {};
    if (search) filter.search = search;
    if (status) filter.status = status;

    const result = await mongo.getAllChessRooms(filter, {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { createdAt: -1 }
    });

    const rooms = result.rooms.map(room => processRoomForAPI(room));

    res.json({
      success: true,
      data: rooms,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: result.total,
        totalPages: Math.ceil(result.total / limit)
      }
    });
  } catch (err) {
    console.error('获取象棋房间列表失败:', err);
    res.status(500).json({ error: '获取象棋房间列表失败' });
  }
});

/**
 * 获取象棋房间详情
 * GET /api/admin/chess/rooms/:id
 */
router.get('/rooms/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const room = await mongo.getChessRoomById(id);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }

    res.json({
      success: true,
      data: processRoomForAPI(room)
    });
  } catch (err) {
    console.error('获取象棋房间详情失败:', err);
    res.status(500).json({ error: '获取象棋房间详情失败' });
  }
});

/**
 * 更新象棋房间
 * PUT /api/admin/chess/rooms/:id
 */
router.put('/rooms/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { room_name, energy_per_game, total_games, is_public, game_status } = req.body;

    const room = await mongo.getChessRoomById(id);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }

    const update = { updatedAt: new Date() };

    if (room_name !== undefined) {
      update.roomName = room_name;
    }
    if (energy_per_game !== undefined) {
      update.energyPerGame = parseInt(energy_per_game);
    }
    if (total_games !== undefined) {
      update.totalGames = parseInt(total_games);
    }
    if (is_public !== undefined) {
      update.isPublic = is_public;
    }
    if (game_status !== undefined) {
      update.gameStatus = game_status;
    }

    await mongo.updateChessRoom(id, update);

    // 记录操作日志
    await logAdminAction(req.user.id, 'update_chess_room', id, {
      roomName: room.roomName,
      updates: update
    });

    res.json({
      success: true,
      message: '房间更新成功'
    });
  } catch (err) {
    console.error('更新象棋房间失败:', err);
    res.status(500).json({ error: '更新象棋房间失败' });
  }
});

/**
 * 删除象棋房间（软删除）
 * DELETE /api/admin/chess/rooms/:id
 */
router.delete('/rooms/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const room = await mongo.getChessRoomById(id);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }

    // 软删除
    await mongo.updateChessRoom(id, {
      isDeleted: true
    });

    // 记录操作日志
    await logAdminAction(req.user.id, 'delete_chess_room', id, {
      roomName: room.roomName
    });

    res.json({
      success: true,
      message: '房间删除成功'
    });
  } catch (err) {
    console.error('删除象棋房间失败:', err);
    res.status(500).json({ error: '删除象棋房间失败' });
  }
});

/**
 * 管理员创建象棋房间
 * POST /api/admin/chess/rooms
 */
router.post('/rooms', async (req, res) => {
  try {
    const { room_name, energy_per_game, total_games, is_public, password } = req.body;

    // 验证房间名
    if (!room_name || room_name.trim().length === 0) {
      return res.status(400).json({ error: '请输入房间名称' });
    }

    if (room_name.length > 30) {
      return res.status(400).json({ error: '房间名称不能超过30个字符' });
    }

    // 默认值
    const energyPerGame = Math.max(1, Math.min(100, parseInt(energy_per_game) || 10));
    const totalGames = Math.max(1, Math.min(11, parseInt(total_games) || 3));
    const isPublic = is_public !== false;
    const roomPassword = password && password.trim() ? password.trim() : '';

    // 管理员创建房间，无需能量检查
    const roomData = {
      roomName: room_name.trim(),
      creatorId: req.user.id,  // 管理员ID作为创建者
      creatorName: '管理员',
      energyPerGame,
      totalGames,
      currentGames: 0,
      redPlayerId: null,
      redPlayerName: null,
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
      frozenEnergy: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await mongo.createChessRoom(roomData);

    // 记录操作日志
    await logAdminAction(req.user.id, 'create_chess_room', result.insertedId.toString(), {
      roomName: room_name.trim(),
      energyPerGame,
      totalGames,
      isPublic
    });

    res.json({
      success: true,
      message: '房间创建成功',
      data: {
        id: result.insertedId.toString(),
        room_name: room_name.trim(),
        energy_per_game: energyPerGame,
        total_games: totalGames,
        is_public: isPublic,
        game_status: 'waiting'
      }
    });
  } catch (err) {
    console.error('创建象棋房间失败:', err);
    res.status(500).json({ error: '创建象棋房间失败' });
  }
});

/**
 * 强制玩家离场
 * POST /api/admin/chess/rooms/:id/force-leave
 */
router.post('/rooms/:id/force-leave', async (req, res) => {
  try {
    const { id } = req.params;
    const { side } = req.body; // 'red', 'black', 或 'all'

    if (!side || !['red', 'black', 'all'].includes(side)) {
      return res.status(400).json({ error: '请指定离场方：red, black, 或 all' });
    }

    const room = await mongo.getChessRoomById(id);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }

    const update = {
      updatedAt: new Date()
    };
    const leaveInfo = [];

    // 处理红方离场
    if ((side === 'red' || side === 'all') && room.redPlayerId) {
      update.redPlayerId = null;
      update.redPlayerName = null;
      // 如果游戏进行中，红方离场视为黑方获胜
      if (room.gameStatus === 'playing') {
        update.gameStatus = 'finished';
        update.blackScore = (room.blackScore || 0) + 1;
        update.currentGames = (room.currentGames || 0) + 1;
      }
      leaveInfo.push({ side: 'red', playerId: room.redPlayerId, playerName: room.redPlayerName });
    }

    // 处理黑方离场
    if ((side === 'black' || side === 'all') && room.blackPlayerId) {
      update.blackPlayerId = null;
      update.blackPlayerName = null;
      // 如果游戏进行中，黑方离场视为红方获胜
      if (room.gameStatus === 'playing') {
        update.gameStatus = 'finished';
        update.redScore = (room.redScore || 0) + 1;
        update.currentGames = (room.currentGames || 0) + 1;
      }
      leaveInfo.push({ side: 'black', playerId: room.blackPlayerId, playerName: room.blackPlayerName });
    }

    // 如果双方都离场，重置游戏状态
    if (!room.redPlayerId && !room.blackPlayerId && side === 'all') {
      update.gameStatus = 'waiting';
      update.currentTurn = 'red';
    }

    await mongo.updateChessRoom(id, update);

    // 记录操作日志
    await logAdminAction(req.user.id, 'force_leave_chess_room', id, {
      roomName: room.roomName,
      side,
      leaveInfo
    });

    res.json({
      success: true,
      message: '玩家已强制离场',
      data: {
        side,
        leaveInfo
      }
    });
  } catch (err) {
    console.error('强制玩家离场失败:', err);
    res.status(500).json({ error: '强制玩家离场失败' });
  }
});

// ==================== 对局记录管理 ====================

/**
 * 获取对局记录列表
 * GET /api/admin/chess/games
 */
router.get('/games', async (req, res) => {
  try {
    const { page = 1, limit = 20, room_id = '', winner = '' } = req.query;

    const filter = {};
    if (room_id) filter.roomId = room_id;
    if (winner) filter.winner = winner;

    const result = await mongo.getAllChessGames(filter, {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { startedAt: -1 }
    });

    const games = result.games.map(game => processGameForAPI(game));

    res.json({
      success: true,
      data: games,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: result.total,
        totalPages: Math.ceil(result.total / limit)
      }
    });
  } catch (err) {
    console.error('获取对局记录列表失败:', err);
    res.status(500).json({ error: '获取对局记录列表失败' });
  }
});

/**
 * 获取对局记录详情（含完整棋谱）
 * GET /api/admin/chess/games/:id
 */
router.get('/games/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const game = await mongo.getChessGameById(id);
    if (!game) {
      return res.status(404).json({ error: '对局记录不存在' });
    }

    res.json({
      success: true,
      data: processGameForAPI(game)
    });
  } catch (err) {
    console.error('获取对局详情失败:', err);
    res.status(500).json({ error: '获取对局详情失败' });
  }
});

/**
 * 删除对局记录
 * DELETE /api/admin/chess/games/:id
 */
router.delete('/games/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const game = await mongo.getChessGameById(id);
    if (!game) {
      return res.status(404).json({ error: '对局记录不存在' });
    }

    const coll = await mongo.getChessGamesCollection();
    const { ObjectId } = require('mongodb');
    await coll.deleteOne({ _id: ObjectId.createFromHexString(id) });

    // 记录操作日志
    await logAdminAction(req.user.id, 'delete_chess_game', id, {
      roomId: game.roomId.toString(),
      gameNumber: game.gameNumber
    });

    res.json({
      success: true,
      message: '对局记录删除成功'
    });
  } catch (err) {
    console.error('删除对局记录失败:', err);
    res.status(500).json({ error: '删除对局记录失败' });
  }
});

/**
 * 获取AI接管状态
 * GET /api/admin/chess/rooms/:id/ai-status
 */
router.get('/rooms/:id/ai-status', async (req, res) => {
  try {
    const { id } = req.params;

    const room = await mongo.getChessRoomById(id);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }

    res.json({
      success: true,
      data: {
        red_ai: room.redAI || false,
        black_ai: room.blackAI || false
      }
    });
  } catch (err) {
    console.error('获取AI接管状态失败:', err);
    res.status(500).json({ error: '获取AI接管状态失败' });
  }
});

/**
 * 设置AI接管
 * POST /api/admin/chess/rooms/:id/ai-control
 */
router.post('/rooms/:id/ai-control', async (req, res) => {
  try {
    const { id } = req.params;
    const { red_ai, black_ai } = req.body;

    const room = await mongo.getChessRoomById(id);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }

    const update = {
      redAI: red_ai === true,
      blackAI: black_ai === true,
      updatedAt: new Date()
    };

    await mongo.updateChessRoom(id, update);

    // 记录操作日志
    await logAdminAction(req.user.id, 'set_chess_ai_control', id, {
      roomName: room.roomName,
      redAI: update.redAI,
      blackAI: update.blackAI
    });

    res.json({
      success: true,
      message: 'AI接管设置成功',
      data: {
        red_ai: update.redAI,
        black_ai: update.blackAI
      }
    });
  } catch (err) {
    console.error('设置AI接管失败:', err);
    res.status(500).json({ error: '设置AI接管失败' });
  }
});

/**
 * 取消AI接管
 * DELETE /api/admin/chess/rooms/:id/ai-control
 */
router.delete('/rooms/:id/ai-control', async (req, res) => {
  try {
    const { id } = req.params;
    const { side } = req.query; // 'red', 'black', 或 'all'

    const room = await mongo.getChessRoomById(id);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }

    const update = { updatedAt: new Date() };

    if (side === 'red' || side === 'all' || !side) {
      update.redAI = false;
    }
    if (side === 'black' || side === 'all' || !side) {
      update.blackAI = false;
    }

    await mongo.updateChessRoom(id, update);

    // 记录操作日志
    await logAdminAction(req.user.id, 'cancel_chess_ai_control', id, {
      roomName: room.roomName,
      side: side || 'all'
    });

    res.json({
      success: true,
      message: 'AI接管已取消',
      data: {
        red_ai: side === 'black' ? room.redAI : false,
        black_ai: side === 'red' ? room.blackAI : false
      }
    });
  } catch (err) {
    console.error('取消AI接管失败:', err);
    res.status(500).json({ error: '取消AI接管失败' });
  }
});

module.exports = router;
