#!/bin/bash
# 服务器部署脚本
# 在服务器上执行此脚本进行部署

echo "========================================"
echo "  能量山项目服务器部署脚本"
echo "========================================"

# 项目路径
PROJECT_DIR="/www/wwwroot/aibot"
PM2_NAME="aibotdemo"

# 进入项目目录
cd $PROJECT_DIR

# 1. 备份当前代码（可选）
# tar -czf backup_$(date +%Y%m%d_%H%M%S).tar.gz --exclude=node_modules .

# 2. 同步代码（选择一种方式）

# 方式A: 如果有git仓库
if [ -d ".git" ]; then
    echo "使用 git pull 同步代码..."
    git pull
else
    echo "注意: 项目没有git仓库，请在本地手动同步文件"
fi

# 3. 安装依赖
echo "安装依赖..."
npm install --production

# 4. 重启PM2
echo "重启PM2服务..."
pm2 restart $PM2_NAME

# 5. 查看状态
echo "PM2状态:"
pm2 status

# 6. 查看日志
echo "最近日志:"
pm2 logs $PM2_NAME --lines 10 --nostream

echo "========================================"
echo "  部署完成!"
echo "========================================"
