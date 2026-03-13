/**
 * @file import-novel-to-mongo.js
 * @description 将小说数据从 data.js 导入到 MongoDB
 * 使用方法: node server/scripts/import-novel-to-mongo.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 读取 data.js 文件
const dataJsPath = path.join(__dirname, '..', '..', 'public', 'novel', 'js', 'data.js');
const dataJsContent = fs.readFileSync(dataJsPath, 'utf-8');

console.log('读取文件成功，文件大小:', dataJsContent.length, '字符');

// 提取 chapters 定义并执行
// 找到 const chapters = [ 开始位置
const startMarker = 'const chapters = [';
const endMarker = '];';
const startIdx = dataJsContent.indexOf(startMarker);
const endIdx = dataJsContent.indexOf(endMarker, startIdx);

if (startIdx === -1 || endIdx === -1) {
  console.error('无法找到 chapters 数组');
  process.exit(1);
}

const chaptersCode = dataJsContent.substring(startIdx + startMarker.length, endIdx + 1);
console.log('提取到 chapters 代码，长度:', chaptersCode.length);

// 尝试使用 vm 执行
let chapters = null;

try {
  // 创建 sandbox 环境
  const sandbox = { chapters: [] };
  const script = new vm.Script(`chapters = ${chaptersCode}`);
  script.runInNewContext(sandbox, { timeout: 5000 });
  chapters = sandbox.chapters;
  console.log('方法1（vm）解析成功! 章节数:', chapters?.length);
} catch (e) {
  console.log('方法1失败:', e.message);
}

// 备用：使用更简单的正则提取
if (!chapters || chapters.length === 0) {
  console.log('尝试方法2：正则提取...');
  const chaptersData = [];
  // 匹配包含模板字符串的章节
  const regex = /\{\s*id:\s*(\d+),\s*date:\s*"([^"]+)",\s*title:\s*"([^"]+)",\s*volume:\s*"([^"]+)",\s*content:\s*`([\s\S]*?)`\s*\}/g;
  let match;
  let count = 0;

  while ((match = regex.exec(dataJsContent)) !== null && count < 100) {
    chaptersData.push({
      id: parseInt(match[1]),
      date: match[2],
      title: match[3],
      volume: match[4],
      content: match[5]
    });
    count++;
  }

  if (chaptersData.length > 0) {
    chapters = chaptersData;
    console.log('方法2解析成功! 章节数:', chapters.length);
  }
}

if (!chapters || chapters.length === 0) {
  console.error('无法解析章节数据');
  process.exit(1);
}

// 去重并排序
const uniqueChapters = [];
const seen = new Set();
for (const ch of chapters) {
  if (!seen.has(ch.id)) {
    seen.add(ch.id);
    uniqueChapters.push(ch);
  }
}
chapters = uniqueChapters.sort((a, b) => a.id - b.id);

console.log(`\n最终解析结果: ${chapters.length} 个章节`);
console.log('首章:', chapters[0]?.title, '- 内容长度:', chapters[0]?.content?.length || 0);

// 导入到 MongoDB
const { MongoClient } = require('mongodb');
const config = require('../config/database');

async function importToMongo() {
  const client = new MongoClient(config.mongo.uri);

  try {
    await client.connect();
    console.log('\n连接 MongoDB 成功');

    const db = client.db(config.mongo.dbName);
    const collection = db.collection('novel_chapters');

    // 清空并重建
    await collection.deleteMany({});
    await collection.dropIndexes();
    console.log('已清空现有数据');

    // 批量插入
    const docs = chapters.map(ch => ({
      chapterId: ch.id,
      date: ch.date,
      title: ch.title,
      volume: ch.volume,
      content: ch.content || '',
      createdAt: new Date(),
      updatedAt: new Date()
    }));

    const insertResult = await collection.insertMany(docs);
    console.log(`成功导入 ${insertResult.insertedCount} 个章节`);

    // 重建索引
    await collection.createIndex({ chapterId: 1 }, { unique: true });
    await collection.createIndex({ volume: 1, chapterId: 1 });
    console.log('索引创建成功');

    // 验证
    const count = await collection.countDocuments({});
    console.log(`\nMongoDB 中共有 ${count} 个章节`);

    // 验证内容
    const sample = await collection.findOne({ chapterId: 1 });
    if (sample?.content) {
      console.log('首章内容预览:', sample.content.substring(0, 80) + '...');
    }

    // 各卷统计
    const volumeStats = await collection.aggregate([
      { $group: { _id: '$volume', count: { $sum: 1 } } }
    ]).toArray();

    console.log('\n各卷章节数量:');
    volumeStats.forEach(stat => {
      console.log(`  ${stat._id}: ${stat.count} 章`);
    });

    console.log('\n导入完成!');

  } catch (error) {
    console.error('导入失败:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

importToMongo();
