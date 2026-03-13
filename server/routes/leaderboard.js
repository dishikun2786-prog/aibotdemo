/**
 * @file leaderboard.js
 * @module routes/leaderboard
 * @description 贡献榜、福力榜排行榜接口 - Redis ZSET优化版
 */
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const redis = require('../utils/redis');
const mongo = require('../utils/mongo');

// Redis Key 常量
const LEADERBOARD_KEYS = {
  CONTRIBUTION_ZS: 'leaderboard:contribution:zs',
  FORTUNE_ZS: 'leaderboard:fortune:zs',
  CONTRIBUTION_DATA: 'leaderboard:contribution:data',
  FORTUNE_DATA: 'leaderboard:fortune:data'
};

const CACHE_TTL = 300; // 缓存5分钟

/**
 * 清除排行榜缓存并重新同步（管理员接口）
 */
router.post('/refresh', async (req, res) => {
  try {
    // 清除所有排行榜缓存
    await redis.del(LEADERBOARD_KEYS.CONTRIBUTION_ZS);
    await redis.del(LEADERBOARD_KEYS.FORTUNE_ZS);
    await redis.del(LEADERBOARD_KEYS.CONTRIBUTION_DATA);
    await redis.del(LEADERBOARD_KEYS.FORTUNE_DATA);

    // 重新从MySQL同步
    await syncLeaderboardFromMySQL();

    res.json({ success: true, message: '排行榜缓存已清除并重新同步' });
  } catch (err) {
    console.error('刷新排行榜失败:', err);
    res.status(500).json({ error: '刷新失败' });
  }
});

/**
 * 手动触发全量同步（管理员接口）
 */
router.post('/sync', async (req, res) => {
  try {
    await syncLeaderboardFromMySQL();
    res.json({ success: true, message: '排行榜同步完成' });
  } catch (err) {
    console.error('同步排行榜失败:', err);
    res.status(500).json({ error: '同步失败' });
  }
});

/**
 * 从MySQL全量同步排行榜数据到Redis ZSET
 * 同时包含MySQL的pk_records和MongoDB的battle_logs（自由PK团）数据
 */
