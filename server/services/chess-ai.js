/**
 * @file chess-ai.js
 * @module services/chess-ai
 * @description 象棋AI服务 - 无敌象棋宗师风格
 */
const bailian = require('../utils/bailian');
const chessValidate = require('../utils/chess-validate');

/**
 * 棋子Unicode字符映射
 */
const PIECE_CHARS = {
  // 红方
  'r_k': '帅', 'r_a': '仕', 'r_e': '相', 'r_h': '马', 'r_r': '车',
  'r_c': '炮', 'r_p': '兵',
  // 黑方
  'b_k': '将', 'b_a': '士', 'b_e': '象', 'b_h': '马', 'b_r': '车',
  'b_c': '炮', 'b_p': '卒'
};

/**
 * 简化棋子名称
 */
const PIECE_NAMES = {
  'r_k': '帅', 'r_a': '仕', 'r_e': '相', 'r_h': '马', 'r_r': '车',
  'r_c': '炮', 'r_p': '兵',
  'b_k': '将', 'b_a': '士', 'b_e': '象', 'b_h': '马', 'b_r': '车',
  'b_c': '炮', 'b_p': '卒'
};

/**
 * 子力价值表
 */
const PIECE_VALUES = {
  '帥': 100, '将': 100,   // 将帅
  '仕': 20, '士': 20,     // 士
  '相': 20, '象': 20,     // 象
  '馬': 40, '马': 40,     // 马
  '車': 90, '车': 90,     // 车
  '炮': 45, '炮': 45,     // 炮
  '兵': 10, '卒': 10      // 兵/卒
};

/**
 * 计算子力价值
 * @param {Array} pieces - 棋子数组
 * @returns {number} 总价值
 */
function calculatePieceValue(pieces) {
  if (!pieces || !Array.isArray(pieces)) return 0;
  return pieces.reduce((sum, p) => sum + (PIECE_VALUES[p.type] || 0), 0);
}

/**
 * 判断棋局阶段
 * @param {Array} moves - 历史走法
 * @returns {string} 阶段名称
 */
function getGamePhase(moves) {
  const moveCount = moves ? moves.length : 0;
  if (moveCount < 10) return '开局阶段';
  if (moveCount < 30) return '中局阶段';
  return '残局阶段';
}

/**
 * 将棋盘状态转换为可读格式
 * @param {Array} board - 10x9棋盘数组
 * @param {string} aiColor - AI执子颜色 'red' 或 'black'
 * @returns {Object} 解析后的棋盘信息
 */
function parseBoardState(board, aiColor = 'red') {
  const redPieces = [];
  const blackPieces = [];

  if (!board || !Array.isArray(board)) {
    return { redPieces, blackPieces };
  }

  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = board[y] && board[y][x];
      if (piece && piece.type) {
        const pieceInfo = {
          type: piece.type,
          name: piece.type,
          x: x,
          y: y,
          position: `(${x},${y})`
        };

        // 根据color属性判断红黑方
        if (piece.color === 'red') {
          redPieces.push(pieceInfo);
        } else if (piece.color === 'black') {
          blackPieces.push(pieceInfo);
        }
      }
    }
  }

  return { redPieces, blackPieces };
}

/**
 * 构建象棋提示词（无敌象棋宗师风格）
 * @param {Array} board - 棋盘状态
 * @param {string} currentTurn - 当前执子方 'red' 或 'black'
 * @param {Array} moves - 历史走法
 * @param {string} aiColor - AI执子颜色
 * @returns {string} 完整的提示词
 */
