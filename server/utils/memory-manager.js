/**
 * @file memory-manager.js
 * @module utils/memory-manager
 * @description AI智能体记忆管理工具（短期/中期/长期记忆读写 MongoDB，对话数据源可回退 MySQL）
 */
const db = require('./db');
const mongo = require('./mongo');
const minimax = require('./minimax');
const bailian = require('./bailian');

async function getAiProviderModule() {
  try {
    const rows = await db.query('SELECT config_value FROM game_config WHERE config_key = ?', ['ai_provider']);
    const value = rows.length > 0 ? (rows[0].config_value || '').toLowerCase().trim() : '';
    return value === 'bailian' ? bailian : minimax;
  } catch (e) {
    return minimax;
  }
}

const SHORT_TERM_LIMIT = 20; // 短期记忆：最近20条对话
const MEDIUM_TERM_THRESHOLD = 10; // 每10条对话生成一次中期记忆摘要

/**
 * 获取游戏内最近对话（优先 MongoDB，失败回退 MySQL）
 * @param {number} agentId
 * @param {number} limit
 * @returns {Promise<Array<{ user_message: string, agent_message: string }>>}
 */
async function getRecentConversationsForMemory(agentId, limit) {
  let conversations = await mongo.getAgentConversationsForMemory(agentId, limit);
  if (conversations.length === 0) {
    try {
      const rows = await db.query(
        `SELECT user_message, agent_message FROM ai_agent_conversations 
         WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`,
        [agentId, limit]
      );
      conversations = (rows || []).reverse();
    } catch (e) {
      console.warn('MySQL 获取对话回退失败:', e.message);
    }
  }
  return conversations;
}

/**
 * 添加短期记忆（最近20条对话），写入 MongoDB
 * @param {number} agentId - AI智能体ID
 * @param {string} userMessage - 用户消息
 * @param {string} agentMessage - AI回复
 * @returns {Promise<void>}
 */
async function addShortTermMemory(agentId, userMessage, agentMessage) {
  try {
    const conversations = await getRecentConversationsForMemory(agentId, SHORT_TERM_LIMIT);
    const memoryContent = {
      conversations: conversations.map(conv => ({
        user: conv.user_message,
        agent: conv.agent_message
      })),
      updatedAt: new Date().toISOString()
    };
    await mongo.upsertAgentMemory(agentId, 'short', memoryContent);
  } catch (error) {
    console.error('添加短期记忆失败:', error);
    throw error;
  }
}

/**
 * 添加中期记忆（最近100条对话摘要），写入 MongoDB
 * @param {number} agentId - AI智能体ID
 * @returns {Promise<void>}
 */
async function addMediumTermMemory(agentId) {
  try {
    const conversations = await getRecentConversationsForMemory(agentId, 100);
    if (conversations.length === 0) {
      return;
    }

    // 尝试使用LLM生成摘要（如果失败则降级到简单摘要）
    let summary;
    try {
      // 构建对话文本
      const conversationText = conversations.map(conv => 
        `用户: ${conv.user_message}\nAI: ${conv.agent_message}`
      ).join('\n\n');

      // 限制长度（避免超出token限制）
      const maxLength = 8000;
      const truncatedText = conversationText.length > maxLength 
        ? conversationText.substring(0, maxLength) + '\n\n[...更多对话内容已省略...]'
        : conversationText;

      const summaryPrompt = `请对以下对话进行摘要，提取：
1. 主要讨论的主题（3-5个）
2. 用户的偏好和兴趣
3. 重要的对话内容

对话内容：
${truncatedText}

请以JSON格式返回：
{
  "topics": ["主题1", "主题2"],
  "userPreferences": "用户偏好描述",
  "keyPoints": ["要点1", "要点2"]
}`;

      const ai = await getAiProviderModule();
      const summaryResponse = await ai.generateConversation(
        [{ role: 'user', content: summaryPrompt }],
        { temperature: 0.3, maxTokens: 500 }
      );

      // 解析摘要（尝试提取JSON）
      try {
        const jsonMatch = summaryResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          summary = JSON.parse(jsonMatch[0]);
        } else {
          summary = { rawSummary: summaryResponse };
        }
      } catch (e) {
        summary = { rawSummary: summaryResponse };
      }

      summary.totalConversations = conversations.length;
      summary.updatedAt = new Date().toISOString();
    } catch (error) {
      console.warn('使用LLM生成中期记忆摘要失败，降级到简单摘要:', error.message);
      summary = {
        totalConversations: conversations.length,
        recentTopics: extractTopics(conversations),
        userPreferences: extractPreferences(conversations),
        updatedAt: new Date().toISOString()
      };
    }

    await mongo.upsertAgentMemory(agentId, 'medium', summary);
  } catch (error) {
    console.error('添加中期记忆失败:', error);
    throw error;
  }
}

/**
 * 添加长期记忆（角色设定和关键信息），写入 MongoDB
 * @param {number} agentId - AI智能体ID
 * @param {Object} role - 角色设定
 * @param {Object} appearance - 形象设定
 * @returns {Promise<void>}
 */
async function addLongTermMemory(agentId, role, appearance) {
  try {
    const memoryContent = {
      role,
      appearance,
      updatedAt: new Date().toISOString()
    };
    await mongo.upsertAgentMemory(agentId, 'long', memoryContent);
  } catch (error) {
    console.error('添加长期记忆失败:', error);
    throw error;
  }
}

