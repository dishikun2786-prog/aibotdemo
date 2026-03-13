# 数据模型文档

## 1. ER 图

```mermaid
erDiagram
    users ||--o{ game_nodes : "occupies"
    users ||--o{ pk_records : "attacker"
    users ||--o{ pk_records : "defender"
    users ||--o{ admin_logs : "admin"
    users ||--o| ai_agents : "owns"
    users ||--o{ user_story_progress : "progress"
    users ||--o{ user_task_progress : "progress"
    game_rooms ||--o{ game_nodes : "contains"
    game_rooms ||--o{ virtual_ai_agents : "contains"
    story_chapters ||--o{ story_tasks : "contains"
    story_chapters ||--o{ user_story_progress : "progress"
    story_tasks ||--o{ user_task_progress : "progress"
    ai_agents ||--o{ ai_agent_memories : "has"
    ai_agents ||--o{ ai_agent_conversations : "conversations"
    virtual_ai_agents ||--o{ virtual_agent_battles : "battles"

    users {
        int id PK
        string username UK
        string password
        int energy
        int stamina
        int total_energy
        int wins
        int losses
        int draws
        datetime created_at
        datetime last_login
        tinyint is_admin
        tinyint has_used_first_free_occupy
        enum status
    }

    game_rooms {
        int id PK
        string room_name
        int max_players
        int current_players
        bigint platform_pool
        enum status
    }

    game_nodes {
        int id PK
        int room_id FK
        int node_id
        int owner_id FK
        datetime occupied_at
        int energy_production
    }

    pk_records {
        int id PK
        int attacker_id FK
        enum attacker_type
        int defender_id FK
        enum defender_type
        int attacker_king
        int attacker_assassin
        int defender_king
        int defender_assassin
        enum result
        int energy_change
        datetime created_at
    }

    admin_logs {
        int id PK
        int admin_id FK
        string action
        int target_id
        text details
        datetime created_at
    }

    game_config {
        int id PK
        string config_key UK
        text config_value
        string description
        datetime updated_at
    }

    story_chapters {
        int id PK
        int chapter_number UK
        string chapter_title
        text story_content
        json completion_condition
        int stamina_reward
        int energy_reward
        tinyint is_active
        int sort_order
    }

    story_tasks {
        int id PK
        int chapter_id FK
        string task_type
        string task_title
        text task_description
        int target_value
        int stamina_reward
        int energy_reward
        tinyint is_active
        int sort_order
    }

    user_story_progress {
        int id PK
        int user_id FK
        int chapter_id FK
        int task_id
        int progress_value
        tinyint is_completed
        datetime completed_at
    }

    user_task_progress {
        int id PK
        int user_id FK
        int task_id FK
        int progress_value
        tinyint is_completed
        datetime completed_at
    }

    ai_agents {
        int id PK
        int user_id UK FK
        string name
        json role
        json appearance
        int energy
        tinyint is_initialized
        json model_preferences
    }

    ai_agent_memories {
        int id PK
        int agent_id FK
        enum memory_type
        json content
        datetime created_at
    }

    ai_agent_conversations {
        int id PK
        int agent_id FK
        text user_message
        text agent_message
        int energy_cost
        datetime created_at
    }

    virtual_ai_agents {
        int id PK
        string name
        int energy
        int stamina
        enum status
        int room_id FK
        int current_node_id
        int wins
        int losses
        int draws
        bigint total_energy
        datetime last_action_at
    }

    virtual_agent_battles {
        int id PK
        int attacker_id FK
        enum attacker_type
        string attacker_name
        int defender_id
        enum defender_type
        string defender_name
        int attacker_king
        int attacker_assassin
        int defender_king
        int defender_assassin
        enum result
        int attacker_energy_change
        int defender_energy_change
        int room_id
        datetime created_at
    }
```

## 2. 表结构说明

