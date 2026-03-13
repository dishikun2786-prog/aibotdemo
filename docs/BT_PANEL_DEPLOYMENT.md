# 宝塔面板生产环境部署指南

## 1. 概述

本文档介绍如何在Linux服务器上使用宝塔面板部署能量山游戏项目到生产环境。

## 2. 前置要求

### 2.1 服务器要求

- Linux系统（推荐：CentOS 7+ / Ubuntu 18+）
- 至少2GB内存
- 至少20GB磁盘空间
- 已安装宝塔面板

### 2.2 软件要求

- Node.js 14+（通过宝塔面板安装）
- MySQL 5.7+ / 8.0+（通过宝塔面板安装）
- Redis 5.0+（可选，通过宝塔面板安装）
- Nginx（通过宝塔面板安装）
- PM2（Node.js进程管理器）

## 3. 宝塔面板环境准备

### 3.1 安装必要软件

1. 登录宝塔面板
2. 进入「软件商店」
3. 安装以下软件：
   - **Node.js版本管理器**（推荐安装Node.js 16.x或18.x）
   - **MySQL**（推荐5.7或8.0）
   - **Redis**（可选，用于验证码缓存）
   - **Nginx**（Web服务器）

### 3.2 创建网站

1. 进入「网站」→「添加站点」
2. 填写域名（如：`game.example.com`）
3. 选择PHP版本（本项目不需要PHP，可任意选择）
4. 创建数据库（记录数据库名、用户名、密码）
5. 点击「提交」

### 3.3 上传项目文件

**方法一：通过宝塔面板文件管理器**

1. 进入「文件」→ 找到网站根目录（如：`/www/wwwroot/game.example.com`）
2. 删除默认的`index.html`等文件
3. 上传项目压缩包并解压
4. 或使用Git克隆项目：
   ```bash
   cd /www/wwwroot/game.example.com
   git clone <your-repo-url> .
   ```

**方法二：通过SSH**

```bash
cd /www/wwwroot/game.example.com
git clone <your-repo-url> .
# 或使用scp上传文件
```

## 4. 环境配置

### 4.1 安装Node.js依赖

通过SSH连接到服务器，执行：

```bash
cd /www/wwwroot/game.example.com
npm install --production
```

### 4.2 配置环境变量

1. 复制环境变量模板：
   ```bash
   cp .env.production.example .env
   ```

2. 编辑`.env`文件，填写生产环境配置：
   ```bash
   nano .env
   ```

3. 关键配置项：
   ```env
   # MySQL配置（使用宝塔面板创建的数据库信息）
   MYSQL_HOST=localhost
   MYSQL_PORT=3306
   MYSQL_USER=数据库用户名
   MYSQL_PASSWORD=数据库密码
   MYSQL_DATABASE=数据库名
   
   # Redis配置（如果安装了Redis）
   REDIS_HOST=localhost
   REDIS_PORT=6379
   REDIS_PASSWORD=Redis密码（如果设置了）
   REDIS_DB=0
   
   # JWT配置（生产环境必须修改为强随机密钥）
   JWT_SECRET=请使用强随机字符串（至少32位）
   JWT_EXPIRES_IN=24h
   
   # 服务器配置
   PORT=3000
   CORS_ORIGIN=https://game.example.com
   ```

### 4.3 初始化数据库

1. 通过宝塔面板「数据库」→「phpMyAdmin」打开数据库管理
2. 选择创建的数据库
3. 导入`database/init_env.sql`文件
4. 或使用命令行：
   ```bash
   mysql -u数据库用户名 -p数据库名 < database/init_env.sql
   ```

## 5. PM2进程管理配置

### 5.1 安装PM2

```bash
npm install -g pm2
```

### 5.2 使用PM2启动应用

**方法一：使用ecosystem配置文件（推荐）**

1. 复制PM2配置文件：
   ```bash
   cp scripts/pm2_ecosystem.config.js ecosystem.config.js
   ```

2. 编辑`ecosystem.config.js`，修改应用路径和名称

3. 启动应用：
   ```bash
   pm2 start ecosystem.config.js
   ```

**方法二：直接启动**

```bash
pm2 start server/app.js --name energy-mountain --env production
```

### 5.3 PM2常用命令

```bash
# 查看应用状态
pm2 status

# 查看日志
pm2 logs energy-mountain

# 重启应用
pm2 restart energy-mountain

# 停止应用
pm2 stop energy-mountain

# 删除应用
pm2 delete energy-mountain

# 保存PM2配置（开机自启）
pm2 save
pm2 startup
```

## 6. Nginx反向代理配置

### 6.1 配置Nginx

1. 进入宝塔面板「网站」→ 选择你的网站 → 「设置」
2. 点击「配置文件」
3. 替换为以下配置（或参考`scripts/nginx_config.conf`）：

