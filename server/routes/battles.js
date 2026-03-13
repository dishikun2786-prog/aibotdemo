/**
 * @file battles.js
 * @module routes/battles
 * @description 用户对战与消费记录 API，从 MongoDB user_game_records 查询并返回（含对战、能量消耗、宝藏、激活码）
 */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const mongo = require('../utils/mongo');

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

/**
 * GET /api/battles
 * 获取当前用户的游戏记录列表（对战 + 能量消耗 + 宝藏 + 激活码），分页；每条带 recordType
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const userId = req.user.id;

    const coll = await mongo.getUserGameRecordsCollection();

    const filter = { userId };
    const total = await coll.countDocuments(filter);

    const rawList = await coll
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    const list = rawList.map((doc) => {
      const base = {
        id: doc._id.toString(),
        recordType: doc.recordType || 'battle',
        createdAt: doc.createdAt
      };
      // 获取房间名称
      const roomId = doc.roomId;
      const roomName = roomId === 1 ? '平台房间' : (doc.roomName || `房间${roomId}`);
      
      if (doc.recordType === 'battle') {
        return {
          ...base,
          type: doc.type,
          myResult: doc.myResult,
          opponentName: doc.opponentName,
          myKing: doc.myKing,
          myAssassin: doc.myAssassin,
          opponentKing: doc.opponentKing,
          opponentAssassin: doc.opponentAssassin,
          myAttackDist: doc.myAttackDist,
          opponentAttackDist: doc.opponentAttackDist,
          myEnergyChange: doc.myEnergyChange,
          opponentEnergyChange: doc.opponentEnergyChange,
          roomId: roomId,
          roomName: roomName
        };
      }
      if (doc.recordType === 'energy_consume') {
        return {
          ...base,
          amount: doc.amount,
          reason: doc.reason,
          roomId: doc.roomId,
          roomName: roomName,
          nodeId: doc.nodeId
        };
      }
      if (doc.recordType === 'treasure') {
        return {
          ...base,
          amount: doc.amount,
          claimType: doc.claimType,
          roomId: doc.roomId,
          roomName: roomName,
          nodeId: doc.nodeId
        };
      }
      if (doc.recordType === 'activation_code') {
        return {
          ...base,
          codeType: doc.codeType,
          amount: doc.amount
        };
      }
      if (doc.recordType === 'free_pk_reward') {
        return {
          ...base,
          type: doc.type, // 'winner' or 'loser'
          groupId: doc.groupId,
          postId: doc.postId,
          energyChange: doc.energyChange,
          fortuneChange: doc.fortuneChange,
          contributionChange: doc.contributionChange
        };
      }
      return base;
    });

    res.json({
      success: true,
      list,
      total
    });
  } catch (error) {
    console.error('获取对战记录失败:', error);
    res.status(500).json({
      success: false,
      error: '对战记录暂不可用'
    });
  }
});

module.exports = router;