### users（用户表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 用户 ID |
| username | VARCHAR(50) | NOT NULL, UNIQUE | - | 用户名 |
| password | VARCHAR(255) | NOT NULL | - | bcrypt 加密密码 |
| email | VARCHAR(100) | - | NULL | 邮箱 |
| energy | INT(11) | - | 0 | 当前能量（0-100） |
| stamina | INT(11) | - | 100 | 当前体力（0-100） |
| total_energy | BIGINT(20) | - | 0 | 累计获得能量 |
| wins | INT(11) | - | 0 | PK 胜利次数 |
| losses | INT(11) | - | 0 | PK 失败次数 |
| draws | INT(11) | - | 0 | PK 平局次数 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 注册时间 |
| last_login | DATETIME | - | NULL | 最后登录时间 |
| is_admin | TINYINT(1) | - | 0 | 是否管理员 |
| has_used_first_free_occupy | TINYINT(1) | - | 0 | 是否已使用首次免费占据（0=未使用，1=已使用） |
| status | ENUM | - | 'active' | active / banned |

**索引**：idx_username, idx_status

---

### game_rooms（游戏房间表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 房间 ID |
| room_name | VARCHAR(50) | NOT NULL | - | 房间名称 |
| max_players | INT(11) | - | 100 | 最大玩家数 |
| current_players | INT(11) | - | 0 | 当前在线人数 |
| platform_pool | BIGINT(20) | - | 10240 | 平台池能量 |
| status | ENUM | - | 'waiting' | waiting / playing / ended |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |

**索引**：idx_status

---

### game_nodes（游戏节点表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 主键 |
| room_id | INT(11) | NOT NULL, FK | - | 房间 ID |
| node_id | INT(11) | NOT NULL | - | 节点编号 1-100 |
| owner_id | INT(11) | FK, ON DELETE SET NULL | NULL | 占用者用户 ID |
| occupied_at | DATETIME | - | NULL | 占用时间 |
| energy_production | INT(11) | - | 5 | 每秒能量产出 |

**唯一键**：uk_room_node (room_id, node_id)  
**索引**：idx_owner, idx_room  
**外键**：room_id -> game_rooms(id), owner_id -> users(id)

---

### pk_records（PK 战斗记录表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 主键 |
| attacker_id | INT(11) | NOT NULL, FK | - | 攻击者 ID（用户或虚拟智能体） |
| attacker_type | ENUM | NOT NULL | 'user' | user / virtual_agent |
| defender_id | INT(11) | NOT NULL, FK | - | 防御者 ID |
| defender_type | ENUM | NOT NULL | 'user' | user / virtual_agent |
| attacker_king | INT(11) | NOT NULL | - | 攻击者 King 值 |
| attacker_assassin | INT(11) | NOT NULL | - | 攻击者 Assassin 值 |
| defender_king | INT(11) | NOT NULL | - | 防御者 King 值 |
| defender_assassin | INT(11) | NOT NULL | - | 防御者 Assassin 值 |
| result | ENUM | NOT NULL | - | win / lose / draw |
| energy_change | INT(11) | - | 0 | 攻击方能量变化 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 战斗时间 |

**索引**：idx_attacker, idx_defender, idx_created, idx_attacker_type, idx_defender_type  
**外键**：attacker_id, defender_id -> users(id) 或 virtual_ai_agents(id)（由 type 区分）

---

### admin_logs（管理员操作日志表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 主键 |
| admin_id | INT(11) | NOT NULL, FK | - | 管理员 ID |
| action | VARCHAR(50) | NOT NULL | - | 操作类型 |
| target_id | INT(11) | - | NULL | 目标用户 ID |
| details | TEXT | - | NULL | 操作详情 JSON |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 操作时间 |

**索引**：idx_admin, idx_target, idx_created  
**外键**：admin_id -> users(id)

**action 取值**：ban_user, unban_user, delete_user, edit_user_stats, update_config

---

### game_config（游戏配置表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 主键 |
| config_key | VARCHAR(50) | NOT NULL, UNIQUE | - | 配置键 |
| config_value | TEXT | NOT NULL | - | 配置值 |
| description | VARCHAR(255) | - | NULL | 描述 |
| updated_at | DATETIME | - | ON UPDATE | 更新时间 |

