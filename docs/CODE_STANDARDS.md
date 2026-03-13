# 代码规范文档

## 1. 概述

本文档定义了能量山项目的代码规范，旨在保持代码风格一致性和可维护性。

## 2. 命名规范

### 2.1 变量和函数

- **变量名**：使用小驼峰命名（camelCase）
  ```javascript
  const userName = 'admin';
  const maxPlayers = 100;
  ```

- **函数名**：使用小驼峰命名，动词开头
  ```javascript
  function getUserById(id) {}
  async function handlePKRejection() {}
  ```

- **常量**：使用大写下划线分隔（UPPER_SNAKE_CASE）
  ```javascript
  const MAX_RETRY_COUNT = 3;
  const DEFAULT_PORT = 3000;
  ```

- **私有变量/函数**：使用下划线前缀（可选）
  ```javascript
  const _internalCache = {};
  function _validateInput() {}
  ```

### 2.2 文件和目录

- **文件名**：使用小写字母和连字符（kebab-case）
  - 示例：`auth.js`, `database.js`, `backup-database.js`

- **目录名**：使用小写字母和连字符
  - 示例：`server/routes/`, `database/migrations/`

### 2.3 类和构造函数

- 使用大驼峰命名（PascalCase）
  ```javascript
  class UserService {}
  function DatabaseConnection() {}
  ```

## 3. 注释规范

### 3.1 文件头注释

每个文件开头应包含JSDoc格式的文件说明：

```javascript
/**
 * @file app.js
 * @module app
 * @description Express 主服务入口，挂载路由、中间件，初始化 Socket.io
 */
```

### 3.2 函数注释

使用JSDoc格式注释函数：

```javascript
/**
 * 执行 SQL 查询
 * @param {string} sql - SQL 语句
 * @param {Array} [params=[]] - 参数
 * @returns {Promise<Array>} 查询结果
 * @throws {Error} 查询失败时抛出
 */
async function query(sql, params = []) {
  // ...
}
```

### 3.3 行内注释

- 使用 `//` 进行单行注释
- 注释应解释"为什么"而非"是什么"
- 复杂逻辑必须添加注释

```javascript
// 检查挑战状态是否存在（避免重复处理）
const challengeState = await redis.get(challengeKey);
```

## 4. 代码结构规范

### 4.1 模块导入顺序

1. Node.js 内置模块
2. 第三方模块
3. 项目内部模块

```javascript
// 1. Node.js 内置模块
const http = require('http');
const path = require('path');

// 2. 第三方模块
const express = require('express');
const mysql = require('mysql2/promise');

// 3. 项目内部模块
const config = require('./config/database');
const db = require('./utils/db');
```

### 4.2 代码组织

- 变量声明在顶部
- 函数定义按逻辑分组
- 导出语句在文件末尾

```javascript
// 1. 模块导入
const express = require('express');

// 2. 常量定义
const MAX_RETRY = 3;

// 3. 变量声明
let pool = null;

// 4. 函数定义
function getPool() {}

async function query() {}

// 5. 导出
module.exports = { getPool, query };
```

### 4.3 异步处理

- 优先使用 `async/await` 而非 Promise.then()
- 必须处理错误情况

```javascript
// ✅ 推荐
async function getUser(id) {
  try {
    const user = await db.query('SELECT * FROM users WHERE id = ?', [id]);
    return user[0];
  } catch (error) {
    console.error('查询用户失败:', error);
    throw error;
  }
}

// ❌ 不推荐
function getUser(id) {
  return db.query('SELECT * FROM users WHERE id = ?', [id])
    .then(results => results[0])
    .catch(error => {
      console.error('查询用户失败:', error);
      throw error;
    });
}
```

## 5. 格式规范

### 5.1 缩进和空格

- 使用 2 个空格缩进（不使用 Tab）
- 操作符前后加空格
- 对象和数组元素后不加尾随逗号

```javascript
// ✅ 正确
const config = {
  host: 'localhost',
  port: 3000
};

if (user && user.isAdmin) {
  // ...
}

// ❌ 错误
const config = {
  host:'localhost',
  port:3000,
};

if(user&&user.isAdmin){
  // ...
}
```

### 5.2 引号

- 字符串使用单引号
- 仅在需要转义时使用双引号

```javascript
// ✅ 正确
const message = 'Hello World';
const json = '{"key": "value"}';

// ❌ 错误
const message = "Hello World";
```

### 5.3 分号

- 语句末尾必须加分号

```javascript
// ✅ 正确
const name = 'admin';
function getUser() {}

// ❌ 错误
const name = 'admin'
function getUser() {}
```

## 6. 错误处理

### 6.1 错误捕获

- 使用 try-catch 处理异步错误
- 记录错误日志
- 向客户端返回友好的错误信息

```javascript
async function handleRequest(req, res) {
  try {
    const result = await processData();
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('处理请求失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
}
```

### 6.2 错误信息

- 生产环境不暴露详细错误信息
- 开发环境可输出详细错误

```javascript
if (process.env.NODE_ENV === 'development') {
  console.error('详细错误:', error);
} else {
  console.error('错误:', error.message);
}
```

## 7. Git 提交规范

### 7.1 提交信息格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

### 7.2 类型（type）

- `feat`: 新功能
- `fix`: 修复bug
- `docs`: 文档更新
- `style`: 代码格式调整（不影响功能）
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建/工具链相关

### 7.3 示例

```
feat(auth): 添加JWT认证功能

实现用户登录后生成JWT token，并在后续请求中验证token有效性。

Closes #123
```

## 8. 代码审查清单

提交代码前请检查：

- [ ] 代码符合命名规范
- [ ] 函数有JSDoc注释
- [ ] 复杂逻辑有注释说明
- [ ] 错误处理完善
- [ ] 没有console.log调试代码（生产代码）
- [ ] 代码通过ESLint检查
- [ ] 代码格式化符合Prettier规范
- [ ] 没有硬编码的敏感信息
- [ ] 异步操作正确处理错误

## 9. 工具配置

项目使用以下工具保证代码质量：

- **ESLint**: 代码检查（`.eslintrc.js`）
- **Prettier**: 代码格式化（`.prettierrc`）
- **EditorConfig**: 编辑器配置（`.editorconfig`）

### 9.1 使用方式

```bash
# 检查代码
npm run lint

# 自动修复
npm run lint:fix

# 格式化代码
npm run format
```

## 10. 特殊约定

### 10.1 数据库查询

- 使用参数化查询防止SQL注入
- 使用事务处理多步操作

```javascript
// ✅ 正确
await db.query('SELECT * FROM users WHERE id = ?', [userId]);

// ❌ 错误（SQL注入风险）
await db.query(`SELECT * FROM users WHERE id = ${userId}`);
```

### 10.2 环境变量

- 使用 `dotenv` 加载环境变量
- 敏感信息不提交到版本库
- 提供 `.env.example` 模板

### 10.3 日志输出

- 使用 `console.log` 输出普通信息
- 使用 `console.error` 输出错误信息
- 生产环境考虑使用日志库（如winston）

## 11. 参考资源

- [JavaScript Standard Style](https://standardjs.com/)
- [JSDoc 文档](https://jsdoc.app/)
- [Node.js 最佳实践](https://github.com/goldbergyoni/nodebestpractices)