async function syncLeaderboardFromMySQL() {
  console.log('开始同步排行榜数据...');

  try {
    // 先清空旧的排行榜数据（避免重复）
    await redis.del(LEADERBOARD_KEYS.CONTRIBUTION_ZS);
    await redis.del(LEADERBOARD_KEYS.FORTUNE_ZS);

    // ========== 1. 从MySQL获取贡献榜数据 ==========
    // 贡献榜：用户输掉的能量（result='lose'）
    const contribSql = `
      SELECT
        u.id,
        COALESCE((
          SELECT COALESCE(SUM(ABS(pr.energy_change)), 0)
          FROM pk_records pr
          WHERE (pr.attacker_id = u.id OR pr.defender_id = u.id)
            AND pr.result = 'lose'
        ), 0) AS score
      FROM users u
      WHERE u.status = 'active'
    `;
    const mysqlContribResults = await db.query(contribSql);

    // ========== 2. 从MySQL获取福力榜数据 ==========
    // 福力榜：用户获得的能量（result='win'）
    const fortuneSql = `
      SELECT
        u.id,
        COALESCE((
          SELECT COALESCE(SUM(pr.energy_change), 0)
          FROM pk_records pr
          WHERE (pr.attacker_id = u.id OR pr.defender_id = u.id)
            AND pr.result = 'win'
        ), 0) AS score
      FROM users u
      WHERE u.status = 'active'
    `;
    const mysqlFortuneResults = await db.query(fortuneSql);

    // ========== 3. 从MongoDB获取自由PK团贡献榜数据 ==========
    // 贡献榜：自由PK团中淘汰者输掉的能量
    let mongoContribMap = new Map();
    try {
      const battleLogsColl = await mongo.getBattleLogsCollection();
      const freePKContribPipeline = [
        { $match: { type: 'free_pk', result: 'loser' } },
        { $group: { _id: '$defenderId', totalEnergyLost: { $sum: { $abs: '$defenderEnergyChange' } } } }
      ];
      const freePKContribResults = await battleLogsColl.aggregate(freePKContribPipeline).toArray();
      mongoContribMap = new Map(freePKContribResults.map(r => [r._id.toString(), r.totalEnergyLost || 0]));
      console.log(`[Leaderboard] MongoDB自由PK团贡献榜: ${mongoContribMap.size}条记录`);
    } catch (err) {
      console.error('[Leaderboard] 获取MongoDB自由PK团贡献榜失败:', err.message);
    }

    // ========== 4. 从MongoDB获取自由PK团福力榜数据 ==========
    // 福力榜：自由PK团中获胜者获得的能量
    let mongoFortuneMap = new Map();
    try {
      const battleLogsColl = await mongo.getBattleLogsCollection();
      const freePKFortunePipeline = [
        { $match: { type: 'free_pk', result: 'winner' } },
        { $group: { _id: '$winnerId', totalEnergyWon: { $sum: '$winnerEnergyChange' } } }
      ];
      const freePKFortuneResults = await battleLogsColl.aggregate(freePKFortunePipeline).toArray();
      mongoFortuneMap = new Map(freePKFortuneResults.map(r => [r._id.toString(), r.totalEnergyWon || 0]));
      console.log(`[Leaderboard] MongoDB自由PK团福力榜: ${mongoFortuneMap.size}条记录`);
    } catch (err) {
      console.error('[Leaderboard] 获取MongoDB自由PK团福力榜失败:', err.message);
    }

    // ========== 5. 合并数据并写入Redis ==========

    // 合并贡献榜：MySQL + MongoDB
    for (const row of mysqlContribResults) {
      const userId = row.id.toString();
      const mysqlScore = row.score || 0;
      const mongoScore = mongoContribMap.get(userId) || 0;
      const totalScore = mysqlScore + mongoScore;

      if (totalScore > 0) {
        await redis.zAdd(LEADERBOARD_KEYS.CONTRIBUTION_ZS, totalScore, userId);
      }
    }

    // 合并福力榜：MySQL + MongoDB
    for (const row of mysqlFortuneResults) {
      const userId = row.id.toString();
      const mysqlScore = row.score || 0;
      const mongoScore = mongoFortuneMap.get(userId) || 0;
      const totalScore = mysqlScore + mongoScore;

      if (totalScore > 0) {
        await redis.zAdd(LEADERBOARD_KEYS.FORTUNE_ZS, totalScore, userId);
      }
    }

    // 清除缓存
    await redis.del(LEADERBOARD_KEYS.CONTRIBUTION_DATA);
    await redis.del(LEADERBOARD_KEYS.FORTUNE_DATA);

    console.log(`排行榜同步完成: ${mysqlContribResults.length} 贡献榜, ${mysqlFortuneResults.length} 福力榜`);
    console.log(`[Leaderboard] MongoDB自由PK团贡献榜额外增加: ${mongoContribMap.size}条`);
    console.log(`[Leaderboard] MongoDB自由PK团福力榜额外增加: ${mongoFortuneMap.size}条`);
  } catch (err) {
    console.error('同步排行榜失败:', err);
  }
}

/**
 * 格式化排行榜数据
 */
function formatLeaderboardData(results, type) {
  return results.map((r, index) => ({
    id: parseInt(r.value),
    score: type === 'contribution' ? Math.abs(Math.round(r.score)) : Math.round(r.score),
    rank: index + 1
  }));
}

/**
 * 获取贡献榜 - PK输掉的能量总和排名
 * 贡献榜积分 = 用户作为攻击者或防御者时，result='lose'的energy_change绝对值之和
 */
