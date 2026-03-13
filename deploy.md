# 部署指南

## 快速开始

在 Cursor 中打开终端，运行以下命令部署代码到服务器：

```bash
node deploy.js
```

## 首次部署前检查

1. 确保服务器已开启 SSH 远程访问
2. 确保 PM2 已安装并运行
3. 确保服务器目录存在

## 部署流程

部署脚本会自动执行以下步骤：

1. **同步代码** - 将本地代码上传到服务器（使用 rsync 或 scp）
2. **安装依赖** - 在服务器执行 `npm install --production`
3. **重启服务** - 执行 `pm2 restart aibotdemo`
4. **验证** - 检查服务状态

## 配置说明

### 修改服务器信息

编辑 `deploy.config.js` 文件：

```javascript
module.exports = {
  server: {
    host: '47.115.168.24',    // 服务器IP
    port: 22,                 // SSH端口
    username: 'root',          // SSH用户名
    password: 'xxx'            // SSH密码
  },
  project: {
    remotePath: '/www/wwwroot/aibot',  // 服务器项目路径
    pm2Name: 'aibotdemo'               // PM2进程名称
  }
};
```

### 部署选项

```javascript
options: {
  exclude: ['node_modules', '.git', ...],  // 排除的文件
  installDeps: true,   // 是否安装依赖
  restartPm2: true     // 是否重启PM2
}
```

## 手动部署（不使用脚本）

如果脚本不可用，可以手动执行：

```bash
# 1. 同步代码（本地执行）
rsync -avz -e "ssh -p 22" --exclude="node_modules" --exclude=".git" ./ root@47.115.168.24:/www/wwwroot/aibot/

# 2. SSH连接服务器
ssh root@47.115.168.24

# 3. 安装依赖
cd /www/wwwroot/aibot
npm install --production

# 4. 重启PM2
pm2 restart aibotdemo
```

## 常见问题

### 1. 部署脚本报错 "Permission denied"

检查 `deploy.config.js` 中的密码是否正确。

### 2. 找不到 rsync

Windows 系统默认没有 rsync，脚本会自动降级使用 scp 方案。
或安装 [cwrsync](https://sourceforge.net/projects/rsyncwindows/)。

### 3. PM2 重启失败

SSH 登录服务器检查：
```bash
pm2 status
pm2 logs aibotdemo
```

### 4. 服务启动但无法访问

检查：
- 防火墙是否开放端口
- Nginx 是否配置正确
- 域名是否解析正确

## 访问地址

- 游戏首页: https://aibotdemo.skym178.com/game.html
- 管理后台: https://aibotdemo.skym178.com/admin.html
- 健康检查: https://aibotdemo.skym178.com/health