**默认配置**：energy_per_second, stamina_recovery_rate, max_energy, max_stamina, pk_energy_reward, pk_energy_loss, pk_draw_energy_loss, platform_pool_bonus, energy_treasure, occupy_node_energy_cost, initial_stamina；AI 相关：minimax_api_key, minimax_api_url, minimax_default_model, minimax_image_model, minimax_video_model, minimax_t2a_model, minimax_* 参数, ai_agent_energy_cost, ai_agent_image_enabled, ai_agent_video_enabled, ai_agent_voice_enabled；客户端：client_api_base, client_socket_url, client_video_*；规则：game_rules_pk_min_value, game_rules_pk_max_value。详见 [CONFIG.md](CONFIG.md) 与 [GAME_LOGIC.md](GAME_LOGIC.md)。

---

### treasure_claims（能量宝藏领取记录表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 主键 |
| user_id | INT(11) | NOT NULL, FK | - | 用户 ID |
| room_id | INT(11) | NOT NULL | - | 房间 ID |
| node_id | INT(11) | NOT NULL | - | 节点 ID |
| amount | INT(11) | NOT NULL | - | 领取的能量数 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 领取时间 |

**唯一约束**：uk_room_node (room_id, node_id)，保证每个节点仅可被领取一次（任何人先占先得）。领取成功后，该节点会从 `game_config.energy_treasure` 中移除。  
**外键**：user_id -> users(id) ON DELETE CASCADE

---

### story_chapters（剧情章节表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 主键 |
| chapter_number | INT(11) | NOT NULL, UNIQUE | - | 章节编号（0,1,2...） |
| chapter_title | VARCHAR(100) | NOT NULL | - | 章节标题 |
| chapter_description | TEXT | NOT NULL | - | 章节描述 |
| story_content | TEXT | NOT NULL | - | 剧情内容 |
| completion_condition | JSON | NOT NULL | - | 完成条件（如 complete_all_tasks） |
| stamina_reward | INT(11) | - | 0 | 完成章节奖励体力 |
| energy_reward | INT(11) | - | 0 | 完成章节奖励能量 |
| is_active | TINYINT(1) | - | 1 | 是否启用 |
| sort_order | INT(11) | - | 0 | 排序顺序 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | ON UPDATE | 更新时间 |

**索引**：uk_chapter_number, idx_active  
**外键**：无（顶级表）

---

### story_tasks（任务线索表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 主键 |
| chapter_id | INT(11) | NOT NULL, FK | - | 所属章节 ID |
| task_type | VARCHAR(50) | NOT NULL | - | 任务类型（occupy_node/mine_energy/complete_pk/chat_with_ai/find_treasure/reach_energy 等） |
| task_title | VARCHAR(100) | NOT NULL | - | 任务标题 |
| task_description | TEXT | NOT NULL | - | 任务描述 |
| task_hint | TEXT | - | NULL | 任务提示 |
| target_value | INT(11) | - | NULL | 目标数值（如占据节点数、挖掘能量数等） |
| stamina_reward | INT(11) | - | 0 | 完成任务奖励体力 |
| energy_reward | INT(11) | - | 0 | 完成任务奖励能量 |
| is_active | TINYINT(1) | - | 1 | 是否启用 |
| sort_order | INT(11) | - | 0 | 排序顺序 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |

**索引**：idx_chapter, idx_active, idx_task_type  
**外键**：chapter_id -> story_chapters(id) ON DELETE CASCADE

---

### user_story_progress（用户剧情进度表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 主键 |
| user_id | INT(11) | NOT NULL, FK | - | 用户 ID |
| chapter_id | INT(11) | NOT NULL, FK | - | 章节 ID |
| task_id | INT(11) | - | NULL | 当前任务 ID（NULL 表示章节未开始） |
| progress_value | INT(11) | - | 0 | 进度数值 |
| is_completed | TINYINT(1) | - | 0 | 是否完成 |
| completed_at | DATETIME | - | NULL | 完成时间 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | ON UPDATE | 更新时间 |

**唯一键**：uk_user_chapter (user_id, chapter_id)  
**索引**：idx_user, idx_chapter, idx_completed  
**外键**：user_id -> users(id) ON DELETE CASCADE, chapter_id -> story_chapters(id) ON DELETE CASCADE

---

