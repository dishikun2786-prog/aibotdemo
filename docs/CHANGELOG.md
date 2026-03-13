# 版本变更记录

## [Unreleased]

### 新增

- 代码规范体系
  - `.eslintrc.js` - ESLint代码检查配置
  - `.prettierrc` - Prettier代码格式化配置
  - `.editorconfig` - 编辑器统一配置
  - `docs/CODE_STANDARDS.md` - 代码规范文档
- 数据库备份脚本
  - `scripts/backup_database.js` - Node.js跨平台备份脚本
  - `scripts/backup_database.bat` - Windows批处理备份脚本
  - `scripts/backup_database.sh` - Linux Shell备份脚本
- 宝塔面板生产环境部署
  - `docs/BT_PANEL_DEPLOYMENT.md` - 宝塔面板部署完整指南
  - `scripts/bt_panel_setup.sh` - 宝塔面板环境初始化脚本
  - `scripts/pm2_ecosystem.config.js` - PM2进程管理配置
  - `scripts/nginx_config.conf` - Nginx反向代理配置示例
  - `.env.production.example` - 生产环境变量模板
- 开发文档标准体系（docs/）
  - ARCHITECTURE.md - 架构设计
  - API.md - REST API 规范
  - SOCKET_PROTOCOL.md - Socket 事件协议
  - DATABASE.md - 数据模型
  - GAME_LOGIC.md - 游戏规则与数值
  - CONFIG.md - 配置与环境
  - DEPLOYMENT.md - 运维与部署
- .env.example 模板

### 改进

- 完善项目文档结构
- 添加代码规范检查工具
- 优化生产环境部署流程

---

## [1.0.0]

- 能量山多人在线游戏
- 用户注册、登录、JWT 认证
- Socket.io 实时通信
- 节点占据、挖矿、能量/体力
- PK 对战、平台池
- 管理后台（用户、配置、统计、日志）
