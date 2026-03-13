# Socket 事件协议文档

## 1. 概述

Socket.io 用于能量山游戏的实时通信。所有事件均需在连接时携带 JWT Token：`auth: { token }`。

**连接示例**：
```javascript
const socket = io(SOCKET_URL, { auth: { token: authToken } });
```

## 2. 事件分类

| 分类 | 事件 | 方向 | 说明 |
|------|------|------|------|
| 房间 | join_game | C->S | 加入房间 |
| 房间 | leave_game | C->S | 离开房间 |
| 节点 | occupy_node | C->S | 占据节点 |
| 挖矿 | start_mining | C->S | 开始挖矿（已占据节点后） |
| PK | challenge_player | C->S | 发起 PK 挑战 |
| PK | pk_set_values | C->S | 设置 PK 数值（king, assassin） |
| PK | resolve_pk | C->S | 提交 PK 结算 |
| PK | reject_pk_challenge | C->S | 防御者拒绝 PK 挑战 |
| 状态 | game_state | S->C | 游戏状态（节点、玩家、平台池、已中奖节点） |
| 状态 | player_update | S->C | 能量/体力/canPK 更新 |
| 宝藏 | treasure_claimed | S->C | 领取能量宝藏成功（仅发中奖者） |
| 宝藏 | treasure_node_revealed | S->C | 某节点宝藏被领取，广播给全房间 |
| PK | pk_challenge | S->C | 收到 PK 挑战请求 |
| PK | pk_matched_virtual | S->C | 挑战匹配到虚拟智能体并已接受，请设置 PK 数值 |
| PK | pk_result | S->C | PK 结果（可带 settlementComplete 表示是否已全部落库） |
| PK | pk_settlement_complete | S->C | 结算流与数据库全部处理完毕，可展示最终结果 |
| 剧情 | task_progress_ready | S->C | 剧情任务进度可更新时推送（挖矿/占据等触发） |
| 系统 | system_message | S->C | 系统提示/错误 |

---

## 3. 客户端 -> 服务端（C->S）

### join_game

加入游戏房间，服务端发送当前游戏状态和玩家属性。

**参数**：
```typescript
{
  roomId?: number;  // 默认 1
}
```

**触发后服务端行为**：
- 将 socket 加入 `room_{roomId}`
- 更新房间在线人数
- 发送 `game_state`（full_state）
- 发送 `player_update`
- 发送 `system_message`（success）

**错误**：通过 `system_message`（type: 'error'）返回

---

### leave_game

离开房间。

**参数**：
```typescript
{
  roomId?: number;  // 默认 1
}
```

---

### occupy_node

占据指定节点。若已占据其他节点，则先释放旧节点再占据新节点。

**参数**：
```typescript
{
  nodeId: number;   // 节点编号 1-100
  roomId?: number;  // 默认 1
}
```

**前置条件**：节点存在且未被占用

**成功后**：向房间广播 `game_state`（type: 'node_occupied'）

**错误**：
- 节点不存在
- 节点已被占用

---

### start_mining

标记开始挖矿。需已占据节点。

**参数**：
```typescript
{
  roomId?: number;  // 默认 1
}
```

**前置条件**：用户已占据该房间内某节点

**说明**：挖矿由服务端定时任务驱动，此事件主要用于标记状态；能量/体力由服务端每秒更新。

---

### challenge_player

向目标玩家发起 PK 挑战。

**参数**：
```typescript
{
  defenderId: number;  // 被挑战者用户 ID
  roomId?: number;     // 默认 1
}
```

**前置条件**：
- 不能挑战自己
- 被挑战者在线

**成功后**：
- 向被挑战者发送 `pk_challenge`
- 在Redis中存储挑战状态（30秒TTL，用于超时检查）

**超时机制**：
- 如果被挑战者在30秒内未响应（既不接受也不拒绝），自动判被挑战者输
- 如果挑战者在30秒内离线，超时检查时不会判被挑战者输

**错误**：
- 目标玩家不在线
- 不能挑战自己

---

### pk_set_values

