/**
 * @file redis.js
 * @module utils/redis
 * @description Redis 客户端封装，支持 set/get/del，失败时降级不抛错
 */
const redis = require('redis');
const config = require('../config/database');

let client = null;

async function getClient() {
  if (!client) {
    client = redis.createClient({
      socket: {
        host: config.redis.host,
        port: config.redis.port,
        reconnectStrategy: (retries) => {
          if (retries > 3) {
            console.error('Redis连接失败，超过最大重试次数');
            return false; // 停止重试
          }
          return Math.min(retries * 100, 3000); // 最多等待3秒
        }
      },
      password: config.redis.password || undefined,
      database: config.redis.db
    });

    client.on('error', (err) => {
      console.error('Redis客户端错误:', err);
    });

    try {
      await client.connect();
      console.log('Redis连接成功');
    } catch (error) {
      console.error('Redis连接失败:', error.message);
      // 不抛出错误，允许服务器在没有Redis的情况下运行
      client = null; // 连接失败时设置为null，避免后续调用崩溃
    }
  }
  if (client && !client.isOpen) {
    client = null; // 如果连接已关闭，设置为null
    return await getClient(); // 递归重新创建
  }
  return client;
}

/**
 * 设置键值，字符串直接存，对象自动 JSON 序列化
 * @param {string} key - 键
 * @param {string|Object} value - 值
 * @param {number|null} [expireSeconds=null] - 过期秒数
 * @returns {Promise<string|null>} OK 或 null（Redis 未连接）
 */
async function set(key, value, expireSeconds = null) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) {
      return null; // Redis未连接，返回null
    }
    // 如果值是字符串，直接存储；否则序列化为JSON
    const storedValue = typeof value === 'string' ? value : JSON.stringify(value);
    if (expireSeconds) {
      return await client.setEx(key, expireSeconds, storedValue);
    }
    return await client.set(key, storedValue);
  } catch (error) {
    console.error('Redis set错误:', error.message);
    return null;
  }
}

/**
 * 获取值，自动尝试 JSON 解析
 * @param {string} key - 键
 * @returns {Promise<string|Object|null>} 值或 null
 */
async function get(key) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) {
      return null; // Redis未连接，返回null
    }
    const value = await client.get(key);
    if (!value) return null;
    // 尝试解析JSON，如果失败则返回原始字符串
    try {
      return JSON.parse(value);
    } catch (e) {
      return value;
    }
  } catch (error) {
    console.error('Redis get错误:', error.message);
    return null;
  }
}

/**
 * 删除键
 * @param {string} key - 键
 * @returns {Promise<number>} 删除数量
 */
async function del(key) {
  try {
    // 参数校验：忽略无效参数
    if (!key || typeof key !== 'string') {
      return 0;
    }
    const client = await getClient();
    if (!client || !client.isOpen) {
      return 0; // Redis未连接，返回0
    }
    return await client.del(key);
  } catch (error) {
    console.error('Redis del错误:', error.message);
    return 0;
  }
}

// 检查键是否存在
async function exists(key) {
  const client = await getClient();
  return await client.exists(key);
}

// 递增计数器
async function incr(key) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) {
      return null;
    }
    return await client.incr(key);
  } catch (error) {
    console.error('Redis incr错误:', error.message);
    return null;
  }
}

// 设置过期时间
async function expire(key, seconds) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) {
      return false;
    }
    return await client.expire(key, seconds);
  } catch (error) {
    console.error('Redis expire错误:', error.message);
    return false;
  }
}

/**
 * 获取键的剩余生存时间（秒）
 * @param {string} key - 键名
 * @returns {Promise<number>} 剩余生存时间（-1表示永不过期，-2表示键不存在）
 */
async function ttl(key) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) {
      return -2;
    }
    return await client.ttl(key);
  } catch (error) {
    console.error('Redis ttl错误:', error.message);
    return -2;
  }
}

// 获取所有匹配的键
async function keys(pattern) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) {
      return []; // Redis未连接，返回空数组
    }
    return await client.keys(pattern);
  } catch (error) {
    console.error('Redis keys错误:', error.message);
    return [];
  }
}

/**
 * 使用 SCAN 安全遍历匹配 pattern 的键（推荐替代 keys）
 * @param {string} pattern - 匹配模式，如 'pk_challenge:*'
 * @param {number} [count=100] - 每次扫描的键数量
 * @returns {Promise<string[]>} 所有匹配的键数组
 */
async function scan(pattern, count = 100) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) {
      return [];
    }
    const keys = [];
    let cursor = 0;
    do {
      let result;
      try {
        result = await client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
      } catch (scanErr) {
        console.error('Redis client.scan 错误:', scanErr.message);
        break;
      }
      // 安全检查 result 格式
      if (!result || typeof result !== 'object' || !Array.isArray(result)) {
        break;
      }
      if (result.length < 2) {
        break;
      }
      cursor = typeof result[0] === 'number' ? result[0] : 0;
      const batch = result[1];
      if (batch && Array.isArray(batch) && batch.length > 0) {
        for (const key of batch) {
          if (key && typeof key.toString === 'function') {
            keys.push(key.toString());
          }
        }
      }
    } while (cursor !== 0);
    return keys;
  } catch (error) {
    console.error('Redis scan错误:', error.message);
    return [];
  }
}

