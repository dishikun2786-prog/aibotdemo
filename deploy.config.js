// 部署配置
// 使用方法: 修改下面的服务器配置，然后运行 node deploy.js

module.exports = {
  // 服务器配置
  server: {
    host: '47.115.168.24',
    port: 22,
    username: 'root',
    password: 'Ylh19920309'
  },

  // 项目路径
  project: {
    // 本地项目路径（相对于此配置文件）
    localPath: '.',
    // 服务器项目路径
    remotePath: '/www/wwwroot/aibot',
    // PM2进程名称
    pm2Name: 'aibotdemo'
  },

  // 部署选项
  options: {
    // 排除的文件/文件夹（只保留必要的项目文件）
    exclude: [
      // 依赖和版本控制
      'node_modules',
      '.git',
      'package-lock.json',

      // IDE和工具配置
      '.cursor',
      '.vscode',
      '.idea',

      // 日志和临时文件
      '*.log',
      'logs',
      'backups',

      // 部署脚本（本地使用，不上传）
      'deploy.js',
      'deploy.config.js',
      'deploy.md',

      // 无关项目（App、小说、PDF处理等）
      'energy-mountain-app',
      'pdf2text',
      'novel',
      'chapters_*.json',

      // 测试和文档
      '*.md',
      'jest.config.js',
      'jest.setup.js',
      '__tests__',

      // 临时和杂项脚本
      'scripts',
      'parse-*.js',
      'find-issues.js',

      // 临时页面
      'baixing.html',
      'promotion.html',
      'landing.html',
      'aiwork.html',
      'knowledge-manage.html',

      // .env 由服务器提供，不同步
      '.env'
    ],
    // 是否在部署前安装依赖
    installDeps: true,
    // 是否重启PM2
    restartPm2: true
  }
};
