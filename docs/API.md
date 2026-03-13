# REST API 规范文档

## 1. 概述

- **Base URL**：`http://localhost:3000/api`（可配置）
- **认证方式**：JWT，请求头 `Authorization: Bearer <token>`
- **响应格式**：成功 `{ success: true, data?, message? }`，失败 `{ error: string }` 或 `{ success: false, error }`
- **错误码**：4xx 客户端错误，5xx 服务端错误

## 2. 认证接口（/api/auth）

### GET /api/auth/captcha

获取验证码，用于登录/注册前展示。

**请求**：无

**响应**：
```json
{
  "success": true,
  "captchaId": "uuid-string",
  "image": "data:image/svg+xml;base64,..."
}
```

**错误**：500 生成验证码失败

---

### POST /api/auth/register

用户注册。

**限流**：15 分钟内最多 10 次

**请求体**：
```json
{
  "username": "string",       // 3-20 字符
  "password": "string",       // 至少 6 字符
  "confirmPassword": "string",
  "captchaId": "string",
  "captchaCode": "string"
}
```

**成功响应**：
```json
{
  "success": true,
  "message": "注册成功",
  "token": "jwt-string",
  "user": {
    "id": 1,
    "username": "xxx",
    "energy": 0,
    "stamina": 100
  }
}
```

**错误**：
- 400：缺少必填项、用户名长度不符、密码长度不符、两次密码不一致、验证码错误、用户名已存在

---

### POST /api/auth/login

用户登录。

**限流**：15 分钟内最多 10 次

**请求体**：
```json
{
  "username": "string",
  "password": "string",
  "captchaId": "string",
  "captchaCode": "string"
}
```

**成功响应**：
```json
{
  "success": true,
  "message": "登录成功",
  "token": "jwt-string",
  "user": {
    "id": 1,
    "username": "xxx",
    "energy": 0,
    "stamina": 100,
    "is_admin": false
  }
}
```

**错误**：
- 400：缺少必填项、验证码错误
- 401：用户名或密码错误
- 403：账户已被封禁

---

### GET /api/auth/me

获取当前登录用户信息。需认证。

**请求头**：`Authorization: Bearer <token>`

**成功响应**：
```json
{
  "success": true,
  "user": {
    "id": 1,
    "username": "xxx",
    "energy": 0,
    "stamina": 100,
    "total_energy": 0,
    "wins": 0,
    "losses": 0,
    "draws": 0,
    "is_admin": false,
    "created_at": "2024-01-01T00:00:00.000Z"
  }
}
```

**错误**：401 未认证、404 用户不存在

---

### POST /api/auth/logout

用户登出。需认证。

**请求头**：`Authorization: Bearer <token>`

**成功响应**：
```json
{
  "success": true,
  "message": "登出成功"
}
```

**功能说明**：
- 登出时会自动释放用户占据的所有节点
- 释放节点包括：更新数据库、清理Redis缓存、广播节点释放事件给房间内其他玩家
- 确保用户登出后，其占据的节点立即变为可用状态

**错误**：401 未认证、500 服务器错误

---

## 3. 管理接口（/api/admin）

所有管理接口需认证且 `users.is_admin = 1`。

**请求头**：`Authorization: Bearer <token>`

### GET /api/admin/users

获取用户列表，支持分页和筛选。

**Query**：
- `page`：页码，默认 1
- `limit`：每页数量，默认 20
- `search`：用户名模糊搜索
- `status`：`active` | `banned`

