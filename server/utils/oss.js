/**
 * @file oss.js
 * @module utils/oss
 * @description 阿里云 OSS 对象存储封装，支持文件上传、删除、URL生成
 */
const OSS = require('ali-oss');
const config = require('../config/database');
const db = require('../utils/db');

let ossClient = null;
let configCache = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 60000; // 配置缓存1分钟

/**
 * 从数据库获取OSS配置
 */
async function getOSSConfig() {
  const now = Date.now();

  // 使用缓存
  if (configCache && (now - configCacheTime) < CONFIG_CACHE_TTL) {
    return configCache;
  }

  try {
    // 从game_config表读取OSS配置
    const configKeys = [
      'oss_access_key_id',
      'oss_access_key_secret',
      'oss_bucket',
      'oss_region',
      'oss_endpoint',
      'oss_accelerate_domain',
      'oss_bucket_domain',
      'oss_use_accelerate',
      'oss_cname_domain'
    ];

    const results = await db.query(
      'SELECT config_key, config_value FROM game_config WHERE config_key IN (?)',
      [configKeys]
    );

    const ossConfig = {};
    results.forEach(row => {
      ossConfig[row.config_key] = row.config_value;
    });

    configCache = ossConfig;
    configCacheTime = now;

    return ossConfig;
  } catch (error) {
    console.error('从数据库获取OSS配置失败:', error.message);
    // 返回默认值
    return {};
  }
}

/**
 * 清除OSS配置缓存
 */
function clearConfigCache() {
  configCache = null;
  configCacheTime = 0;
}

/**
 * 获取 OSS 客户端实例（单例模式）
 * @returns {OSS} OSS 客户端
 */
async function getOSSClient() {
  if (!ossClient) {
    // 优先从数据库获取配置，如果没有则使用配置文件
    let ossConfig = {};
    try {
      ossConfig = await getOSSConfig();
    } catch (err) {
      console.error('获取OSS配置失败，使用默认配置:', err.message);
    }

    const dbConfig = config.oss || {};

    ossClient = new OSS({
      region: ossConfig.oss_region || dbConfig.region || 'oss-cn-shenzhen',
      accessKeyId: ossConfig.oss_access_key_id || dbConfig.accessKeyId || process.env.OSS_ACCESS_KEY_ID || '',
      accessKeySecret: ossConfig.oss_access_key_secret || dbConfig.accessKeySecret || process.env.OSS_ACCESS_KEY_SECRET || '',
      bucket: ossConfig.oss_bucket || dbConfig.bucket || 'aibotboke',
      endpoint: ossConfig.oss_endpoint || dbConfig.endpoint || 'oss-cn-shenzhen.aliyuncs.com',
      cname: false,
      secure: true,
      timeout: 60000
    });

    console.log('OSS客户端初始化完成，Bucket:', ossConfig.oss_bucket || dbConfig.bucket || 'aibotboke');
  }
  return ossClient;
}

/**
 * 同步获取OSS客户端（不读取数据库，用于测试）
 */
function getOSSClientSync(ossConfig, useCname = false) {
  return new OSS({
    region: ossConfig.region || 'oss-cn-shenzhen',
    accessKeyId: ossConfig.accessKeyId,
    accessKeySecret: ossConfig.accessKeySecret,
    bucket: ossConfig.bucket,
    endpoint: ossConfig.endpoint || `${ossConfig.region || 'oss-cn-shenzhen'}.aliyuncs.com`,
    cname: useCname,
    secure: true,
    timeout: 10000
  });
}

/**
 * 上传文件到 OSS
 * @param {string} objectName - OSS存储对象名称（如 'podcast-audio/xxx.mp3'）
 * @param {string} localFilePath - 本地文件路径
 * @returns {Promise<Object>} 上传结果
 */