/**
 * 获取指定类型的记忆（优先 MongoDB，失败回退 MySQL）
 * @param {number} agentId - AI智能体ID
 * @param {string} memoryType - 记忆类型：'short' | 'medium' | 'long'
 * @returns {Promise<Object|null>} 记忆内容
 */
async function getMemories(agentId, memoryType) {
  try {
    let content = await mongo.getAgentMemory(agentId, memoryType);
    if (content != null) return content;
    const memories = await db.query(
      `SELECT content FROM ai_agent_memories 
       WHERE agent_id = ? AND memory_type = ? ORDER BY created_at DESC LIMIT 1`,
      [agentId, memoryType]
    );
    if (memories.length === 0) return null;
    const raw = memories[0].content;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    console.error('获取记忆失败:', error);
    return null;
  }
}

/**
 * 获取所有记忆（用于构建对话上下文）
 * @param {number} agentId - AI智能体ID
 * @returns {Promise<Object>} 包含所有类型记忆的对象
 */
async function getAllMemories(agentId) {
  const [shortTerm, mediumTerm, longTerm] = await Promise.all([
    getMemories(agentId, 'short'),
    getMemories(agentId, 'medium'),
    getMemories(agentId, 'long')
  ]);

  return {
    short: shortTerm,
    medium: mediumTerm,
    long: longTerm
  };
}

/**
 * 清理过期记忆（MongoDB 按 updatedAt 删除 short/medium）
 * @param {number} agentId - AI智能体ID
 * @param {number} daysToKeep - 保留天数（默认30天）
 * @returns {Promise<void>}
 */
async function cleanupOldMemories(agentId, daysToKeep = 30) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    await mongo.deleteAgentMemoriesOlderThan(agentId, ['short', 'medium'], cutoffDate);
  } catch (error) {
    console.error('清理过期记忆失败:', error);
    throw error;
  }
}

/**
 * 提取对话主题（简化实现）
 * @param {Array} conversations - 对话记录数组
 * @returns {Array<string>} 主题列表
 */
function extractTopics(conversations) {
  // 改进的主题提取：使用更智能的关键词匹配和频率统计
  const topics = [];
  const keywords = ['能量', '挖矿', 'PK', '节点', '对战', '能量山', '矩阵网络', '智能体', '能量核心'];
  const topicFrequency = {};
  
  conversations.forEach(conv => {
    const text = (conv.user_message + ' ' + conv.agent_message).toLowerCase();
    keywords.forEach(keyword => {
      const keywordLower = keyword.toLowerCase();
      if (text.includes(keywordLower)) {
        if (!topicFrequency[keyword]) {
          topicFrequency[keyword] = 0;
        }
        topicFrequency[keyword]++;
      }
    });
  });

  // 按频率排序，返回前5个最常讨论的主题
  const sortedTopics = Object.entries(topicFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(entry => entry[0]);

  return sortedTopics.length > 0 ? sortedTopics : keywords.slice(0, 3); // 如果没有匹配，返回默认主题
}

/**
 * 提取用户偏好（简化实现）
 * @param {Array} conversations - 对话记录数组
 * @returns {Object} 偏好对象
 */
function extractPreferences(conversations) {
  // 改进的偏好提取：分析对话模式和用户行为
  if (conversations.length === 0) {
    return {
      averageMessageLength: 0,
      conversationCount: 0,
      preferredTopics: [],
      communicationStyle: 'unknown'
    };
  }

  const totalLength = conversations.reduce((sum, conv) => 
    sum + conv.user_message.length + conv.agent_message.length, 0
  );
  const avgLength = Math.round(totalLength / conversations.length);

  // 分析用户消息长度模式
  const userMessageLengths = conversations.map(conv => conv.user_message.length);
  const avgUserLength = Math.round(
    userMessageLengths.reduce((sum, len) => sum + len, 0) / userMessageLengths.length
  );

  // 判断沟通风格
  let communicationStyle = 'balanced';
  if (avgUserLength < 20) {
    communicationStyle = 'concise';
  } else if (avgUserLength > 100) {
    communicationStyle = 'detailed';
  }

  return {
    averageMessageLength: avgLength,
    conversationCount: conversations.length,
    averageUserMessageLength: avgUserLength,
    communicationStyle: communicationStyle,
    preferredTopics: extractTopics(conversations).slice(0, 3) // 前3个偏好主题
  };
}

/**
 * 检查是否需要生成中期记忆摘要（优先 MongoDB 计数，失败回退 MySQL）
 * @param {number} agentId - AI智能体ID
 * @returns {Promise<boolean>} 是否需要生成摘要
 */
async function shouldGenerateMediumTermMemory(agentId) {
  try {
    let count = await mongo.getAgentConversationCount(agentId);
    if (count === 0) {
      try {
        const rows = await db.query(
          'SELECT COUNT(*) as count FROM ai_agent_conversations WHERE agent_id = ?',
          [agentId]
        );
        count = rows[0]?.count || 0;
      } catch (e) {
        return false;
      }
    }
    return count > 0 && count % MEDIUM_TERM_THRESHOLD === 0;
  } catch (error) {
    console.error('检查中期记忆生成条件失败:', error);
    return false;
  }
}

module.exports = {
  addShortTermMemory,
  addMediumTermMemory,
  addLongTermMemory,
  getMemories,
  getAllMemories,
  cleanupOldMemories,
  shouldGenerateMediumTermMemory
};
