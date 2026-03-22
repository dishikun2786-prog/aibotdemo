/**
 * @file message-queue.js
 * @module services/message-queue
 * @description 消息队列Worker - 处理异步任务
 * 通过Redis Stream实现异步任务处理，提升主请求响应速度
 */
const redis = require('../utils/redis');
const db = require('../utils/db');
const mongo = require('../utils/mongo');
const minimax = require('../utils/minimax');
const bailian = require('../utils/bailian');
const cache = require('../utils/cache');

// Stream键名定义
const STREAMS = {
  AGENT_CHAT: 'agent-chat:tasks',      // 客服对话异步任务
  ENERGY_DEDUCT: 'energy:deduct',        // 能量扣减任务
  KNOWLEDGE_SAVE: 'knowledge:save',     // 知识库保存任务
  MEMORY_UPDATE: 'memory:update',        // 记忆更新任务
  MESSAGE_SAVE: 'message:save',          // 消息记录任务
  // 新增：实时消息Stream
  AGENT_CHAT_MESSAGES: 'agent:chat:messages',     // 实时消息推送
  AGENT_CHAT_STATUS: 'agent:chat:status',        // 状态变更通知
  AGENT_CHAT_OFFLINE: 'agent:chat:offline',     // 离线消息队列
  // 播客任务队列
  PODCAST_TASKS: 'podcast:tasks',         // 播客异步任务
  // 支付商户任务队列
  PAYMENT_ORDER: 'payment:orders',        // 支付订单任务
  PAYMENT_NOTIFY: 'payment:notify'         // 支付通知任务
};

// 任务类型
const TASK_TYPES = {
  SAVE_MESSAGE: 'save_message',
  UPDATE_MEMORY: 'update_memory',
  SAVE_KNOWLEDGE: 'save_knowledge',
  UPDATE_CHAT_COUNT: 'update_chat_count',
  DEDUCT_ENERGY: 'deduct_energy',
  // 新增：实时消息任务
  PROCESS_MESSAGE: 'process_message',     // 处理新消息
  AI_RESPONSE: 'ai_response',            // AI响应生成
  OFFLINE_CHECK: 'offline_check',        // 离线检查
  SESSION_ASSIGN: 'session_assign',      // 会话分配
  // 新增：AI总结任务
  AI_SUMMARY: 'ai_summary',              // AI总结对话
  // 播客任务
  PODCAST_PLAY: 'podcast_play',          // 播放记录
  PODCAST_STATS_UPDATE: 'podcast_stats_update',  // 统计更新
  PODCAST_LIKE: 'podcast_like',         // 点赞处理
  PODCAST_SUBSCRIBE: 'podcast_subscribe',  // 订阅处理
  // 支付商户任务
  PAYMENT_CREATE_ORDER: 'payment_create_order',        // 创建订单
  PAYMENT_ORDER_PAID: 'payment_order_paid',           // 订单已付款
  PAYMENT_ORDER_CONFIRMED: 'payment_order_confirmed', // 订单已确认
  PAYMENT_ORDER_CANCELLED: 'payment_order_cancelled', // 订单已取消
  PAYMENT_SEND_MERCHANT_NOTIFY: 'payment_send_merchant_notify',   // 通知商户
  PAYMENT_SEND_PAYER_NOTIFY: 'payment_send_payer_notify',         // 通知付款人
  PAYMENT_UPDATE_STATS: 'payment_update_stats'        // 更新统计缓存
};

/**
 * 任务入队 - 添加到指定Stream
 * @param {string} streamKey - Stream键名
 * @param {Object} payload - 任务数据
 * @returns {Promise<string|null>} 消息ID
 */
async function enqueue(streamKey, payload) {
  return await redis.xAdd(streamKey, payload, 1000); // 保留最近1000条
}

/**
 * 客服对话任务入队
 * @param {Object} data - 对话数据
 */
async function enqueueAgentChatTask(data) {
  const taskType = data.type || TASK_TYPES.SAVE_MESSAGE;
  await enqueue(STREAMS.AGENT_CHAT, {
    type: taskType,
    ...data,
    createdAt: new Date().toISOString()
  });
}

/**
 * 播客任务入队
 * @param {Object} data - 播客任务数据
 */