function buildChessPrompt(board, currentTurn, moves = [], aiColor = 'red') {
  const { redPieces, blackPieces } = parseBoardState(board, aiColor);

  const aiColorName = aiColor === 'red' ? '红方' : '黑方';
  const opponentColorName = aiColor === 'red' ? '黑方' : '红方';
  const pieces = aiColor === 'red' ? redPieces : blackPieces;
  const opponentPieces = aiColor === 'red' ? blackPieces : redPieces;

  // 计算子力价值
  const aiValue = calculatePieceValue(pieces);
  const opponentValue = calculatePieceValue(opponentPieces);
  const valueDiff = aiValue - opponentValue;
  const valueStatus = valueDiff > 0 ? `优势(+${valueDiff})` : valueDiff < 0 ? `劣势(${valueDiff})` : '均势';

  // 获取棋局阶段
  const gamePhase = getGamePhase(moves);

  // 检查是否被将军
  let checkStatus = '';
  try {
    const isInCheck = chessValidate.isInCheck(board, aiColor);
    checkStatus = isInCheck ? '【警告：您正被将军！】' : '';
  } catch (e) {
    // 忽略错误
  }

  // 格式化历史走法 - 使用数字坐标格式
  let movesHistory = '';
  if (moves && moves.length > 0) {
    const recentMoves = moves.slice(-10);
    movesHistory = recentMoves.map((m, i) => {
      const moveNum = Math.floor(i / 2) + 1;
      const side = i % 2 === 0 ? '红' : '黑';
      return `${moveNum}.${side}: (${m.fromX},${m.fromY}) → (${m.toX},${m.toY})`;
    }).join('\n');
  }

  const prompt = `你是象棋大师。请选择一步最佳走法。

【棋局信息】
阶段：${gamePhase} | 子力对比：${valueStatus}（我方${aiValue}分 vs 对手${opponentValue}分）
${checkStatus}

【坐标】x=0-8(左到右)，y=0-9(上到下)。红方在下方(7-9)，黑方在上方(0-2)。
当前执子：${aiColorName}

【我方棋子】${pieces.map(p => `${p.type}(${p.x},${p.y})`).join('、')}
【对手棋子】${opponentPieces.map(p => `${p.type}(${p.x},${p.y})`).join('、')}

${movesHistory ? `【历史走法】\n${movesHistory}` : '【开局阶段】'}

返回JSON：{"from_x":0-8整数,"from_y":0-9整数,"to_x":0-8整数,"to_y":0-9整数,"reason":"原因"}`;

  return prompt;
}

/**
 * 获取AI思考时间（模拟人工，3-5秒）
 * @returns {number} 延迟毫秒数
 */
function getThinkTime() {
  // 3-5秒随机延迟，模拟人工思考
  return 3000 + Math.random() * 2000;
}

/**
 * 解析AI返回的走法
 * @param {string} aiResponse - AI返回的JSON字符串
 * @returns {Object|null} 解析后的走法或null
 */
function parseAIMove(aiResponse) {
  try {
    // 尝试提取JSON
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[Chess AI] 无法从响应中提取JSON:', aiResponse);
      return null;
    }

    const move = JSON.parse(jsonMatch[0]);

    // 尝试修正坐标（非整数时四舍五入）
    const fromX = typeof move.from_x === 'number' ? Math.round(move.from_x) : null;
    const fromY = typeof move.from_y === 'number' ? Math.round(move.from_y) : null;
    const toX = typeof move.to_x === 'number' ? Math.round(move.to_x) : null;
    const toY = typeof move.to_y === 'number' ? Math.round(move.to_y) : null;

    // 验证坐标有效性
    if (fromX === null || fromY === null || toX === null || toY === null) {
      console.error('[Chess AI] 走法坐标格式错误:', move);
      return null;
    }

    // 验证坐标范围
    if (fromX < 0 || fromX > 8 || fromY < 0 || fromY > 9 ||
        toX < 0 || toX > 8 || toY < 0 || toY > 9) {
      console.error('[Chess AI] 走法坐标超出范围:', move);
      return null;
    }

    return {
      from_x: fromX,
      from_y: fromY,
      to_x: toX,
      to_y: toY,
      reason: move.reason || 'AI分析走法'
    };
  } catch (err) {
    console.error('[Chess AI] 解析AI响应失败:', err, aiResponse);
    return null;
  }
}

