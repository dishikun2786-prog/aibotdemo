# MongoDB 对战详细日志（battle_logs）

对战详情使用 MongoDB 的 `battle_logs` 集合存储每场对战的完整日志。前端「对战与消费记录」列表**从 `user_game_records` 查询**（含对战、能量消耗、宝藏、激活码），详见 [USER_GAME_RECORDS.md](USER_GAME_RECORDS.md)。对战在写入本集合的同时会双写到 `user_game_records`，便于按用户时间线展示。

## 与 MySQL pk_records 的关系

- **MySQL `pk_records`**：仅记录**正常 PK**（双方都设置了 King/Assassin 并完成结算）的战斗，供管理端统计与现有逻辑使用。
- **MongoDB `battle_logs`**：记录**全部对战**，包括：
  - `type: 'normal'`：正常 PK（与 pk_records 对应）
  - `type: 'rejected'`：防御者拒绝对决
  - `type: 'timeout'`：防御者超时未响应

## 集合与索引

- **数据库**：由配置 `MONGODB_DB`（默认 `energy_mountain`）指定。
- **集合名**：`battle_logs`。
- **推荐索引**（代码中已通过 `getBattleLogsCollection` 自动创建）：
  - `{ attackerId: 1, createdAt: -1 }`
  - `{ defenderId: 1, createdAt: -1 }`

## 文档字段

| 字段 | 类型 | 说明 |
|------|------|------|
| attackerId | Number | 攻击者用户 ID |
| defenderId | Number | 防御者用户 ID |
| attackerName | String | 攻击者用户名（展示用） |
| defenderName | String | 防御者用户名（展示用） |
| type | String | `'normal'` \| `'rejected'` \| `'timeout'` |
| attackerKing | Number? | 仅 type=normal 有 |
| attackerAssassin | Number? | 仅 type=normal 有 |
| defenderKing | Number? | 仅 type=normal 有 |
| defenderAssassin | Number? | 仅 type=normal 有 |
| attackerAttackDist | Number? | 攻击方攻击距离，仅 normal |
| defenderAttackDist | Number? | 防御方攻击距离，仅 normal |
| result | String | 攻击方视角：`'win'` \| `'lose'` \| `'draw'`；拒绝/超时为攻击方 win |
| attackerEnergyChange | Number | 攻击方能量变化 |
| defenderEnergyChange | Number | 防御方能量变化 |
| roomId | Number | 房间 ID |
| createdAt | Date | 对战时间 |

## 配置与部署

- 环境变量：`MONGODB_URI`（默认 `mongodb://localhost:27017`）、`MONGODB_DB`（默认 `energy_mountain`）。
- 若 MongoDB 不可用：双写处已 try-catch 降级，PK 流程不中断；`GET /api/battles` 返回 500，前端提示「对战记录暂不可用」。