router.get('/contribution', async (req, res) => {
  try {
    const searchUsername = req.query.search;

    // 如果有搜索参数，从MySQL搜索
    if (searchUsername) {
      try {
        const sql = `
          SELECT
            u.id,
            u.username,
            COALESCE((
              SELECT COALESCE(SUM(ABS(pr.energy_change)), 0)
              FROM pk_records pr
              WHERE (pr.attacker_id = u.id OR pr.defender_id = u.id)
                AND pr.result = 'lose'
            ), 0) AS contribution_score
          FROM users u
          WHERE u.status = 'active' AND u.username LIKE ?
          LIMIT 10
        `;
        const results = await db.query(sql, [`%${searchUsername}%`]);

        // 计算每个搜索结果的排名
        for (const row of results) {
          const rankSql = `
            SELECT COUNT(*) + 1 AS rank
            FROM (
              SELECT u.id, COALESCE((
                SELECT COALESCE(SUM(ABS(pr.energy_change)), 0)
                FROM pk_records pr
                WHERE (pr.attacker_id = u.id OR pr.defender_id = u.id)
                  AND pr.result = 'lose'
              ), 0) AS score
              FROM users u
              WHERE u.status = 'active'
              HAVING score > (
                SELECT COALESCE(SUM(ABS(pr.energy_change)), 0)
                FROM pk_records pr
                WHERE (pr.attacker_id = ? OR pr.defender_id = ?)
                  AND pr.result = 'lose'
              )
            ) AS ranking
          `;
          const [rankResult] = await db.query(rankSql, [row.id, row.id]);
          row.rank = rankResult[0]?.rank || 0;
        }

        return res.json({ success: true, data: results });
      } catch (dbErr) {
        console.error('搜索贡献榜失败:', dbErr.message);
        return res.status(500).json({ error: '搜索失败' });
      }
    }

    // 1. 尝试从Redis缓存获取JSON数据
    const cachedData = await redis.get(LEADERBOARD_KEYS.CONTRIBUTION_DATA);
    if (cachedData) {
      // 检查是否是对象（redis.get已解析），还是字符串需要解析
      if (typeof cachedData === 'object' && cachedData !== null) {
        return res.json({ success: true, data: cachedData, fromCache: true });
      }
      try {
        return res.json({ success: true, data: JSON.parse(cachedData), fromCache: true });
      } catch (parseErr) {
        console.error('排行榜数据解析失败:', parseErr.message);
      }
    }

    // 2. 缓存不存在，从ZSET获取Top 100
    const results = await redis.zRevRangeWithScores(LEADERBOARD_KEYS.CONTRIBUTION_ZS, 0, 99);

    if (results.length === 0) {
      // 首次初始化，从MySQL同步
      await syncLeaderboardFromMySQL();
      const newResults = await redis.zRevRangeWithScores(LEADERBOARD_KEYS.CONTRIBUTION_ZS, 0, 99);

      if (newResults.length === 0) {
        return res.json({ success: true, data: [] });
      }

      // 批量获取用户信息
      const userIds = newResults.map(r => parseInt(r.value));
      const users = await db.query(
        'SELECT id, username FROM users WHERE id IN (?)',
        [userIds]
      );
      const userMap = new Map(users.map(u => [u.id, u]));

      const data = newResults.map((r, index) => ({
        id: parseInt(r.value),
        username: userMap.get(parseInt(r.value))?.username || '未知',
        avatar: null,
        contribution_score: Math.abs(Math.round(r.score)),
        rank: index + 1
      }));

      // 缓存结果
      await redis.set(LEADERBOARD_KEYS.CONTRIBUTION_DATA, JSON.stringify(data), CACHE_TTL);

      return res.json({ success: true, data });
    }

    // 3. 批量获取用户信息
    const userIds = results.map(r => parseInt(r.value));
    const users = await db.query(
      'SELECT id, username FROM users WHERE id IN (?)',
      [userIds]
    );
    const userMap = new Map(users.map(u => [u.id, u]));

    // 4. 格式化返回数据
    const data = results.map((r, index) => ({
      id: parseInt(r.value),
      username: userMap.get(parseInt(r.value))?.username || '未知',
      avatar: null,
      contribution_score: Math.abs(Math.round(r.score)),
      rank: index + 1
    }));

    // 5. 缓存5分钟
    await redis.set(LEADERBOARD_KEYS.CONTRIBUTION_DATA, JSON.stringify(data), CACHE_TTL);

    res.json({ success: true, data });
  } catch (err) {
    console.error('获取贡献榜失败:', err);
    // 降级到MySQL查询
    try {
      const sql = `
        SELECT
          u.id,
          u.username,
          COALESCE((
            SELECT COALESCE(SUM(ABS(pr.energy_change)), 0)
            FROM pk_records pr
            WHERE (pr.attacker_id = u.id OR pr.defender_id = u.id)
              AND pr.result = 'lose'
          ), 0) AS contribution_score
        FROM users u
        WHERE u.status = 'active'
        ORDER BY contribution_score DESC
        LIMIT 100
      `;
      const results = await db.query(sql);
      const data = results.map((r, index) => ({ ...r, rank: index + 1 }));
      res.json({ success: true, data, degraded: true });
    } catch (dbErr) {
      res.status(500).json({ error: '服务器内部错误' });
    }
  }
});

