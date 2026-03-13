/**
 * @file chess-socket.js
 * @module services/chess-socket
 * @description 象棋房间Socket事件处理
 */
const mongo = require('../utils/mongo');
const db = require('../utils/db');
const redis = require('../utils/redis');
const chessValidate = require('../utils/chess-validate');
const chessAI = require('./chess-ai');

// 观战者集合，使用Map存储房间ID -> Set(socketId)
// 注意：服务器重启后数据会丢失，可以考虑从MongoDB初始化
const roomViewers = new Map();

// AI定时器集合，用于存储每个房间的AI走棋定时器
const aiTimers = new Map();

/**
 * 获取或创建房间观战者Set
 * @param {string} roomId - 房间ID
 * @param {number} initialCount - 可选的初始计数（从MongoDB获取）
 */
function getViewersSet(roomId, initialCount = 0) {
  if (!roomViewers.has(roomId)) {
    // 使用MongoDB中的计数作为初始值（减去玩家数量）
    roomViewers.set(roomId, new Set());
  }
  return roomViewers.get(roomId);
}

/**
 * 清理房间的观战者集合（房间删除时调用）
 * @param {string} roomId - 房间ID
 */
function clearViewersSet(roomId) {
  roomViewers.delete(roomId);
}

/**
 * 象棋房间Socket事件处理
 * @param {SocketIO.Server} io - Socket.io实例
 */