设置当前用户 PK 数值（King、Assassin）。数值存入 Redis，有效期 300 秒。

**参数**：
```typescript
{
  king: number;     // 1-100
  assassin: number; // 1-100
}
```

**说明**：在 `resolve_pk` 前，攻击方和防御方都需调用此事件设置数值。

---

### reject_pk_challenge

拒绝 PK 挑战。被挑战者明确拒绝时调用，服务端执行判输逻辑。

**参数**：
```typescript
{
  attackerId: number;  // 挑战者用户 ID
  roomId?: number;     // 默认 1
}
```

**前置条件**：
- 必须收到过 `pk_challenge` 事件

**处理后**：
- 被挑战者（防御者）判输：能量 -50，losses +1
- 挑战者（攻击者）判赢：能量 +50，wins +1
- 向双方发送 `pk_result`（reason: 'rejected'）
- 向双方发送 `player_update`
- 清理挑战状态
- **不记录到 pk_records 表**

---

### resolve_pk

提交 PK 结算。服务端从 Redis 读取双方 King/Assassin，计算胜负并更新 MySQL。

**参数**：
```typescript
{
  defenderId: number;  // 对手用户 ID
  roomId?: number;     // 默认 1
}
```

**前置条件**：
- 双方均已调用 `pk_set_values`（Redis 中存在数据）

**结算公式**：
- 攻击距离：`|己方 assassin - 对方 king|`
- 距离小者胜；相等则平局
- 胜：能量 +50；败/平：能量 -50
- 平局时平台池增加 `platform_pool_bonus`（默认 100）

**成功后**：
- 向双方发送 `pk_result`
- 向双方发送 `player_update`
- 平局时向房间广播 `platform_pool_update`
- 清理挑战状态（挑战已被接受）

**错误**：
- 己方或对方未设置 PK 数值

---

## 4. 服务端 -> 客户端（S->C）

### game_state

游戏状态推送，根据 `type` 不同包含不同字段。

**type: 'full_state'**（加入房间时）：
```typescript
{
  type: 'full_state';
  nodes: Array<{ nodeId: number; ownerId: number | null }>;
  players: Array<{ id: number; username: string; energy: number; stamina: number }>;
  platformPool: number;
  claimedTreasureNodes?: Array<{ nodeId: number; claimedAt: string }>;  // 最近1小时内有人中奖的节点列表，claimedAt 为 ISO 字符串，用于展示金色效果（1小时后前端自动隐藏）
}
```

**type: 'node_occupied'**（节点占用变化）：
```typescript
{
  type: 'node_occupied';
  nodeId: number;
  ownerId: number | null;   // 用户 ID 或虚拟智能体时为负数 -agentId
  ownerName?: string | null;
  ownerType?: 'user' | 'virtual_agent' | null;  // 占用者类型，虚拟智能体时存在
}
```

**type: 'player_count_update'**：
```typescript
{
  type: 'player_count_update';
  playerCount: number;
}
```

**type: 'platform_pool_update'**：
```typescript
{
  type: 'platform_pool_update';
  platformPool: number;
}
```

---

### treasure_claimed

用户占据节点并首次领取能量宝藏时，服务端向该用户单独推送。

```typescript
{
  nodeId: number;
  amount: number;   // 实际获得能量（受 max_energy 上限影响）
  newEnergy: number;
}
```

**说明**：每个用户每个宝藏节点仅可领取一次。服务端同时向房间广播 `treasure_node_revealed`，供全房间展示该节点金色效果。

---

### treasure_node_revealed

某节点宝藏被领取时，服务端向房间内所有玩家广播，用于展示该节点的金色效果。

```typescript
{
  nodeId: number;
  claimedAt: string;  // ISO 时间字符串，用于前端判断 1 小时后自动隐藏金色效果
}
```

**说明**：客户端收到后将该 nodeId 与 claimedAt 加入 `claimedTreasureNodes` 并渲染金色效果；超过 1 小时后前端自动隐藏金色。用户不能预先得知未中奖的宝藏点位。

---

### player_update