/**
 * Redis Stream: 追加一条消息
 * @param {string} streamKey - 流键名，如 'pk:settlement'
 * @param {Object} payload - 消息体（将序列化为 data 字段）
 * @param {number|null} [maxLen=null] - 可选，流最大长度，超过则淘汰旧消息
 * @returns {Promise<string|null>} 消息 ID 或 null（未连接/失败）
 */
async function xAdd(streamKey, payload, maxLen = null) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return null;
    const message = { data: typeof payload === 'string' ? payload : JSON.stringify(payload) };
    const options = maxLen != null && maxLen > 0 ? { TRIM: { strategy: 'MAXLEN', threshold: maxLen } } : undefined;
    return await client.xAdd(streamKey, '*', message, options);
  } catch (error) {
    console.error('Redis xAdd错误:', error.message);
    return null;
  }
}

/**
 * Redis Stream: 从流中读取消息
 * @param {string} streamKey - 流键名
 * @param {string} lastId - 从该 ID 之后读取，'0' 表示从最早开始
 * @param {number} [count=10] - 最多返回条数
 * @returns {Promise<Array<{id: string, data: Object}>>} 消息列表，每项 { id, data }
 */
async function xRead(streamKey, lastId = '0', count = 10) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return [];
    const result = await client.xRead({ key: streamKey, id: lastId }, { COUNT: count });
    if (!result) return [];
    const streams = Array.isArray(result) ? result : [result];
    const out = [];
    for (const stream of streams) {
      const name = stream?.name ?? streamKey;
      const messages = stream?.messages ?? [];
      for (const msg of messages) {
        let data = null;
        try {
          const raw = msg?.message?.data ?? msg?.message;
          data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) {
          data = msg?.message?.data ?? msg?.message;
        }
        out.push({ id: msg?.id ?? '', data, streamKey: name });
      }
    }
    return out;
  } catch (error) {
    console.error('Redis xRead错误:', error.message);
    return [];
  }
}

/**
 * Redis Hash: 设置hash字段
 */
async function hSet(key, field, value) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return null;
    const val = typeof value === 'string' ? value : JSON.stringify(value);
    return await client.hSet(key, field, val);
  } catch (error) {
    console.error('Redis hSet错误:', error.message);
    return null;
  }
}

/**
 * Redis Hash: 获取hash字段
 */
async function hGet(key, field) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return null;
    const value = await client.hGet(key, field);
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (e) {
      return value;
    }
  } catch (error) {
    console.error('Redis hGet错误:', error.message);
    return null;
  }
}

/**
 * Redis Hash: 获取所有hash字段
 */
async function hGetAll(key) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return {};
    const value = await client.hGetAll(key);
    if (!value) return {};
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      try {
        result[k] = JSON.parse(v);
      } catch (e) {
        result[k] = v;
      }
    }
    return result;
  } catch (error) {
    console.error('Redis hGetAll错误:', error.message);
    return {};
  }
}

/**
 * Redis Hash: 删除hash字段
 */
async function hDel(key, ...fields) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return 0;
    return await client.hDel(key, ...fields);
  } catch (error) {
    console.error('Redis hDel错误:', error.message);
    return 0;
  }
}

/**
 * Redis List: 左侧弹出
 */
async function lPop(key) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return null;
    return await client.lPop(key);
  } catch (error) {
    console.error('Redis lPop错误:', error.message);
    return null;
  }
}

/**
 * Redis List: 左侧推送
 */
async function lPush(key, value) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return 0;
    const val = typeof value === 'string' ? value : JSON.stringify(value);
    return await client.lPush(key, val);
  } catch (error) {
    console.error('Redis lPush错误:', error.message);
    return 0;
  }
}

/**
 * Redis List: 获取列表范围
 */
async function lRange(key, start, stop) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return [];
    const values = await client.lRange(key, start, stop);
    return values.map(v => {
      try {
        return JSON.parse(v);
      } catch (e) {
        return v;
      }
    });
  } catch (error) {
    console.error('Redis lRange错误:', error.message);
    return [];
  }
}

/**
 * Redis List: 裁剪列表
 */
async function lTrim(key, start, stop) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return false;
    return await client.lTrim(key, start, stop);
  } catch (error) {
    console.error('Redis lTrim错误:', error.message);
    return false;
  }
}

/**
 * Redis Sorted Set: 添加成员
 */
async function zAdd(key, score, member) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return 0;
    const val = typeof member === 'string' ? member : JSON.stringify(member);
    return await client.zAdd(key, { score, value: val });
  } catch (error) {
    console.error('Redis zAdd错误:', error.message);
    return 0;
  }
}

/**
 * Redis Sorted Set: 获取成员数量
 */
