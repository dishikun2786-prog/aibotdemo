# AI 工作台与记忆存储（MongoDB）

AI 工作台的历史会话以及智能体短期/中期/长期记忆的存储与查询由 **MongoDB** 承担，MySQL 仅保留其更擅长的场景（用户、智能体元数据、能量、事务性写入等）。本文说明 MongoDB 侧集合用途、字段与索引，以及与 MySQL 的职责划分。

## 职责划分

| 数据 | 存储 | 说明 |
|------|------|------|
| 工作台会话线程列表 | MongoDB `agent_conversation_threads` | 每个线程一条文档，threadId 与 MySQL 自增 id 一致（双写） |
| 工作台按会话的对话历史 | MongoDB `agent_conversations`（带 threadId） | 查询按 agentId + threadId，分页按 createdAt 正序 |
| 游戏内对话（无 threadId） | MySQL + MongoDB 双写 | 游戏内对话写入两库；记忆构建时优先从 MongoDB 取无 threadId 的对话 |
| 短期/中期/长期记忆 | MongoDB `agent_memories` | 每 agent 每种类型一份文档，upsert 更新；读取优先 MongoDB，可回退 MySQL |

## 集合与索引

### agent_conversation_threads

- **用途**：工作台多会话的线程列表（标题、创建时间）。
- **字段**：`threadId`（number，与 MySQL 自增 id 一致）、`agentId`、`title`、`createdAt`。
- **索引**：`{ agentId: 1, createdAt: -1 }`，`{ threadId: 1 }`（unique）。

### agent_conversations

- **用途**：单条对话记录；带 `threadId` 的为工作台会话，无/空 `threadId` 为游戏内对话。
- **字段**：`agentId`、`userId`、`userMessage`、`agentMessage`、`energyCost`、`energyAfter`、`createdAt`、`threadId`（可选）。
- **索引**：`{ agentId: 1, createdAt: -1 }`，`{ userId: 1, createdAt: -1 }`，`{ agentId: 1, threadId: 1, createdAt: 1 }`。

### agent_memories

- **用途**：短期（short）、中期（medium）、长期（long）记忆，每 agent 每种类型一份文档。
- **字段**：`agentId`、`memoryType`（'short'|'medium'|'long'）、`content`（对象）、`updatedAt`。
- **索引**：`{ agentId: 1, memoryType: 1 }`（unique）。

## 读写路径与回退

- **GET 会话线程列表**：`mongo.getAgentConversationThreads(agentId)`，失败回退 MySQL `ai_agent_conversation_threads`。
- **GET 按 thread 的对话历史**：`mongo.getAgentConversationHistoryByThread(agentId, threadId, limit, offset)`，失败回退 MySQL。
- **记忆读写**：`mongo.upsertAgentMemory` / `mongo.getAgentMemory`；读取时若无结果可回退 MySQL `ai_agent_memories`。
- **短期/中期记忆的对话数据源**：`mongo.getAgentConversationsForMemory(agentId, limit)`（仅无 threadId），失败回退 MySQL 查询 `ai_agent_conversations`。

## 相关文档

- [DATABASE_USAGE_GUIDELINES.md](DATABASE_USAGE_GUIDELINES.md) — 数据库使用规范与选型
- [ARCHITECTURE.md](ARCHITECTURE.md) — 整体架构与数据一致性表
- [MONGODB_BATTLE_LOGS.md](MONGODB_BATTLE_LOGS.md) — 对战日志集合说明
