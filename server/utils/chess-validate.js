/**
 * @file chess-validate.js
 * @module utils/chess-validate
 * @description 中国象棋规则验证
 *
 * 棋盘坐标系说明：
 * - 棋盘为10行9列
 * - x: 列号，从左到右 0-8
 * - y: 行号，从上到下 0-9
 * - 红方在下方(行7-9)，黑方在上方(行0-2)
 * - 红兵初始位置: y=6, 黑卒初始位置: y=3
 */

/**
 * 棋盘坐标验证
 * @param {number} x - 列 (0-8)
 * @param {number} y - 行 (0-9)
 * @returns {boolean}
 */
function isValidPosition(x, y) {
  return x >= 0 && x <= 8 && y >= 0 && y <= 9;
}

/**
 * 获取棋盘指定位置的棋子
 * @param {Array} board - 棋盘数组
 * @param {number} x - 列
 * @param {number} y - 行
 * @returns {Object|null}
 */
function getPieceAt(board, x, y) {
  if (!isValidPosition(x, y)) return null;
  return board[y] && board[y][x];
}

/**
 * 检查起点和终点之间是否有阻挡（用于直线棋子）
 * @param {Array} board - 棋盘数组
 * @param {number} fromX - 起点列
 * @param {number} fromY - 起点行
 * @param {number} toX - 终点列
 * @param {number} toY - 终点行
 * @returns {boolean} true表示有阻挡
 */
function isPathBlocked(board, fromX, fromY, toX, toY) {
  const dx = Math.sign(toX - fromX);
  const dy = Math.sign(toY - fromY);
  let x = fromX + dx;
  let y = fromY + dy;

  while (x !== toX || y !== toY) {
    if (getPieceAt(board, x, y)) {
      return true;
    }
    x += dx;
    y += dy;
  }
  return false;
}

/**
 * 验证帅(将)的走法
 * 只能在九宫内，每步一格，上下左右移动
 */
function validateKingMove(board, fromX, fromY, toX, toY, color) {
  const piece = getPieceAt(board, fromX, fromY);
  if (!piece || piece.type !== '帥' && piece.type !== '将') return false;

  const dx = Math.abs(toX - fromX);
  const dy = Math.abs(toY - fromY);

  // 只能走一格
  if (dx + dy !== 1) return false;

  // 必须在九宫内
  const palaceX = color === 'red' ? [3, 4, 5] : [3, 4, 5];
  const palaceY = color === 'red' ? [7, 8, 9] : [0, 1, 2];

  if (!palaceX.includes(toX) || !palaceY.includes(toY)) return false;

  return true;
}

/**
 * 验证仕(士)的走法
 * 只能在九宫内，斜走一格
 */
function validateAdvisorMove(board, fromX, fromY, toX, toY, color) {
  const piece = getPieceAt(board, fromX, fromY);
  if (!piece || piece.type !== '仕' && piece.type !== '士') return false;

  const dx = Math.abs(toX - fromX);
  const dy = Math.abs(toY - fromY);

  // 只能斜走一格
  if (dx !== 1 || dy !== 1) return false;

  // 必须在九宫内
  const palaceX = [3, 4, 5];
  const palaceY = color === 'red' ? [7, 8, 9] : [0, 1, 2];

  if (!palaceX.includes(toX) || !palaceY.includes(toY)) return false;

  return true;
}

/**
 * 验证相(象)的走法
 * 只能走"田"字，不能过河，不能被塞象眼
 */
function validateElephantMove(board, fromX, fromY, toX, toY, color) {
  const piece = getPieceAt(board, fromX, fromY);
  if (!piece || piece.type !== '相' && piece.type !== '象') return false;

  const dx = Math.abs(toX - fromX);
  const dy = Math.abs(toY - fromY);

  // 必须走田字
  if (dx !== 2 || dy !== 2) return false;

  // 不能过河
  if (color === 'red' && toY < 5) return false;
  if (color === 'black' && toY > 4) return false;

  // 检查象眼
  const eyeX = (fromX + toX) / 2;
  const eyeY = (fromY + toY) / 2;
  if (getPieceAt(board, eyeX, eyeY)) {
    return false;
  }

  return true;
}

/**
 * 验证车的走法
 * 直线行走，不能越过障碍
 */
