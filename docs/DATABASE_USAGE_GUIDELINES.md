# 数据库使用规范

## 基本原则

### MySQL使用场景
MySQL用于存储**结构化业务数据**，需要事务支持、外键约束、关系查询的场景：
- 用户账户信息（users表）
- AI 智能体元数据（ai_agents表）- 与用户一对一、需 JOIN
- 游戏配置（game_config表）
- 节点占用状态（game_nodes表）
- 房间信息（game_rooms表）
- 管理员操作记录（admin_logs表）- 需要外键关联
- 虚拟智能体基础信息（virtual_ai_agents表）- 需要实时查询和更新
- 剧情与任务进度、需要事务的写（如扣能量+记一笔）

**不用于**：AI 工作台会话线程与按会话的对话历史、AI 智能体短期/中期/长期记忆（上述由 MongoDB 承担）。

### MongoDB使用场景
MongoDB用于存储**查询记录、日志、历史数据、文档型高读写**等不需要 MySQL 事务和关系约束的场景：
- **PK对战记录**（battle_logs集合）- 包括真实用户和虚拟智能体的所有PK记录
- **AI智能体对话记录**（agent_conversations集合）- 含 threadId 区分工作台会话
- **AI 工作台会话线程**（agent_conversation_threads 集合）- 工作台多会话列表与标题
- **AI 智能体短期/中期/长期记忆**（agent_memories 集合）- 每 agent 每种类型一份文档，upsert 更新
- **其他日志类数据**（如操作日志、行为日志等）
- **统计分析数据**（如每日统计、排行榜历史等）

## 具体规则

### 1. PK对战记录
- **统一使用MongoDB**：所有PK记录（真实用户之间、真实用户与虚拟智能体、虚拟智能体之间）都写入MongoDB的`battle_logs`集合
- **不再使用MySQL**：`pk_records`和`virtual_agent_battles`表仅用于历史数据兼容，新记录不再写入
- **查询方式**：用户查询PK记录时，统一从MongoDB查询，无需查询MySQL

### 2. 日志类数据
- **操作日志**：如果不需要外键关联和事务支持，优先使用MongoDB
- **行为日志**：用户行为、系统事件等日志数据，统一使用MongoDB
- **统计日志**：每日统计、排行榜历史等，使用MongoDB

### 3. 实时业务数据
- **需要事务支持**：使用MySQL（如节点占用、能量更新）
- **需要外键约束**：使用MySQL（如用户关联数据）
- **需要实时查询和更新**：使用MySQL（如虚拟智能体状态）

### 4. AI 工作台与记忆
- **工作台历史会话**：线程列表、按 thread 的对话历史 — **读写 MongoDB**（`agent_conversation_threads`、`agent_conversations` 按 threadId 查询）。POST 对话时 MySQL 与 MongoDB 双写；GET 优先 MongoDB，失败回退 MySQL。
- **短期/中期/长期记忆**：**读写 MongoDB**（`agent_memories` 集合）。对话数据源（构建短期/中期内容）优先从 MongoDB 取游戏内对话（无 threadId），失败回退 MySQL。新功能仅写 MongoDB，读取优先 MongoDB 再回退 MySQL。

## 实施指南

### 新增功能时如何选择数据库？

1. **判断是否需要事务和外键**：
   - 是 → 使用MySQL
   - 否 → 继续判断

2. **判断数据类型**：
   - 查询记录、日志、历史数据 → 使用MongoDB
   - 实时业务数据、配置数据 → 使用MySQL

3. **判断查询模式**：
   - 主要是查询和写入，不需要复杂关联 → 使用MongoDB
   - 需要JOIN查询、外键关联 → 使用MySQL

### 示例

✅ **使用MongoDB的场景**：
- PK对战记录查询
- AI 工作台会话线程列表、按会话的对话历史
- AI 智能体短期/中期/长期记忆的读写
- AI 对话记录写入（与 MySQL 双写）
- 用户行为日志、系统操作日志、排行榜历史记录

✅ **使用MySQL的场景**：
- 用户账户信息、AI 智能体元数据（ai_agents）
- 游戏节点占用状态、能量扣减与事务性写入
- 虚拟智能体基础信息（需要实时更新）
- 管理员操作记录（需要外键关联用户）
- 游戏配置参数、剧情与任务进度

## 迁移说明

### 历史数据兼容
- `pk_records`和`virtual_agent_battles`表中的历史数据保留，不做迁移
- 新记录统一写入MongoDB
- 查询时优先查询MongoDB，如需查询历史数据可单独处理

## 注意事项

### 虚拟智能体名称显示
- MongoDB中存储的`attackerName`和`defenderName`直接使用虚拟智能体的`name`字段
- **不添加"虚拟AI智能体"、"AI"等标识**
- 确保与真实用户名称显示方式一致

### MongoDB写入失败处理
- MongoDB写入失败不应中断业务流程
- 使用try-catch包裹，记录错误日志
- MySQL写入仍然保留（用于统计和历史数据兼容）

### 性能考虑
- MongoDB写入是异步的，不影响业务性能
- 查询时只查询MongoDB，简化查询逻辑
- 对于高频查询，考虑在MongoDB中建立合适的索引

## 相关文档

- [MongoDB对战日志文档](MONGODB_BATTLE_LOGS.md)
- [AI 工作台与记忆存储](AI_STUDIO_AND_MEMORY_STORAGE.md)
- [数据库架构文档](DATABASE.md)
- [Socket协议文档](SOCKET_PROTOCOL.md)
