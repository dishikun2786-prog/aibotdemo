# 运维与部署文档

## 1. 启动流程

### 方法一：使用启动脚本（推荐）

1. 复制 `.env.example` 为 `.env` 并填写配置
2. 双击运行 `启动服务器.bat`
3. 脚本会自动检查并安装依赖
4. 服务器启动后，在浏览器中打开 `game.html`

### 方法二：手动启动

```bash
# 安装依赖（首次运行）
npm install

# 生产模式
npm start

# 开发模式（代码修改自动重启）
npm run dev
```

## 2. 依赖要求

| 依赖 | 版本要求 | 说明 |
|------|----------|------|
| Node.js | 14+ | 运行环境 |
| MySQL | 5.7+ / 8.x | 持久化存储 |
| Redis | 可选 | 验证码缓存；未运行则验证码可能异常 |

## 3. 数据库初始化

1. 确保 MySQL 服务已启动
2. 根据 `.env` 中 `MYSQL_DATABASE` 执行对应初始化：
   - 使用 `database/init_env.sql`（会按 .env 生成）
   - 或手动创建库后执行 `database/init.sql`（若存在）
3. 脚本会创建表、默认房间、100 个节点、默认配置

## 4. 健康检查

- **端点**：`GET /health`
- **示例**：http://localhost:3000/health
- **成功响应**：`{ "status": "ok", "timestamp": "..." }`

## 5. 日志

- 当前输出到控制台（stdout）
- 连接/断开：`用户连接: xxx (id)`、`用户断开: xxx (id)`
- 错误：`console.error` 输出，如 `加入游戏房间失败`、`PK战斗失败`
- 生产建议：使用 PM2 等进程管理器，将 stdout/stderr 重定向到日志文件

## 6. 优雅关闭

- 监听 `SIGTERM`，收到后关闭 HTTP 服务器并退出
- 见 `server/app.js` 中的 `process.on('SIGTERM', ...)`

## 7. 常见故障与排查

详见根目录 [登录问题排查指南.md](../登录问题排查指南.md)。

### 快速检查清单

- [ ] MySQL 服务已启动
- [ ] 后端服务已启动（端口 3000）
- [ ] 数据库已初始化（执行 init_env.sql）
- [ ] `.env` 配置正确
- [ ] Redis 已启动（验证码功能）
- [ ] 浏览器控制台无错误

### 典型问题

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| ERR_CONNECTION_REFUSED | 后端未启动 | 运行 `npm start` 或 `启动服务器.bat` |
| 用户名或密码错误 | 账号不存在或密码错误 | 运行 `快速修复管理员账号.bat` 或创建管理员 |
| 验证码错误/无法显示 | Redis 未启动或验证码过期 | 启动 Redis，刷新验证码 |
| 数据库连接失败 | MySQL 未启动或配置错误 | 检查 `.env`，执行 init_env.sql |

## 8. 端口配置

- 后端默认：3000
- 修改：在 `.env` 中设置 `PORT=3001`，同时修改 `game.html` 中 `API_BASE` 和 `SOCKET_URL`

## 9. 数据库备份

项目提供了多种备份方式：

### 方法一：使用Node.js脚本（推荐）

```bash
node scripts/backup_database.js
```

### 方法二：使用Windows批处理脚本

```bash
scripts\backup_database.bat
```

### 方法三：使用Linux Shell脚本

```bash
bash scripts/backup_database.sh
```

备份文件保存在项目根目录，文件名格式：`数据库名_backup_YYYYMMDD_HHMMSS.sql`

## 10. 生产环境部署

### 10.1 Linux宝塔面板部署

详细部署指南请参考：[docs/BT_PANEL_DEPLOYMENT.md](BT_PANEL_DEPLOYMENT.md)

快速部署步骤：

1. 上传项目文件到服务器
2. 运行初始化脚本：
   ```bash
   bash scripts/bt_panel_setup.sh
   ```
3. 配置环境变量（`.env`文件）
4. 初始化数据库
5. 使用PM2启动应用：
   ```bash
   pm2 start scripts/pm2_ecosystem.config.js
   ```
6. 配置Nginx反向代理（参考`scripts/nginx_config.conf`）

### 10.2 生产环境注意事项

- ✅ 必须修改 `JWT_SECRET` 为强随机字符串
- ✅ 配置 `CORS_ORIGIN` 限制允许的域名
- ✅ 使用HTTPS加密传输
- ✅ 使用PM2管理进程，确保服务稳定运行
- ✅ 配置数据库定期备份
- ✅ 监控服务器资源使用情况
