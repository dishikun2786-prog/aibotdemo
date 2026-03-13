/**
 * @file database.js
 * @module config/database
 * @description 数据库与服务器配置，优先从环境变量加载
 */
module.exports = {
  mysql: {
    host: process.env.MYSQL_HOST || 'localhost',
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'energy_mountain',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || '',
    db: process.env.REDIS_DB || 0
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'energy-mountain-secret-key-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '24h'
  },
  server: {
    port: process.env.PORT || 3000,
    corsOrigin: process.env.CORS_ORIGIN || '*'
  },
  mongo: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
    dbName: process.env.MONGODB_DB || 'energy_mountain'
  },
  oss: {
    region: process.env.OSS_REGION || 'oss-cn-shenzhen',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || '',
    bucket: process.env.OSS_BUCKET || 'aibotboke',
    endpoint: process.env.OSS_ENDPOINT || 'oss-cn-shenzhen.aliyuncs.com',
    accelerateDomain: process.env.OSS_ACCELERATE_DOMAIN || 'https://boke.skym178.com',
    bucketDomain: process.env.OSS_BUCKET_DOMAIN || 'https://aibotboke.oss-cn-shenzhen.aliyuncs.com',
    useAccelerateDomain: process.env.OSS_USE_ACCELERATE !== 'false'
  }
};
