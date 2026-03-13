/**
 * @file pk-challenge-helper.js
 * @description 判定用户或虚拟 AI 是否处于任意一场 PK 挑战中（作为攻击者或防御者）；判定用户是否可发起 PK（能量≥100 且已占据节点）
 */
const redis = require('./redis');
const db = require('./db');

/**
 * 判定 participantId 是否正在任意一场 PK 中（Redis 中存在以其为 defender 或 attacker 的 challenge key）
 * @param {number|string} participantId - 用户 ID 或虚拟智能体 ID
 * @returns {Promise<boolean>}
 */
async function isParticipantInAnyChallenge(participantId) {
  if (participantId == null) return false;
  const pid = Number(participantId);
  const pidStr = String(participantId);
  try {
    // 优先使用 SCAN，失败则回退到 KEYS
    let keys = [];
    try {
      keys = await redis.scan('pk_challenge:*', 100);
    } catch (scanErr) {
      console.warn('[pk-challenge-helper] scan 失败，使用 keys 回退:', scanErr.message);
      keys = await redis.keys('pk_challenge:*');
    }
    // 安全处理 keys
    if (!Array.isArray(keys)) {
      keys = [];
    }
    for (const key of keys) {
      if (!key || typeof key !== 'string') continue;
      const parts = key.split(':');
      if (parts.length >= 3 && parts[0] === 'pk_challenge') {
        const defId = parts[1];
        const atkId = parts[2];
        const defNum = Number(defId);
        const atkNum = Number(atkId);
        if (pid === defNum || pid === atkNum || pidStr === defId || pidStr === atkId) {
          return true;
        }
      }
    }
    return false;
  } catch (err) {
    console.error('[pk-challenge-helper] isParticipantInAnyChallenge error:', err);
    return false;
  }
}

/**
 * 判定 participantId 是否作为防御者存在待响应的挑战（Redis 中存在 key pk_challenge:participantId:*）
 * 仅当目标正在等待响应“别人发来的挑战”时才返回 true；若仅作为攻击者在等别人响应，返回 false。
 * @param {number|string} participantId - 用户 ID 或虚拟智能体 ID（防御者）
 * @returns {Promise<boolean>}
 */
async function isDefenderInPendingChallenge(participantId) {
  if (participantId == null) return false;
  const pid = Number(participantId);
  const pidStr = String(participantId);
  try {
    // 优先使用 SCAN，失败则回退到 KEYS
    let keys = [];
    try {
      keys = await redis.scan('pk_challenge:*', 100);
    } catch (scanErr) {
      console.warn('[pk-challenge-helper] scan 失败，使用 keys 回退:', scanErr.message);
      keys = await redis.keys('pk_challenge:*');
    }
    // 安全处理 keys
    if (!Array.isArray(keys)) {
      keys = [];
    }
    for (const key of keys) {
      if (!key || typeof key !== 'string') continue;
      const parts = key.split(':');
      if (parts.length >= 3 && parts[0] === 'pk_challenge') {
        const defId = parts[1];
        const defNum = Number(defId);
        if (pid === defNum || pidStr === defId) {
          return true;
        }
      }
    }
    return false;
  } catch (err) {
    console.error('[pk-challenge-helper] isDefenderInPendingChallenge error:', err);
    return false;
  }
}

/**
 * 判定用户在该房间内是否已占据能量节点
 * @param {number|string} userId - 用户 ID
 * @param {number|string} roomId - 房间 ID
 * @returns {Promise<boolean>}
 */
async function userHasNodeInRoom(userId, roomId) {
  if (userId == null || roomId == null) return false;
  try {
    const rows = await db.query(
      'SELECT 1 FROM game_nodes WHERE owner_id = ? AND room_id = ? LIMIT 1',
      [userId, roomId]
    );
    return rows && rows.length > 0;
  } catch (err) {
    console.error('[pk-challenge-helper] userHasNodeInRoom error:', err);
    return false;
  }
}

/**
 * 判定用户是否可发起 PK：能量≥100 且在该房间已占据节点
 * @param {number|string} userId - 用户 ID
 * @param {number|string} roomId - 房间 ID
 * @param {number} energy - 当前能量值
 * @returns {Promise<boolean>}
 */
async function getCanPK(userId, roomId, energy) {
  if (energy == null || energy < 100) return false;
  return userHasNodeInRoom(userId, roomId);
}

module.exports = {
  isParticipantInAnyChallenge,
  isDefenderInPendingChallenge,
  userHasNodeInRoom,
  getCanPK
};