async function enqueuePodcastTask(data) {
  const taskType = data.type || TASK_TYPES.PODCAST_STATS_UPDATE;
  try {
    // 确保 type 字段在最后，避免被 data 中的 type 覆盖
    await enqueue(STREAMS.PODCAST_TASKS, {
      ...data,
      type: taskType,
      createdAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('[MessageQueue] 播客任务入队失败:', err.message);
  }
}

/**
 * 处理消息保存任务
 */
async function handleSaveMessage(data) {
  try {
    const { sessionId, role, content } = data;
    if (!sessionId || !content) {
      console.error('[MessageQueue] 消息保存任务缺少必要参数');
      return;
    }
    await mongo.addSessionMessage(sessionId, role, content);
  } catch (error) {
    console.error('[MessageQueue] 消息保存失败:', error.message);
  }
}

/**
 * 处理记忆更新任务
 */
async function handleUpdateMemory(data) {
  try {
    const { avatarId, role, content } = data;
    if (!avatarId || !content) {
      console.error('[MessageQueue] 记忆更新任务缺少必要参数');
      return;
    }
    await mongo.addShortTermMemory(avatarId, role, content);
  } catch (error) {
    console.error('[MessageQueue] 记忆更新失败:', error.message);
  }
}

/**
 * 处理知识库保存任务
 */
async function handleSaveKnowledge(data) {
  try {
    const { avatarId, title, content, tags } = data;
    if (!avatarId || !content) {
      console.error('[MessageQueue] 知识库保存任务缺少必要参数');
      return;
    }
    await mongo.addKnowledgeDocument(avatarId, title, content, null, tags || ['客服对话']);
  } catch (error) {
    console.error('[MessageQueue] 知识库保存失败:', error.message);
  }
}

/**
 * 处理对话计数更新任务
 */
async function handleUpdateChatCount(data) {
  try {
    const { avatarId } = data;
    if (!avatarId) {
      console.error('[MessageQueue] 对话计数更新任务缺少avatarId');
      return;
    }
    await db.query(
      'UPDATE ai_agent_avatars SET chat_count = chat_count + 1 WHERE avatar_id = ?',
      [avatarId]
    );
  } catch (error) {
    console.error('[MessageQueue] 对话计数更新失败:', error.message);
  }
}

/**
 * 处理能量扣减任务（简化版）
 * 只保留必要的数据库操作，移除重复的MongoDB写入
 */
async function handleDeductEnergy(data) {
  try {
    const { userId, energyCost, avatarId, sessionId, userMessage, agentMessage, threadId } = data;
    if (!userId || energyCost === undefined) {
      console.error('[MessageQueue] 能量扣减任务缺少必要参数');
      return;
    }

    // 使用事务保存对话记录和更新能量
    await db.transaction(async (conn) => {
      // 扣减能量
      await conn.execute(
        'UPDATE users SET energy = GREATEST(0, energy - ?) WHERE id = ?',
        [energyCost, userId]
      );

      // 保存对话记录到MySQL（主存储）
      if (userMessage && agentMessage) {
        try {
          await conn.execute(
            `INSERT INTO ai_agent_conversations (agent_id, thread_id, user_message, agent_message, energy_cost)
             VALUES (?, ?, ?, ?, ?)`,
            [avatarId, threadId || null, userMessage, agentMessage, energyCost]
          );
        } catch (e) {
          console.error('[MessageQueue] 保存对话记录失败:', e.message);
        }
      }
    });

    // 异步记录能量消耗到MongoDB（可选，不阻塞主流程）
    if (userId && energyCost) {
      setImmediate(async () => {
        try {
          await mongo.insertEnergyConsumption({
            userId,
            type: 'agent_chat',
            amount: energyCost,
            mode: 'text',
            avatarId,
            sessionId,
            threadId,
            createdAt: new Date()
          });
        } catch (mongoErr) {
          console.error('[MessageQueue] 记录能量消耗失败:', mongoErr.message);
        }
      });
    }
  } catch (error) {
    console.error('[MessageQueue] 能量扣减失败:', error.message);
  }
}

/**
 * 处理客服对话任务
 */
async function handleAgentChatTask(data) {
  const { type } = data;

  switch (type) {
    case TASK_TYPES.SAVE_MESSAGE:
      await handleSaveMessage(data);
      break;
    case TASK_TYPES.UPDATE_MEMORY:
      await handleUpdateMemory(data);
      break;
    case TASK_TYPES.SAVE_KNOWLEDGE:
      await handleSaveKnowledge(data);
      break;
    case TASK_TYPES.UPDATE_CHAT_COUNT:
      await handleUpdateChatCount(data);
      break;
    case TASK_TYPES.DEDUCT_ENERGY:
      await handleDeductEnergy(data);
      break;
    case TASK_TYPES.PROCESS_MESSAGE:
      await handleProcessMessage(data);
      break;
    case TASK_TYPES.AI_RESPONSE:
      await handleAIResponse(data);
      break;
    case TASK_TYPES.AI_SUMMARY:
      await handleAISummary(data);
      break;
    // 播客任务处理
    case TASK_TYPES.PODCAST_PLAY:
      await handlePodcastPlay(data);
      break;
    case TASK_TYPES.PODCAST_STATS_UPDATE:
      await handlePodcastStatsUpdate(data);
      break;
    case TASK_TYPES.PODCAST_LIKE:
      await handlePodcastStatsUpdate(data);
      break;
    case TASK_TYPES.PODCAST_SUBSCRIBE:
      await handlePodcastStatsUpdate(data);
      break;
    default:
      console.warn(`[MessageQueue] 未知的任务类型: ${type}`);
  }
}

/**
 * 处理实时消息
 */
async function handleProcessMessage(data) {
  try {
    const { sessionId, messageId, role, content } = data;
    if (!sessionId || !content) {
      console.error('[MessageQueue] 处理消息缺少必要参数');
      return;
    }

    // 保存到MongoDB
    await mongo.addSessionMessage(sessionId, role, content);

    // 更新会话最后消息时间
    await mongo.updateSessionLastMessage(sessionId);

    // 通知AI响应(如果是用户消息)
    if (role === 'user') {
      await enqueue(STREAMS.AGENT_CHAT, {
        type: TASK_TYPES.AI_RESPONSE,
        sessionId,
        userMessage: content,
        messageId,
        createdAt: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('[MessageQueue] 消息处理失败:', error.message);
  }
}

/**
 * 处理AI响应
 */
async function handleAIResponse(data) {
  try {
    const { sessionId, userMessage } = data;
    if (!sessionId || !userMessage) {
      console.error('[MessageQueue] AI响应缺少必要参数');
      return;
    }

    // 获取会话信息，检查是否需要人工
    const session = await mongo.getAgentSession(sessionId);
    if (!session || session.status !== 'active') {
      return;
    }

    // 如果是人工模式，不生成AI回复
    if (session.mode === 'human') {
      return;
    }

    // 如果等待人工接入，不生成AI回复
    if (session.pendingHuman) {
      return;
    }

    // TODO: 调用AI服务生成响应
    // 这里需要集成现有的AI响应逻辑
  } catch (error) {
    console.error('[MessageQueue] AI响应处理失败:', error.message);
  }
}

/**
 * 处理AI总结任务 - 每10次对话后精简记忆和知识库
 */
async function handleAISummary(data) {
  try {
    const { avatarId, sessionId } = data;
    if (!avatarId || !sessionId) {
      console.error('[AI总结] 缺少必要参数');
      return;
    }

    // 获取最近20条消息（10次对话）
    const messages = await mongo.getSessionMessages(sessionId);
    const recentMessages = messages.slice(-20);

    // 少于4条消息不总结
    if (recentMessages.length < 4) {
      return;
    }

    // 获取AI配置
    let aiModule = minimax;
    try {
      const configs = await db.query(
        'SELECT config_value FROM game_config WHERE config_key = ?',
        ['ai_provider']
      );
      if (configs.length > 0 && configs[0].config_value === 'bailian') {
        aiModule = bailian;
      }
    } catch (e) {
      console.error('[AI总结] 获取AI配置失败:', e.message);
    }

    const summaryPrompt = `请总结以下客服对话的要点：
${recentMessages.map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content.substring(0, 200)}`).join('\n')}

要求：
1. 提取关键信息（用户姓名、偏好、需求、重要约定等）
2. 用50字以内概括
3. 只返回JSON格式，不要其他内容
格式：{"key_info": "关键信息", "user_needs": "用户需求"}`;

    const summary = await aiModule.generateConversation([
      { role: 'system', content: '你是一个客服对话总结助手，请简洁准确地提取关键信息。' },
      { role: 'user', content: summaryPrompt }
    ], { maxTokens: 200, temperature: 0.3 });

    // 解析AI返回
    let summaryObj = { key_info: '', user_needs: '' };
    try {
      const match = summary.match(/\{[\s\S]*\}/);
      if (match) {
        summaryObj = JSON.parse(match[0]);
      }
    } catch (e) {
      console.error('[AI总结] 解析失败，使用原始内容:', e.message);
      summaryObj = { key_info: summary.substring(0, 100), user_needs: '' };
    }

    // 更新长期记忆
    if (summaryObj.key_info) {
      // 获取现有记忆
      const existingMemory = await mongo.getLongTermMemory(avatarId);
      const existingInfo = existingMemory?.roleDescription || '';

      // 合并新记忆（保留旧的重要记忆）
      const mergedInfo = existingInfo + '\n' + summaryObj.key_info;
      const finalInfo = mergedInfo.length > 500 ? mergedInfo.substring(mergedInfo.length - 500) : mergedInfo;

      await mongo.setLongTermMemory(avatarId, finalInfo, '', '');
      console.log(`[AI总结] 更新长期记忆成功: ${summaryObj.key_info.substring(0, 50)}...`);
    }

    // 清除知识库缓存，触发重新加载
    await cache.clearKnowledgeBase(avatarId).catch(() => {});

  } catch (error) {
    console.error('[AI总结] 处理失败:', error.message);
  }
}

/**
 * 处理实时消息推送
 */
async function handleChatMessage(data) {
  try {
    const { sessionId, message } = data;
    if (!sessionId || !message) {
      console.error('[MessageQueue] 实时消息缺少必要参数');
      return;
    }
  } catch (error) {
    console.error('[MessageQueue] 实时消息处理失败:', error.message);
  }
}

/**
 * 处理状态变更通知
 */
async function handleStatusChange(data) {
  try {
    const { sessionId, status } = data;
    if (!sessionId || !status) {
      console.error('[MessageQueue] 状态变更缺少必要参数');
      return;
    }
  } catch (error) {
    console.error('[MessageQueue] 状态变更处理失败:', error.message);
  }
}

/**
 * 处理离线消息
 */
async function handleOfflineMessage(data) {
  try {
    const { sessionId, messages } = data;
    if (!sessionId || !messages || !Array.isArray(messages)) {
      console.error('[MessageQueue] 离线消息缺少必要参数');
      return;
    }
    for (const msg of messages) {
      await mongo.addSessionMessage(sessionId, msg.role, msg.content);
    }
  } catch (error) {
    console.error('[MessageQueue] 离线消息处理失败:', error.message);
  }
}

/**
 * 处理播客任务（入口函数，根据type分发）
 */
async function handlePodcastTask(data) {
  const { type } = data;
  switch (type) {
    case TASK_TYPES.PODCAST_PLAY:
      await handlePodcastPlay(data);
      break;
    case TASK_TYPES.PODCAST_STATS_UPDATE:
    case TASK_TYPES.PODCAST_LIKE:
    case TASK_TYPES.PODCAST_SUBSCRIBE:
      await handlePodcastStatsUpdate(data);
      break;
    default:
      console.warn(`[MessageQueue] 未知的播客任务类型: ${type}`);
  }
}

// ============================================
// 播客任务处理
// ============================================

/**
 * 处理播客播放记录任务
 */
async function handlePodcastPlay(data) {
  try {
    const { episode_id, podcast_id } = data;
    if (!episode_id || !podcast_id) {
      console.error('[MessageQueue] 播客播放任务缺少必要参数');
      return;
    }

    // 更新剧集播放次数
    const episodesColl = await mongo.getPodcastEpisodesCollection();
    await episodesColl.updateOne(
      { episode_id: episode_id },
      { $inc: { plays_count: 1 } }
    );

    // 更新播客总播放次数
    const podcastsColl = await mongo.getPodcastPodcastsCollection();
    await podcastsColl.updateOne(
      { podcast_id: podcast_id },
      { $inc: { total_plays: 1 } }
    );

    console.log(`[MessageQueue] 播客播放记录已更新: episode=${episode_id}, podcast=${podcast_id}`);
  } catch (error) {
    console.error('[MessageQueue] 播客播放记录更新失败:', error.message);
  }
}

/**
 * 处理播客统计更新任务
 */
async function handlePodcastStatsUpdate(data) {
  try {
    // 使用 action 而不是 type，因为路由传入的是 action 字段
    const { podcast_id, episode_id, action, increment } = data;

    if (action === 'like' && podcast_id) {
      const coll = await mongo.getPodcastPodcastsCollection();
      await coll.updateOne(
        { podcast_id: podcast_id },
        { $inc: { likes_count: increment || 1 } }
      );
    } else if (action === 'subscriber' && podcast_id) {
      const coll = await mongo.getPodcastPodcastsCollection();
      await coll.updateOne(
        { podcast_id: podcast_id },
        { $inc: { subscriber_count: increment || 1 } }
      );
    } else if (action === 'episode_like' && episode_id) {
      const coll = await mongo.getPodcastEpisodesCollection();
      await coll.updateOne(
        { episode_id: episode_id },
        { $inc: { likes_count: increment || 1 } }
      );
    }

    console.log(`[MessageQueue] 播客统计已更新: action=${action}, id=${podcast_id || episode_id}`);
  } catch (error) {
    console.error('[MessageQueue] 播客统计更新失败:', error.message);
  }
}

/**
 * 播客客服消息入队 - 用于实时推送
 * @param {Object} data - 消息数据
 */
async function enqueueChatMessage(data) {
  return await redis.xAdd(STREAMS.AGENT_CHAT_MESSAGES, data, 5000);
}

/**
 * 客服状态变更入队
 * @param {Object} data - 状态数据
 */
async function enqueueStatusChange(data) {
  return await redis.xAdd(STREAMS.AGENT_CHAT_STATUS, data, 1000);
}

/**
 * 启动Worker - 持续监听并处理任务
 */
let workerRunning = false;
let lastIds = {};
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

async function startWorker() {
  if (workerRunning) {
    return;
  }

  workerRunning = true;

  // 初始化每个Stream的起始位置
  // 使用 '$' 符号只读取新消息，不读取历史消息，避免启动时日志刷屏
  for (const key of Object.values(STREAMS)) {
    lastIds[key] = '$';
  }

  // 持续监听
  while (workerRunning) {
    try {
      // 并行读取所有Stream
      const promises = Object.values(STREAMS).map(streamKey =>
        redis.xRead(streamKey, lastIds[streamKey], 10)
      );

      const results = await Promise.all(promises);

      // 处理每个Stream的消息
      const streamKeys = Object.values(STREAMS);
      for (let i = 0; i < results.length; i++) {
        const messages = results[i];
        const streamKey = streamKeys[i];

        if (messages && messages.length > 0) {
          for (const msg of messages) {
            const { id, data } = msg;

            try {
              // 根据Stream类型处理任务
              await processStreamMessage(streamKey, data);
            } catch (err) {
              console.error(`[MessageQueue] 消息处理失败: ${streamKey}`, err.message);
              // 可以在这里添加重试逻辑
            }

            // 更新最后处理的ID
            lastIds[streamKey] = id;
          }
        }
      }

      // 短暂休眠，避免CPU空转
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error('[MessageQueue] Worker错误:', error.message);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

/**
 * 根据Stream类型处理消息
 */
async function processStreamMessage(streamKey, data) {
  switch (streamKey) {
    case STREAMS.AGENT_CHAT:
      await handleAgentChatTask(data);
      break;
    case STREAMS.AGENT_CHAT_MESSAGES:
      await handleChatMessage(data);
      break;
    case STREAMS.AGENT_CHAT_STATUS:
      await handleStatusChange(data);
      break;
    case STREAMS.AGENT_CHAT_OFFLINE:
      await handleOfflineMessage(data);
      break;
    case STREAMS.ENERGY_DEDUCT:
    case STREAMS.KNOWLEDGE_SAVE:
    case STREAMS.MEMORY_UPDATE:
    case STREAMS.MESSAGE_SAVE:
      // 这些Stream暂时使用默认处理
      break;
    case STREAMS.PODCAST_TASKS:
      // 播客任务处理
      await handlePodcastTask(data);
      break;
    default:
      console.warn(`[MessageQueue] 未知的Stream: ${streamKey}`);
  }
}

/**
 * 停止Worker
 */
function stopWorker() {
  workerRunning = false;
}

module.exports = {
  STREAMS,
  TASK_TYPES,
  enqueue,
  enqueueAgentChatTask,
  enqueueChatMessage,
  enqueueStatusChange,
  enqueuePodcastTask,
  startWorker,
  stopWorker
};