**成功响应**：
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "username": "xxx",
      "email": null,
      "energy": 0,
      "stamina": 100,
      "total_energy": 0,
      "wins": 0,
      "losses": 0,
      "draws": 0,
      "created_at": "...",
      "last_login": null,
      "status": "active"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "pages": 5
  }
}
```

---

### PUT /api/admin/users/:id/ban

封禁用户。

**路径参数**：`id` - 用户 ID

**成功响应**：`{ "success": true, "message": "用户已封禁" }`

**错误**：400 不能封禁自己、用户已被封禁；404 用户不存在

---

### PUT /api/admin/users/:id/unban

解封用户。

**成功响应**：`{ "success": true, "message": "用户已解封" }`

**错误**：400 用户未被封禁；404 用户不存在

---

### DELETE /api/admin/users/:id

删除用户（级联删除相关数据）。

**错误**：400 不能删除自己；404 用户不存在

---

### GET /api/admin/users/:id/auth-code

生成用户权威识别码（用于线下核验等）。需管理员认证。

**路径参数**：`id` - 用户 ID

**成功响应**：
```json
{
  "success": true,
  "data": {
    "authCode": "用户名+密码哈希后5位+能量余额",
    "username": "xxx",
    "energy": 0
  }
}
```

**错误**：404 用户不存在；500 服务器错误

---

### PUT /api/admin/users/:id/stats

修改用户能量和体力。若用户在线，会通过 Socket 推送 `player_update`。

**请求体**：
```json
{
  "energy": 0,    // 可选，0-1000
  "stamina": 100  // 可选，0-100
}
```

**成功响应**：`{ "success": true, "message": "用户数据更新成功" }`

**错误**：400 至少需提供 energy 或 stamina 之一、数值超出范围；404 用户不存在

---

### GET /api/admin/stats

获取统计数据。

**成功响应**：
```json
{
  "success": true,
  "data": {
    "users": {
      "total": 100,
      "active": 95,
      "banned": 5,
      "today": 10
    },
    "game": {
      "totalPk": 1000,
      "todayPk": 50,
      "platformPool": 10240,
      "totalEnergy": 50000
    },
    "trends": {
      "registerTrend": [
        { "date": "2024-01-01", "count": 5 }
      ]
    }
  }
}
```

---

### GET /api/admin/config

获取游戏配置键值。

**成功响应**：
```json
{
  "success": true,
  "data": {
    "energy_per_second": { "value": "5", "description": "每秒能量产出" },
    "max_energy": { "value": "100", "description": "最大能量值" }
  }
}
```

---

### PUT /api/admin/config

更新游戏配置。

**请求体**：
```json
{
  "configs": {
    "energy_per_second": "5",
    "platform_pool_bonus": "100"
  }
}
```

**成功响应**：`{ "success": true, "message": "配置更新成功" }`

---

### GET /api/admin/logs

获取管理员操作日志。

**Query**：`page`、`limit`（默认 50）

**成功响应**：
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "admin_id": 1,
      "admin_name": "admin",
      "target_id": 2,
      "target_name": "user1",
      "action": "ban_user",
      "details": { "username": "user1" },
      "created_at": "..."
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 100, "pages": 2 }
}
```

---

### POST /api/admin/config/test-minimax

测试 MiniMAX API 连接。需管理员认证。

**请求**：无请求体

**成功响应**：
```json
{
  "success": true,
  "data": { "success": true, ... },
  "message": "API连接测试成功"
}
```

**失败响应**：`{ "success": false, "error": "测试失败: ..." }`

---

## 4. 对战与消费记录接口（/api/battles）

需认证。从 MongoDB `user_game_records` 查询当前用户的游戏记录（对战、能量消耗、宝藏奖励、激活码兑换），详见 [USER_GAME_RECORDS.md](USER_GAME_RECORDS.md)。

### GET /api/battles

获取当前用户的游戏记录列表，分页；每条带 `recordType`，按时间倒序。

**Query**：
- `page`：页码，默认 1
- `limit`：每页数量，默认 20，最大 50

**成功响应**：
```json
{
  "success": true,
  "list": [
    {
      "id": "MongoDB _id 字符串",
      "recordType": "battle|energy_consume|treasure|activation_code",
      "createdAt": "ISO8601",
      "type": "normal|rejected|timeout",
      "myResult": "win|lose|draw",
      "opponentName": "对手名称",
      "myKing": 50,
      "myAssassin": 60,
      "opponentKing": 40,
      "opponentAssassin": 55,
      "myAttackDist": 10,
      "opponentAttackDist": 15,
      "myEnergyChange": 50,
      "opponentEnergyChange": -50
    }
  ],
  "total": 100
}
```

