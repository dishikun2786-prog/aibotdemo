/**
 * @file db.js
 * @module utils/db
 * @description MySQL 连接池与查询封装
 */
const mysql = require('mysql2/promise');
const config = require('../config/database');

let pool = null;

/**
 * 获取 MySQL 连接池，懒加载创建
 * @returns {import('mysql2/promise').Pool}
 */
function getPool() {
  if (!pool) {
    const poolConfig = {
      ...config.mysql,
      charset: 'utf8mb4',
      // 确保连接使用正确的字符集
      typeCast: function (field, next) {
        if (field.type === 'VAR_STRING' || field.type === 'STRING' || field.type === 'TEXT' || field.type === 'BLOB') {
          return field.string();
        }
        return next();
      }
    };
    
    pool = mysql.createPool(poolConfig);
    
    // 确保所有连接都设置正确的字符集
    pool.on('connection', (connection) => {
      connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');
      connection.query('SET CHARACTER SET utf8mb4');
    });
  }
  return pool;
}

/**
 * 执行 SQL 查询
 * @param {string} sql - SQL 语句
 * @param {Array} [params=[]] - 参数
 * @returns {Promise<Array>} 查询结果
 * @throws {Error} 查询失败时抛出
 */
async function query(sql, params = []) {
  const pool = getPool();
  try {
    // 使用 execute 方法，它会自动处理字符集
    // 但为了确保字符集正确，我们在执行前设置字符集
    const connection = await pool.getConnection();
    try {
      // 确保连接使用正确的字符集（每次查询前设置，确保可靠性）
      await connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');
      await connection.query('SET CHARACTER SET utf8mb4');
      
      const [results] = await connection.query(sql, params);
      return results;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('MySQL查询错误:', error);
    throw error;
  }
}

/**
 * 执行事务
 * @param {Function} callback - (conn) => Promise，conn 为数据库连接
 * @returns {Promise<*>} callback 的返回值
 * @throws {Error} 事务失败时回滚并抛出
 */
async function transaction(callback) {
  const pool = getPool();
  const conn = await pool.getConnection();
  
  try {
    // 确保连接使用正确的字符集
    await conn.query('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');
    await conn.query('SET CHARACTER SET utf8mb4');
    
    await conn.beginTransaction();
    const result = await callback(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  getPool,
  query,
  transaction
};