/**
 * 获取福力榜 - PK赢得的能量总和排名
 * 福力榜积分 = 用户作为攻击者或防御者时，result='win'的energy_change之和
 */
router.get('/fortune', async (req, res) => {
  try {
    const searchUsername = req.query.search;

    // 如果有搜索参数，从MySQL搜索
    if (searchUsername) {
      try {
        const sql = `
          SELECT
            u.id,
            u.username,
            COALESCE((
              SELECT COALESCE(SUM(pr.energy_change), 0)
              FROM pk_records pr
              WHERE (pr.attacker_id = u.id OR pr.defender_id = u.id)
                AND pr.result = 'win'
            ), 0) AS fortune_score
          FROM users u
          WHERE u.status = 'active' AND u.username LIKE ?
          LIMIT 10
        `;
        const results = await db.query(sql, [`%${searchUsername}%`]);

        // 计算每个搜索结果的排名
        for (const row of results) {
          const rankSql = `
            SELECT COUNT(*) + 1 AS rank
            FROM (
              SELECT u.id, COALESCE((
                SELECT COALESCE(SUM(pr.energy_change), 0)
                FROM pk_records pr
                WHERE (pr.attacker_id = u.id OR pr.defender_id = u.id)
                  AND pr.result = 'win'
              ), 0) AS score
              FROM users u
              WHERE u.status = 'active'
              HAVING score > (
                SELECT COALESCE(SUM(pr.energy_change), 0)
                FROM pk_records pr
                WHERE (pr.attacker_id = ? OR pr.defender_id = ?)
                  AND pr.result = 'win'
              )
            ) AS ranking
          `;
          const [rankResult] = await db.query(rankSql, [row.id, row.id]);
          row.rank = rankResult[0]?.rank || 0;
        }

        return res.json({ success: true, data: results });
      } catch (dbErr) {
        console.error('搜索福力榜失败:', dbErr.message);
        return res.status(500).json({ error: '搜索失败' });
      }
    }

    // 1. 尝试从Redis缓存获取JSON数据
    const cachedData = await redis.get(LEADERBOARD_KEYS.FORTUNE_DATA);
    if (cachedData) {
      // 检查是否是对象（redis.get已解析），还是字符串需要解析
      if (typeof cachedData === 'object' && cachedData !== null) {
        return res.json({ success: true, data: cachedData, fromCache: true });
      }
      try {
        return res.json({ success: true, data: JSON.parse(cachedData), fromCache: true });
      } catch (parseErr) {
        console.error('福力榜数据解析失败:', parseErr.message);
      }
    }

    // 2. 缓存不存在，从ZSET获取Top 100
    const results = await redis.zRevRangeWithScores(LEADERBOARD_KEYS.FORTUNE_ZS, 0, 99);

    if (results.length === 0) {
      // 首次初始化，从MySQL同步
      await syncLeaderboardFromMySQL();
      const newResults = await redis.zRevRangeWithScores(LEADERBOARD_KEYS.FORTUNE_ZS, 0, 99);

      if (newResults.length === 0) {
        return res.json({ success: true, data: [] });
      }

      // 批量获取用户信息
      const userIds = newResults.map(r => parseInt(r.value));
      const users = await db.query(
        'SELECT id, username FROM users WHERE id IN (?)',
        [userIds]
      );
      const userMap = new Map(users.map(u => [u.id, u]));

      const data = newResults.map((r, index) => ({
        id: parseInt(r.value),
        username: userMap.get(parseInt(r.value))?.username || '未知',
        avatar: null,
        fortune_score: Math.round(r.score),
        rank: index + 1
      }));

      await redis.set(LEADERBOARD_KEYS.FORTUNE_DATA, JSON.stringify(data), CACHE_TTL);

      return res.json({ success: true, data });
    }

    // 3. 批量获取用户信息
    const userIds = results.map(r => parseInt(r.value));
    const users = await db.query(
      'SELECT id, username FROM users WHERE id IN (?)',
      [userIds]
    );
    const userMap = new Map(users.map(u => [u.id, u]));

    // 4. 格式化返回数据
    const data = results.map((r, index) => ({
      id: parseInt(r.value),
      username: userMap.get(parseInt(r.value))?.username || '未知',
      avatar: null,
      fortune_score: Math.round(r.score),
      rank: index + 1
    }));

    // 5. 缓存5分钟
    await redis.set(LEADERBOARD_KEYS.FORTUNE_DATA, JSON.stringify(data), CACHE_TTL);

    res.json({ success: true, data });
  } catch (err) {
    console.error('获取福力榜失败:', err);
    // 降级到MySQL查询
    try {
      const sql = `
        SELECT
          u.id,
          u.username,
          COALESCE((
            SELECT COALESCE(SUM(pr.energy_change), 0)
            FROM pk_records pr
            WHERE (pr.attacker_id = u.id OR pr.defender_id = u.id)
              AND pr.result = 'win'
          ), 0) AS fortune_score
        FROM users u
        WHERE u.status = 'active'
        ORDER BY fortune_score DESC
        LIMIT 100
      `;
      const results = await db.query(sql);
      const data = results.map((r, index) => ({ ...r, rank: index + 1 }));
      res.json({ success: true, data, degraded: true });
    } catch (dbErr) {
      res.status(500).json({ error: '服务器内部错误' });
    }
  }
});