```nginx
server {
    listen 80;
    server_name game.example.com;
    
    # 重定向到HTTPS（如果配置了SSL）
    # return 301 https://$server_name$request_uri;
    
    # 如果未配置SSL，使用以下配置
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
    
    # WebSocket支持（Socket.io）
    location /socket.io/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # API代理
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # 健康检查
    location /health {
        proxy_pass http://localhost:3000;
        access_log off;
    }
}
```

4. 点击「保存」

### 6.2 配置SSL证书（推荐）

1. 进入「SSL」选项卡
2. 选择「Let's Encrypt」免费证书
3. 填写邮箱，点击「申请」
4. 申请成功后，开启「强制HTTPS」
5. 更新Nginx配置，取消HTTPS重定向的注释

## 7. 防火墙配置

### 7.1 宝塔面板防火墙

1. 进入「安全」→「防火墙」
2. 确保以下端口开放：
   - **80**（HTTP）
   - **443**（HTTPS）
   - **3000**（Node.js应用，仅本地访问，可不开放）

### 7.2 系统防火墙

如果使用系统防火墙（如firewalld），执行：

```bash
# CentOS/RHEL
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --reload

# Ubuntu/Debian
ufw allow 80/tcp
ufw allow 443/tcp
ufw reload
```

## 8. 定时任务配置

### 8.1 数据库备份

1. 进入宝塔面板「计划任务」
2. 添加任务：
   - **任务类型**：Shell脚本
   - **任务名称**：数据库备份
   - **执行周期**：每天 2:00
   - **脚本内容**：
     ```bash
     cd /www/wwwroot/game.example.com
     node scripts/backup_database.js
     ```
3. 点击「添加任务」

### 8.2 清理旧备份（可选）

添加清理任务，删除7天前的备份：

```bash
find /www/wwwroot/game.example.com -name "*_backup_*.sql" -mtime +7 -delete
```

## 9. 日志管理

### 9.1 PM2日志

PM2日志默认位置：
- 标准输出：`~/.pm2/logs/energy-mountain-out.log`
- 错误输出：`~/.pm2/logs/energy-mountain-error.log`

### 9.2 应用日志

如需自定义日志位置，修改`ecosystem.config.js`中的日志配置。

### 9.3 日志轮转

使用PM2的日志轮转功能：

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

## 10. 监控与健康检查

### 10.1 健康检查端点

应用提供健康检查端点：`/health`

可通过以下方式监控：

```bash
# 手动检查
curl http://localhost:3000/health

# 或通过Nginx代理
curl https://game.example.com/health
```

### 10.2 宝塔面板监控

1. 进入「监控」查看服务器资源使用情况
2. 设置告警阈值（CPU、内存、磁盘）

### 10.3 PM2监控

```bash
# 实时监控
pm2 monit

# 查看详细信息
pm2 describe energy-mountain
```

## 11. 安全建议

### 11.1 环境变量安全

- ✅ 生产环境必须修改`JWT_SECRET`为强随机字符串
- ✅ 数据库密码使用强密码
- ✅ `.env`文件权限设置为600：
  ```bash
  chmod 600 .env
  ```

### 11.2 数据库安全

- ✅ 数据库用户仅授予必要权限
- ✅ 限制数据库仅允许本地访问
- ✅ 定期备份数据库

### 11.3 服务器安全

- ✅ 定期更新系统和软件
- ✅ 使用SSH密钥登录，禁用密码登录
- ✅ 配置fail2ban防止暴力破解
- ✅ 定期检查日志文件

### 11.4 应用安全

- ✅ 使用HTTPS加密传输
- ✅ 配置CORS限制允许的域名
- ✅ 启用速率限制（已在代码中实现）
- ✅ 定期更新依赖包：
  ```bash
  npm audit
  npm update
  ```

## 12. 故障排查

### 12.1 npm 命令未找到（Command 'npm' not found）

**错误示例：**
```
Command 'npm' not found, but can be installed with:
apt install npm
```

**原因：** 服务器上未安装 Node.js 和 npm。

**解决方法：**

**方法一：通过宝塔面板安装（推荐）**

1. 登录宝塔面板
2. 进入「软件商店」
3. 搜索并安装「Node.js版本管理器」
4. 安装完成后，选择 Node.js 版本（推荐 16.x、18.x 或 20.x）
5. 安装完成后，通过 SSH 验证：
   ```bash
   node -v
   npm -v
   ```

**方法二：通过命令行安装（Ubuntu/Debian）**

1. 更新软件包列表：
   ```bash
   sudo apt update
   ```

2. 安装 Node.js 和 npm：
   ```bash
   # 方法A：安装 Node.js 18.x（推荐）
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt install -y nodejs
   
   # 方法B：直接通过 apt 安装（版本可能较旧）
   sudo apt install -y nodejs npm
   ```

3. 验证安装：
   ```bash
   node -v
   npm -v
   ```

**方法三：使用 NVM 安装（灵活管理多个版本）**