当前用户能量、体力、是否可 PK 的更新。

```typescript
{
  energy: number;   // 0-100
  stamina: number;  // 0-100
  canPK: boolean;   // energy >= 100 && 当前用户在该房间已占据节点
}
```

**触发时机**：
- 加入房间后
- 挖矿定时任务更新后
- PK 结算后
- 管理员修改用户数据后

---

### pk_challenge

收到其他玩家的 PK 挑战请求。

```typescript
{
  attackerId: number;
  attackerName: string;
  roomId: number;
}
```

**客户端行为**：弹出确认框，接受后进入 PK 界面并设置 `pkData.enemyId` 等。

---

### pk_matched_virtual

当用户挑战的 `defenderId` 为虚拟智能体且虚拟智能体“接受”挑战时，服务端向挑战者发送此事件，表示可直接进入 PK 数值设置与结算流程（无需真人确认）。

```typescript
{
  defenderId: number;   // 虚拟智能体 ID
  defenderName: string;
}
```

**客户端行为**：与真人接受挑战类似，进入 PK 界面，设置 King/Assassin 后调用 `resolve_pk`（defenderId 为该虚拟智能体 ID）。

---

### task_progress_ready

剧情任务进度可由服务端更新时（如挖矿产出、占据节点后）推送给当前用户，便于前端刷新任务进度或提示用户去完成/领取任务。

```typescript
{
  taskId: number;
  taskType: string;   // 如 mine_energy, occupy_node
  progress: number;
  target: number;
}
```

**说明**：客户端可根据 `taskType` 与 `progress`/`target` 调用 `POST /api/story/tasks/:taskId/progress` 或展示提示。

---

### pk_result

PK 结算结果。

```typescript
{
  result: 'win' | 'lose' | 'draw';
  myAttackDist: number | null;    // 己方攻击距离 |assassin - enemyKing|，拒绝/超时时为null
  enemyAttackDist: number | null; // 对方攻击距离，拒绝/超时时为null
  energyChange: number;           // +50 或 -50
  reason?: 'rejected' | 'timeout'; // 可选：拒绝或超时原因（正常PK时不存在）
  settlementComplete?: boolean;   // 可选：true 表示所有数据库与消息队列已处理完毕；false 表示仅请求路径完成，前端应显示「结算中」并等待 pk_settlement_complete 后再展示结果
}
```

**说明**：
- 正常PK时：`myAttackDist` 和 `enemyAttackDist` 为实际攻击距离
- 拒绝/超时时：`myAttackDist` 和 `enemyAttackDist` 为 `null`，`reason` 字段标识原因，不经过 stream，直接展示结果
- 真人 vs 真人正常PK：服务端会带 `settlementComplete: false`，前端显示「能量与对战日志同步中」；待收到 `pk_settlement_complete` 后再展示最终结果弹窗

---

### pk_settlement_complete

PK 结算流（pk:settlement）与相关数据库（MongoDB 对战日志、任务进度、平台池）全部处理完毕时，向该次 PK 的双方推送。

```typescript
{
  roomId?: number;  // 房间 ID，便于前端区分
}
```

**说明**：消费者处理完一条 pk:settlement 消息后，向 `actualAttackerId` 与 `actualDefenderId` 对应 socket 各发送一次。前端收到后若有暂存的 `pendingResult` 则展示最终结算结果并隐藏「结算中」提示。

---

### system_message

系统提示或错误信息。

```typescript
{
  type: 'success' | 'error' | 'info';
  message: string;
}
```

---

## 5. 重连与状态恢复

- Socket.io 自动重连，重连后需重新 `emit('join_game', { roomId })` 以获取最新状态
- 当前实现：`socket.on('connect', () => { socket.emit('join_game', ...) })`，连接成功即重新加入
- 游戏状态以服务端 MySQL 为准，重连后通过 `game_state` 和 `player_update` 恢复

## 6. 错误处理

- 认证失败：连接被拒绝
- 业务错误：通过 `system_message` 返回，`type: 'error'`
- 服务端异常：`console.error` 并发送 `system_message`