function validateRookMove(board, fromX, fromY, toX, toY) {
  const piece = getPieceAt(board, fromX, fromY);
  if (!piece || piece.type !== '車') return false;

  // 只能直线
  if (fromX !== toX && fromY !== toY) return false;

  // 检查路径是否有阻挡
  if (isPathBlocked(board, fromX, fromY, toX, toY)) {
    return false;
  }

  return true;
}

/**
 * 验证马的走法
 * "日"字形，有蹩马腿限制
 */
function validateKnightMove(board, fromX, fromY, toX, toY) {
  const piece = getPieceAt(board, fromX, fromY);
  if (!piece || piece.type !== '馬' && piece.type !== '马') return false;

  const dx = Math.abs(toX - fromX);
  const dy = Math.abs(toY - fromY);

  // 必须走日字
  if (!((dx === 1 && dy === 2) || (dx === 2 && dy === 1))) {
    return false;
  }

  // 检查蹩马腿
  if (dx === 2) {
    // 横走，马腿在中间列
    const legX = fromX + Math.sign(toX - fromX);
    const legY = fromY;
    if (getPieceAt(board, legX, legY)) {
      return false;
    }
  } else {
    // 竖走，马腿在中间行
    const legX = fromX;
    const legY = fromY + Math.sign(toY - fromY);
    if (getPieceAt(board, legX, legY)) {
      return false;
    }
  }

  return true;
}

/**
 * 验证炮的走法
 * 直线行走，吃子时中间必须有一个子
 */
function validateCannonMove(board, fromX, fromY, toX, toY) {
  const piece = getPieceAt(board, fromX, fromY);
  if (!piece || piece.type !== '炮') return false;

  // 只能直线
  if (fromX !== toX && fromY !== toY) {
    return false;
  }

  const targetPiece = getPieceAt(board, toX, toY);

  if (!targetPiece) {
    // 移动到空位，不能有阻挡
    return !isPathBlocked(board, fromX, fromY, toX, toY);
  } else {
    // 吃子，中间必须有一个子
    let count = 0;
    const dx = Math.sign(toX - fromX);
    const dy = Math.sign(toY - fromY);
    let x = fromX + dx;
    let y = fromY + dy;

    while (x !== toX || y !== toY) {
      if (getPieceAt(board, x, y)) {
        count++;
      }
      x += dx;
      y += dy;
    }

    return count === 1;
  }
}

/**
 * 验证兵(卒)的走法
 * 未过河只能向前，过河可左右移动，不能后退
 */
function validatePawnMove(board, fromX, fromY, toX, toY, color) {
  const piece = getPieceAt(board, fromX, fromY);
  if (!piece || piece.type !== '兵' && piece.type !== '卒') return false;

  const dx = toX - fromX;
  const dy = toY - fromY;

  const isRed = color === 'red';
  const isOverRiver = isRed ? fromY <= 4 : fromY >= 5;

  if (!isOverRiver) {
    // 未过河，只能向前
    if (isRed) {
      // 红兵向前(向下，y增大)
      return dx === 0 && dy === 1;
    } else {
      // 黑卒向前(向上，y减小)
      return dx === 0 && dy === -1;
    }
  } else {
    // 已过河，可向前或左右，但不能向后
    if (dx === 0 && dy !== 0) {
      // 向前 - 红兵只能向下(正dy)，黑卒只能向上(负dy)
      if (isRed) {
        return dy === 1; // 红兵只能向前（向下）
      } else {
        return dy === -1; // 黑卒只能向前（向上）
      }
    } else if (Math.abs(dx) === 1 && dy === 0) {
      // 左右移动 - 正确
      return true;
    }
    return false;
  }
}

/**
 * 验证走法是否合法
 * @param {Array} board - 棋盘数组
 * @param {number} fromX - 起点列
 * @param {number} fromY - 起点行
 * @param {number} toX - 终点列
 * @param {number} toY - 终点行
 * @param {string} color - 当前行棋方颜色 'red' 或 'black'
 * @returns {Object} { valid: boolean, error: string }
 */
