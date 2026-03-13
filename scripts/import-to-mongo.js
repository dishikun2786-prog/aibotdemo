#!/usr/bin/env node
/**
 * 胄空形仙传 章节导入MongoDB脚本
 * 将novel_chapters.json中的章节数据导入到MongoDB
 */

const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

// MongoDB配置
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const MONGO_DB = process.env.MONGODB_DB || 'energy_mountain';
const COLLECTION_NAME = 'novel_chapters';

// 章节数据文件
const CHAPTERS_FILE = path.join(__dirname, '..', 'novel_chapters.json');

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
        const collection = db.collection(COLLECTION_NAME);
        
        // 确认操作
        const existingCount = await collection.countDocuments({});
        console.log(`当前数据库中已有 ${existingCount} 个章节`);
        
        if (existingCount > 0) {
            console.log('\n注意：数据库中已有章节数据');
            console.log('请选择操作：');
            console.log('  1. 清空现有数据并重新导入');
            console.log('  2. 增量导入（跳过已存在的ID）');
            console.log('  3. 取消');
            
            // 这里我们选择清空并重新导入
            console.log('\n执行清空并重新导入...');
            await collection.deleteMany({});
            console.log('已清空现有数据');
        }
        
        // 准备导入数据
        const docs = chaptersData.map(ch => ({
            chapterId: ch.id,
            date: ch.date,
            title: ch.title,
            volume: ch.volume,
            content: ch.content || '',
            page: ch.page,
            createdAt: new Date(),
            updatedAt: new Date()
        }));
        
        // 批量导入
        console.log('\n开始导入章节数据...');
        const result = await collection.insertMany(docs, { ordered: false });
        console.log(`成功导入 ${result.insertedCount} 个章节`);
        
        // 创建索引
        console.log('\n创建索引...');
        await collection.createIndex({ chapterId: 1 }, { unique: true });
        await collection.createIndex({ volume: 1, chapterId: 1 });
        console.log('索引创建完成');
        
        // 显示统计
        const totalChapters = await collection.countDocuments({});
        const volumes = await collection.distinct('volume');
        console.log(`\n=== 导入完成 ===`);
        console.log(`总章节数: ${totalChapters}`);
        console.log(`卷次: ${volumes.join(', ')}`);
        
        // 按卷次统计
        for (const vol of volumes) {
            const count = await collection.countDocuments({ volume: vol });
            console.log(`  - ${vol}: ${count} 章`);
        }
        
    } catch (error) {
        console.error('导入失败:', error.message);
        throw error;
    } finally {
        await client.close();
        console.log('\nMongoDB连接已关闭');
    }
}

// 直接执行导入
importChapters()
    .then(() => {
        console.log('\n导入任务完成');
        process.exit(0);
    })
    .catch(err => {
        console.error('\n导入任务失败:', err);
        process.exit(1);
    });
