# 配置与环境文档

## 1. 环境变量清单

| 变量名 | 说明 | 默认值 | 必填 | 示例 |
|--------|------|--------|------|------|
| MYSQL_HOST | MySQL 主机 | localhost | 是 | localhost |
| MYSQL_PORT | MySQL 端口 | 3306 | 否 | 3306 |
| MYSQL_USER | MySQL 用户名 | root | 是 | root |
| MYSQL_PASSWORD | MySQL 密码 | 空 | 是* | 123456 |
| MYSQL_DATABASE | 数据库名 | energy_mountain | 是 | root |
| REDIS_HOST | Redis 主机 | localhost | 否** | localhost |
| REDIS_PORT | Redis 端口 | 6379 | 否 | 6379 |
| REDIS_PASSWORD | Redis 密码 | 空 | 否 | - |
| REDIS_DB | Redis 库号 | 0 | 否 | 0 |
| JWT_SECRET | JWT 签名密钥 | energy-mountain-secret-key... | 是*** | 随机长字符串 |
| JWT_EXPIRES_IN | JWT 过期时间 | 24h | 否 | 24h / 7d |
| PORT | 服务端口 | 3000 | 否 | 3000 |
| CORS_ORIGIN | 允许的跨域来源 | * | 否 | * / https://example.com |
| MONGODB_URI | MongoDB 连接 URI | mongodb://localhost:27017 | 否**** | mongodb://localhost:27017 |
| MONGODB_DB | MongoDB 数据库名 | energy_mountain | 否 | energy_mountain |

\* 本地开发可为空，生产需设置  
\*\* Redis 可选，未连接时验证码功能受影响，其他逻辑可运行  
\*\*\* 生产环境必须更换为强随机密钥  
\*\*\*\* 对战记录（battle_logs）使用 MongoDB；未配置时对战记录接口可能不可用

## 2. 配置文件加载

- 使用 `dotenv` 从项目根目录加载 `.env`
- 配置解析位于 `server/config/database.js`
- 环境变量优先于代码内默认值

## 3. 环境差异

| 环境 | 说明 |
|------|------|
| 开发 | 使用 `.env`，CORS 通常为 `*`，JWT_SECRET 可弱 |
| 测试 | 使用独立数据库，可复用开发配置 |
| 生产 | 必须修改 JWT_SECRET、MYSQL_PASSWORD，CORS 建议限定域名 |

## 4. 敏感信息安全

- **JWT_SECRET**：生产环境必须使用随机生成的强密钥，且不提交到版本库
- **MYSQL_PASSWORD**：不要提交到 Git，`.env` 已在 `.gitignore` 中排除
- `.env.example` 仅包含变量名和占位符，不含真实密码

## 5. .env.example 模板

参见项目根目录 `.env.example` 文件。

## 6. 游戏配置（game_config）

除环境变量外，部分游戏参数存储于数据库 `game_config` 表，可由管理后台修改。主要配置项说明如下：

| config_key | 说明 | 格式 |
|------------|------|------|
| initial_stamina | 新玩家初始体力值 | 整数，范围0-100，默认100 |
| energy_treasure | 能量宝藏节点与金额 | JSON 数组，如 `[{"nodeId":5,"amount":30},{"nodeId":12,"amount":50}]`。用户领取后，对应节点会从配置中自动移除。 |
| smart_treasure_enabled | 是否开启智能宝藏 | `true` \| `false`，默认 `false`。仅影响切换节点时的概率中奖，与固定宝藏并存。 |
| smart_treasure_prob_min | 智能宝藏中奖概率下限 | 0~1，默认 0.05 |
| smart_treasure_prob_max | 智能宝藏中奖概率上限 | 0~1，默认 0.25，须 ≥ prob_min |
| smart_treasure_ratio | 消耗与中奖能量总比率 | 长期期望回报/消耗，建议 0.2~0.6，默认 0.35 |
| smart_treasure_amount_min | 智能宝藏单次奖励下限（能量） | 整数 1~1000，默认 10 |
| smart_treasure_amount_max | 智能宝藏单次奖励上限（能量） | 整数 1~1000，默认 80，须 ≥ amount_min |

配置方式：登录管理后台 → 游戏配置 → 能量宝藏配置区域，选择节点并设置金额后保存。每个节点仅可被领取一次，领取后自动从配置中清除。智能宝藏在「智能宝藏配置」区块中配置，并可使用「AI 推荐参数」根据近期数据生成建议值。

其余 `game_config` 键（如 occupy_node_energy_cost、AI 相关 minimax_*、ai_agent_*、client_*、game_rules_*、virtual_agent_max_count 等）见 [DATABASE.md](DATABASE.md) 与 [GAME_LOGIC.md](GAME_LOGIC.md)。