function validateMove(board, fromX, fromY, toX, toY, color) {
  // 验证坐标
  if (!isValidPosition(fromX, fromY)) {
    return { valid: false, error: '起点位置无效' };
  }
  if (!isValidPosition(toX, toY)) {
    return { valid: false, error: '终点位置无效' };
  }

  // 获取起点棋子
  const piece = getPieceAt(board, fromX, fromY);
  if (!piece) {
    return { valid: false, error: '起点没有棋子' };
  }

  // 检查棋子颜色
  if (piece.color !== color) {
    return { valid: false, error: '这不是您的棋子' };
  }

  // 检查终点是否有己方棋子
  const targetPiece = getPieceAt(board, toX, toY);
  if (targetPiece && targetPiece.color === color) {
    return { valid: false, error: '终点有己方棋子' };
  }

  // 根据棋子类型验证走法
  let isValid = false;
  switch (piece.type) {
    case '帥':
    case '将':
      isValid = validateKingMove(board, fromX, fromY, toX, toY, color);
      break;
    case '仕':
    case '士':
      isValid = validateAdvisorMove(board, fromX, fromY, toX, toY, color);
      break;
    case '相':
    case '象':
      isValid = validateElephantMove(board, fromX, fromY, toX, toY, color);
      break;
    case '車':
      isValid = validateRookMove(board, fromX, fromY, toX, toY);
      break;
    case '馬':
    case '马':
      isValid = validateKnightMove(board, fromX, fromY, toX, toY);
      break;
    case '炮':
      isValid = validateCannonMove(board, fromX, fromY, toX, toY);
      break;
    case '兵':
    case '卒':
      isValid = validatePawnMove(board, fromX, fromY, toX, toY, color);
      break;
    default:
      return { valid: false, error: '未知棋子类型' };
  }

  if (!isValid) {
    return { valid: false, error: '走法不符合规则' };
  }

  // 验证走棋后是否会导致己方被将军
  // 创建临时棋盘模拟走棋
  const tempBoard = board.map(row => row.map(p => p ? { ...p } : null));
  tempBoard[toY][toX] = tempBoard[fromY][fromX];
  tempBoard[fromY][fromX] = null;

  // 检查是否会导致己方被将军
  if (isInCheck(tempBoard, color)) {
    return { valid: false, error: '走棋后会被将军，无法这样走' };
  }

  // 检查是否将帅对面（特殊规则：将帅不能在同一列面对面）
  if (isKingsFacing(board, fromX, fromY, toX, toY, color)) {
    return { valid: false, error: '将帅不能面对面' };
  }

  return { valid: true, error: null };
}

/**
 * 检查是否将军
 * @param {Array} board - 棋盘数组
 * @param {string} kingColor - 被检查方的颜色
 * @returns {boolean}
 */
function isInCheck(board, kingColor) {
  // 找到将(帅)的位置
  let kingX = -1, kingY = -1;
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = board[y][x];
      if (piece && piece.color === kingColor) {
        if ((piece.type === '帥' || piece.type === '将') && piece.color === kingColor) {
          kingX = x;
          kingY = y;
          break;
        }
      }
    }
    if (kingX >= 0) break;
  }

  if (kingX < 0) return false;

  // 检查敌方棋子是否能攻击到将(帅)
  const enemyColor = kingColor === 'red' ? 'black' : 'red';
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = board[y][x];
      if (piece && piece.color === enemyColor) {
        const result = validateMove(board, x, y, kingX, kingY, enemyColor);
        if (result.valid) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * 检查是否将帅对面（将帅不能在同一列面对面，且中间无阻挡）
 * @param {Array} board - 棋盘数组
 * @param {number} fromX - 起点列
 * @param {number} fromY - 起点行
 * @param {number} toX - 终点列
 * @param {number} toY - 终点行
 * @param {string} color - 当前行棋方颜色
 * @returns {boolean}
 */
function isKingsFacing(board, fromX, fromY, toX, toY, color) {
  // 只有帅/将移动时才需要检查将帅对面
  const piece = board[fromY][fromX];
  if (!piece || (piece.type !== '帥' && piece.type !== '将')) {
    return false;
  }

  // 找到红帅和黑将的位置
  let redKing = null;
  let blackKing = null;

  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 9; x++) {
      const p = board[y][x];
      if (p) {
        if (p.type === '帥') {
          redKing = { x, y };
        } else if (p.type === '将') {
          blackKing = { x, y };
        }
      }
    }
  }

  // 计算走棋后的位置
  const redKingPos = piece.color === 'red' ? { x: toX, y: toY } : redKing;
  const blackKingPos = piece.color === 'black' ? { x: toX, y: toY } : blackKing;

  if (!redKingPos || !blackKingPos) return false;

  // 必须同列才能面对面
  if (redKingPos.x !== blackKingPos.x) return false;

  // 检查中间是否有阻挡（不能有其他棋子）
  const minY = Math.min(redKingPos.y, blackKingPos.y);
  const maxY = Math.max(redKingPos.y, blackKingPos.y);

  for (let y = minY + 1; y < maxY; y++) {
    if (board[y][redKingPos.x]) {
      return false;
    }
  }

  return true;
}

