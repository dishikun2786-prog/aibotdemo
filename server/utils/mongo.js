/**
 * @file mongo.js
 * @module utils/mongo
 * @description MongoDB 连接单例：battle_logs、user_game_records、agent_conversations、agent_conversation_threads、agent_memories
 */
const { MongoClient } = require('mongodb');
const config = require('../config/database');
const db = require('../utils/db');

const BATTLE_LOGS_COLLECTION = 'battle_logs';
const USER_GAME_RECORDS_COLLECTION = 'user_game_records';
const AGENT_CONVERSATIONS_COLLECTION = 'agent_conversations';
const AGENT_CONVERSATION_THREADS_COLLECTION = 'agent_conversation_threads';
const AGENT_MEMORIES_COLLECTION = 'agent_memories';
const AGENT_KNOWLEDGE_BASES_COLLECTION = 'agent_knowledge_bases';  // AI分身知识库
const AGENT_SESSIONS_COLLECTION = 'agent_sessions';  // 匿名会话
const ENERGY_CONSUMPTION_COLLECTION = 'energy_consumption';  // 能量消耗记录
const PLAZA_POSTS_COLLECTION = 'plaza_posts';  // 玩家广场帖子
const PLAZA_COMMENTS_COLLECTION = 'plaza_comments';  // 玩家广场评论
const PLAZA_LIKES_COLLECTION = 'plaza_likes';  // 玩家广场点赞
const PLAZA_FREE_PK_GROUPS_COLLECTION = 'plaza_free_pk_groups';  // 自由PK团
const PLAZA_FREE_PK_PARTICIPANTS_COLLECTION = 'plaza_free_pk_participants';  // 自由PK团参与者
const PODCAST_PODCASTS_COLLECTION = 'podcast_podcasts';  // 播客主表
const PODCAST_EPISODES_COLLECTION = 'podcast_episodes';  // 剧集表
const PODCAST_SUBSCRIPTIONS_COLLECTION = 'podcast_subscriptions';  // 订阅关系表
const PODCAST_COMMENTS_COLLECTION = 'podcast_comments';  // 播客评论
const PODCAST_LIKES_COLLECTION = 'podcast_likes';  // 播客点赞
const ENERGY_TRADE_MESSAGES_COLLECTION = 'energy_trade_messages';  // 能量交易消息
const ENERGY_TRADE_NOTIFICATIONS_COLLECTION = 'energy_trade_notifications';  // 能量交易通知
const CHESS_ROOMS_COLLECTION = 'chess_rooms';  // 象棋房间
const CHESS_GAMES_COLLECTION = 'chess_games';  // 象棋对局记录

let client = null;
let mongoDb = null;

/**
 * 获取 MongoDB 客户端（懒加载）
 * @returns {Promise<import('mongodb').MongoClient>}
 */
async function getClient() {
  if (!client) {
    client = new MongoClient(config.mongo.uri);
    await client.connect();
  }
  return client;
}

/**
 * 获取数据库实例
 * @returns {Promise<import('mongodb').Db>}
 */
async function getDb() {
  if (!mongoDb) {
    const c = await getClient();
    mongoDb = c.db(config.mongo.dbName);
  }
  return mongoDb;
}

/**
 * 获取 battle_logs 集合，并确保索引存在
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getBattleLogsCollection() {
  const database = await getDb();
  const coll = database.collection(BATTLE_LOGS_COLLECTION);
  await coll.createIndex({ attackerId: 1, createdAt: -1 });
  await coll.createIndex({ defenderId: 1, createdAt: -1 });
  return coll;
}

/**
 * 获取 agent_conversations 集合，并确保索引存在
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getAgentConversationsCollection() {
  const database = await getDb();
  const coll = database.collection(AGENT_CONVERSATIONS_COLLECTION);
  await coll.createIndex({ agentId: 1, createdAt: -1 });
  await coll.createIndex({ userId: 1, createdAt: -1 });
  await coll.createIndex({ agentId: 1, threadId: 1, createdAt: 1 });
  return coll;
}

/**
 * 获取 agent_conversation_threads 集合（工作台多会话线程），并确保索引存在
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getAgentConversationThreadsCollection() {
  const database = await getDb();
  const coll = database.collection(AGENT_CONVERSATION_THREADS_COLLECTION);
  await coll.createIndex({ agentId: 1, createdAt: -1 });
  await coll.createIndex({ threadId: 1 }, { unique: true });
  return coll;
}

/**
 * 获取 user_game_records 集合（对战 + 能量消耗 + 宝藏 + 激活码），并确保索引存在
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getUserGameRecordsCollection() {
  const database = await getDb();
  const coll = database.collection(USER_GAME_RECORDS_COLLECTION);
  await coll.createIndex({ userId: 1, createdAt: -1 });
  return coll;
}

/**
 * 插入一条用户游戏记录（battle / energy_consume / treasure / activation_code）
 * @param {Object} doc - 含 recordType、userId、createdAt 及类型相关字段
 * @returns {Promise<import('mongodb').InsertOneResult>}
 */
async function insertUserGameRecord(doc) {
  try {
    const coll = await getUserGameRecordsCollection();
    const result = await coll.insertOne({
      ...doc,
      createdAt: doc.createdAt || new Date()
    });
    return result;
  } catch (err) {
    console.error('MongoDB insertUserGameRecord error:', err);
    throw err;
  }
}

/**
 * 插入一条对战日志（正常 PK / 拒绝 / 超时）
 * @param {Object} doc - 符合 battle_logs 结构的文档
 * @returns {Promise<import('mongodb').InsertOneResult>}
 */
async function insertBattleLog(doc) {
  try {
    const coll = await getBattleLogsCollection();
    const result = await coll.insertOne({
      ...doc,
      createdAt: doc.createdAt || new Date()
    });
    return result;
  } catch (err) {
    console.error('MongoDB insertBattleLog error:', err);
    throw err;
  }
}

/**
 * 插入一条AI智能体对话记录（可含 threadId，工作台会话用）
 * @param {Object} doc - agentId, userId, userMessage, agentMessage, energyCost, energyAfter?, createdAt?, threadId?
 * @returns {Promise<import('mongodb').InsertOneResult>}
 */
async function insertAgentConversation(doc) {
  try {
    const coll = await getAgentConversationsCollection();
    const result = await coll.insertOne({
      ...doc,
      createdAt: doc.createdAt || new Date()
    });
    return result;
  } catch (err) {
    console.error('MongoDB insertAgentConversation error:', err);
    throw err;
  }
}

/**
 * 插入一条会话线程（与 MySQL ai_agent_conversation_threads 双写，threadId 与 MySQL 自增 id 一致）
 * @param {Object} doc - { threadId (number), agentId, title, createdAt? }
 * @returns {Promise<import('mongodb').InsertOneResult>}
 */
async function insertAgentConversationThread(doc) {
  try {
    const coll = await getAgentConversationThreadsCollection();
    const result = await coll.insertOne({
      threadId: doc.threadId,
      agentId: doc.agentId,
      title: doc.title || '新对话',
      createdAt: doc.createdAt || new Date()
    });
    return result;
  } catch (err) {
    console.error('MongoDB insertAgentConversationThread error:', err);
    throw err;
  }
}

/**
 * 按 agent 查询会话线程列表（工作台历史会话），按创建时间倒序
 * @param {number} agentId
 * @returns {Promise<Array<{ id: number, title: string, created_at: Date }>>}
 */
async function getAgentConversationThreads(agentId) {
  const coll = await getAgentConversationThreadsCollection();
  const list = await coll.find({ agentId }).sort({ createdAt: -1 }).toArray();
  return (list || []).map(t => ({
    id: t.threadId,
    title: t.title || '新对话',
    created_at: t.createdAt
  }));
}