### 6.1 AI 服务提供商与阿里云百炼（bailian）

管理员可在「游戏配置」中切换 **AI 服务提供商**（`ai_provider`），并配置对应 API：

| config_key | 说明 | 格式/可选值 |
|------------|------|--------------|
| ai_provider | 当前使用的 AI 服务 | `minimax` \| `bailian`，默认 `minimax` |
| bailian_api_key | 阿里云百炼（DashScope）API Key | 敏感，在管理后台填写或设置环境变量 `DASHSCOPE_API_KEY` |
| bailian_base_url | 百炼对话兼容接口 Base URL | 默认 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| bailian_default_model | 百炼对话模型 | qwen-max、qwen-plus、qwen-turbo、qwen-long、qwen-max-longcontext；支持联网：qwen3.5-plus、qwen3.5-plus-2026-02-15、qwen3-max、qwen3-max-2026-01-23、qwen3-max-2025-09-23 |
| bailian_image_model | 百炼图像生成模型（统一回退） | wanx-v1、wan2.6-image、qwen-image-max、qwen-image-plus 等 |
| bailian_image_model_t2i | 百炼文生图模型 | 空则使用上方图像生成模型；可选同上 |
| bailian_image_model_i2i | 百炼图生图模型 | 空则使用上方图像生成模型；图生图需上传参考图，建议 wan2.6-image |
| bailian_video_model | 百炼文生视频模型 | wanx2.1-t2v-plus、wanx2.1-t2v-turbo |
| bailian_i2v_model | 百炼图生视频模型 | wan2.6-i2v-flash、wan2.5-i2v-preview |
| bailian_speech_model | 百炼语音合成模型 | cosyvoice-v3-plus、cosyvoice-v3-flash、cosyvoice-v2、qwen-tts |
| bailian_temperature / bailian_max_tokens / bailian_top_p | 百炼对话参数 | 与 minimax 同含义 |

- **文生图/图生图**：有参考图时后端自动使用「图生图模型」，无参考图时使用「文生图模型」；未单独配置 t2i/i2i 时均使用「图像生成模型」。MiniMAX 同理支持 `minimax_image_model_t2i`、`minimax_image_model_i2i`。
- 配置方式：登录管理后台 → 游戏配置 → 「AI 服务提供商」选择 MiniMAX 或 阿里云百炼，并在「阿里云百炼 API 配置」区域填写 API Key 与模型。
- 官方文档：[百炼控制台](https://bailian.console.aliyun.com/)、[DashScope API 参考](https://help.aliyun.com/zh/model-studio/dashscope-api-reference/)。

### 6.2 AI 智能体联网搜索

启用后，AI 智能体与 AI 工作台对话时可使用阿里云百炼的**联网搜索**能力（实时信息、阿里云文档等）。仅在使用 **百炼** 时生效；MiniMAX 暂不支持。

| config_key | 说明 | 格式/可选值 |
|------------|------|--------------|
| ai_agent_web_search_enabled | 是否启用联网搜索 | `true` \| `false`，默认 `false` |
| ai_agent_web_search_studio_only | 是否仅在工作台启用联网 | `true` 时仅 context=studio（AI 工作台）启用；`false` 时工作台与游戏内均按总开关生效。默认 `false` |

- **模型要求**：使用联网时须将 `bailian_default_model` 设为支持联网的模型，如 **qwen3.5-plus**、**qwen3-max** 等；旧版 `qwen-plus` 可能不支持。在管理后台「默认对话模型」下拉中可直接选择上述支持联网的模型。
- **计费**：联网搜索会增加 token 消耗，且搜索策略（如 agent）按次计费，详见 [阿里云 - 大模型如何联网搜索](https://www.alibabacloud.com/help/zh/model-studio/web-search)。
- 配置方式：管理后台 → 游戏配置 → 「AI智能体功能开关」→ 勾选「联网搜索」/「联网仅工作台」；对话模型在「阿里云百炼 API 配置」→「默认对话模型」中选择。

**启用联网后仍回复“无法联网”时的排查**：
1. 确认 `ai_agent_web_search_enabled` 为 `true`（管理后台已勾选「联网搜索」并保存）。
2. 确认 `bailian_default_model` 为 **qwen3.5-plus** 或 **qwen3-max** 等支持联网的模型（旧版 `qwen-plus` 不支持）。
3. 若使用 AI 工作台：确认「仅工作台启用」与预期一致（`ai_agent_web_search_studio_only` 为 `false` 时工作台与游戏内均可用；为 `true` 时仅工作台可用）。工作台内可勾选「本条使用联网搜索」以确认本条请求走联网。