/**
 * 验证游戏是否结束
 * @param {Array} board - 棋盘数组
 * @param {string} currentColor - 当前行棋方颜色
 * @returns {Object} { gameOver: boolean, winner: string|null }
 */
function checkGameOver(board, currentColor) {
  const enemyColor = currentColor === 'red' ? 'black' : 'red';

  // 情况1：对方被将军且无合法走法（困毙）
  if (isInCheck(board, enemyColor)) {
    // 检查是否无合法走法（被困）
    let hasLegalMove = false;
    for (let fromY = 0; fromY < 10 && !hasLegalMove; fromY++) {
      for (let fromX = 0; fromX < 9 && !hasLegalMove; fromX++) {
        const piece = board[fromY][fromX];
        if (piece && piece.color === enemyColor) {
          for (let toY = 0; toY < 10 && !hasLegalMove; toY++) {
            for (let toX = 0; toX < 9 && !hasLegalMove; toX++) {
              if (fromX === toX && fromY === toY) continue;
              const result = validateMove(board, fromX, fromY, toX, toY, enemyColor);
              if (result.valid) {
                // 模拟走棋后检查是否仍然被将军
                const tempBoard = board.map(row => row.map(p => p ? { ...p } : null));
                tempBoard[toY][toX] = tempBoard[fromY][fromX];
                tempBoard[fromY][fromX] = null;
                if (!isInCheck(tempBoard, enemyColor)) {
                  hasLegalMove = true;
                }
              }
            }
          }
        }
      }
    }

    if (!hasLegalMove) {
      return { gameOver: true, winner: currentColor };
    }
  }

  // 情况2：对方未应将将帅面对面（另一种困毙情况）
  // 如果将帅在同一列且中间无子，且当前方未将军对方，则对方可以将帅面对面来解杀
  // 这种情况下游戏也应该结束，当前方获胜
  if (isKingsFacingInCheck(board, enemyColor)) {
    // 对方已经无子可动（将帅面对面也算作无子可动）
    return { gameOver: true, winner: currentColor };
  }

  return { gameOver: false, winner: null };
}

/**
 * 检查是否将帅面对面导致无法解杀
 * @param {Array} board - 棋盘数组
 * @param {string} kingColor - 被将军方的颜色
 * @returns {boolean}
 */
function isKingsFacingInCheck(board, kingColor) {
  // 找到将帅位置
  let redKing = null;
  let blackKing = null;

  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 9; x++) {
      const p = board[y][x];
      if (p) {
        if (p.type === '帥') {
          redKing = { x, y };
        } else if (p.type === '将') {
          blackKing = { x, y };
        }
      }
    }
  }

  if (!redKing || !blackKing) return false;

  // 检查是否在同一列
  if (redKing.x !== blackKing.x) return false;

  // 检查中间是否有其他棋子
  const minY = Math.min(redKing.y, blackKing.y);
  const maxY = Math.max(redKing.y, blackKing.y);

  for (let y = minY + 1; y < maxY; y++) {
    if (board[y][redKing.x]) {
      return false;
    }
  }

  // 如果将帅面对面，且当前被将军方是将帅之一
  // 这意味着无子可动（将帅不能移开，否则会被将军）
  return true;
}

// 尝试加载 chess.js，如果不存在则使用内置实现
let initBoardFunction;
try {
  initBoardFunction = require('./chess').initBoard;
} catch (e) {
  initBoardFunction = null;
}

const defaultInitBoard = () => {
  const board = Array(10).fill(null).map(() => Array(9).fill(null));
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
};

module.exports = {
  isValidPosition,
  getPieceAt,
  isPathBlocked,
  validateKingMove,
  validateAdvisorMove,
  validateElephantMove,
  validateRookMove,
  validateKnightMove,
  validateCannonMove,
  validatePawnMove,
  validateMove,
  isInCheck,
  isKingsFacing,
  checkGameOver,
  initBoard: initBoardFunction || defaultInitBoard
};