### user_task_progress（用户任务进度表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 主键 |
| user_id | INT(11) | NOT NULL, FK | - | 用户 ID |
| task_id | INT(11) | NOT NULL, FK | - | 任务 ID |
| progress_value | INT(11) | - | 0 | 进度数值 |
| is_completed | TINYINT(1) | - | 0 | 是否完成 |
| completed_at | DATETIME | - | NULL | 完成时间 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | ON UPDATE | 更新时间 |

**唯一键**：uk_user_task (user_id, task_id)  
**索引**：idx_user, idx_task, idx_completed  
**外键**：user_id -> users(id) ON DELETE CASCADE, task_id -> story_tasks(id) ON DELETE CASCADE

---

### ai_agents（AI 智能体表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 主键 |
| user_id | INT(11) | NOT NULL, UNIQUE FK | - | 用户 ID（每用户一个智能体） |
| name | VARCHAR(100) | NOT NULL | - | AI 智能体名称 |
| role | JSON | - | NULL | 角色设定 |
| appearance | JSON | - | NULL | 形象设定 |
| energy | INT(11) | NOT NULL | 100 | 当前能量值（对话等消耗） |
| is_initialized | TINYINT(1) | NOT NULL | 0 | 是否完成初始化 |
| model_preferences | JSON | - | NULL | 用户自定义模型参数偏好 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | ON UPDATE | 更新时间 |

**唯一键**：uk_user_agent (user_id)  
**索引**：idx_user, idx_initialized  
**外键**：user_id -> users(id) ON DELETE CASCADE

---

### ai_agent_memories（AI 智能体记忆表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 主键 |
| agent_id | INT(11) | NOT NULL, FK | - | AI 智能体 ID |
| memory_type | ENUM | NOT NULL | - | short / medium / long |
| content | JSON | NOT NULL | - | 记忆内容 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |

**索引**：idx_agent, idx_type, idx_agent_type  
**外键**：agent_id -> ai_agents(id) ON DELETE CASCADE

---

### ai_agent_conversations（AI 智能体对话记录表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 主键 |
| agent_id | INT(11) | NOT NULL, FK | - | AI 智能体 ID |
| user_message | TEXT | NOT NULL | - | 用户消息 |
| agent_message | TEXT | NOT NULL | - | AI 回复 |
| energy_cost | INT(11) | NOT NULL | 5 | 本次对话消耗能量 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 对话时间 |

**索引**：idx_agent, idx_created  
**外键**：agent_id -> ai_agents(id) ON DELETE CASCADE

---

### virtual_ai_agents（虚拟 AI 智能体表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 主键 |
| name | VARCHAR(100) | NOT NULL | - | 智能体名称 |
| energy | INT(11) | NOT NULL | 100 | 当前能量值 |
| stamina | INT(11) | NOT NULL | 100 | 当前体力值 |
| status | ENUM | NOT NULL | 'offline' | online / offline |
| room_id | INT(11) | NOT NULL, FK | - | 当前所在房间 ID |
| current_node_id | INT(11) | - | NULL | 当前占据的节点编号（game_nodes.node_id） |
| wins | INT(11) | NOT NULL | 0 | 胜利次数 |
| losses | INT(11) | NOT NULL | 0 | 失败次数 |
| draws | INT(11) | NOT NULL | 0 | 平局次数 |
| total_energy | BIGINT(20) | NOT NULL | 0 | 累计能量 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | ON UPDATE | 更新时间 |
| last_action_at | DATETIME | - | NULL | 最后行动时间（调度用） |

**索引**：idx_status, idx_room, idx_node, idx_last_action  
**外键**：room_id -> game_rooms(id) ON DELETE CASCADE

---

