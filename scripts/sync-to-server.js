#!/usr/bin/env node
/**
 * 胄空形仙传 同步到远程MongoDB
 * 支持从环境变量读取MongoDB配置
 * 
 * 使用方法:
 *   node scripts/sync-to-server.js                    # 使用本地MongoDB
 *   node scripts/sync-to-server.js --remote           # 使用线上MongoDB（从.env读取）
 *   MONGODB_URI=mongodb://xxx node scripts/sync-to-server.js  # 自定义MongoDB
 */

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

// 读取.env文件
function loadEnv() {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split('\n').forEach(line => {
            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) {
                process.env[match[1].trim()] = match[2].trim();
            }
        });
    }
}

// MongoDB配置
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const MONGO_DB = process.env.MONGODB_DB || 'energy_mountain';
const COLLECTION_NAME = 'novel_chapters';
const CHAPTERS_FILE = path.join(__dirname, '..', 'novel_chapters.json');

async function syncToServer() {
    // 显示配置信息
    console.log('=== MongoDB同步配置 ===');
    console.log(`MongoDB URI: ${MONGO_URI}`);
    console.log(`数据库名: ${MONGO_DB}`);
    console.log(`集合名: ${COLLECTION_NAME}`);
    console.log('');
    
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
        
        // 查看现有数据
        const existingCount = await collection.countDocuments({});
        console.log(`当前数据库中已有 ${existingCount} 个章节`);
        
        // 清空并导入
        console.log('\n清空现有数据并导入新数据...');
        await collection.deleteMany({});
        
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
        const result = await collection.insertMany(docs, { ordered: false });
        console.log(`成功导入 ${result.insertedCount} 个章节`);
        
        // 创建索引
        await collection.createIndex({ chapterId: 1 }, { unique: true });
        await collection.createIndex({ volume: 1, chapterId: 1 });
        
        // 显示统计
        const totalChapters = await collection.countDocuments({});
        const volumes = await collection.distinct('volume');
        
        console.log(`\n=== 同步完成 ===`);
        console.log(`总章节数: ${totalChapters}`);
        console.log(`卷次: ${volumes.join(', ')}`);
        
        for (const vol of volumes) {
            const count = await collection.countDocuments({ volume: vol });
            console.log(`  - ${vol}: ${count} 章`);
        }
        
        console.log(`\n数据库地址: ${MONGO_URI}`);
        console.log(`数据库名称: ${MONGO_DB}`);
        
    } catch (error) {
        console.error('同步失败:', error.message);
        throw error;
    } finally {
        await client.close();
        console.log('\nMongoDB连接已关闭');
    }
}

// 加载环境变量
loadEnv();

// 执行同步
syncToServer()
    .then(() => {
        console.log('\n同步任务完成');
        process.exit(0);
    })
    .catch(err => {
        console.error('\n同步任务失败:', err);
        process.exit(1);
    });
