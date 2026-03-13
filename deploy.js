/**
 * 能量山项目自动部署脚本
 * 
 * 使用方法:
 *   node deploy.js
 * 
 * 功能:
 *   1. 本地代码推送到GitHub
 *   2. SSH连接到服务器执行git pull
 *   3. 重启PM2服务
 */

const { execSync } = require('child_process');

// 服务器配置
const SERVER = {
  host: '47.115.168.24',
  port: 22,
  username: 'root',
  password: 'Ylh19920309',
  projectPath: '/www/wwwroot/aibot',
  pm2Name: 'aibotdemo',
  gitBranch: 'master'
};

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function logStep(step, msg) {
  log(`\n[${step}/3] ${msg}`, 'cyan');
}

function logSuccess(msg) {
  log(`✓ ${msg}`, 'green');
}

function logError(msg) {
  log(`✗ ${msg}`, 'red');
}

function logInfo(msg) {
  log(`  ${msg}`, 'yellow');
}

// SSH执行命令
function sshExec(command) {
  const fullCommand = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -p ${SERVER.port} ${SERVER.username}@${SERVER.host} "${command}"`;
  return execSync(fullCommand, { encoding: 'utf-8', stdio: 'pipe' });
}

// 本地git推送
function pushToGitHub() {
  logInfo('添加所有更改...');
  execSync('git add -A', { stdio: 'inherit' });
  
  logInfo('提交更改...');
  try {
    execSync('git commit -m "Update"', { stdio: 'inherit' });
  } catch (e) {
    logInfo('没有新的更改需要提交');
  }
  
  logInfo('推送到GitHub...');
  execSync('git push -u origin master', { stdio: 'inherit' });
  logSuccess('GitHub推送完成');
}

// 服务器部署
function deployToServer() {
  // 1. 拉取最新代码
  logInfo('服务器拉取最新代码...');
  try {
    sshExec(`cd ${SERVER.projectPath} && git fetch origin && git checkout ${SERVER.gitBranch} && git pull origin ${SERVER.gitBranch}`);
    logSuccess('代码同步完成');
  } catch (e) {
    // 如果git pull失败，尝试重新克隆
    logInfo('git pull失败，尝试重新克隆...');
    sshExec(`cd ${SERVER.projectPath} && git checkout ${SERVER.gitBranch} && git reset --hard origin/${SERVER.gitBranch}`);
    logSuccess('代码重置完成');
  }
  
  // 2. 安装依赖
  logInfo('安装依赖...');
  try {
    sshExec(`cd ${SERVER.projectPath} && npm install --production`);
    logSuccess('依赖安装完成');
  } catch (e) {
    logInfo('依赖安装跳过或失败');
  }
  
  // 3. 重启PM2
  logInfo('重启PM2服务...');
  try {
    sshExec(`cd ${SERVER.projectPath} && pm2 restart ${SERVER.pm2Name}`);
    logSuccess('PM2重启完成');
  } catch (e) {
    logError(`PM2重启失败: ${e.message}`);
  }
  
  // 4. 验证
  logInfo('验证服务状态...');
  try {
    const status = sshExec(`pm2 describe ${SERVER.pm2Name} | grep status`);
    if (status.includes('online')) {
      logSuccess('服务运行正常');
    }
  } catch (e) {
    logError('服务状态验证失败');
  }
}

// 主函数
function deploy() {
  log('========================================', 'blue');
  log('  能量山项目自动部署', 'blue');
  log('========================================', 'blue');
  
  log(`目标服务器: ${SERVER.username}@${SERVER.host}`, 'yellow');
  log(`项目路径: ${SERVER.projectPath}`, 'yellow');
  log(`PM2进程: ${SERVER.pm2Name}`, 'yellow');
  
  try {
    // Step 1: 推送到GitHub
    logStep(1, '推送到GitHub');
    pushToGitHub();
    
    // Step 2: 服务器部署
    logStep(2, '服务器部署');
    deployToServer();
    
    // Step 3: 完成
    logStep(3, '部署完成');
    
    log('\n========================================', 'green');
    log('  部署成功!', 'green');
    log('========================================', 'green');
    log(`访问地址: https://aibotdemo.skym178.com`, 'cyan');
    
  } catch (e) {
    logError(`部署失败: ${e.message}`);
    process.exit(1);
  }
}

deploy();