/**
 * 获取AI最佳走法
 * @param {Array} board - 当前棋盘状态
 * @param {string} currentTurn - 当前执子方 'red' 或 'black'
 * @param {Array} moves - 历史走法
 * @param {string} aiColor - AI执子颜色
 * @returns {Promise<Object>} AI走法
 */
async function getAIMove(board, currentTurn, moves = [], aiColor = 'red') {
  console.log(`[Chess AI] AI开始分析，执${aiColor === 'red' ? '红方' : '黑方'}`);

  const prompt = buildChessPrompt(board, currentTurn, moves, aiColor);

  try {
    // 调用AI接口
    const messages = [
      { role: 'user', content: prompt }
    ];

    const aiResponse = await bailian.generateConversation(messages, {
      temperature: 0.2, // 更低，更稳定
      maxTokens: 150,    // 减少，够用即可
      top_p: 0.9
    });

    console.log('[Chess AI] AI响应:', aiResponse.substring(0, 200) + '...');

    // 解析AI走法
    const move = parseAIMove(aiResponse);

    if (!move) {
      // 如果解析失败，返回一个默认走法
      console.error('[Chess AI] 无法解析AI走法，使用备用策略');
      return getFallbackMove(board, aiColor);
    }

    return move;
  } catch (err) {
    console.error('[Chess AI] AI调用失败:', err);
    // 返回备用走法
    return getFallbackMove(board, aiColor);
  }
}

/**
 * 备用走法策略（当AI调用失败时）
 * @param {Array} board - 棋盘状态
 * @param {string} aiColor - AI执子颜色
 * @returns {Object} 备用走法
 */
function getFallbackMove(board, aiColor) {
  if (!board || !Array.isArray(board)) {
    // 返回默认走法：红方跳马，黑方跳马
    return {
      from_x: aiColor === 'red' ? 1 : 1,
      from_y: aiColor === 'red' ? 9 : 0,
      to_x: aiColor === 'red' ? 2 : 2,
      to_y: aiColor === 'red' ? 7 : 2,
      reason: '马走日'
    };
  }

  // 尝试找到AI的棋子
  // 简单策略：找到第一个可移动的棋子
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = board[y] && board[y][x];
      if (piece && piece.color === aiColor) {
        // 尝试向前移动一步
        const forwardY = aiColor === 'red' ? y + 1 : y - 1;
        if (forwardY >= 0 && forwardY < 10) {
          // 检查目标位置
          const targetPiece = board[forwardY] && board[forwardY][x];
          if (!targetPiece || targetPiece.color !== aiColor) {
            return {
              from_x: x,
              from_y: y,
              to_x: x,
              to_y: forwardY,
              reason: '备用策略：向前推进'
            };
          }
        }
      }
    }
  }

  // 如果都无法移动，返回默认走法
  return {
    from_x: aiColor === 'red' ? 1 : 1,
    from_y: aiColor === 'red' ? 9 : 0,
    to_x: aiColor === 'red' ? 2 : 2,
    to_y: aiColor === 'red' ? 7 : 2,
    reason: '马走日'
  };
}

/**
 * 检查AI是否应该接管
 * @param {Object} room - 房间对象
 * @returns {Object} { shouldAIMove: boolean, aiColor: string }
 */
function shouldAIMove(room) {
  if (!room || room.gameStatus !== 'playing') {
    return { shouldAIMove: false, aiColor: null };
  }

  const currentTurn = room.currentTurn || 'red';
  const redAI = room.redAI === true;
  const blackAI = room.blackAI === true;

  if (currentTurn === 'red' && redAI) {
    return { shouldAIMove: true, aiColor: 'red' };
  }
  if (currentTurn === 'black' && blackAI) {
    return { shouldAIMove: true, aiColor: 'black' };
  }

  return { shouldAIMove: false, aiColor: null };
}

module.exports = {
  getAIMove,
  buildChessPrompt,
  getThinkTime,
  parseAIMove,
  shouldAIMove,
  parseBoardState,
  getFallbackMove,
  calculatePieceValue,
  getGamePhase
};