async function uploadFile(objectName, localFilePath) {
  try {
    const client = await getOSSClient();
    const fs = require('fs');
    const stats = fs.statSync(localFilePath);
    const fileSize = stats.size;

    // 大文件使用更长的超时时间（文件大小/1MB * 10秒，最少60秒，最多10分钟）
    let timeout = Math.max(60000, Math.min(fileSize / (1024 * 1024) * 10000, 600000));

    const result = await client.put(objectName, localFilePath, {
      timeout: Math.round(timeout)
    });
    console.log('OSS文件上传成功:', objectName, '超时设置:', Math.round(timeout/1000) + '秒');
    return result;
  } catch (error) {
    console.error('OSS文件上传失败:', error.message);
    throw error;
  }
}

/**
 * 上传 Buffer 数据到 OSS
 * @param {string} objectName - OSS存储对象名称
 * @param {Buffer} buffer - 数据 Buffer
 * @param {Object} options - 上传选项（如 Content-Type）
 * @returns {Promise<Object>} 上传结果
 */
async function uploadBuffer(objectName, buffer, options = {}) {
  try {
    const client = await getOSSClient();
    const result = await client.put(objectName, buffer, options);
    console.log('OSS Buffer上传成功:', objectName);
    return result;
  } catch (error) {
    console.error('OSS Buffer上传失败:', error.message);
    throw error;
  }
}

/**
 * 删除 OSS 文件
 * @param {string} objectName - OSS存储对象名称
 * @returns {Promise<Object>} 删除结果
 */
async function deleteFile(objectName) {
  try {
    const client = await getOSSClient();
    const result = await client.delete(objectName);
    console.log('OSS文件删除成功:', objectName);
    return result;
  } catch (error) {
    console.error('OSS文件删除失败:', error.message);
    throw error;
  }
}

/**
 * 获取文件公开访问 URL
 * @param {string} objectName - OSS存储对象名称
 * @param {number} expires - URL过期时间（秒），默认31536000（1年）
 * @returns {string} 文件访问URL
 */
function getFileUrl(objectName, expires = 31536000) {
  const configOSS = config.oss || {};

  // 优先使用加速域名
  const accelerateDomain = configOSS.accelerateDomain || 'https://boke.skym178.com';
  const bucketDomain = configOSS.bucketDomain || 'https://aibotboke.oss-cn-shenzhen.aliyuncs.com';

  // 如果配置了加速域名，使用加速域名
  if (configOSS.useAccelerateDomain !== false) {
    return `${accelerateDomain}/${objectName}`;
  }

  // 否则使用签名URL（私有 bucket）
  // 注意：getOSSClient 是异步的，这里简化处理，直接返回加速域名URL
  return `${accelerateDomain}/${objectName}`;
}

/**
 * 获取文件访问URL（带签名，解决防盗链问题）
 * @param {string} objectName - OSS存储对象名称
 * @param {number} expires - 过期时间（秒），默认1小时
 * @returns {Promise<string>} 文件访问URL
 */
