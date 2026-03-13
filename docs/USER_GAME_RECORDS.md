# MongoDB 用户游戏记录（user_game_records）

前端「对战与消费记录」列表从 MongoDB 的 `user_game_records` 集合按用户、时间分页查询，统一展示对战、能量消耗、宝藏奖励、激活码兑换等记录。

## 与 battle_logs 的关系

- **MongoDB `battle_logs`**：仍按场次存储每场对战详情（见 [MONGODB_BATTLE_LOGS.md](MONGODB_BATTLE_LOGS.md)），供兼容与审计。
- **MongoDB `user_game_records`**：
  - **对战**：每次写入 `battle_logs` 时双写两条文档（攻击方视角、防御方视角），便于按用户时间线展示。
  - **能量消耗 / 宝藏 / 激活码**：仅写入 `user_game_records`，不写 `battle_logs`。

`GET /api/battles` 仅查询 `user_game_records`，返回按 `createdAt` 倒序的混合列表，每条带 `recordType` 供前端区分展示。

## 集合与索引

- **数据库**：与 battle_logs 相同，由 `MONGODB_DB`（默认 `energy_mountain`）指定。
- **集合名**：`user_game_records`。
- **索引**（代码中通过 `getUserGameRecordsCollection` 自动创建）：
  - `{ userId: 1, createdAt: -1 }`

## 文档形状（按 recordType）

| recordType        | 必选字段                                                                 | 可选/说明 |
|-------------------|--------------------------------------------------------------------------|-----------|
| `battle`          | userId, createdAt, type, myResult, opponentName, myEnergyChange, opponentEnergyChange | type=normal 时有 myKing, myAssassin, opponentKing, opponentAssassin, myAttackDist, opponentAttackDist |
| `energy_consume`  | userId, createdAt, amount（负数）, reason                                | reason='occupy_node' 时 roomId, nodeId |
| `treasure`        | userId, createdAt, amount, claimType ('fixed' \| 'smart')                 | roomId, nodeId |
| `activation_code` | userId, createdAt, codeType ('energy' \| 'stamina'), amount              | - |

## 写入点

- **对战**：`server/socket.js`（handlePKRejection、consumePkSettlement）、`server/services/virtual-agent-socket.js`（拒绝/超时与正常结算），在 `insertBattleLog` 后 try-catch 内双写两条 `insertUserGameRecord`（recordType: 'battle'）。
- **能量消耗**：`server/socket.js` 的 `occupy_node`，非首次占据且扣费成功后写入 recordType: 'energy_consume'。
- **宝藏**：同文件固定宝藏与智能宝藏发放成功后分别写入 recordType: 'treasure'，claimType: 'fixed' / 'smart'。
- **激活码**：`server/routes/auth.js` 的 `POST /redeem-game-code` 兑换成功后写入 recordType: 'activation_code'。

## 旧数据迁移（可选）

若希望历史对战也出现在「对战与消费记录」中，可运行一次性脚本，从现有 `battle_logs` 为每条对战生成两条 `user_game_records`（攻击方、防御方视角）。脚本见项目根目录 `scripts/migrate-battle-logs-to-user-game-records.js`（若存在）。新产生的 PK 已双写，无需再次迁移。

## 配置与部署

- 与 battle_logs 共用 `MONGODB_URI`、`MONGODB_DB`。
- 写入失败时仅打日志，不中断主流程；查询失败时 `GET /api/battles` 返回 500，前端提示「对战记录暂不可用」。
