#!/usr/bin/env node
/**
 * 华夏五千年 章节导入MongoDB脚本
 * 将 huaxia5000.json 中的章节数据导入到 MongoDB
 */

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

// MongoDB配置
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const MONGO_DB = process.env.MONGODB_DB || 'energy_mountain';

// 章节数据文件 - 放在项目根目录
const CHAPTERS_FILE = path.join(__dirname, '..', 'huaxia5000.json');

// 书籍信息
const BOOK_INFO = {
  bookId: 'huaxia5000',
  title: '华夏五千年',
  subtitle: '人间修行录',
  author: '清风',
  cover: '',
  description: '记录华夏五千年修行文明发展历程',
  status: 'published'
};

async function importChapters() {
  // 读取章节数据
  console.log('读取章节数据文件...');
  const chaptersData = JSON.parse(fs.readFileSync(CHAPTERS_FILE, 'utf8'));
  console.log(`读取到 ${chaptersData.length} 个章节`);
  
  // 连接MongoDB
  console.log('\n连接MongoDB...');
  const client = new MongoClient(MONGO_URI);
  
  try {
    await client.connect();
    console.log('MongoDB连接成功');
    
    const db = client.db(MONGO_DB);
    const chaptersColl = db.collection('novel_chapters');
    const booksColl = db.collection('novel_books');
    
    // 检查现有数据
    const existingCount = await chaptersColl.countDocuments({ bookId: BOOK_INFO.bookId });
    console.log(`当前数据库中 huaxia5000 已有 ${existingCount} 个章节`);
    
    // 删除旧数据（如果存在）
    if (existingCount > 0) {
      console.log('\n删除旧数据...');
      await chaptersColl.deleteMany({ bookId: BOOK_INFO.bookId });
      await booksColl.deleteOne({ bookId: BOOK_INFO.bookId });
    }
    
    // 重建索引 - 先删除旧索引
    console.log('重建索引...');
    try { await chaptersColl.dropIndex('chapterId_1'); } catch(e) {}
    try { await chaptersColl.dropIndex('bookId_1_chapterId_1'); } catch(e) {}
    try { await chaptersColl.dropIndex('bookId_1_volume_1_chapterId_1'); } catch(e) {}
    
    await chaptersColl.createIndex({ bookId: 1, chapterId: 1 }, { unique: true });
    await chaptersColl.createIndex({ bookId: 1, volume: 1, chapterId: 1 });
    console.log('索引创建完成');
    
    // 插入书籍信息
    await booksColl.insertOne({
      ...BOOK_INFO,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    console.log('书籍信息已保存');
    
    // 准备导入数据
    const docs = chaptersData.map(ch => ({
      chapterId: ch.id,
      date: ch.date,
      title: ch.title,
      volume: ch.volume,
      content: ch.content || '',
      bookId: BOOK_INFO.bookId,
      createdAt: new Date(),
      updatedAt: new Date()
    }));
    
    // 批量导入
    console.log('\n开始导入章节数据...');
    const batchSize = 30;
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize);
      await chaptersColl.insertMany(batch, { ordered: false });
      console.log(`已导入 ${Math.min(i + batchSize, docs.length)}/${docs.length}`);
    }
    
    // 统计
    const totalChapters = await chaptersColl.countDocuments({ bookId: BOOK_INFO.bookId });
    const volumes = await chaptersColl.distinct('volume', { bookId: BOOK_INFO.bookId });
    
    console.log(`\n=== 导入完成 ===`);
    console.log(`小说: ${BOOK_INFO.title}`);
    console.log(`总章节数: ${totalChapters}`);
    console.log(`卷次: ${volumes.join(', ')}`);
    
    // 按卷次统计
    for (const vol of volumes) {
      const count = await chaptersColl.countDocuments({ bookId: BOOK_INFO.bookId, volume: vol });
      console.log(`  - ${vol}: ${count} 章`);
    }
    
    console.log(`\n访问地址: /novel/index.html?book=huaxia5000`);
    
  } catch (error) {
    console.error('导入失败:', error.message);
    throw error;
  } finally {
    await client.close();
    console.log('\nMongoDB连接已关闭');
  }
}

// 执行导入
importChapters()
  .then(() => {
    console.log('\n导入任务完成');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n导入任务失败:', err);
    process.exit(1);
  });