### virtual_agent_battles（虚拟智能体对战记录表）

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | INT(11) | PK, AUTO_INCREMENT | - | 主键 |
| attacker_id | INT(11) | NOT NULL, FK | - | 攻击者 ID（virtual_ai_agents.id） |
| attacker_type | ENUM | NOT NULL | 'virtual_agent' | virtual_agent / user |
| attacker_name | VARCHAR(100) | NOT NULL | - | 攻击者名称 |
| defender_id | INT(11) | NOT NULL | - | 防御者 ID（用户或虚拟智能体） |
| defender_type | ENUM | NOT NULL | 'virtual_agent' | virtual_agent / user |
| defender_name | VARCHAR(100) | NOT NULL | - | 防御者名称 |
| attacker_king | INT(11) | - | NULL | 攻击者 King 值 |
| attacker_assassin | INT(11) | - | NULL | 攻击者 Assassin 值 |
| defender_king | INT(11) | - | NULL | 防御者 King 值 |
| defender_assassin | INT(11) | - | NULL | 防御者 Assassin 值 |
| result | ENUM | NOT NULL | - | win / lose / draw / rejected / timeout |
| attacker_energy_change | INT(11) | - | 0 | 攻击者能量变化 |
| defender_energy_change | INT(11) | - | 0 | 防御者能量变化 |
| room_id | INT(11) | NOT NULL | 1 | 房间 ID |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 战斗时间 |

**索引**：idx_attacker, idx_defender, idx_created, idx_room  
**外键**：attacker_id -> virtual_ai_agents(id) ON DELETE CASCADE

---

## 3. 索引与查询场景

| 表 | 索引 | 查询场景 |
|----|------|----------|
| users | idx_username | 登录时按用户名查询 |
| users | idx_status | 筛选封禁/活跃用户 |
| game_nodes | uk_room_node | 按房间+节点查询占用 |
| game_nodes | idx_owner | 查询用户占用节点 |
| pk_records | idx_created | 按时间查询战斗记录 |
| pk_records | idx_attacker_type, idx_defender_type | 按参与方类型筛选 |
| admin_logs | idx_created | 按时间查询操作日志 |
| treasure_claims | uk_room_node | 防重复领取、每节点仅可领取一次 |
| story_chapters | idx_active, uk_chapter_number | 剧情章节列表与排序 |
| story_tasks | idx_chapter, idx_task_type | 章节任务列表、按类型筛选 |
| user_story_progress | uk_user_chapter, idx_user | 用户章节进度 |
| user_task_progress | uk_user_task, idx_user | 用户任务进度 |
| ai_agents | uk_user_agent | 用户智能体唯一绑定 |
| ai_agent_memories | idx_agent_type | 按智能体与类型查记忆 |
| virtual_ai_agents | idx_status, idx_room | 在线虚拟智能体、按房间 |
| virtual_agent_battles | idx_attacker, idx_defender, idx_created | 对战记录查询 |

---

## 4. Migration 策略

- **初始化**：`database/init_env.sql` 创建库、表、默认房间、100 个节点、默认配置
- **增量**：新增 migration 脚本置于 `database/migrations/` 下，按执行顺序建议：
  1. add_energy_treasure.sql（能量宝藏）
  2. fix_treasure_one_time_per_node.sql（宝藏节点唯一领取）
  3. add_initial_stamina_config.sql（初始体力配置）
  4. add_occupy_node_energy_cost.sql（占据节点消耗与首次免费标记 users.has_used_first_free_occupy）
  5. add_story_system.sql（剧情章节、任务、用户进度表）
  6. init_story_data.sql（剧情初始数据）
  7. add_ai_agent_tables.sql（AI 智能体、记忆、对话表）
  8. add_ai_agent_indexes.sql、add_ai_agent_feature_toggles.sql、add_config_extensions.sql、add_model_preferences.sql（AI 扩展与配置）
  9. add_virtual_ai_agents.sql、add_virtual_agent_configs.sql、add_virtual_agent_challenge_user_config.sql（虚拟智能体）
  10. extend_pk_records_for_virtual_agents.sql（pk_records 增加 attacker_type/defender_type）
- 注意：`init_env.sql` 中数据库名取自 `.env` 的 `MYSQL_DATABASE`，需与运行环境一致；部分 migration 使用 `USE \`root\``，部署时需替换为实际库名。

---

## 5. MongoDB 对战日志（battle_logs）

对战记录展示使用 MongoDB 存储详细对战日志，与 MySQL `pk_records` 互补：MySQL 仅存正常 PK，MongoDB 存全部对战（含拒绝/超时）。集合结构、索引与部署说明见 [MONGODB_BATTLE_LOGS.md](MONGODB_BATTLE_LOGS.md)。
