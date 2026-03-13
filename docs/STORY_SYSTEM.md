# 剧情系统设计文档

## 1. 概述

剧情系统用于引导新玩家熟悉游戏、提供阶段性目标，并通过章节与任务奖励（体力/能量）推动进度。章节按顺序解锁，每章包含若干任务，完成全部任务后可完成章节并领取章节奖励。

## 2. 数据模型

- **story_chapters**：剧情章节。字段包括章节编号、标题、描述、剧情正文（story_content）、完成条件（JSON，如 `complete_all_tasks`）、体力/能量奖励、是否启用、排序。
- **story_tasks**：任务线索。隶属某章节，包含任务类型（task_type）、标题、描述、提示（task_hint）、目标数值（target_value）、体力/能量奖励、排序。
- **user_story_progress**：用户章节进度。每用户每章节一条，记录当前任务、进度值、是否已完成、完成时间。
- **user_task_progress**：用户任务进度。每用户每任务一条，记录进度值、是否已完成、完成时间。

表结构详见 [DATABASE.md](DATABASE.md)。

## 3. 任务类型枚举

| task_type | 含义 | target_value 含义 |
|------------|------|-------------------|
| chat_with_ai | 与 AI 智能体对话 | 无或对话次数 |
| occupy_node | 占据节点 | 占据节点数（如 1、3） |
| mine_energy | 挖掘能量 | 累计挖掘能量数 |
| find_treasure | 发现能量宝藏 | 领取宝藏次数 |
| reach_energy | 能量达到某值 | 目标能量值（如 100） |
| complete_pk | 完成 PK 对战 | 完成 PK 次数（如 1） |

进度统计来源：挖矿对应 `users.total_energy` 或实时上报；占据节点数、宝藏领取、PK 次数等由服务端或 Socket 在对应行为发生后更新或由客户端调用进度接口上报。

## 4. 进度与完成逻辑

- **任务进度**：通过 `POST /api/story/tasks/:taskId/progress` 更新（请求体可传 `progressValue` 绝对值或 `increment: true` 增量）。服务端会取 max(当前进度, 新进度) 或当前+增量，且不超过任务 `target_value`。
- **任务完成**：当进度达到目标后，用户调用 `POST /api/story/tasks/:taskId/complete` 领取任务奖励（体力/能量），并写入 `user_task_progress.is_completed`。
- **章节完成条件**：当前为「完成本章所有任务」（completion_condition.type = complete_all_tasks）。用户调用 `POST /api/story/chapters/:chapterId/complete` 时，服务端校验该章所有任务均已完成，然后写入 `user_story_progress.is_completed` 并发放章节奖励。

## 5. 与游戏逻辑的衔接

- **挖矿**：服务端挖矿定时任务或 Socket 逻辑在能量/体力更新后，可检查用户任务列表，对类型为 `mine_energy` 等任务更新进度，并向客户端推送 `task_progress_ready`（含 taskId、taskType、progress、target），客户端可据此调用进度接口或刷新 UI。
- **占据节点**：占据成功后服务端可更新 `occupy_node` 类任务进度并推送 `task_progress_ready`。
- **PK**：完成一场 PK 后更新 `complete_pk` 类任务进度。
- **能量宝藏**：领取宝藏后更新 `find_treasure` 类任务进度。
- **与 AI 对话**：对话成功后更新 `chat_with_ai` 类任务进度。

实际实现中，部分进度在服务端（如 socket 挖矿/占据）更新后 emit `task_progress_ready`，前端可再调用 `POST /api/story/tasks/:taskId/progress` 或直接调用 complete（若进度已达标）。

## 6. 扩展与迁移

- 初始剧情数据来自 [database/migrations/init_story_data.sql](database/migrations/init_story_data.sql)（第 0～2 章及对应任务）。
- 新增章节/任务可通过新增 migration 插入 `story_chapters`、`story_tasks`，或后续扩展管理端进行维护。
- 剧情文案与当前已上线内容见 [STORY_CONTENT.md](STORY_CONTENT.md)。