- `recordType: "battle"` 时包含上述对战字段（type、myResult、opponentName、攻防与能量变化等）。
- `recordType: "energy_consume"` 时包含 `amount`、`reason`、`roomId`、`nodeId`。
- `recordType: "treasure"` 时包含 `amount`、`claimType`（fixed/smart）、`roomId`、`nodeId`。
- `recordType: "activation_code"` 时包含 `codeType`（energy/stamina）、`amount`。

**错误**：500 对战记录暂不可用

---

## 5. 剧情接口（/api/story）

所有接口需认证。

### GET /api/story/chapters

获取所有章节列表（含每章任务列表）。仅返回 `is_active = 1` 的章节与任务。

**成功响应**：
```json
{
  "success": true,
  "chapters": [
    {
      "id": 1,
      "chapter_number": 0,
      "chapter_title": "接入协议",
      "chapter_description": "...",
      "story_content": "...",
      "completion_condition": { "type": "complete_all_tasks", "description": "..." },
      "stamina_reward": 10,
      "energy_reward": 0,
      "is_active": 1,
      "sort_order": 0,
      "tasks": [
        {
          "id": 1,
          "task_type": "chat_with_ai",
          "task_title": "...",
          "task_description": "...",
          "task_hint": "...",
          "target_value": null,
          "stamina_reward": 5,
          "energy_reward": 0,
          "sort_order": 0
        }
      ]
    }
  ]
}
```

---

### GET /api/story/chapters/:chapterId

获取章节详情（含任务列表与当前用户在该章的进度）。

**路径参数**：`chapterId` - 章节 ID

**成功响应**：章节信息 + tasks 数组 + 用户在该章的 userProgress（task_id、progress_value、is_completed、completed_at 等）

**错误**：404 章节不存在

---

### GET /api/story/my-progress

获取当前用户剧情进度摘要。返回所有章节及每章下的任务与完成状态，以及 `currentChapter`（当前应进行的章节）。

**成功响应**：
```json
{
  "success": true,
  "chapters": [ { "...": "章节+任务+progress" } ],
  "currentChapter": {
    "chapterNumber": 0,
    "chapterTitle": "接入协议",
    "chapterId": 1
  }
}
```

---

### POST /api/story/tasks/:taskId/complete

标记任务为已完成并发放任务奖励（体力/能量）。仅当进度达到目标值时允许完成。

**路径参数**：`taskId` - 任务 ID

**成功响应**：`{ "success": true, "message": "...", "rewards": { "stamina", "energy" }, "userStatus": { "stamina", "energy" } }`

**错误**：404 任务不存在；400 任务已完成、进度未达目标

---

### POST /api/story/tasks/:taskId/progress

更新任务进度（绝对值或增量）。用于挖矿/占据/PK 等行为后由服务端或客户端上报进度。

**路径参数**：`taskId` - 任务 ID

**请求体**：
```json
{
  "progressValue": 10,
  "increment": false
}
```
- `progressValue`：进度值（绝对值模式）；或增量模式下为递增值（默认 1）
- `increment`：true 表示在现有进度上增加，否则为取 max(当前, progressValue)

**成功响应**：`{ "success": true, "message": "进度更新成功", "progress": 10, "target": 50, "canComplete": false }`

**错误**：400 请提供进度值或使用增量模式；404 任务不存在；500 服务器错误

---

### POST /api/story/chapters/:chapterId/complete

完成章节（需本章所有任务已完成），发放章节奖励（体力/能量）。

**路径参数**：`chapterId` - 章节 ID

**成功响应**：`{ "success": true, "message": "章节完成", "rewards": { "stamina", "energy" }, "userStatus": { "stamina", "energy" } }`

**错误**：404 章节不存在；400 章节任务未全部完成、章节已完成；500 服务器错误

---

## 6. AI 智能体接口（/api/ai-agents）

