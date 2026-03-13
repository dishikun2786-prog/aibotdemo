#!/usr/bin/env node
/**
 * 华夏五千年 数据清理与导入脚本
 * 清理旧数据 (huaxia5000) 并导入新数据 (huaxia_wushinian)
 */

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

// MongoDB配置
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const MONGO_DB = process.env.MONGODB_DB || 'energy_mountain';

// 数据文件
const DATA_FILE = path.join(__dirname, 'huaxia_wushinian.json');

// 新的书籍信息
const BOOK_INFO = {
  bookId: 'huaxia_wushinian',
  title: '华夏五千年',
  subtitle: '人间修行录',
  author: '清风',
  cover: '',
  description: '记录华夏五千年修行文明发展历程，从远古神话到近现代，包含修行觉醒、神话传说、历史人物、天地大战等丰富内容',
  status: 'published',
  category: '修行文明'
};

async function clearAndImport() {
  console.log('========== 华夏五千年 数据清理与导入 ==========\n');
  
  // 读取数据
  console.log('读取数据文件...');
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  console.log(`读取到 ${data.length} 篇文章\n`);
  
  // 连接MongoDB
  console.log('连接MongoDB...');
  const client = new MongoClient(MONGO_URI);
  
  try {
    await client.connect();
    console.log('MongoDB连接成功\n');
    
    const db = client.db(MONGO_DB);
    const chaptersColl = db.collection('novel_chapters');
    const booksColl = db.collection('novel_books');
    
    // 显示当前数据情况
    console.log('--- 当前数据情况 ---');
    const allBooks = await booksColl.find({}).project({ bookId: 1, title: 1 }).toArray();
    for (const book of allBooks) {
      const count = await chaptersColl.countDocuments({ bookId: book.bookId });
      console.log(`  书籍: ${book.title} (${book.bookId}) - ${count} 章`);
    }
    console.log('');
    
    // 清理旧数据
    console.log('--- 清理旧数据 ---');
    
    // 清理 huaxia5000
    const oldCount1 = await chaptersColl.countDocuments({ bookId: 'huaxia5000' });
    if (oldCount1 > 0) {
      await chaptersColl.deleteMany({ bookId: 'huaxia5000' });
      await booksColl.deleteOne({ bookId: 'huaxia5000' });
      console.log(`已删除 huaxia5000: ${oldCount1} 章`);
    }
    
    // 清理 huaxia_wushinian (如果存在)
    const oldCount2 = await chaptersColl.countDocuments({ bookId: 'huaxia_wushinian' });
    if (oldCount2 > 0) {
      await chaptersColl.deleteMany({ bookId: 'huaxia_wushinian' });
      await booksColl.deleteOne({ bookId: 'huaxia_wushinian' });
      console.log(`已删除 huaxia_wushinian: ${oldCount2} 章`);
    }
    
    console.log('旧数据清理完成\n');
    
    // 重建索引
    console.log('--- 重建索引 ---');
    try { await chaptersColl.dropIndex('chapterId_1'); } catch(e) {}
    try { await chaptersColl.dropIndex('bookId_1_chapterId_1'); } catch(e) {}
    try { await chaptersColl.dropIndex('bookId_1_volume_1_chapterId_1'); } catch(e) {}
    try { await chaptersColl.dropIndex('bookId_1_category_1'); } catch(e) {}
    
    await chaptersColl.createIndex({ bookId: 1, chapterId: 1 }, { unique: true });
    await chaptersColl.createIndex({ bookId: 1, volume: 1, chapterId: 1 });
    await chaptersColl.createIndex({ bookId: 1, category: 1 });
    console.log('索引创建完成\n');
    
    // 插入书籍信息
    await booksColl.insertOne({
      ...BOOK_INFO,
      totalChapters: data.length,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    console.log('书籍信息已保存\n');
    
    // 准备导入数据
    const docs = data.map((article, index) => ({
      chapterId: index + 1,
      chapterIndex: index + 1,
      date: article.date,
      title: article.title,
      volume: article.category,
      category: article.category,
      content: article.content || '',
      summary: article.summary || '',
      wordCount: article.wordCount || 0,
      tags: article.tags || [],
      page: article.page || 0,
      bookId: BOOK_INFO.bookId,
      createdAt: new Date(),
      updatedAt: new Date()
    }));
    
    // 批量导入
    console.log('--- 导入数据 ---');
    const batchSize = 30;
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize);
      await chaptersColl.insertMany(batch, { ordered: false });
      console.log(`已导入 ${Math.min(i + batchSize, docs.length)}/${docs.length}`);
    }
    
    // 最终统计
    console.log('\n========== 导入完成 ==========');
    const totalChapters = await chaptersColl.countDocuments({ bookId: BOOK_INFO.bookId });
    const categories = await chaptersColl.distinct('category', { bookId: BOOK_INFO.bookId });
    
    console.log(`小说: ${BOOK_INFO.title}`);
    console.log(`总章节数: ${totalChapters}`);
    console.log(`\n分类统计:`);
    for (const cat of categories) {
      const count = await chaptersColl.countDocuments({ bookId: BOOK_INFO.bookId, category: cat });
      console.log(`  - ${cat}: ${count} 篇`);
    }
    
    console.log(`\n访问地址: /novel/index.html?book=huaxia_wushinian`);
    
  } catch (error) {
    console.error('\n导入失败:', error.message);
    throw error;
  } finally {
    await client.close();
    console.log('\nMongoDB连接已关闭');
  }
}

// 执行
clearAndImport()
  .then(() => {
    console.log('\n任务完成');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n任务失败:', err);
    process.exit(1);
  });