async function getPublicUrl(objectName, expires = 3600) {
  // 从数据库异步获取OSS配置（带缓存）
  const ossConfigFromDB = await getOSSConfig();

  const configOSS = config.oss || {};
  const ossConfig = {
    region: ossConfigFromDB.oss_region || configOSS.region || 'oss-cn-shenzhen',
    accessKeyId: ossConfigFromDB.oss_access_key_id || configOSS.accessKeyId || '',
    accessKeySecret: ossConfigFromDB.oss_access_key_secret || configOSS.accessKeySecret || '',
    bucket: ossConfigFromDB.oss_bucket || configOSS.bucket || 'aibotboke'
  };

  // 获取自定义域名/加速域名
  let customDomain = ossConfigFromDB.oss_cname_domain || configOSS.cnameDomain || '';
  if (!customDomain) {
    customDomain = ossConfigFromDB.oss_accelerate_domain || configOSS.accelerateDomain || 'boke.skym178.com';
  }
  // 移除协议前缀
  customDomain = customDomain.replace(/^https?:\/\//, '');

  // 检查凭证是否有效
  if (!ossConfig.accessKeyId || !ossConfig.accessKeySecret) {
    console.error('OSS配置无效: 缺少accessKeyId或accessKeySecret');
    return null;
  }

  // 检查是否使用自定义域名/加速域名
  const useCname = !!(customDomain && customDomain !== '' && customDomain !== 'boke.skym178.com' && customDomain !== 'https://boke.skym178.com');

  // 使用同步客户端生成签名URL
  const client = getOSSClientSync(ossConfig, useCname);
  const signedUrl = client.signatureUrl(objectName, { expires: expires });

  // 替换域名：使用bucket名称进行替换
  const bucketName = ossConfig.bucket;
  const url = signedUrl.replace(`https://${bucketName}.oss-cn-shenzhen.aliyuncs.com`, `https://${customDomain}`);

  return url;
}

/**
 * 检查文件是否存在
 * @param {string} objectName - OSS存储对象名称
 * @returns {Promise<boolean>} 文件是否存在
 */
async function fileExists(objectName) {
  try {
    const client = await getOSSClient();
    await client.head(objectName);
    return true;
  } catch (error) {
    if (error.code === 'NoSuchKey' || error.status === 404) {
      return false;
    }
    console.error('检查文件是否存在失败:', error.message);
    return false;
  }
}

/**
 * 批量删除文件
 * @param {string[]} objectNames - OSS存储对象名称数组
 * @returns {Promise<Object>} 删除结果
 */
async function deleteFiles(objectNames) {
  try {
    const client = await getOSSClient();
    const result = await client.deleteMulti(objectNames);
    console.log('OSS批量文件删除成功:', objectNames.length, '个文件');
    return result;
  } catch (error) {
    console.error('OSS批量文件删除失败:', error.message);
    throw error;
  }
}

/**
 * 列出目录下的文件
 * @param {string} prefix - 文件前缀（如 'podcast-audio/'）
 * @param {number} maxKeys - 最大数量，默认100
 * @returns {Promise<Array>} 文件列表
 */
async function listFiles(prefix, maxKeys = 100) {
  try {
    const client = await getOSSClient();
    const result = await client.list({
      prefix: prefix,
      maxKeys: maxKeys
    });
    return result.objects || [];
  } catch (error) {
    console.error('列出OSS文件失败:', error.message);
    throw error;
  }
}

/**
 * 重置 OSS 客户端（用于配置更新后重新初始化）
 */
function resetClient() {
  ossClient = null;
  console.log('OSS客户端已重置');
}

/**
 * 初始化分片上传
 * @param {string} objectName - OSS存储对象名称
 * @returns {Promise<Object>} 上传ID和基本信息
 */
async function createMultipartUpload(objectName) {
  try {
    console.log('[createMultipartUpload] 开始获取OSS客户端...');
    const client = await getOSSClient();
    console.log('[createMultipartUpload] OSS客户端获取成功, 开始初始化分片上传, objectName:', objectName);
    console.log('[createMultipartUpload] client类型:', typeof client);
    
    // ali-oss 6.x 使用 initMultipartUpload 而不是 initiateMultipartUpload
    const result = await client.initMultipartUpload(objectName);
    console.log('分片上传初始化成功:', result.uploadId);
    return {
      uploadId: result.uploadId,
      objectName: objectName
    };
  } catch (error) {
    console.error('分片上传初始化失败:', error.message);
    console.error('分片上传初始化失败详情:', error);
    throw error;
  }
}

/**
 * 上传单个分片
 * @param {string} objectName - OSS存储对象名称
 * @param {string} uploadId - 分片上传ID
 * @param {number} partNumber - 分片编号
 * @param {string} localFilePath - 本地文件路径
 * @returns {Promise<Object>} 上传结果（包含ETag）
 */
async function uploadPart(objectName, uploadId, partNumber, localFilePath) {
  try {
    const client = await getOSSClient();
    const result = await client.uploadPart(objectName, uploadId, partNumber, localFilePath);
    return {
      partNumber: partNumber,
      etag: result.etag
    };
  } catch (error) {
    console.error('分片上传失败 (part ' + partNumber + '):', error.message);
    throw error;
  }
}

/**
 * 完成分片上传
 * @param {string} objectName - OSS存储对象名称
 * @param {string} uploadId - 分片上传ID
 * @param {Array} parts - 分片列表 [{partNumber, etag}, ...]
 * @returns {Promise<Object>} 完成结果
 */
async function completeMultipartUpload(objectName, uploadId, parts) {
  try {
    const client = await getOSSClient();
    const result = await client.completeMultipartUpload(objectName, uploadId, parts);
    console.log('分片上传完成:', objectName);
    return result;
  } catch (error) {
    console.error('分片上传完成失败:', error.message);
    throw error;
  }
}

/**
 * 取消分片上传
 * @param {string} objectName - OSS存储对象名称
 * @param {string} uploadId - 分片上传ID
 * @returns {Promise<Object>} 取消结果
 */
async function abortMultipartUpload(objectName, uploadId) {
  try {
    const client = await getOSSClient();
    const result = await client.abortMultipartUpload(objectName, uploadId);
    console.log('分片上传已取消:', uploadId);
    return result;
  } catch (error) {
    console.error('取消分片上传失败:', error.message);
    throw error;
  }
}

/**
 * 获取上传文件的预签名URL（用于客户端直传）
 * @param {string} objectName - OSS存储对象名称
 * @param {number} expires - 过期时间（秒），默认3600
 * @returns {Promise<string>} 预签名URL
 */
async function getUploadUrl(objectName, expires = 3600) {
  try {
    const client = await getOSSClient();
    // ali-oss 6.x 使用 signatureUrl
    const url = await client.signatureUrl(objectName, {
      expires: expires,
      method: 'PUT',
      'content-type': 'audio/mpeg'
    });
    return url;
  } catch (error) {
    console.error('获取预签名URL失败:', error.message);
    throw error;
  }
}

/**
 * 获取单个分片的预签名URL（用于客户端直传）
 * @param {string} objectName - OSS存储对象名称
 * @param {string} uploadId - 分片上传ID
 * @param {number} partNumber - 分片编号
 * @param {number} expires - 过期时间（秒），默认3600
 * @param {string} contentType - 文件的Content-Type，默认 audio/mpeg
 * @returns {Promise<Object>} 包含签名URL和必要信息
 */
async function getPartUrl(objectName, uploadId, partNumber, expires = 3600, contentType = 'audio/mpeg') {
  try {
    const client = await getOSSClient();

    // 从配置中获取 endpoint（而不是从 client.options，因为那里可能是对象）
    const ossConfig = await getOSSConfig();
    const dbConfig = config.oss || {};
    const endpoint = ossConfig.oss_endpoint || dbConfig.endpoint || 'oss-cn-shenzhen.aliyuncs.com';
    const bucket = ossConfig.oss_bucket || dbConfig.bucket || 'aibotboke';

    // 构建分片上传的URL
    // 格式: https://{bucket}.{endpoint}/{objectName}?partNumber={partNumber}&uploadId={uploadId}
    // 对于公共读存储桶，不需要签名
    const url = `https://${bucket}.${endpoint}/${objectName}?partNumber=${partNumber}&uploadId=${uploadId}`;

    console.log('[getPartUrl] 生成分片上传URL:', url);

    return {
      url: url,
      partNumber: partNumber,
      uploadId: uploadId
    };
  } catch (error) {
    console.error('获取分片预签名URL失败:', error.message);
    console.error('获取分片预签名URL失败详情:', error);
    throw error;
  }
}

/**
 * 获取STS临时访问凭证（用于浏览器直传）
 * @param {number} durationSeconds - 凭证有效期（秒），默认3600
 * @returns {Promise<Object>} 临时凭证对象
 */
async function getSTSToken(durationSeconds = 3600) {
  try {
    const client = await getOSSClient();
    const ossConfig = await getOSSConfig();
    const dbConfig = config.oss || {};

    // 获取RoleArn（需要先在阿里云RAM控制台创建角色并获取ARN）
    // 格式: acs:ram::${accountId}:role/${roleName}
    const roleArn = dbConfig.stsRoleArn || process.env.OSS_STS_ROLE_ARN;

    // 如果没有配置STS RoleArn，使用长期AK作为临时方案
    if (!roleArn) {
      console.warn('[getSTSToken] 未配置STS RoleArn，使用长期AK（生产环境建议配置STS）');

      const accessKeyId = ossConfig.oss_access_key_id || dbConfig.accessKeyId || process.env.OSS_ACCESS_KEY_ID;
      const accessKeySecret = ossConfig.oss_access_key_secret || dbConfig.accessKeySecret || process.env.OSS_ACCESS_KEY_SECRET;

      // 传输加速域名
      const accelerateDomain = 'oss-accelerate.aliyuncs.com';
      // 地区标识（只需要 cn-shenzhen，不需要 oss- 前缀）
      const region = (ossConfig.oss_region || dbConfig.region || 'cn-shenzhen').replace('oss-', '');
      
      return {
        accessKeyId: accessKeyId,
        accessKeySecret: accessKeySecret,
        stsToken: null,  // 无需STS Token
        expiration: new Date(Date.now() + durationSeconds * 1000).toISOString(),
        region: region,
        bucket: ossConfig.oss_bucket || dbConfig.bucket || 'aibotboke',
        useLongTermKey: true,  // 标记使用了长期AK
        accelerateDomain: accelerateDomain,
        useAccelerate: ossConfig.oss_use_accelerate === 'true' || dbConfig.useAccelerate === true
      };
    }

    // 使用OSS客户端的STS功能生成临时凭证
    const sts = new OSS.STS({
      accessKeyId: ossConfig.oss_access_key_id || dbConfig.accessKeyId || process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: ossConfig.oss_access_key_secret || dbConfig.accessKeySecret || process.env.OSS_ACCESS_KEY_SECRET
    });

    // 生成临时访问凭证
    const result = await sts.assumeRole(
      roleArn,
      '',  // policy: 可选，用于限制临时凭证的权限
      durationSeconds,  // 凭证有效期
      'browser-upload-session'  // sessionName: 会话名称
    );

    console.log('[getSTSToken] STS临时凭证获取成功');

    return {
      accessKeyId: result.credentials.AccessKeyId,
      accessKeySecret: result.credentials.AccessKeySecret,
      stsToken: result.credentials.SecurityToken,
      expiration: result.credentials.Expiration,
      region: ossConfig.oss_region || dbConfig.region || 'oss-cn-shenzhen',
      bucket: ossConfig.oss_bucket || dbConfig.bucket || 'aibotboke',
      useLongTermKey: false
    };
  } catch (error) {
    console.error('获取STS临时凭证失败:', error.message);
    throw error;
  }
}

module.exports = {
  getOSSClient,
  getOSSConfig,
  clearConfigCache,
  getOSSClientSync,
  uploadFile,
  uploadBuffer,
  deleteFile,
  getFileUrl,
  getPublicUrl,
  fileExists,
  deleteFiles,
  // 新增：OSS原生分片上传
  createMultipartUpload,
  uploadPart,
  completeMultipartUpload,
  abortMultipartUpload,
  // 获取预签名上传URL
  getUploadUrl,
  getPartUrl,
  // 新增：STS临时凭证
  getSTSToken,
  listFiles,
  resetClient
};