所有接口需认证。与用户绑定的 AI 智能体对话、图像/视频/语音生成、记忆与模型配置等。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/ai-agents/test-connection | 测试 AI 服务连接 |
| POST | /api/ai-agents/initialize | 初始化当前用户智能体（名称、角色、形象） |
| GET | /api/ai-agents/my-agent | 获取当前用户智能体信息 |
| POST | /api/ai-agents/conversation | 发送对话消息，返回 AI 回复（消耗能量） |
| POST | /api/ai-agents/set-role | 设置智能体角色/形象 |
| GET | /api/ai-agents/memories | 获取智能体记忆列表 |
| POST | /api/ai-agents/generate-image | 生成图像 |
| POST | /api/ai-agents/create-video-task | 创建视频生成任务 |
| GET | /api/ai-agents/query-video-task/:taskId | 查询视频任务状态 |
| POST | /api/ai-agents/generate-speech | 语音合成 |
| GET | /api/ai-agents/conversations/history | 对话历史 |
| GET | /api/ai-agents/model-config | 获取模型配置与开关 |
| POST | /api/ai-agents/model-preferences | 保存用户模型参数偏好 |
| GET | /api/ai-agents/knowledge-base | 知识库列表 |
| GET | /api/ai-agents/skins/list | 皮肤列表（已拥有 + 可兑换） |
| POST | /api/ai-agents/skins/activate-by-code | 激活码激活皮肤，Body: `{ code }` |
| POST | /api/ai-agents/skins/exchange | 能量兑换皮肤，Body: `{ skin_id }` |
| GET | /api/ai-agents/current-skin | 当前选中的皮肤（未设置则返回默认） |
| PUT | /api/ai-agents/current-skin | 设置当前皮肤，Body: `{ skin_id }` |

请求/响应体以实际代码为准；对话消耗能量由 `game_config.ai_agent_energy_cost` 配置。详见 [server/routes/ai-agents.js](server/routes/ai-agents.js)。

---

## 7. 管理端 AI 智能体皮肤接口（/api/admin/ai-skins）

所有接口需认证且管理员权限。皮肤图片为 PNG 180×320，上传至 `public/bg/skins/`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/admin/ai-skins | 皮肤列表，Query: page, limit |
| GET | /api/admin/ai-skins/:id | 单条详情（含激活码数量） |
| POST | /api/admin/ai-skins | 新增皮肤，multipart: name, description, energy_price, pk_attack, pk_defense, image（PNG） |
| PUT | /api/admin/ai-skins/:id | 编辑皮肤，可选重新上传 image |
| DELETE | /api/admin/ai-skins/:id | 删除皮肤（禁止删除 id=1 默认皮肤） |
| POST | /api/admin/ai-skins/:id/codes | 生成激活码，Body: `{ count }` |
| GET | /api/admin/ai-skins/:id/codes | 该皮肤激活码列表，Query: page, limit |
| POST | /api/admin/ai-skins/:id/grant | 指定用户授权，Body: `{ user_id }` |
| POST | /api/admin/ai-skins/import | 批量导入皮肤元数据，Body: JSON 数组 `[{ name, description, energy_price, pk_attack, pk_defense }, ...]` |

详见 [server/routes/admin-ai-skins.js](server/routes/admin-ai-skins.js)。

---

## 8. 管理端虚拟智能体接口（/api/admin/virtual-agents）

所有接口需认证且 `users.is_admin = 1`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/admin/virtual-agents | 虚拟智能体列表，Query：page、limit、search、status |
| POST | /api/admin/virtual-agents/create | 创建虚拟智能体，Body 可选：name |
| GET | /api/admin/virtual-agents/:id | 获取单个智能体详情 |
| PUT | /api/admin/virtual-agents/:id/online | 上线智能体 |
| PUT | /api/admin/virtual-agents/:id/offline | 下线智能体 |
| PUT | /api/admin/virtual-agents/:id/stats | 修改能量/体力/房间等 |
| GET | /api/admin/virtual-agents/:id/battles | 该智能体对战记录 |
| DELETE | /api/admin/virtual-agents/:id | 删除虚拟智能体 |

响应格式均为 `{ success: true, data?: ..., message?: ... }` 或 `{ success: false, error: "..." }`。详见 [server/routes/admin-virtual-agents.js](server/routes/admin-virtual-agents.js)。

---

## 9. 其他接口

### GET /health

健康检查（不在 /api 下）。

**响应**：`{ "status": "ok", "timestamp": "2024-01-01T00:00:00.000Z" }`