function initChessSocket(io) {
  const chessIO = io.of('/chess');

  // Socket认证中间件 - 支持匿名观战
  chessIO.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        // 允许匿名连接（观战模式）
        socket.userId = null;
        socket.username = 'guest';
        return next();
      }

      const jwt = require('jsonwebtoken');
      const config = require('../config/database');
      const decoded = jwt.verify(token, config.jwt.secret);

      const [user] = await db.query('SELECT id, username, status FROM users WHERE id = ?', [decoded.userId]);
      if (!user || user.status !== 'active') {
        return next(new Error('用户不存在或已禁用'));
      }

      socket.userId = decoded.userId;
      socket.username = user.username;
      next();
    } catch (err) {
      // Token无效时也允许匿名连接
      socket.userId = null;
      socket.username = 'guest';
      next();
    }
  });

  chessIO.on('connection', (socket) => {
    console.log(`[Chess Socket] 新连接: ${socket.id}, userId: ${socket.userId}, username: ${socket.username}`);

    /**
     * 加入象棋房间
     */
    socket.on('join_room', async (data) => {
      try {
        const { roomId, role } = data; // role: 'player' | 'viewer'

        if (!roomId) {
          return socket.emit('error', { message: '缺少房间ID' });
        }

        const room = await mongo.getChessRoom(roomId);
        if (!room) {
          return socket.emit('error', { message: '房间不存在' });
        }

        if (room.isDeleted) {
          return socket.emit('error', { message: '房间已删除' });
        }

        // 记录当前房间
        socket.chessRoomId = roomId;
        socket.chessRole = role || 'viewer';

        // 加入Socket房间
        socket.join(`chess:${roomId}`);

        // 如果是玩家，验证权限
        if (role === 'player' && socket.userId) {
          const isRedPlayer = room.redPlayerId === socket.userId;
          const isBlackPlayer = room.blackPlayerId === socket.userId;

          if (!isRedPlayer && !isBlackPlayer) {
            socket.chessRole = 'viewer';
          }
        }

        // 记录之前的状态
        const previousStatus = room.gameStatus;

        // 观战人数统计 - 区分玩家和观战者
        let newViewerCount = room.viewerCount || 0;
        if (socket.chessRole === 'viewer') {
          const viewersSet = getViewersSet(roomId);
          viewersSet.add(socket.id);
          newViewerCount = viewersSet.size;
        }
        await mongo.updateChessRoom(roomId, { viewerCount: newViewerCount });

        // 如果之前是waiting状态，说明黑方刚加入，现在游戏开始
        if (previousStatus === 'waiting') {
          // 记录游戏开始时间
          const gameStartTime = new Date();
          await mongo.updateChessRoom(roomId, {
            gameStartTime: gameStartTime,
            lastMoveTime: gameStartTime
          });

          chessIO.to(`chess:${roomId}`).emit('game_started', {
            red_player_id: room.redPlayerId,
            black_player_id: room.blackPlayerId,
            red_player_name: room.redPlayerName,
            black_player_name: room.blackPlayerName,
            game_start_time: gameStartTime.toISOString(),
            thinking_time: room.thinkingTime || 15,
            timeout: room.timeout || 10,
            message: '游戏开始！'
          });

          // 游戏开始后检查是否需要AI走棋
          setTimeout(() => {
            checkAndExecuteAIMove(roomId, chessIO);
          }, 1000);
        } else if (room.gameStatus === 'playing') {
          // 如果游戏已经在进行中，也检查是否需要AI走棋
          setTimeout(() => {
            checkAndExecuteAIMove(roomId, chessIO);
          }, 1000);
        }

        // 广播玩家加入
        chessIO.to(`chess:${roomId}`).emit('player_joined', {
          socket_id: socket.id,
          user_id: socket.userId,
          username: socket.username,
          role: socket.chessRole,
          viewer_count: newViewerCount
        });

        // 发送当前房间状态
        socket.emit('room_state', {
          room_id: roomId,
          game_status: room.gameStatus,
          current_turn: room.currentTurn,
          red_player_id: room.redPlayerId,
          black_player_id: room.blackPlayerId,
          red_player_name: room.redPlayerName,
          black_player_name: room.blackPlayerName,
          red_score: room.redScore || 0,
          black_score: room.blackScore || 0,
          current_games: room.currentGames || 0,
          total_games: room.totalGames,
          board_state: room.boardState ? JSON.parse(room.boardState) : null,
          viewer_count: newViewerCount,
          // 游戏时长配置
          game_time_type: room.gameTimeType || 10,
          game_time: room.gameTime || 600,
          thinking_time: room.thinkingTime || 15,
          timeout: room.timeout || 10,
          game_start_time: room.gameStartTime,
          last_move_time: room.lastMoveTime,
          red_ai: room.redAI || false,    // AI接管状态
          black_ai: room.blackAI || false  // AI接管状态
        });

        console.log(`[Chess Socket] 用户 ${socket.userId} 加入房间 ${roomId}, 角色: ${socket.chessRole}`);
      } catch (err) {
        console.error('[Chess Socket] 加入房间失败:', err);
        socket.emit('error', { message: '加入房间失败' });
      }
    });

    /**
     * 离开象棋房间
     */
    socket.on('leave_room', async () => {
      await handleLeaveChessRoom(socket, chessIO);
    });

    /**
     * 走棋
     */
    socket.on('move', async (data) => {
      try {
        const { from_x, from_y, to_x, to_y } = data;
        const fromX = from_x;
        const fromY = from_y;
        const toX = to_x;
        const toY = to_y;
        const roomId = socket.chessRoomId;

        if (!roomId) {
          return socket.emit('error', { message: '未加入房间' });
        }

        if (socket.chessRole !== 'player') {
          return socket.emit('error', { message: '只有玩家可以走棋' });
        }

        const room = await mongo.getChessRoom(roomId);
        if (!room) {
          return socket.emit('error', { message: '房间不存在' });
        }

        if (room.gameStatus !== 'playing') {
          return socket.emit('error', { message: '游戏未在进行' });
        }

        // 确定玩家颜色
        let playerColor = null;
        if (room.redPlayerId === socket.userId) {
          playerColor = 'red';
        } else if (room.blackPlayerId === socket.userId) {
          playerColor = 'black';
        }

        if (!playerColor) {
          return socket.emit('error', { message: '您不是房间的玩家' });
        }

        // 检查是否轮到该玩家
        if (room.currentTurn !== playerColor) {
          return socket.emit('error', { message: '还没轮到你走棋' });
        }

        // 检查是否超时（思考时间超时）
        const now = new Date();
        const lastMoveTime = room.lastMoveTime ? new Date(room.lastMoveTime) : null;
        const thinkingTime = (room.thinkingTime || 15) * 1000; // 转换为毫秒
        const timeout = (room.timeout || 10) * 1000; // 转换为毫秒
        const totalAllowedTime = thinkingTime + timeout;

        if (lastMoveTime && (now - lastMoveTime) > totalAllowedTime) {
          // 超时判负
          const winner = playerColor === 'red' ? 'black' : 'red';
          console.log(`[Chess] 玩家 ${socket.userId} 超时判负，获胜方: ${winner}`);
          return await handleTimeoutOrDraw(roomId, room, winner, 'timeout', chessIO);
        }

        // 检查是否达到总时长（平局判定）
        const gameStartTime = room.gameStartTime ? new Date(room.gameStartTime) : null;
        const gameTime = (room.gameTime || 600) * 1000; // 转换为毫秒

        if (gameStartTime && (now - gameStartTime) > gameTime) {
          // 总时长用完，判平局
          console.log(`[Chess] 游戏总时长用完，判平局`);
          return await handleTimeoutOrDraw(roomId, room, 'draw', 'time_up', chessIO);
        }

        // 解析棋盘
        const board = room.boardState ? JSON.parse(room.boardState) : chessValidate.initBoard;

        // 验证走法
        const validation = chessValidate.validateMove(board, fromX, fromY, toX, toY, playerColor);
        if (!validation.valid) {
          return socket.emit('error', { message: validation.error });
        }

        // 执行走法
        const piece = board[fromY][fromX];
        board[toY][toX] = piece;
        board[fromY][fromX] = null;

        // 记录走法
        const moves = room.moves || [];
        moves.push({
          fromX, fromY, toX, toY,
          piece: piece.type,
          color: piece.color,
          time: new Date().toISOString()
        });

        // 切换回合
        const nextTurn = playerColor === 'red' ? 'black' : 'red';

        // 检查游戏是否结束
        const gameOver = chessValidate.checkGameOver(board, nextTurn);

        let updateData = {
          boardState: JSON.stringify(board),
          moves: moves,
          currentTurn: nextTurn,
          lastMoveTime: new Date() // 更新最后走棋时间
        };

        let result = { gameOver: false, winner: null };

        if (gameOver.gameOver) {
          result.winner = gameOver.winner;

          // 更新分数
          const newRedScore = gameOver.winner === 'red' ? (room.redScore || 0) + 1 : (room.redScore || 0);
          const newBlackScore = gameOver.winner === 'black' ? (room.blackScore || 0) + 1 : (room.blackScore || 0);
          const newCurrentGames = (room.currentGames || 0) + 1;

          updateData.redScore = newRedScore;
          updateData.blackScore = newBlackScore;
          updateData.currentGames = newCurrentGames;

          // 记录对局到MongoDB
          const gameRecord = {
            roomId: room._id,
            gameNumber: newCurrentGames,
            redPlayerId: room.redPlayerId,
            blackPlayerId: room.blackPlayerId,
            winner: gameOver.winner,
            redScore: newRedScore,
            blackScore: newBlackScore,
            moves: moves,
            energyExchanged: gameOver.winner !== 'draw' ? room.energyPerGame : 0,
            startedAt: new Date(Date.now() - 30 * 60 * 1000), // 假设每局30分钟
            endedAt: new Date()
          };
          await mongo.createChessGame(gameRecord);

          // 能量结算
          if (gameOver.winner !== 'draw') {
            const winnerId = gameOver.winner === 'red' ? room.redPlayerId : room.blackPlayerId;
            const loserId = gameOver.winner === 'red' ? room.blackPlayerId : room.redPlayerId;
            const energyAmount = room.energyPerGame || 10;

            if (winnerId && loserId) {
              await db.transaction(async (conn) => {
                await conn.execute(
                  'UPDATE users SET energy = GREATEST(0, energy - ?) WHERE id = ?',
                  [energyAmount, loserId]
                );
                await conn.execute(
                  'UPDATE users SET energy = energy + ? WHERE id = ?',
                  [energyAmount, winnerId]
                );

                // 写入pk_records表，用于排行榜统计
                await conn.execute(
                  `INSERT INTO pk_records
                   (attacker_id, defender_id, attacker_king, attacker_assassin, defender_king, defender_assassin, result, energy_change, attacker_type, defender_type, room_id, room_name)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    loserId,
                    winnerId,
                    0, 0, 0, 0,
                    'lose',
                    -energyAmount,
                    'user',
                    'user',
                    room._id.toString(),
                    room.roomName || ''
                  ]
                );
              });
            }
          }

          // 判断是否所有局数已完成
          if (newCurrentGames >= room.totalGames) {
            updateData.gameStatus = 'finished';
          } else {
            // 重置棋盘，开始下一局
            updateData.boardState = JSON.stringify(chessValidate.initBoard);
            updateData.moves = [];
            updateData.gameStatus = 'playing';
          }

          result.gameOver = true;
        }

        // 更新房间
        await mongo.updateChessRoom(roomId, updateData);

        // 广播走棋结果
        chessIO.to(`chess:${roomId}`).emit('move_result', {
          from_x: fromX,
          from_y: fromY,
          to_x: toX,
          to_y: toY,
          piece: piece.type,
          color: piece.color,
          next_turn: nextTurn,
          board_state: board,
          red_score: updateData.redScore,
          black_score: updateData.blackScore,
          game_over: result.gameOver,
          winner: result.winner
        });

        // 如果游戏结束，广播最终结果
        if (result.gameOver) {
          chessIO.to(`chess:${roomId}`).emit('game_over', {
            winner: result.winner,
            red_score: updateData.redScore,
            black_score: updateData.blackScore,
            total_games: room.totalGames,
            message: result.winner === 'draw' ? '平局！' :
              `${result.winner === 'red' ? room.redPlayerName : room.blackPlayerName} 获胜！`
          });
        }

        console.log(`[Chess Socket] 玩家 ${socket.userId} 走棋: ${fromX},${fromY} -> ${toX},${toY}`);
      } catch (err) {
        console.error('[Chess Socket] 走棋失败:', err);
        socket.emit('error', { message: '走棋失败' });
      }
    });

    /**
     * 认输
     */
    socket.on('resign', async () => {
      try {
        const roomId = socket.chessRoomId;

        if (!roomId) {
          return socket.emit('error', { message: '未加入房间' });
        }

        if (socket.chessRole !== 'player') {
          return socket.emit('error', { message: '只有玩家可以认输' });
        }

        const room = await mongo.getChessRoom(roomId);
        if (!room || room.gameStatus !== 'playing') {
          return socket.emit('error', { message: '游戏未在进行' });
        }

        const winner = socket.userId === room.redPlayerId ? 'black' : 'red';
        await settleGame(roomId, room, winner);

        chessIO.to(`chess:${roomId}`).emit('game_over', {
          winner: winner,
          reason: 'resign',
          message: `${socket.userId === room.redPlayerId ? room.redPlayerName : room.blackPlayerName} 认输！`
        });
      } catch (err) {
        console.error('[Chess Socket] 认输失败:', err);
        socket.emit('error', { message: '认输失败' });
      }
    });

    /**
     * 求和
     */
    socket.on('draw_offer', async () => {
      try {
        const roomId = socket.chessRoomId;

        if (!roomId) {
          return socket.emit('error', { message: '未加入房间' });
        }

        const room = await mongo.getChessRoom(roomId);
        if (!room || room.gameStatus !== 'playing') {
          return socket.emit('error', { message: '游戏未在进行' });
        }

        // 广播求和请求给另一方
        const offererColor = socket.userId === room.redPlayerId ? 'red' : 'black';
        chessIO.to(`chess:${roomId}`).emit('draw_offered', {
          offerer: socket.userId,
          offererName: socket.userId === room.redPlayerId ? room.redPlayerName : room.blackPlayerName,
          offererColor: offererColor
        });
      } catch (err) {
        console.error('[Chess Socket] 求和失败:', err);
        socket.emit('error', { message: '求和失败' });
      }
    });

    /**
     * 响应求和
     */
    socket.on('draw_response', async (data) => {
      try {
        const { accepted } = data;
        const roomId = socket.chessRoomId;

        if (!roomId) {
          return socket.emit('error', { message: '未加入房间' });
        }

        const room = await mongo.getChessRoom(roomId);
        if (!room || room.gameStatus !== 'playing') {
          return socket.emit('error', { message: '游戏未在进行' });
        }

        if (accepted) {
          await settleGame(roomId, room, 'draw');

          chessIO.to(`chess:${roomId}`).emit('game_over', {
            winner: 'draw',
            reason: 'draw',
            message: '和棋！'
          });
        } else {
          chessIO.to(`chess:${roomId}`).emit('draw_rejected', {
            rejecter: socket.userId
          });
        }
      } catch (err) {
        console.error('[Chess Socket] 响应求和失败:', err);
        socket.emit('error', { message: '响应求和失败' });
      }
    });

    /**
     * 断开连接
     */
    socket.on('disconnect', async () => {
      console.log(`[Chess Socket] 断开连接: ${socket.id}`);
      await handleLeaveChessRoom(socket, chessIO);
    });
  });
}

/**
 * 处理离开象棋房间
 */
async function handleLeaveChessRoom(socket, chessIO) {
  const roomId = socket.chessRoomId;
  if (!roomId) return;

  try {
    const room = await mongo.getChessRoom(roomId);
    if (!room) return;

    // 观战人数统计 - 使用Set精确计数
    let newViewerCount = room.viewerCount || 0;
    if (socket.chessRole === 'viewer') {
      const viewersSet = getViewersSet(roomId);
      viewersSet.delete(socket.id);
      newViewerCount = viewersSet.size;
    }
    await mongo.updateChessRoom(roomId, { viewerCount: newViewerCount });

    // 如果是玩家离开，游戏结束
    if (socket.chessRole === 'player' && room.gameStatus === 'playing') {
      const winner = socket.userId === room.redPlayerId ? 'black' : 'red';
      await settleGame(roomId, room, winner);

      chessIO.to(`chess:${roomId}`).emit('game_over', {
        winner: winner,
        reason: 'player_left',
        message: '对手离开游戏获胜！'
      });
    }

    // 广播离开
    chessIO.to(`chess:${roomId}`).emit('player_left', {
      socket_id: socket.id,
      user_id: socket.userId,
      username: socket.username,
      role: socket.chessRole,
      viewer_count: newViewerCount
    });

    console.log(`[Chess Socket] 用户 ${socket.userId} 离开房间 ${roomId}`);
  } catch (err) {
    console.error('[Chess Socket] 离开房间失败:', err);
  }
}

/**
 * 结算游戏
 */
async function settleGame(roomId, room, winner) {
  // 检查是否所有局数已完成
  const isRoomFinished = (room.currentGames || 0) + 1 >= room.totalGames;

  let updateData;

  if (isRoomFinished) {
    // 所有局数完成，彻底清理房间
    updateData = {
      gameStatus: 'finished',
      redPlayerId: null,
      blackPlayerId: null,
      redPlayerName: null,
      blackPlayerName: null
    };
  } else {
    // 未完成所有局数，重置棋盘，等待新玩家加入
    updateData = {
      gameStatus: 'waiting',
      boardState: JSON.stringify(chessValidate.initBoard),
      moves: [],
      currentTurn: 'red',
      // 清理玩家ID，让新玩家可以加入
      redPlayerId: null,
      blackPlayerId: null,
      redPlayerName: null,
      blackPlayerName: null,
      // 重置游戏时间
      gameStartTime: null,
      lastMoveTime: null
    };
  }

  if (winner !== 'draw') {
    const winnerId = winner === 'red' ? room.redPlayerId : room.blackPlayerId;
    const loserId = winner === 'red' ? room.blackPlayerId : room.redPlayerId;

    // 更新分数
    if (winner === 'red') {
      updateData.redScore = (room.redScore || 0) + 1;
    } else {
      updateData.blackScore = (room.blackScore || 0) + 1;
    }
    updateData.currentGames = (room.currentGames || 0) + 1;

    // 能量结算
    if (winnerId && loserId) {
      const energyAmount = room.energyPerGame || 10;
      await db.transaction(async (conn) => {
        await conn.execute(
          'UPDATE users SET energy = GREATEST(0, energy - ?) WHERE id = ?',
          [energyAmount, loserId]
        );
        await conn.execute(
          'UPDATE users SET energy = energy + ? WHERE id = ?',
          [energyAmount, winnerId]
        );

        // 写入pk_records表，用于排行榜统计
        await conn.execute(
          `INSERT INTO pk_records
           (attacker_id, defender_id, attacker_king, attacker_assassin, defender_king, defender_assassin, result, energy_change, attacker_type, defender_type, room_id, room_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            loserId,
            winnerId,
            0, 0, 0, 0,
            'lose',
            -energyAmount,
            'user',
            'user',
            room._id.toString(),
            room.roomName || ''
          ]
        );
      });
    }

    // 记录对局到MongoDB
    const gameRecord = {
      roomId: room._id,
      gameNumber: updateData.currentGames,
      redPlayerId: room.redPlayerId,
      blackPlayerId: room.blackPlayerId,
      winner: winner,
      redScore: updateData.redScore || 0,
      blackScore: updateData.blackScore || 0,
      moves: room.moves || [],
      energyExchanged: winner !== 'draw' ? room.energyPerGame : 0,
      startedAt: new Date(Date.now() - 30 * 60 * 1000),
      endedAt: new Date()
    };
    await mongo.createChessGame(gameRecord);
  } else {
    updateData.currentGames = (room.currentGames || 0) + 1;

    // 记录对局到MongoDB（平局）
    const gameRecord = {
      roomId: room._id,
      gameNumber: updateData.currentGames,
      redPlayerId: room.redPlayerId,
      blackPlayerId: room.blackPlayerId,
      winner: 'draw',
      redScore: room.redScore || 0,
      blackScore: room.blackScore || 0,
      moves: room.moves || [],
      energyExchanged: 0,
      startedAt: new Date(Date.now() - 30 * 60 * 1000),
      endedAt: new Date()
    };
    await mongo.createChessGame(gameRecord);
  }

  await mongo.updateChessRoom(roomId, updateData);
}

/**
 * 处理超时或平局（总时长用完）
 * @param {string} roomId - 房间ID
 * @param {object} room - 房间对象
 * @param {string} winner - 获胜方 ('red', 'black', 'draw')
 * @param {string} reason - 原因 ('timeout' 或 'time_up')
 * @param {object} chessIO - Socket.io命名空间
 */
async function handleTimeoutOrDraw(roomId, room, winner, reason, chessIO) {
  console.log(`[Chess] handleTimeoutOrDraw: winner=${winner}, reason=${reason}, roomId=${roomId}`);

  // 计算当前局数
  const currentGames = (room.currentGames || 0) + 1;

  let updateData = {
    gameStatus: 'playing', // 先设置为playing，等待settleGame处理
    currentGames: currentGames
  };

  // 根据原因设置消息
  let message = '';
  if (reason === 'timeout') {
    const loserColor = winner === 'red' ? '黑方' : '红方';
    const winnerColor = winner === 'red' ? '红方' : '黑方';
    message = `${loserColor}超时，${winnerColor}获胜！`;
  } else if (reason === 'time_up') {
    message = '游戏总时长用完，判为平局！';
  }

  // 广播超时/平局消息
  chessIO.to(`chess:${roomId}`).emit('game_timeout', {
    winner: winner,
    reason: reason,
    message: message,
    red_score: room.redScore || 0,
    black_score: room.blackScore || 0,
    current_games: currentGames,
    total_games: room.totalGames
  });

  // 调用settleGame处理结算
  await settleGame(roomId, room, winner);

  // 再次广播最终结果
  const updatedRoom = await mongo.getChessRoom(roomId);
  if (updatedRoom) {
    chessIO.to(`chess:${roomId}`).emit('game_over', {
      winner: winner,
      reason: reason,
      red_score: updatedRoom.redScore || 0,
      black_score: updatedRoom.blackScore || 0,
      current_games: updatedRoom.currentGames || 0,
      total_games: updatedRoom.totalGames,
      game_status: updatedRoom.gameStatus
    });
  }
}

/**
 * 检查并执行AI走棋
 * 当轮到AI且AI接管了该方时，自动触发AI走棋
 * @param {string} roomId - 房间ID
 * @param {object} chessIO - Socket.io命名空间
 */
async function checkAndExecuteAIMove(roomId, chessIO) {
  try {
    const room = await mongo.getChessRoom(roomId);
    if (!room) return;

    const { shouldAIMove, aiColor } = chessAI.shouldAIMove(room);

    if (!shouldAIMove) return;

    console.log(`[Chess AI] 开始AI走棋，房间: ${roomId}, 执${aiColor === 'red' ? '红方' : '黑方'}`);

    // 广播AI正在思考
    chessIO.to(`chess:${roomId}`).emit('ai_thinking', {
      color: aiColor,
      message: `AI正在思考中...`
    });

    // 获取AI思考时间（3-5秒）
    const thinkTime = chessAI.getThinkTime();

    // 设置定时器，延迟后执行AI走棋
    const timerId = setTimeout(async () => {
      try {
        await executeAIMove(roomId, chessIO);
      } catch (err) {
        console.error(`[Chess AI] AI走棋执行失败:`, err);
        chessIO.to(`chess:${roomId}`).emit('error', { message: 'AI走棋失败' });
      }
    }, thinkTime);

    // 存储定时器ID，以便后续可以取消
    aiTimers.set(roomId, timerId);

  } catch (err) {
    console.error(`[Chess AI] 检查AI走棋失败:`, err);
  }
}

/**
 * 执行AI走棋
 * @param {string} roomId - 房间ID
 * @param {object} chessIO - Socket.io命名空间
 */
async function executeAIMove(roomId, chessIO) {
  // 清除之前的定时器
  const existingTimer = aiTimers.get(roomId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    aiTimers.delete(roomId);
  }

  const room = await mongo.getChessRoom(roomId);
  if (!room || room.gameStatus !== 'playing') {
    return;
  }

  const { shouldAIMove, aiColor } = chessAI.shouldAIMove(room);
  if (!shouldAIMove) {
    return;
  }

  // 解析棋盘
  const board = room.boardState ? JSON.parse(room.boardState) : chessValidate.initBoard();
  const moves = room.moves || [];

  // 获取AI走法
  const aiMove = await chessAI.getAIMove(board, room.currentTurn, moves, aiColor);

  if (!aiMove) {
    console.error(`[Chess AI] 无法获取AI走法`);
    chessIO.to(`chess:${roomId}`).emit('error', { message: 'AI无法计算出走法' });
    return;
  }

  console.log(`[Chess AI] AI选择走法: ${aiMove.from_x},${aiMove.from_y} -> ${aiMove.to_x},${aiMove.to_y}`);

  // 验证走法是否合法
  const validation = chessValidate.validateMove(board, aiMove.from_x, aiMove.from_y, aiMove.to_x, aiMove.to_y, aiColor);

  if (!validation.valid) {
    console.error(`[Chess AI] AI走法不合法:`, validation.error);
    // 如果AI走法不合法，尝试获取备用走法
    const fallbackMove = chessAI.getFallbackMove ? chessAI.getFallbackMove(board, aiColor) : null;
    if (fallbackMove) {
      console.log(`[Chess AI] 使用备用走法: ${fallbackMove.from_x},${fallbackMove.from_y} -> ${fallbackMove.to_x},${fallbackMove.to_y}`);
      await processAIMove(roomId, chessIO, fallbackMove, board, aiColor);
    }
    return;
  }

  // 处理AI走棋
  await processAIMove(roomId, chessIO, aiMove, board, aiColor);
}

/**
 * 处理AI走棋的完整流程
 * @param {string} roomId - 房间ID
 * @param {object} chessIO - Socket.io命名空间
 * @param {object} aiMove - AI走法
 * @param {Array} board - 棋盘状态
 * @param {string} aiColor - AI颜色
 */
async function processAIMove(roomId, chessIO, aiMove, board, aiColor) {
  const { from_x, from_y, to_x, to_y, reason } = aiMove;

  // 执行走法
  const piece = board[from_y][from_x];
  board[to_y][to_x] = piece;
  board[from_y][from_x] = null;

  // 记录走法
  const room = await mongo.getChessRoom(roomId);
  const moves = room.moves || [];
  moves.push({
    fromX: from_x,
    fromY: from_y,
    toX: to_x,
    toY: to_y,
    piece: piece,
    color: aiColor,
    time: new Date().toISOString(),
    isAI: true,
    aiReason: reason
  });

  // 切换回合
  const nextTurn = aiColor === 'red' ? 'black' : 'red';

  // 检查游戏是否结束
  const gameOver = chessValidate.checkGameOver(board, nextTurn);

  let updateData = {
    boardState: JSON.stringify(board),
    moves: moves,
    currentTurn: nextTurn
  };

  let result = { gameOver: false, winner: null };

  if (gameOver.gameOver) {
    result.winner = gameOver.winner;

    // 更新分数
    const newRedScore = gameOver.winner === 'red' ? (room.redScore || 0) + 1 : (room.redScore || 0);
    const newBlackScore = gameOver.winner === 'black' ? (room.blackScore || 0) + 1 : (room.blackScore || 0);
    const newCurrentGames = (room.currentGames || 0) + 1;

    updateData.redScore = newRedScore;
    updateData.blackScore = newBlackScore;
    updateData.currentGames = newCurrentGames;

    // 记录对局
    const gameRecord = {
      roomId: room._id,
      gameNumber: newCurrentGames,
      redPlayerId: room.redPlayerId,
      blackPlayerId: room.blackPlayerId,
      winner: gameOver.winner,
      redScore: newRedScore,
      blackScore: newBlackScore,
      moves: moves,
      energyExchanged: gameOver.winner !== 'draw' ? room.energyPerGame : 0,
      startedAt: new Date(Date.now() - 30 * 60 * 1000),
      endedAt: new Date()
    };
    await mongo.createChessGame(gameRecord);

    // 能量结算
    if (gameOver.winner !== 'draw') {
      const winnerId = gameOver.winner === 'red' ? room.redPlayerId : room.blackPlayerId;
      const loserId = gameOver.winner === 'red' ? room.blackPlayerId : room.redPlayerId;
      const energyAmount = room.energyPerGame || 10;

      if (winnerId && loserId) {
        await db.transaction(async (conn) => {
          await conn.execute(
            'UPDATE users SET energy = GREATEST(0, energy - ?) WHERE id = ?',
            [energyAmount, loserId]
          );
          await conn.execute(
            'UPDATE users SET energy = energy + ? WHERE id = ?',
            [energyAmount, winnerId]
          );
        });
      }
    }

    // 判断是否所有局数已完成
    if (newCurrentGames >= room.totalGames) {
      updateData.gameStatus = 'finished';
    } else {
      // 重置棋盘，开始下一局
      updateData.boardState = JSON.stringify(chessValidate.initBoard());
      updateData.moves = [];
      updateData.gameStatus = 'playing';
    }

    result.gameOver = true;
  }

  // 更新房间
  await mongo.updateChessRoom(roomId, updateData);

  // 广播AI走棋结果
  chessIO.to(`chess:${roomId}`).emit('ai_move_result', {
    from_x: from_x,
    from_y: from_y,
    to_x: to_x,
    to_y: to_y,
    piece: piece,
    color: aiColor,
    reason: reason,
    next_turn: nextTurn,
    board_state: board,
    red_score: updateData.redScore || room.redScore || 0,
    black_score: updateData.blackScore || room.blackScore || 0,
    game_over: result.gameOver,
    winner: result.winner
  });

  // 如果游戏结束，广播最终结果
  if (result.gameOver) {
    chessIO.to(`chess:${roomId}`).emit('game_over', {
      winner: result.winner,
      red_score: updateData.redScore || room.redScore || 0,
      black_score: updateData.blackScore || room.blackScore || 0,
      total_games: room.totalGames,
      message: result.winner === 'draw' ? '平局！' :
        `${result.winner === 'red' ? room.redPlayerName : room.blackPlayerName} 获胜！`
    });
  } else {
    // 继续检查是否需要AI走棋
    await checkAndExecuteAIMove(roomId, chessIO);
  }

  console.log(`[Chess AI] AI走棋完成: ${from_x},${from_y} -> ${to_x},${to_y}`);
}

/**
 * 取消房间的AI定时器
 * @param {string} roomId - 房间ID
 */
function cancelAITimer(roomId) {
  const timerId = aiTimers.get(roomId);
  if (timerId) {
    clearTimeout(timerId);
    aiTimers.delete(roomId);
    console.log(`[Chess AI] 已取消房间 ${roomId} 的AI定时器`);
  }
}

module.exports = { initChessSocket };