async function zCard(key) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return 0;
    return await client.zCard(key);
  } catch (error) {
    console.error('Redis zCard错误:', error.message);
    return 0;
  }
}

/**
 * Redis Sorted Set: 按分数范围获取成员
 */
async function zRangeByScore(key, min, max) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return [];
    const values = await client.zRangeByScore(key, min, max);
    return values.map(v => {
      try {
        return JSON.parse(v);
      } catch (e) {
        return v;
      }
    });
  } catch (error) {
    console.error('Redis zRangeByScore错误:', error.message);
    return [];
  }
}

/**
 * Redis Sorted Set: 移除成员
 */
async function zRem(key, ...members) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return 0;
    const vals = members.map(m => typeof m === 'string' ? m : JSON.stringify(m));
    return await client.zRem(key, ...vals);
  } catch (error) {
    console.error('Redis zRem错误:', error.message);
    return 0;
  }
}

/**
 * Redis Sorted Set: 递增成员分数
 */
async function zIncrBy(key, increment, member) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return 0;
    const val = typeof member === 'string' ? member : JSON.stringify(member);
    return await client.zIncrBy(key, increment, val);
  } catch (error) {
    console.error('Redis zIncrBy错误:', error.message);
    return 0;
  }
}

/**
 * Redis Sorted Set: 按分数降序获取成员（不包含分数）
 */
async function zRevRange(key, start, stop) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return [];
    // 使用 zRange 方法 + REV 选项
    const values = await client.zRange(key, start, stop, { REV: true });
    return values.map(v => {
      try {
        return JSON.parse(v);
      } catch (e) {
        return v;
      }
    });
  } catch (error) {
    console.error('Redis zRevRange错误:', error.message);
    return [];
  }
}

/**
 * Redis Sorted Set: 按分数降序获取成员（包含分数）
 */
async function zRevRangeWithScores(key, start, stop) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) {
      console.error('Redis zRevRangeWithScores错误: client未连接或未打开');
      return [];
    }
    // 使用 zRangeWithScores 方法 + REV 选项
    const results = await client.zRangeWithScores(key, start, stop, { REV: true });
    return results.map(item => ({
      value: item.value,
      score: item.score
    }));
  } catch (error) {
    console.error('Redis zRevRangeWithScores错误:', error.message);
    console.error('Redis zRevRangeWithScores堆栈:', error.stack);
    return [];
  }
}

/**
 * Redis Sorted Set: 获取成员分数
 */
async function zScore(key, member) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return null;
    const val = typeof member === 'string' ? member : JSON.stringify(member);
    const score = await client.zScore(key, val);
    return score;
  } catch (error) {
    console.error('Redis zScore错误:', error.message);
    return null;
  }
}

/**
 * Redis Sorted Set: 获取成员排名（分数降序，0开始）
 */
async function zRevRank(key, member) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) return null;
    const val = typeof member === 'string' ? member : JSON.stringify(member);
    const rank = await client.zRevRank(key, val);
    return rank;
  } catch (error) {
    console.error('Redis zRevRank错误:', error.message);
    return null;
  }
}

/**
 * 分布式锁：获取锁
 * @param {string} lockKey - 锁的key
 * @param {string} lockValue - 锁的值（通常是请求ID）
 * @param {number} expireSeconds - 锁过期时间（秒）
 * @returns {Promise<boolean>} 是否获取成功
 */
async function acquireLock(lockKey, lockValue, expireSeconds = 10) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) {
      console.error('Redis acquireLock错误: client未连接');
      return false;
    }
    // 使用SET NX EX命令
    const result = await client.set(lockKey, lockValue, {
      NX: true,
      EX: expireSeconds
    });
    return result === 'OK';
  } catch (error) {
    console.error('Redis acquireLock错误:', error.message);
    return false;
  }
}

/**
 * 分布式锁：释放锁
 * @param {string} lockKey - 锁的key
 * @param {string} lockValue - 锁的值（用于验证是否是持有者）
 * @returns {Promise<boolean>} 是否释放成功
 */
async function releaseLock(lockKey, lockValue) {
  try {
    const client = await getClient();
    if (!client || !client.isOpen) {
      return false;
    }
    // 简单方式：先检查值再删除
    const currentValue = await client.get(lockKey);
    if (currentValue === lockValue) {
      await client.del(lockKey);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Redis releaseLock错误:', error.message);
    return false;
  }
}

module.exports = {
  getClient,
  set,
  get,
  del,
  incr,
  exists,
  expire,
  ttl,
  keys,
  scan,
  xAdd,
  xRead,
  // 新增：实时消息同步相关方法
  hSet,
  hGet,
  hGetAll,
  hDel,
  lPush,
  lPop,
  lRange,
  lTrim,
  zAdd,
  zCard,
  zRangeByScore,
  zRem,
  zIncrBy,
  zRevRange,
  zRevRangeWithScores,
  zScore,
  zRevRank,
  // 分布式锁
  acquireLock,
  releaseLock
};
