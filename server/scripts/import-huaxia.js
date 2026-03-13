/**
 * @file import-huaxia.js
 * @description 将《华夏五千年》从txt文件导入到MongoDB
 * 使用方法: node import-huaxia.js
 */

const fs = require('fs');
const path = require('path');

const SOURCE_FILE = path.join(__dirname, '..', '..', 'huaxia5000.txt');

const BOOK_INFO = {
  bookId: 'huaxia5000',
  title: '华夏五千年',
  subtitle: '人间修行录',
  author: '清风',
  cover: '',
  description: '记录华夏五千年修行文明发展历程',
  status: 'published'
};

const { MongoClient } = require('mongodb');
const config = require('../config/database');

/**
 * 解析txt文件
 */
function parseNovelFile(filePath) {
  console.log('正在读取文件:', filePath);

  let content;
  for (const encoding of ['utf-8', 'gbk', 'gb2312']) {
    try {
      content = fs.readFileSync(filePath, encoding);
      console.log(`使用编码 ${encoding} 读取成功, 文件大小:`, content.length, '字符');
      break;
    } catch (e) {
      console.log(`编码 ${encoding} 失败`);
    }
  }

  if (!content) throw new Error('无法读取文件');

  const lines = content.split(/\r?\n/);
  const chapters = [];
  
  // 目录信息：id -> {date, title}
  const toc = new Map();
  let inToc = false;
  let tocStartLine = 0;
  
  console.log('开始解析文件，共', lines.length, '行');

  // ============ 第一遍：解析目录 ============
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // 检测目录开始
    if (line.includes('目') && line.includes('录')) {
      inToc = true;
      tocStartLine = i;
      console.log('目录开始于第', i + 1, '行');
      continue;
    }
    
    if (!inToc) continue;
    
    // 目录结束（检测到第4页）
    if (line.match(/^--- 第 4 页 ---$/)) {
      inToc = false;
      console.log('目录结束于第', i + 1, '行');
      break;
    }
    
    // 解析目录中的日期+标题
    const dateMatch = line.match(/^(\d{4}\.\d{2}\.\d{2}(?:-\d{4}\.\d{2}\.\d{2})?)$/);
    if (dateMatch) {
      // 下一行是标题
      const nextLine = lines[i + 1]?.trim();
      if (nextLine && !nextLine.match(/^\d{4}\./) && nextLine.length > 0) {
        const id = toc.size + 1;
        toc.set(id, {
          date: dateMatch[1],
          title: nextLine
        });
      }
    }
  }

  console.log('解析目录完成:', toc.size, '条记录');
  console.log('目录预览:', Array.from(toc.values()).slice(0, 5));

  // ============ 第二遍：解析正文 ============
  let inContent = false;
  let chapterId = 0;
  let currentChapter = null;
  let currentContent = [];
  let contentStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // 正文开始
    if (line.match(/^--- 第 4 页 ---$/)) {
      inContent = true;
      contentStartLine = i;
      console.log('正文开始于第', i + 1, '行');
      continue;
    }
    
    if (!inContent) continue;
    
    // 检测章节号（单独的数字）
    const chMatch = line.match(/^(\d+)$/);
    if (chMatch) {
      // 保存上一章
      if (currentChapter) {
        currentChapter.content = currentContent.join('\n\n').trim();
        if (currentChapter.content) {
          chapters.push(currentChapter);
        }
      }
      
      chapterId = parseInt(chMatch[1]);
      const tocInfo = toc.get(chapterId);
      
      currentChapter = {
        id: chapterId,
        date: tocInfo?.date || getCurrentDate(),
        title: tocInfo?.title || `第${chapterId}章`,
        volume: '第一卷',
        content: ''
      };
      currentContent = [];
      continue;
    }
    
    // 收集正文
    if (currentChapter) {
      // 跳过空行和日期行
      if (line && !line.match(/^\d{4}\./)) {
        currentContent.push(line);
      }
    }
  }

  // 保存最后一章
  if (currentChapter) {
    currentChapter.content = currentContent.join('\n\n').trim();
    if (currentChapter.content) {
      chapters.push(currentChapter);
    }
  }

  console.log('\n解析结果:', chapters.length, '章');
  return chapters;
}

function getCurrentDate() {
  const now = new Date();
  return `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * 导入到 MongoDB
 */
async function importToMongo(chapters) {
  console.log('\n连接 MongoDB...');
  const client = new MongoClient(config.mongo.uri);

  try {
    await client.connect();
    console.log('连接成功');

    const db = client.db(config.mongo.dbName);
    const booksColl = db.collection('novel_books');
    const chaptersColl = db.collection('novel_chapters');

    // 删除旧数据
    await chaptersColl.deleteMany({ bookId: BOOK_INFO.bookId });
    await booksColl.deleteOne({ bookId: BOOK_INFO.bookId });
    
    // 删除旧索引
    try { await chaptersColl.dropIndex('chapterId_1'); } catch(e) {}
    
    // 创建索引
    await chaptersColl.createIndex({ bookId: 1, chapterId: 1 }, { unique: true });
    await chaptersColl.createIndex({ bookId: 1, volume: 1, chapterId: 1 });
    console.log('索引已重建');

    // 插入小说信息
    await booksColl.insertOne({
      ...BOOK_INFO,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    console.log('小说信息已保存');

    // 批量插入章节
    let inserted = 0;
    const batchSize = 30;
    for (let i = 0; i < chapters.length; i += batchSize) {
      const batch = chapters.slice(i, i + batchSize);
      const docs = batch.map(ch => ({
        chapterId: ch.id,
        date: ch.date,
        title: ch.title,
        volume: ch.volume,
        content: ch.content,
        bookId: BOOK_INFO.bookId,
        createdAt: new Date(),
        updatedAt: new Date()
      }));
      
      await chaptersColl.insertMany(docs, { ordered: false });
      inserted += docs.length;
      console.log(`已导入 ${inserted}/${chapters.length}`);
    }

    console.log(`\n成功导入 ${inserted} 个章节`);
    console.log(`访问: /novel/index.html?book=${BOOK_INFO.bookId}`);

  } catch (error) {
    console.error('导入失败:', error.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

async function main() {
  console.log('=== 华夏五千年 导入脚本 ===\n');

  if (!fs.existsSync(SOURCE_FILE)) {
    console.error('错误: 找不到文件', SOURCE_FILE);
    process.exit(1);
  }

  const chapters = parseNovelFile(SOURCE_FILE);
  console.log(`\n最终解析: ${chapters.length} 章`);

  if (chapters.length === 0) {
    console.error('错误: 未解析到章节');
    process.exit(1);
  }

  console.log('\n前20章:');
  chapters.slice(0, 20).forEach((ch, i) => {
    console.log(`  ${i+1}. ${ch.title} (${ch.date}) - ${ch.content.length}字`);
  });

  await importToMongo(chapters);
}

main();