/**
 * 按 agent 与 thread 查询对话历史（工作台某会话内），按时间正序，分页
 * @param {number} agentId
 * @param {number} threadId
 * @param {number} limit
 * @param {number} offset
 * @returns {Promise<{ conversations: Array, total: number }>}
 */
async function getAgentConversationHistoryByThread(agentId, threadId, limit = 20, offset = 0) {
  const coll = await getAgentConversationsCollection();
  const filter = { agentId, threadId };
  const [conversations, total] = await Promise.all([
    coll.find(filter).sort({ createdAt: 1 }).skip(offset).limit(limit)
      .project({ userMessage: 1, agentMessage: 1, createdAt: 1, energyCost: 1 }).toArray(),
    coll.countDocuments(filter)
  ]);
  const mapped = (conversations || []).map(c => ({
    user_message: c.userMessage,
    agent_message: c.agentMessage,
    created_at: c.createdAt,
    energy_cost: c.energyCost
  }));
  return { conversations: mapped, total };
}

/**
 * 获取 agent_memories 集合（短期/中期/长期记忆），并确保索引
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getAgentMemoriesCollection() {
  const database = await getDb();
  const coll = database.collection(AGENT_MEMORIES_COLLECTION);
  await coll.createIndex({ agentId: 1, memoryType: 1 }, { unique: true });
  return coll;
}

/**
 * 写入或更新某类记忆（每个 agent 每种类型一份文档）
 * @param {number} agentId
 * @param {string} memoryType - 'short' | 'medium' | 'long'
 * @param {Object} content
 * @returns {Promise<import('mongodb').UpdateResult>}
 */
async function upsertAgentMemory(agentId, memoryType, content) {
  try {
    const coll = await getAgentMemoriesCollection();
    const now = new Date();
    const result = await coll.updateOne(
      { agentId, memoryType },
      { $set: { agentId, memoryType, content, updatedAt: now } },
      { upsert: true }
    );
    return result;
  } catch (err) {
    console.error('MongoDB upsertAgentMemory error:', err);
    throw err;
  }
}

/**
 * 获取指定类型的记忆内容
 * @param {number} agentId
 * @param {string} memoryType - 'short' | 'medium' | 'long'
 * @returns {Promise<Object|null>} content 或 null
 */
async function getAgentMemory(agentId, memoryType) {
  try {
    const coll = await getAgentMemoriesCollection();
    const doc = await coll.findOne({ agentId, memoryType }, { projection: { content: 1 } });
    return doc ? doc.content : null;
  } catch (err) {
    console.error('MongoDB getAgentMemory error:', err);
    return null;
  }
}

/**
 * 统计某 agent 的游戏内对话条数（无 threadId 或 threadId 为 null，用于中期记忆触发）
 * @param {number} agentId
 * @returns {Promise<number>}
 */
async function getAgentConversationCount(agentId) {
  try {
    const coll = await getAgentConversationsCollection();
    return await coll.countDocuments({
      agentId,
      $or: [{ threadId: null }, { threadId: { $exists: false } }]
    });
  } catch (err) {
    console.error('MongoDB getAgentConversationCount error:', err);
    return 0;
  }
}

/**
 * 获取游戏内最近对话（无 threadId），用于短期/中期记忆构建
 * @param {number} agentId
 * @param {number} limit
 * @returns {Promise<Array<{ user_message: string, agent_message: string, created_at: Date }>>}
 */
async function getAgentConversationsForMemory(agentId, limit = 100) {
  try {
    const coll = await getAgentConversationsCollection();
    const list = await coll
      .find({ agentId, $or: [{ threadId: null }, { threadId: { $exists: false } }] })
      .sort({ createdAt: -1 })
      .limit(limit)
      .project({ userMessage: 1, agentMessage: 1, createdAt: 1 })
      .toArray();
    return (list || []).map(c => ({
      user_message: c.userMessage,
      agent_message: c.agentMessage,
      created_at: c.createdAt
    })).reverse();
  } catch (err) {
    console.error('MongoDB getAgentConversationsForMemory error:', err);
    return [];
  }
}

/**
 * 清理过期记忆（按 updatedAt 删除 short/medium）
 * @param {number} agentId
 * @param {Date} cutoffDate
 * @param {string[]} memoryTypes - 如 ['short', 'medium']
 * @returns {Promise<import('mongodb').DeleteResult>}
 */
async function deleteAgentMemoriesOlderThan(agentId, memoryTypes, cutoffDate) {
  try {
    const coll = await getAgentMemoriesCollection();
    return await coll.deleteMany({
      agentId,
      memoryType: { $in: memoryTypes },
      updatedAt: { $lt: cutoffDate }
    });
  } catch (err) {
    console.error('MongoDB deleteAgentMemoriesOlderThan error:', err);
    throw err;
  }
}

/**
 * 关闭 MongoDB 连接（用于优雅关闭）
 * @returns {Promise<void>}
 */
async function close() {
  if (client) {
    await client.close();
    client = null;
    mongoDb = null;
  }
}

// ============================================
// AI分身知识库相关函数
// ============================================

/**
 * 获取 agent_knowledge_bases 集合
 */
async function getAgentKnowledgeBasesCollection() {
  const database = await getDb();
  const coll = database.collection(AGENT_KNOWLEDGE_BASES_COLLECTION);
  await coll.createIndex({ avatarId: 1 });
  await coll.createIndex({ userId: 1 });
  return coll;
}

/**
 * 获取 agent_sessions 集合
 */
async function getAgentSessionsCollection() {
  const database = await getDb();
  const coll = database.collection(AGENT_SESSIONS_COLLECTION);
  await coll.createIndex({ sessionId: 1 }, { unique: true });
  await coll.createIndex({ avatarId: 1, createdAt: -1 });
  await coll.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return coll;
}

/**
 * 获取能量消耗记录集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getEnergyConsumptionCollection() {
  const database = await getDb();
  const coll = database.collection(ENERGY_CONSUMPTION_COLLECTION);
  await coll.createIndex({ userId: 1, createdAt: -1 });
  await coll.createIndex({ type: 1, createdAt: -1 });
  return coll;
}

// ========== 玩家广场集合 ==========

/**
 * 获取帖子集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getPlazaPostsCollection() {
  const database = await getDb();
  const coll = database.collection(PLAZA_POSTS_COLLECTION);
  await coll.createIndex({ userId: 1, createdAt: -1 });
  await coll.createIndex({ isDeleted: 1, createdAt: -1 });
  await coll.createIndex({ title: 'text', content: 'text' });
  return coll;
}

/**
 * 获取评论集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getPlazaCommentsCollection() {
  const database = await getDb();
  const coll = database.collection(PLAZA_COMMENTS_COLLECTION);
  await coll.createIndex({ postId: 1, createdAt: 1 });
  await coll.createIndex({ userId: 1, createdAt: -1 });
  return coll;
}

/**
 * 获取点赞集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getPlazaLikesCollection() {
  const database = await getDb();
  const coll = database.collection(PLAZA_LIKES_COLLECTION);
  console.log('[MongoDB] plaza_likes 集合获取成功, 索引状态:', await coll.indexes());
  await coll.createIndex({ userId: 1, targetId: 1, targetType: 1 }, { unique: true });
  await coll.createIndex({ targetId: 1, targetType: 1 });
  return coll;
}

// ========== 自由PK团集合 ==========

/**
 * 获取自由PK团集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getPlazaFreePKGroupsCollection() {
  const database = await getDb();
  const coll = database.collection(PLAZA_FREE_PK_GROUPS_COLLECTION);
  await coll.createIndex({ postId: 1 });
  await coll.createIndex({ creatorId: 1 });
  await coll.createIndex({ status: 1, expiredAt: 1 });
  return coll;
}

/**
 * 获取自由PK团参与者集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getPlazaFreePKParticipantsCollection() {
  const database = await getDb();
  const coll = database.collection(PLAZA_FREE_PK_PARTICIPANTS_COLLECTION);
  await coll.createIndex({ groupId: 1, userId: 1 }, { unique: true });
  await coll.createIndex({ groupId: 1, status: 1 });
  return coll;
}

/**
 * 创建自由PK团
 * @param {Object} groupData - PK团数据
 * @returns {Promise<import('mongodb').InsertOneResult>}
 */