1. 安装 NVM：
   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
   source ~/.bashrc
   ```

2. 安装 Node.js（例如 18.x）：
   ```bash
   nvm install 18
   nvm use 18
   nvm alias default 18
   ```

3. 验证安装：
   ```bash
   node -v
   npm -v
   ```

**安装完成后：**

1. 进入项目目录：
   ```bash
   cd /www/wwwroot/aibot
   ```

2. 安装项目依赖：
   ```bash
   npm install --production
   ```

**注意事项：**
- npm 会随 Node.js 一起安装，不需要单独安装
- 如果使用宝塔面板，推荐使用方法一，便于管理
- 生产环境建议使用 Node.js 16.x 或更高版本
- 如果安装后仍然找不到命令，可能需要重新登录 SSH 或执行 `source ~/.bashrc`

### 12.2 应用无法启动

1. 检查PM2日志：
   ```bash
   pm2 logs energy-mountain
   ```

2. 检查端口是否被占用：
   ```bash
   netstat -tlnp | grep 3000
   ```

3. 检查环境变量配置是否正确

4. 检查数据库连接：
   ```bash
   mysql -u数据库用户名 -p数据库名 -e "SELECT 1"
   ```

### 12.3 模块找不到错误（MODULE_NOT_FOUND）

**错误示例：**
```
Error: Cannot find module 'dotenv'
Error: Cannot find module 'express'
```

**原因：** Node.js 依赖包未安装，`node_modules` 目录不存在或缺失。

**解决方法：**

1. 进入项目目录：
   ```bash
   cd /www/wwwroot/aibot
   # 或你的实际项目路径
   ```

2. 安装生产环境依赖：
   ```bash
   npm install --production
   ```

3. 如果使用宝塔面板的Node.js版本管理器，确保使用正确的Node.js版本：
   ```bash
   # 查看当前Node.js版本
   node -v
   
   # 如果版本不对，切换到正确的版本（例如v22）
   nvm use 22
   # 或使用宝塔面板的Node.js版本管理器切换
   ```

4. 验证安装：
   ```bash
   # 检查 node_modules 目录是否存在
   ls -la node_modules
   
   # 检查 dotenv 是否已安装
   ls node_modules/dotenv
   ```

5. 如果仍然失败，尝试清理缓存后重新安装：
   ```bash
   rm -rf node_modules package-lock.json
   npm cache clean --force
   npm install --production
   ```

6. 安装完成后重启应用：
   ```bash
   pm2 restart energy-mountain
   # 或使用宝塔面板的PM2管理器重启
   ```

**注意事项：**
- 确保在项目根目录（包含 `package.json` 的目录）执行 `npm install`
- 生产环境使用 `--production` 参数，只安装生产依赖，不安装开发依赖
- 如果项目路径是 `/www/wwwroot/aibot`，确保在该目录下有 `package.json` 文件

### 12.4 WebSocket连接失败

1. 检查Nginx配置中的WebSocket代理设置
2. 检查防火墙是否阻止连接
3. 检查应用日志中的错误信息

### 12.5 数据库连接失败

1. 检查`.env`中的数据库配置
2. 检查MySQL服务是否运行：
   ```bash
   systemctl status mysql
   ```
3. 检查数据库用户权限

## 13. 更新部署

### 13.1 更新代码

```bash
cd /www/wwwroot/game.example.com

# 备份当前版本
cp -r . ../backup_$(date +%Y%m%d)

# 拉取最新代码
git pull

# 安装依赖（如果有新增）
npm install --production

# 重启应用
pm2 restart energy-mountain
```

### 13.2 数据库迁移

如果有数据库迁移脚本：

```bash
mysql -u数据库用户名 -p数据库名 < database/migrations/xxx.sql
```

## 14. 性能优化

### 14.1 Node.js优化

- 使用PM2集群模式（多进程）：
  ```bash
  pm2 start ecosystem.config.js -i max
  ```

### 14.2 数据库优化

- 定期优化数据库表
- 添加必要的索引
- 使用连接池（已在代码中实现）

### 14.3 Nginx优化

- 启用Gzip压缩
- 配置静态文件缓存
- 使用CDN加速（如需要）

## 15. 备份与恢复

### 15.1 完整备份

```bash
# 备份数据库
node scripts/backup_database.js

# 备份代码和配置
tar -czf backup_$(date +%Y%m%d).tar.gz \
  --exclude=node_modules \
  --exclude=.git \
  .
```

### 15.2 恢复

1. 恢复代码文件
2. 恢复数据库：
   ```bash
   mysql -u数据库用户名 -p数据库名 < backup.sql
   ```
3. 重启应用

## 16. 联系支持

如遇到问题，请检查：
1. PM2日志
2. Nginx错误日志
3. MySQL错误日志
4. 应用健康检查端点

参考文档：
- [项目架构文档](ARCHITECTURE.md)
- [部署文档](DEPLOYMENT.md)
- [配置文档](CONFIG.md)