/**
 * 获取指定用户的贡献详情
 * 查看用户输给了哪些玩家多少次、多少能量
 */
router.get('/contribution/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);

    if (isNaN(userId)) {
      return res.status(400).json({ error: '无效的用户ID' });
    }

    const sql = `
      SELECT
        CASE
          WHEN pr.attacker_id = ? THEN pr.defender_id
          ELSE pr.attacker_id
        END AS opponent_id,
        u.username AS opponent_name,
        COUNT(*) AS pk_times,
        COALESCE(SUM(ABS(pr.energy_change)), 0) AS total_energy
      FROM pk_records pr
      LEFT JOIN users u ON u.id = CASE
        WHEN pr.attacker_id = ? THEN pr.defender_id
        ELSE pr.attacker_id
      END
      WHERE (pr.attacker_id = ? OR pr.defender_id = ?)
        AND pr.result = 'lose'
      GROUP BY opponent_id
      ORDER BY total_energy DESC
      LIMIT 50
    `;

    const results = await db.query(sql, [userId, userId, userId, userId]);

    res.json({
      success: true,
      data: results
    });
  } catch (err) {
    console.error('获取贡献详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取指定用户的福力详情
 * 查看用户从哪些玩家赢得了多少次、多少能量
 */
router.get('/fortune/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);

    if (isNaN(userId)) {
      return res.status(400).json({ error: '无效的用户ID' });
    }

    const sql = `
      SELECT
        CASE
          WHEN pr.attacker_id = ? THEN pr.defender_id
          ELSE pr.attacker_id
        END AS opponent_id,
        u.username AS opponent_name,
        COUNT(*) AS pk_times,
        COALESCE(SUM(pr.energy_change), 0) AS total_energy
      FROM pk_records pr
      LEFT JOIN users u ON u.id = CASE
        WHEN pr.attacker_id = ? THEN pr.defender_id
        ELSE pr.attacker_id
      END
      WHERE (pr.attacker_id = ? OR pr.defender_id = ?)
        AND pr.result = 'win'
      GROUP BY opponent_id
      ORDER BY total_energy DESC
      LIMIT 50
    `;

    const results = await db.query(sql, [userId, userId, userId, userId]);

    res.json({
      success: true,
      data: results
    });
  } catch (err) {
    console.error('获取福力详情失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取当前登录用户的排行榜数据（包含个人排名信息）
 * 使用Redis ZRANK查询排名，性能更高
 */
router.get('/my-stats', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: '未登录' });
    }

    const token = authHeader.split(' ')[1];
    const jwt = require('jsonwebtoken');
    const config = require('../config/database');

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwt.secret);
    } catch (e) {
      return res.status(401).json({ error: 'Token无效' });
    }

    const userId = decoded.userId.toString();

    try {
      // 并行查询Redis
      const [contribScore, fortuneScore, contribRank, fortuneRank] = await Promise.all([
        redis.zScore(LEADERBOARD_KEYS.CONTRIBUTION_ZS, userId),
        redis.zScore(LEADERBOARD_KEYS.FORTUNE_ZS, userId),
        redis.zRevRank(LEADERBOARD_KEYS.CONTRIBUTION_ZS, userId),
        redis.zRevRank(LEADERBOARD_KEYS.FORTUNE_ZS, userId)
      ]);

      // 如果Redis没有数据，降级到MySQL查询
      if (contribScore === null && fortuneScore === null) {
        throw new Error('Redis无数据，降级到MySQL');
      }

      res.json({
        success: true,
        data: {
          contribution: {
            score: Math.abs(Math.round(contribScore || 0)),
            rank: (contribRank !== null ? contribRank : 0) + 1
          },
          fortune: {
            score: Math.round(fortuneScore || 0),
            rank: (fortuneRank !== null ? fortuneRank : 0) + 1
          }
        }
      });
    } catch (redisErr) {
      // Redis查询失败，降级到MySQL
      console.error('Redis查询失败，降级到MySQL:', redisErr.message);

      const userIdNum = decoded.userId;

      // 获取用户的贡献榜积分和排名
      const contributionSql = `
        SELECT
          u.id,
          COALESCE((
            SELECT COALESCE(SUM(ABS(pr.energy_change)), 0)
            FROM pk_records pr
            WHERE (pr.attacker_id = u.id OR pr.defender_id = u.id)
              AND pr.result = 'lose'
          ), 0) AS score
        FROM users u
        WHERE u.id = ?
      `;

      // 获取用户的福力榜积分和排名
      const fortuneSql = `
        SELECT
          u.id,
          COALESCE((
            SELECT COALESCE(SUM(pr.energy_change), 0)
            FROM pk_records pr
            WHERE (pr.attacker_id = u.id OR pr.defender_id = u.id)
              AND pr.result = 'win'
          ), 0) AS score
        FROM users u
        WHERE u.id = ?
      `;

      // 计算贡献榜排名
      const contributionRankSql = `
        SELECT COUNT(*) + 1 AS rank
        FROM (
          SELECT
            u.id,
            COALESCE((
              SELECT COALESCE(SUM(ABS(pr.energy_change)), 0)
              FROM pk_records pr
              WHERE (pr.attacker_id = u.id OR pr.defender_id = u.id)
                AND pr.result = 'lose'
            ), 0) AS score
          FROM users u
          WHERE u.status = 'active'
          HAVING score > (
            SELECT COALESCE((
              SELECT COALESCE(SUM(ABS(pr.energy_change)), 0)
              FROM pk_records pr
              WHERE (pr.attacker_id = ? OR pr.defender_id = ?)
                AND pr.result = 'lose'
            ), 0)
          )
        ) AS ranking
      `;

      // 计算福力榜排名
      const fortuneRankSql = `
        SELECT COUNT(*) + 1 AS rank
        FROM (
          SELECT
            u.id,
            COALESCE((
              SELECT COALESCE(SUM(pr.energy_change), 0)
              FROM pk_records pr
              WHERE (pr.attacker_id = u.id OR pr.defender_id = u.id)
                AND pr.result = 'win'
            ), 0) AS score
          FROM users u
          WHERE u.status = 'active'
          HAVING score > (
            SELECT COALESCE((
              SELECT COALESCE(SUM(pr.energy_change), 0)
              FROM pk_records pr
              WHERE (pr.attacker_id = ? OR pr.defender_id = ?)
                AND pr.result = 'win'
            ), 0)
          )
        ) AS ranking
      `;

      const [contributionResult] = await db.query(contributionSql, [userIdNum]);
      const [fortuneResult] = await db.query(fortuneSql, [userIdNum]);
      const [contributionRankResult] = await db.query(contributionRankSql, [userIdNum, userIdNum]);
      const [fortuneRankResult] = await db.query(fortuneRankSql, [userIdNum, userIdNum]);

      res.json({
        success: true,
        data: {
          contribution: {
            score: contributionResult[0]?.score || 0,
            rank: contributionRankResult[0]?.rank || 0
          },
          fortune: {
            score: fortuneResult[0]?.score || 0,
            rank: fortuneRankResult[0]?.rank || 0
          }
        },
        degraded: true
      });
    }
  } catch (err) {
    console.error('获取个人排行榜数据失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// 模块加载时检查并同步历史数据
(async () => {
  try {
    const exists = await redis.exists(LEADERBOARD_KEYS.CONTRIBUTION_ZS);
    if (!exists) {
      console.log('Redis排行榜数据为空，开始初始化同步历史数据...');
      await syncLeaderboardFromMySQL();
    }
  } catch (err) {
    console.error('排行榜初始化检查失败:', err.message);
  }
})();

module.exports = router;