async function createFreePKGroup(groupData) {
  const coll = await getPlazaFreePKGroupsCollection();
  return await coll.insertOne({
    ...groupData,
    status: 'waiting',
    createdAt: new Date(),
    pkResults: []
  });
}

/**
 * 获取自由PK团
 * @param {string} groupId - PK团ID
 * @returns {Promise<Object|null>}
 */
async function getFreePKGroup(groupId) {
  const coll = await getPlazaFreePKGroupsCollection();
  const { ObjectId } = require('mongodb');
  return await coll.findOne({ _id: ObjectId.createFromHexString(groupId) });
}

/**
 * 更新自由PK团
 * @param {string} groupId - PK团ID
 * @param {Object} update - 更新数据
 * @returns {Promise<import('mongodb').UpdateResult>}
 */
async function updateFreePKGroup(groupId, update) {
  const coll = await getPlazaFreePKGroupsCollection();
  const { ObjectId } = require('mongodb');
  return await coll.updateOne(
    { _id: ObjectId.createFromHexString(groupId) },
    { $set: { ...update, updatedAt: new Date() } }
  );
}

/**
 * 删除自由PK团
 * @param {string} groupId - PK团ID
 * @returns {Promise<import('mongodb').DeleteResult>}
 */
async function deleteFreePKGroup(groupId) {
  const groupsColl = await getPlazaFreePKGroupsCollection();
  const participantsColl = await getPlazaFreePKParticipantsCollection();
  const { ObjectId } = require('mongodb');
  const objectId = ObjectId.createFromHexString(groupId);

  await groupsColl.deleteOne({ _id: objectId });
  await participantsColl.deleteMany({ groupId: objectId });
  return { deletedCount: 1 };
}

/**
 * 添加自由PK团参与者
 * @param {Object} participantData - 参与者数据
 * @returns {Promise<import('mongodb').InsertOneResult>}
 */
async function addFreePKParticipant(participantData) {
  const coll = await getPlazaFreePKParticipantsCollection();
  return await coll.insertOne({
    ...participantData,
    status: 'pending',
    joinedAt: new Date()
  });
}

/**
 * 获取自由PK团参与者列表
 * @param {string} groupId - PK团ID
 * @returns {Promise<Array>}
 */
async function getFreePKParticipants(groupId) {
  const coll = await getPlazaFreePKParticipantsCollection();
  const { ObjectId } = require('mongodb');
  return await coll.find({ groupId: ObjectId.createFromHexString(groupId) }).sort({ joinedAt: 1 }).toArray();
}

/**
 * 更新参与者状态
 * @param {string} participantId - 参与者ID
 * @param {Object} update - 更新数据
 * @returns {Promise<import('mongodb').UpdateResult>}
 */
async function updateFreePKParticipant(participantId, update) {
  const coll = await getPlazaFreePKParticipantsCollection();
  const { ObjectId } = require('mongodb');
  return await coll.updateOne(
    { _id: ObjectId.createFromHexString(participantId) },
    { $set: update }
  );
}

/**
 * 检查用户是否已加入PK团
 * @param {string} groupId - PK团ID
 * @param {number} userId - 用户ID
 * @returns {Promise<boolean>}
 */
async function hasJoinedFreePK(groupId, userId) {
  const coll = await getPlazaFreePKParticipantsCollection();
  const { ObjectId } = require('mongodb');
  const participant = await coll.findOne({
    groupId: ObjectId.createFromHexString(groupId),
    userId
  });
  return !!participant;
}

/**
 * 插入一条能量消耗记录
 * @param {Object} doc - 含 userId, type, amount, mode, avatarId, threadId, sessionId, createdAt
 * @returns {Promise<import('mongodb').InsertOneResult>}
 */
async function insertEnergyConsumption(doc) {
  try {
    const coll = await getEnergyConsumptionCollection();
    const result = await coll.insertOne({
      ...doc,
      createdAt: doc.createdAt || new Date()
    });
    return result;
  } catch (err) {
    console.error('MongoDB insertEnergyConsumption error:', err);
    throw err;
  }
}

/**
 * 获取能量消耗记录列表
 * @param {Object} query - 查询条件
 * @param {number} page - 页码
 * @param {number} limit - 每页数量
 * @returns {Promise<Array>}
 */
async function getEnergyConsumptionList(query = {}, page = 1, limit = 20) {
  const coll = await getEnergyConsumptionCollection();
  return await coll
    .find(query)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();
}

/**
 * 获取能量消耗记录总数
 * @param {Object} query - 查询条件
 * @returns {Promise<number>}
 */
async function getEnergyConsumptionCount(query = {}) {
  const coll = await getEnergyConsumptionCollection();
  return await coll.countDocuments(query);
}

/**
 * 创建AI分身知识库
 * @param {string} avatarId - 分身ID
 * @param {number} userId - 用户ID
 * @param {string} name - 知识库名称
 * @param {string} description - 描述
 */
async function createAgentKnowledgeBase(avatarId, userId, name, description = '') {
  const coll = await getAgentKnowledgeBasesCollection();
  return await coll.insertOne({
    avatarId,
    userId,
    name,
    description,
    categories: [],  // 知识库分类
    documents: [],
    shortTermMemory: [],
    mediumTermMemory: [],
    longTermMemory: {
      roleDescription: '',
      personality: '',
      knowledge: '',
      updatedAt: new Date()
    },
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

/**
 * 获取AI分身知识库
 */
async function getAgentKnowledgeBase(avatarId) {
  const coll = await getAgentKnowledgeBasesCollection();
  return await coll.findOne({ avatarId });
}

/**
 * 更新AI分身知识库
 */
async function updateAgentKnowledgeBase(avatarId, update) {
  const coll = await getAgentKnowledgeBasesCollection();
  return await coll.updateOne(
    { avatarId },
    { $set: { ...update, updatedAt: new Date() } }
  );
}

/**
 * 删除AI分身知识库
 */
async function deleteAgentKnowledgeBase(avatarId) {
  const coll = await getAgentKnowledgeBasesCollection();
  return await coll.deleteOne({ avatarId });
}

/**
 * 添加知识文档
 */
async function addKnowledgeDocument(avatarId, title, content, categoryId = null, tags = [], keywords = []) {
  const coll = await getAgentKnowledgeBasesCollection();
  const doc = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
    title,
    content,
    categoryId: categoryId,
    tags: tags || [],
    keywords: keywords || [],  // 新增：关键词字段
    createdAt: new Date(),
    updatedAt: new Date()
  };
  return await coll.updateOne(
    { avatarId },
    {
      $push: { documents: doc },
      $set: { updatedAt: new Date() }
    },
    { upsert: true }
  );
}

/**
 * 更新知识文档
 */
async function updateKnowledgeDocument(avatarId, docId, title, content, categoryId = null, tags = [], keywords = []) {
  const coll = await getAgentKnowledgeBasesCollection();
  const updateFields = {
    'documents.$.title': title,
    'documents.$.content': content,
    'documents.$.updatedAt': new Date(),
    updatedAt: new Date()
  };
  if (categoryId !== null) {
    updateFields['documents.$.categoryId'] = categoryId;
  }
  if (tags !== null) {
    updateFields['documents.$.tags'] = tags;
  }
  if (keywords !== null) {
    updateFields['documents.$.keywords'] = keywords;
  }
  return await coll.updateOne(
    { avatarId, 'documents.id': docId },
    { $set: updateFields }
  );
}

/**
 * 删除知识文档
 */
async function deleteKnowledgeDocument(avatarId, docId) {
  const coll = await getAgentKnowledgeBasesCollection();
  return await coll.updateOne(
    { avatarId },
    {
      $pull: { documents: { id: docId } },
      $set: { updatedAt: new Date() }
    }
  );
}

// ============================================
// 知识库分类管理
// ============================================

/**
 * 添加分类
 */
async function addCategory(avatarId, name, color = '#00f3ff') {
  const coll = await getAgentKnowledgeBasesCollection();
  const category = {
    id: 'cat_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6),
    name,
    color,
    createdAt: new Date()
  };
  return await coll.updateOne(
    { avatarId },
    {
      $push: { categories: category },
      $set: { updatedAt: new Date() }
    },
    { upsert: true }
  );
}

/**
 * 更新分类
 */
async function updateCategory(avatarId, categoryId, name, color) {
  const coll = await getAgentKnowledgeBasesCollection();
  return await coll.updateOne(
    { avatarId, 'categories.id': categoryId },
    {
      $set: {
        'categories.$.name': name,
        'categories.$.color': color,
        updatedAt: new Date()
      }
    }
  );
}

/**
 * 删除分类
 */
async function deleteCategory(avatarId, categoryId) {
  const coll = await getAgentKnowledgeBasesCollection();
  // 删除分类时，将该分类的文档改为未分类
  await coll.updateOne(
    { avatarId },
    {
      $set: {
        'documents.$[elem].categoryId': null,
        updatedAt: new Date()
      },
      arrayFilters: [{ 'elem.categoryId': categoryId }]
    }
  );
  return await coll.updateOne(
    { avatarId },
    {
      $pull: { categories: { id: categoryId } },
      $set: { updatedAt: new Date() }
    }
  );
}

/**
 * 获取分类列表
 */
async function getCategories(avatarId) {
  const coll = await getAgentKnowledgeBasesCollection();
  const kb = await coll.findOne({ avatarId }, { projection: { categories: 1 } });
  return kb ? (kb.categories || []) : [];
}

/**
 * 批量添加文档
 */
async function addDocuments(avatarId, documents) {
  const coll = await getAgentKnowledgeBasesCollection();
  const docs = documents.map(doc => ({
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
    title: doc.title,
    content: doc.content,
    categoryId: doc.categoryId || null,
    tags: doc.tags || [],
    createdAt: new Date(),
    updatedAt: new Date()
  }));
  return await coll.updateOne(
    { avatarId },
    {
      $push: { documents: { $each: docs } },
      $set: { updatedAt: new Date() }
    },
    { upsert: true }
  );
}

/**
 * 获取知识文档列表
 */
async function getKnowledgeDocuments(avatarId) {
  const coll = await getAgentKnowledgeBasesCollection();
  const kb = await coll.findOne({ avatarId }, { projection: { documents: 1 } });
  return kb ? kb.documents : [];
}

/**
 * 清理指定天数之前的客服对话知识文档
 * @param {string} avatarId - 分身ID
 * @param {number} daysToKeep - 保留最近天数（默认7天）
 * @returns {Promise<Object>} 更新结果
 */
async function cleanOldKnowledgeDocuments(avatarId, daysToKeep = 7) {
  const coll = await getAgentKnowledgeBasesCollection();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  // 只删除带有"客服对话"标签的旧文档
  return await coll.updateOne(
    { avatarId },
    {
      $pull: {
        documents: {
          createdAt: { $lt: cutoffDate },
          tags: '客服对话'
        }
      }
    }
  );
}

/**
 * 获取知识库统计信息
 * @param {string} avatarId - 分身ID
 * @returns {Promise<Object>} 统计信息
 */
async function getKnowledgeStats(avatarId) {
  const coll = await getAgentKnowledgeBasesCollection();
  const kb = await coll.findOne({ avatarId });

  if (!kb) {
    return { totalDocs: 0, chatRecords: 0, shortTermMemory: 0, mediumTermMemory: 0 };
  }

  const chatRecords = kb.documents ? kb.documents.filter(d => d.tags && d.tags.includes('客服对话')).length : 0;

  return {
    totalDocs: kb.documents ? kb.documents.length : 0,
    chatRecords: chatRecords,
    shortTermMemory: kb.shortTermMemory ? kb.shortTermMemory.length : 0,
    mediumTermMemory: kb.mediumTermMemory ? kb.mediumTermMemory.length : 0
  };
}

// ============================================
// 记忆管理函数（短期/中期/长期）
// ============================================

/**
 * 添加短期记忆
 */
async function addShortTermMemory(avatarId, role, content) {
  const coll = await getAgentKnowledgeBasesCollection();
  const memory = { role, content, timestamp: new Date() };
  // 保持最多20条短期记忆
  await coll.updateOne(
    { avatarId },
    {
      $push: { shortTermMemory: { $each: [memory], $slice: -20 } },
      $set: { updatedAt: new Date() }
    }
  );
}

/**
 * 获取短期记忆
 */
async function getShortTermMemories(avatarId) {
  const coll = await getAgentKnowledgeBasesCollection();
  const kb = await coll.findOne({ avatarId }, { projection: { shortTermMemory: 1 } });
  return kb ? kb.shortTermMemory : [];
}

/**
 * 清空短期记忆
 */
async function clearShortTermMemories(avatarId) {
  const coll = await getAgentKnowledgeBasesCollection();
  return await coll.updateOne(
    { avatarId },
    { $set: { shortTermMemory: [], updatedAt: new Date() } }
  );
}

/**
 * 添加中期记忆
 */
async function addMediumTermMemory(avatarId, summary, keyPoints = []) {
  const coll = await getAgentKnowledgeBasesCollection();
  const memory = { summary, keyPoints, timestamp: new Date() };
  await coll.updateOne(
    { avatarId },
    {
      $push: { mediumTermMemory: memory },
      $set: { updatedAt: new Date() }
    }
  );
}

/**
 * 获取中期记忆
 */
async function getMediumTermMemories(avatarId) {
  const coll = await getAgentKnowledgeBasesCollection();
  const kb = await coll.findOne({ avatarId }, { projection: { mediumTermMemory: 1 } });
  return kb ? kb.mediumTermMemory : [];
}

/**
 * 清空中期记忆
 */
async function clearMediumTermMemories(avatarId) {
  const coll = await getAgentKnowledgeBasesCollection();
  return await coll.updateOne(
    { avatarId },
    { $set: { mediumTermMemory: [], updatedAt: new Date() } }
  );
}

/**
 * 设置长期记忆
 */
async function setLongTermMemory(avatarId, roleDescription, personality, knowledge) {
  const coll = await getAgentKnowledgeBasesCollection();
  return await coll.updateOne(
    { avatarId },
    {
      $set: {
        longTermMemory: {
          roleDescription,
          personality,
          knowledge,
          updatedAt: new Date()
        },
        updatedAt: new Date()
      }
    }
  );
}

/**
 * 获取长期记忆
 */
async function getLongTermMemory(avatarId) {
  const coll = await getAgentKnowledgeBasesCollection();
  const kb = await coll.findOne({ avatarId }, { projection: { longTermMemory: 1 } });
  return kb ? kb.longTermMemory : null;
}

// ============================================
// 匿名会话函数
// ============================================

/**
 * 创建匿名会话
 */
async function createAgentSession(avatarId, visitorIp, expiresAt = null) {
  const coll = await getAgentSessionsCollection();
  const sessionId = 's_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 12);
  await coll.insertOne({
    sessionId,
    avatarId,
    visitorIp,
    messages: [],
    createdAt: new Date(),
    expiresAt,
    // 人工介入相关字段
    mode: 'ai', // 'ai' | 'human' - 当前模式
    humanOperatorId: null, // 人工客服ID
    humanJoinedAt: null, // 人工加入时间
    pendingHuman: false, // 是否等待人工接入
    status: 'active' // 'active' | 'closed' - 会话状态
  });
  return sessionId;
}

/**
 * 获取匿名会话
 */
async function getAgentSession(sessionId) {
  const coll = await getAgentSessionsCollection();
  return await coll.findOne({ sessionId });
}

/**
 * 按avatarId获取所有会话
 */
async function getAgentSessionsByAvatar(avatarId) {
  const coll = await getAgentSessionsCollection();
  const sessions = await coll.find({ avatarId }).sort({ createdAt: -1 }).toArray();
  return sessions;
}

/**
 * 添加会话消息
 */
async function addSessionMessage(sessionId, role, content, messageType = 'text', imageUrl = null) {
  const coll = await getAgentSessionsCollection();
  const message = {
    role,
    content,
    messageType,
    timestamp: new Date()
  };
  if (imageUrl) {
    message.imageUrl = imageUrl;
  }
  return await coll.updateOne(
    { sessionId },
    { $push: { messages: message }, $set: { updatedAt: new Date() } }
  );
}

/**
 * 获取会话消息
 */
async function getSessionMessages(sessionId) {
  const coll = await getAgentSessionsCollection();
  const session = await coll.findOne({ sessionId }, { projection: { messages: 1 } });
  return session ? session.messages : [];
}

/**
 * 关闭会话
 */
async function closeSession(sessionId) {
  const coll = await getAgentSessionsCollection();
  return await coll.deleteOne({ sessionId });
}

/**
 * 更新会话模式（AI/人工）
 */
async function updateSessionMode(sessionId, mode, humanOperatorId = null) {
  const coll = await getAgentSessionsCollection();
  const update = { mode };
  if (mode === 'human') {
    update.humanOperatorId = humanOperatorId;
    update.humanJoinedAt = new Date();
  } else {
    update.humanOperatorId = null;
    update.humanJoinedAt = null;
  }
  return await coll.updateOne(
    { sessionId },
    { $set: update }
  );
}

/**
 * 设置等待人工接入
 */
async function setSessionPendingHuman(sessionId, pending) {
  const coll = await getAgentSessionsCollection();
  return await coll.updateOne(
    { sessionId },
    { $set: { pendingHuman: pending } }
  );
}

/**
 * 获取会员的所有分身的所有活跃会话
 */
async function getActiveSessionsByUser(userId) {
  const coll = await getAgentSessionsCollection();
  // 需要通过avatarId关联查询，这里先获取该用户的所有avatar_id
  const rows = await db.query(
    'SELECT avatar_id FROM ai_agent_avatars WHERE user_id = ?',
    [userId]
  );
  if (rows.length === 0) return [];

  const avatarIds = rows.map(r => r.avatar_id);
  const sessions = await coll.find({
    avatarId: { $in: avatarIds },
    status: 'active'
  }).sort({ createdAt: -1 }).toArray();
  return sessions;
}

/**
 * 关闭会话（标记为关闭）
 */
async function closeAgentSession(sessionId) {
  const coll = await getAgentSessionsCollection();
  return await coll.updateOne(
    { sessionId },
    { $set: { status: 'closed', closedAt: new Date() } }
  );
}

/**
 * 标记消息为已读
 */
async function markMessageRead(sessionId, messageId) {
  const coll = await getAgentSessionsCollection();
  return await coll.updateOne(
    { sessionId, 'messages.timestamp': new Date(messageId) },
    { $set: { 'messages.$.read': true } }
  );
}

/**
 * 标记会话中某角色的所有消息为已读
 */
async function markSessionMessagesRead(sessionId, role) {
  const coll = await getAgentSessionsCollection();
  return await coll.updateMany(
    { sessionId, 'messages.role': role },
    { $set: { 'messages.$[elem].read': true } },
    { arrayFilters: [{ 'elem.role': role }] }
  );
}

/**
 * 获取会话的未读计数
 */
async function getUnreadCount(sessionId) {
  const coll = await getAgentSessionsCollection();
  const session = await coll.findOne({ sessionId }, { projection: { messages: 1 } });
  if (!session) return { user: 0, operator: 0 };

  let userUnread = 0;
  let operatorUnread = 0;

  for (const msg of session.messages || []) {
    if (!msg.read) {
      if (msg.role === 'user') userUnread++;
      else if (msg.role === 'human_operator') operatorUnread++;
    }
  }

  return { user: userUnread, operator: operatorUnread };
}

/**
 * 更新会话的最后消息时间
 */
async function updateSessionLastMessage(sessionId) {
  const coll = await getAgentSessionsCollection();
  return await coll.updateOne(
    { sessionId },
    { $set: { lastMessageAt: new Date(), updatedAt: new Date() } }
  );
}

/**
 * 批量获取会话列表（带分页）
 */
async function getSessionsByAvatar(avatarId, options = {}) {
  const { page = 1, limit = 20, status = 'active' } = options;
  const coll = await getAgentSessionsCollection();

  const query = { avatarId };
  if (status) query.status = status;

  const skip = (page - 1) * limit;

  const [sessions, total] = await Promise.all([
    coll.find(query)
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    coll.countDocuments(query)
  ]);

  return { sessions, total, page, limit };
}

/**
 * 将会话分配给客服
 */
async function assignSessionToOperator(sessionId, operatorId, operatorName) {
  const coll = await getAgentSessionsCollection();
  return await coll.updateOne(
    { sessionId },
    {
      $set: {
        humanOperatorId: operatorId,
        operatorName: operatorName,
        assignedAt: new Date()
      }
    }
  );
}

/**
 * 获取客服当前正在处理的会话
 */
async function getOperatorSessions(operatorId) {
  const coll = await getAgentSessionsCollection();
  return await coll.find({
    humanOperatorId: operatorId,
    status: 'active'
  }).sort({ assignedAt: -1 }).toArray();
}

module.exports = {
  getClient,
  getDb,
  getBattleLogsCollection,
  getUserGameRecordsCollection,
  insertUserGameRecord,
  getAgentConversationsCollection,
  getAgentConversationThreadsCollection,
  getAgentMemoriesCollection,
  insertBattleLog,
  insertAgentConversation,
  insertAgentConversationThread,
  getAgentConversationThreads,
  getAgentConversationHistoryByThread,
  upsertAgentMemory,
  getAgentMemory,
  getAgentConversationCount,
  getAgentConversationsForMemory,
  deleteAgentMemoriesOlderThan,
  close,
  // 新增：AI分身知识库和匿名会话
  getAgentKnowledgeBasesCollection,
  getAgentSessionsCollection,
  createAgentKnowledgeBase,
  getAgentKnowledgeBase,
  updateAgentKnowledgeBase,
  deleteAgentKnowledgeBase,
  addKnowledgeDocument,
  updateKnowledgeDocument,
  deleteKnowledgeDocument,
  getKnowledgeDocuments,
  cleanOldKnowledgeDocuments,
  getKnowledgeStats,
  addShortTermMemory,
  getShortTermMemories,
  clearShortTermMemories,
  addMediumTermMemory,
  getMediumTermMemories,
  clearMediumTermMemories,
  setLongTermMemory,
  getLongTermMemory,
  createAgentSession,
  getAgentSession,
  getAgentSessionsByAvatar,
  addSessionMessage,
  getSessionMessages,
  closeSession,
  // 新增：知识库分类
  addCategory,
  updateCategory,
  deleteCategory,
  getCategories,
  addDocuments,
  // 人工介入相关
  updateSessionMode,
  setSessionPendingHuman,
  getActiveSessionsByUser,
  closeAgentSession,
  // 实时消息同步相关
  markMessageRead,
  markSessionMessagesRead,
  getUnreadCount,
  updateSessionLastMessage,
  getSessionsByAvatar,
  assignSessionToOperator,
  getOperatorSessions,
  // 能量消耗记录
  insertEnergyConsumption,
  getEnergyConsumptionList,
  getEnergyConsumptionCount,
  // 玩家广场
  getPlazaPostsCollection,
  getPlazaCommentsCollection,
  getPlazaLikesCollection,
  // 自由PK团
  getPlazaFreePKGroupsCollection,
  getPlazaFreePKParticipantsCollection,
  createFreePKGroup,
  getFreePKGroup,
  updateFreePKGroup,
  deleteFreePKGroup,
  addFreePKParticipant,
  getFreePKParticipants,
  updateFreePKParticipant,
  hasJoinedFreePK,

  // 播客功能
  getPodcastPodcastsCollection,
  getPodcastEpisodesCollection,
  getPodcastSubscriptionsCollection,
  getPodcastCommentsCollection,
  getPodcastLikesCollection,

  // 能量交易功能
  getEnergyTradeMessagesCollection,
  saveEnergyTradeMessage,
  getEnergyTradeMessages,
  markEnergyTradeMessagesAsRead,
  getUnreadEnergyTradeMessageCount,
  getEnergyTradeNotificationsCollection,
  createEnergyTradeNotification,
  getEnergyTradeNotifications,
  getUnreadEnergyTradeNotificationCount,
  markEnergyTradeNotificationAsRead,
  markAllEnergyTradeNotificationsAsRead,

  // 象棋房间功能
  getChessRoomsCollection,
  getChessGamesCollection,
  createChessRoom,
  getChessRoom,
  updateChessRoom,
  deleteChessRoom,
  createChessGame,
  updateChessGame,
  getChessGamesByRoom,
  getAllChessRooms,
  getChessRoomById,
  getAllChessGames,
  getChessGameById,

  // 访客记录
  getVisitorLogsCollection,
  recordPageView,
  recordPageLeave,
  getVisitorStats,
  getIPVisitHistory,
  getIPList,
  getPageStats,
  getVisitorOverview
};

// ============================================
// 播客功能集合
// ============================================

/**
 * 获取播客主表集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getPodcastPodcastsCollection() {
  const database = await getDb();
  const coll = database.collection(PODCAST_PODCASTS_COLLECTION);
  await coll.createIndex({ author_id: 1, created_at: -1 });
  await coll.createIndex({ status: 1, created_at: -1 });
  await coll.createIndex({ category: 1 });
  await coll.createIndex({ title: 'text', description: 'text' });
  return coll;
}

/**
 * 获取剧集表集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getPodcastEpisodesCollection() {
  const database = await getDb();
  const coll = database.collection(PODCAST_EPISODES_COLLECTION);
  await coll.createIndex({ podcast_id: 1, published_at: -1 });
  await coll.createIndex({ status: 1, published_at: -1 });
  return coll;
}

/**
 * 获取订阅关系表集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getPodcastSubscriptionsCollection() {
  const database = await getDb();
  const coll = database.collection(PODCAST_SUBSCRIPTIONS_COLLECTION);
  await coll.createIndex({ podcast_id: 1, user_id: 1 }, { unique: true });
  await coll.createIndex({ user_id: 1, subscribed_at: -1 });
  return coll;
}

/**
 * 获取播客评论表集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getPodcastCommentsCollection() {
  const database = await getDb();
  const coll = database.collection(PODCAST_COMMENTS_COLLECTION);
  await coll.createIndex({ target_id: 1, target_type: 1, created_at: -1 });
  await coll.createIndex({ user_id: 1, created_at: -1 });
  return coll;
}

/**
 * 获取播客点赞表集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getPodcastLikesCollection() {
  const database = await getDb();
  const coll = database.collection(PODCAST_LIKES_COLLECTION);
  await coll.createIndex({ user_id: 1, target_id: 1, target_type: 1 }, { unique: true });
  await coll.createIndex({ target_id: 1, target_type: 1 });
  return coll;
}

// ============================================================
// 能量交易消息相关函数（MongoDB存储）
// ============================================================

/**
 * 获取能量交易消息集合
 */
async function getEnergyTradeMessagesCollection() {
  const database = await getDb();
  const coll = database.collection(ENERGY_TRADE_MESSAGES_COLLECTION);
  // 创建索引
  await coll.createIndex({ trade_id: 1, created_at: -1 });
  await coll.createIndex({ sender_id: 1 });
  return coll;
}

/**
 * 保存能量交易消息到MongoDB
 */
async function saveEnergyTradeMessage(tradeId, senderId, senderUsername, senderRole, content, messageType = 'text') {
  const coll = await getEnergyTradeMessagesCollection();
  const result = await coll.insertOne({
    trade_id: parseInt(tradeId),
    sender_id: senderId,
    sender_username: senderUsername,
    sender_role: senderRole,
    content: content,
    message_type: messageType,
    created_at: new Date(),
    is_read: false
  });
  return result.insertedId;
}

/**
 * 获取能量交易消息列表
 */
async function getEnergyTradeMessages(tradeId, limit = 50, before = null) {
  const coll = await getEnergyTradeMessagesCollection();
  const query = { trade_id: parseInt(tradeId) };
  if (before) {
    query.created_at = { $lt: new Date(before) };
  }
  return await coll.find(query)
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
}

/**
 * 标记消息为已读
 */
async function markEnergyTradeMessagesAsRead(tradeId, userId) {
  const coll = await getEnergyTradeMessagesCollection();
  return await coll.updateMany(
    { trade_id: parseInt(tradeId), is_read: false, sender_id: { $ne: userId } },
    { $set: { is_read: true, read_at: new Date() } }
  );
}

/**
 * 获取未读消息数量
 */
async function getUnreadEnergyTradeMessageCount(tradeId, userId) {
  const coll = await getEnergyTradeMessagesCollection();
  return await coll.countDocuments({
    trade_id: parseInt(tradeId),
    sender_id: { $ne: userId },
    is_read: false
  });
}

// ============================================================
// 能量交易通知相关函数（MongoDB存储）
// ============================================================

/**
 * 获取能量交易通知集合
 */
async function getEnergyTradeNotificationsCollection() {
  const database = await getDb();
  const coll = database.collection(ENERGY_TRADE_NOTIFICATIONS_COLLECTION);
  // 创建索引
  await coll.createIndex({ user_id: 1, created_at: -1 });
  await coll.createIndex({ user_id: 1, is_read: 1 });
  await coll.createIndex({ trade_id: 1 });
  return coll;
}

/**
 * 创建能量交易通知
 */
async function createEnergyTradeNotification(userId, tradeId, type, title, content, data = {}) {
  const coll = await getEnergyTradeNotificationsCollection();
  const result = await coll.insertOne({
    user_id: userId,
    trade_id: parseInt(tradeId),
    type: type,
    title: title,
    content: content,
    data: data,
    is_read: false,
    created_at: new Date()
  });
  return result.insertedId;
}

/**
 * 获取用户通知列表
 */
async function getEnergyTradeNotifications(userId, limit = 20, offset = 0) {
  const coll = await getEnergyTradeNotificationsCollection();
  return await coll.find({ user_id: userId })
    .sort({ created_at: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();
}

/**
 * 获取用户未读通知数量
 */
async function getUnreadEnergyTradeNotificationCount(userId) {
  const coll = await getEnergyTradeNotificationsCollection();
  return await coll.countDocuments({ user_id: userId, is_read: false });
}

/**
 * 标记通知为已读
 */
async function markEnergyTradeNotificationAsRead(notificationId) {
  const coll = await getEnergyTradeNotificationsCollection();
  const { ObjectId } = require('mongodb');
  return await coll.updateOne(
    { _id: new ObjectId(notificationId) },
    { $set: { is_read: true, read_at: new Date() } }
  );
}

/**
 * 标记用户所有通知为已读
 */
async function markAllEnergyTradeNotificationsAsRead(userId) {
  const coll = await getEnergyTradeNotificationsCollection();
  return await coll.updateMany(
    { user_id: userId, is_read: false },
    { $set: { is_read: true, read_at: new Date() } }
  );
}

// ============================================
// 访客记录功能
// ============================================

const VISITOR_LOGS_COLLECTION = 'visitor_logs';

/**
 * 获取访客记录集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getVisitorLogsCollection() {
  const database = await getDb();
  const coll = database.collection(VISITOR_LOGS_COLLECTION);
  // 创建索引
  await coll.createIndex({ ip: 1, createdAt: -1 });
  await coll.createIndex({ sessionId: 1 });
  await coll.createIndex({ page: 1, createdAt: -1 });
  await coll.createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }); // 30天后自动过期
  return coll;
}

/**
 * 记录页面访问
 * @param {string} ip - 访客IP
 * @param {string} userAgent - 浏览器User-Agent
 * @param {string} page - 页面路径
 * @param {string} sessionId - 会话ID
 * @returns {Promise<import('mongodb').InsertOneResult>}
 */
async function recordPageView(ip, userAgent, page, sessionId) {
  const coll = await getVisitorLogsCollection();
  return await coll.insertOne({
    ip,
    userAgent,
    page,
    sessionId,
    enterTime: new Date(),
    leaveTime: null,
    duration: null,
    createdAt: new Date()
  });
}

/**
 * 记录页面离开（更新停留时间）
 * @param {string} sessionId - 会话ID
 * @param {string} page - 页面路径
 * @returns {Promise<import('mongodb').UpdateResult>}
 */
async function recordPageLeave(sessionId, page) {
  const coll = await getVisitorLogsCollection();
  const now = new Date();

  // 查找最新的未离开记录
  const record = await coll.findOne({
    sessionId,
    page,
    leaveTime: null
  }, { sort: { createdAt: -1 } });

  if (!record) {
    return { modifiedCount: 0, matchedCount: 0 };
  }

  const enterTime = new Date(record.enterTime);
  const duration = Math.floor((now - enterTime) / 1000); // 停留秒数

  return await coll.updateOne(
    { _id: record._id },
    { $set: { leaveTime: now, duration } }
  );
}

/**
 * 获取访客统计
 * @param {Object} filters - 筛选条件 { startDate, endDate, ip, page }
 * @param {number} page - 页码
 * @param {number} limit - 每页数量
 * @returns {Promise<{data: Array, total: number}>}
 */
async function getVisitorStats(filters = {}, page = 1, limit = 20) {
  const coll = await getVisitorLogsCollection();
  const query = {};

  if (filters.startDate) {
    query.createdAt = { $gte: new Date(filters.startDate) };
  }
  if (filters.endDate) {
    query.createdAt = { ...query.createdAt, $lte: new Date(filters.endDate) };
  }
  if (filters.ip) {
    query.ip = filters.ip;
  }
  if (filters.page) {
    query.page = filters.page;
  }

  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    coll.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    coll.countDocuments(query)
  ]);

  return { data, total };
}

/**
 * 获取IP访问历史
 * @param {string} ip - IP地址
 * @param {number} limit - 限制数量
 * @returns {Promise<Array>}
 */
async function getIPVisitHistory(ip, limit = 50) {
  const coll = await getVisitorLogsCollection();
  return await coll.find({ ip })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * 获取IP列表（按IP分组统计）
 * @param {Object} filters - 筛选条件
 * @param {number} page - 页码
 * @param {number} limit - 每页数量
 * @returns {Promise<{data: Array, total: number}>}
 */
async function getIPList(filters = {}, page = 1, limit = 20) {
  const coll = await getVisitorLogsCollection();
  const query = {};

  if (filters.startDate) {
    query.createdAt = { $gte: new Date(filters.startDate) };
  }
  if (filters.endDate) {
    query.createdAt = { ...query.createdAt, $lte: new Date(filters.endDate) };
  }

  const skip = (page - 1) * limit;

  // 按IP分组统计
  const pipeline = [
    { $match: query },
    {
      $group: {
        _id: '$ip',
        visitCount: { $sum: 1 },
        pageCount: { $addToSet: '$page' },
        firstVisit: { $min: '$createdAt' },
        lastVisit: { $max: '$createdAt' },
        avgDuration: { $avg: '$duration' }
      }
    },
    {
      $project: {
        ip: '$_id',
        visitCount: 1,
        pageCount: { $size: '$pageCount' },
        firstVisit: 1,
        lastVisit: 1,
        avgDuration: { $round: ['$avgDuration', 0] },
        _id: 0
      }
    },
    { $sort: { lastVisit: -1 } },
    { $skip: skip },
    { $limit: limit }
  ];

  const data = await coll.aggregate(pipeline).toArray();
  const total = await coll.distinct('ip', query);

  return { data, total: total.length };
}

/**
 * 获取页面访问统计
 * @param {Object} filters - 筛选条件
 * @param {number} limit - 返回数量
 * @returns {Promise<Array>}
 */
async function getPageStats(filters = {}, limit = 10) {
  const coll = await getVisitorLogsCollection();
  const query = {};

  if (filters.startDate) {
    query.createdAt = { $gte: new Date(filters.startDate) };
  }
  if (filters.endDate) {
    query.createdAt = { ...query.createdAt, $lte: new Date(filters.endDate) };
  }

  const pipeline = [
    { $match: query },
    {
      $group: {
        _id: '$page',
        visitCount: { $sum: 1 },
        uniqueIPs: { $addToSet: '$ip' },
        avgDuration: { $avg: '$duration' }
      }
    },
    {
      $project: {
        page: '$_id',
        visitCount: 1,
        uniqueIPCount: { $size: '$uniqueIPs' },
        avgDuration: { $round: ['$avgDuration', 0] },
        _id: 0
      }
    },
    { $sort: { visitCount: -1 } },
    { $limit: limit }
  ];

  return await coll.aggregate(pipeline).toArray();
}

/**
 * 获取访客概览统计
 * @param {string} date - 日期字符串 (YYYY-MM-DD)，默认今天
 * @returns {Promise<Object>}
 */
async function getVisitorOverview(date = null) {
  const coll = await getVisitorLogsCollection();
  const targetDate = date ? new Date(date) : new Date();
  const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
  const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));

  // 今日统计
  const todayQuery = { createdAt: { $gte: startOfDay, $lte: endOfDay } };
  const [todayStats, totalStats, pageStats] = await Promise.all([
    coll.aggregate([
      { $match: todayQuery },
      {
        $group: {
          _id: null,
          visitCount: { $sum: 1 },
          uniqueIPs: { $addToSet: '$ip' }
        }
      },
      {
        $project: {
          visitCount: 1,
          uniqueIPCount: { $size: '$uniqueIPs' },
          _id: 0
        }
      }
    ]).toArray(),
    coll.distinct('ip', {}),
    getPageStats({}, 5)
  ]);

  return {
    todayVisits: todayStats[0]?.visitCount || 0,
    todayUniqueIPs: todayStats[0]?.uniqueIPCount || 0,
    totalUniqueIPs: totalStats.length,
    topPages: pageStats
  };
}

// ============================================
// 象棋房间功能
// ============================================

/**
 * 获取象棋房间集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getChessRoomsCollection() {
  const database = await getDb();
  const coll = database.collection(CHESS_ROOMS_COLLECTION);
  await coll.createIndex({ creatorId: 1 });
  await coll.createIndex({ gameStatus: 1 });
  await coll.createIndex({ createdAt: -1 });
  await coll.createIndex({ isPublic: 1 });
  return coll;
}

/**
 * 获取象棋对局记录集合
 * @returns {Promise<import('mongodb').Collection>}
 */
async function getChessGamesCollection() {
  const database = await getDb();
  const coll = database.collection(CHESS_GAMES_COLLECTION);
  await coll.createIndex({ roomId: 1 });
  await coll.createIndex({ endedAt: -1 });
  return coll;
}

/**
 * 创建象棋房间
 * @param {Object} roomData - 房间数据
 * @returns {Promise<import('mongodb').InsertOneResult>}
 */
async function createChessRoom(roomData) {
  const coll = await getChessRoomsCollection();
  return await coll.insertOne({
    ...roomData,
    gameStatus: 'waiting',
    currentTurn: 'red',
    boardState: null,
    moves: [],
    redScore: 0,
    blackScore: 0,
    currentGames: 0,
    viewerCount: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

/**
 * 获取象棋房间
 * @param {string} roomId - 房间ID
 * @returns {Promise<Object|null>}
 */
async function getChessRoom(roomId) {
  const coll = await getChessRoomsCollection();
  const { ObjectId } = require('mongodb');
  return await coll.findOne({ _id: ObjectId.createFromHexString(roomId) });
}

/**
 * 更新象棋房间
 * @param {string} roomId - 房间ID
 * @param {Object} update - 更新数据
 * @returns {Promise<import('mongodb').UpdateResult>}
 */
async function updateChessRoom(roomId, update) {
  const coll = await getChessRoomsCollection();
  const { ObjectId } = require('mongodb');
  return await coll.updateOne(
    { _id: ObjectId.createFromHexString(roomId) },
    { $set: { ...update, updatedAt: new Date() } }
  );
}

/**
 * 删除象棋房间
 * @param {string} roomId - 房间ID
 * @returns {Promise<import('mongodb').DeleteResult>}
 */
async function deleteChessRoom(roomId) {
  const coll = await getChessRoomsCollection();
  const { ObjectId } = require('mongodb');
  return await coll.deleteOne({ _id: ObjectId.createFromHexString(roomId) });
}

/**
 * 创建象棋对局记录
 * @param {Object} gameData - 对局数据
 * @returns {Promise<import('mongodb').InsertOneResult>}
 */
async function createChessGame(gameData) {
  const coll = await getChessGamesCollection();
  return await coll.insertOne({
    ...gameData,
    moves: [],
    energyExchanged: 0,
    startedAt: new Date(),
    endedAt: null
  });
}

/**
 * 更新象棋对局记录
 * @param {string} gameId - 对局ID
 * @param {Object} update - 更新数据
 * @returns {Promise<import('mongodb').UpdateResult>}
 */
async function updateChessGame(gameId, update) {
  const coll = await getChessGamesCollection();
  const { ObjectId } = require('mongodb');
  return await coll.updateOne(
    { _id: ObjectId.createFromHexString(gameId) },
    { $set: update }
  );
}

/**
 * 获取房间的所有对局记录
 * @param {string} roomId - 房间ID
 * @returns {Promise<Array>}
 */
async function getChessGamesByRoom(roomId) {
  const coll = await getChessGamesCollection();
  const { ObjectId } = require('mongodb');
  return await coll.find({ roomId: ObjectId.createFromHexString(roomId) })
    .sort({ gameNumber: 1 })
    .toArray();
}

/**
 * 获取所有象棋房间（管理用，支持筛选和分页）
 * @param {Object} filter - 筛选条件
 * @param {Object} options - 分页和排序选项 { page, limit, sort }
 * @returns {Promise<{rooms: Array, total: number}>}
 */
async function getAllChessRooms(filter = {}, options = {}) {
  const coll = await getChessRoomsCollection();
  const { page = 1, limit = 20, sort = { createdAt: -1 } } = options;
  const skip = (page - 1) * limit;

  // 构建查询条件
  const query = { isDeleted: { $ne: true } };

  if (filter.status) {
    query.gameStatus = filter.status;
  }

  if (filter.search) {
    const searchRegex = new RegExp(filter.search, 'i');
    query.$or = [
      { roomName: searchRegex },
      { creatorName: searchRegex },
      { redPlayerName: searchRegex },
      { blackPlayerName: searchRegex }
    ];
  }

  const rooms = await coll.find(query)
    .sort(sort)
    .skip(skip)
    .limit(limit)
    .toArray();

  const total = await coll.countDocuments(query);

  return { rooms, total };
}

/**
 * 获取单个象棋房间（管理用，包含全部信息）
 * @param {string} roomId - 房间ID
 * @returns {Promise<Object|null>}
 */
async function getChessRoomById(roomId) {
  const coll = await getChessRoomsCollection();
  const { ObjectId } = require('mongodb');
  return await coll.findOne({ _id: ObjectId.createFromHexString(roomId) });
}

/**
 * 获取所有对局记录（管理用，支持筛选和分页）
 * @param {Object} filter - 筛选条件
 * @param {Object} options - 分页和排序选项 { page, limit, sort }
 * @returns {Promise<{games: Array, total: number}>}
 */
async function getAllChessGames(filter = {}, options = {}) {
  const coll = await getChessGamesCollection();
  const { page = 1, limit = 20, sort = { startedAt: -1 } } = options;
  const skip = (page - 1) * limit;

  // 构建查询条件
  const query = {};

  if (filter.roomId) {
    const { ObjectId } = require('mongodb');
    query.roomId = ObjectId.createFromHexString(filter.roomId);
  }

  if (filter.winner) {
    query.winner = filter.winner;
  }

  if (filter.redPlayerId) {
    query.redPlayerId = parseInt(filter.redPlayerId);
  }

  if (filter.blackPlayerId) {
    query.blackPlayerId = parseInt(filter.blackPlayerId);
  }

  const games = await coll.find(query)
    .sort(sort)
    .skip(skip)
    .limit(limit)
    .toArray();

  const total = await coll.countDocuments(query);

  return { games, total };
}

/**
 * 获取单个对局记录（管理用，包含完整棋谱）
 * @param {string} gameId - 对局ID
 * @returns {Promise<Object|null>}
 */
async function getChessGameById(gameId) {
  const coll = await getChessGamesCollection();
  const { ObjectId } = require('mongodb');
  return await coll.findOne({ _id: ObjectId.createFromHexString(gameId) });
}

