// 迁移脚本：添加用户头像字段
// 运行方式: node docs/migrations/run_add_user_avatar.js

const db = require('../server/utils/db');

async function runMigration() {
    try {
        console.log('开始迁移: 添加用户头像字段...');
        
        // 检查字段是否已存在
        const [columns] = await db.execute('DESCRIBE users');
        const hasAvatarField = columns.some(col => col.Field === 'avatar_image');
        
        if (hasAvatarField) {
            console.log('字段 avatar_image 已存在，跳过迁移');
            return;
        }
        
        // 添加字段
        await db.execute(
            'ALTER TABLE users ADD COLUMN avatar_image VARCHAR(255) DEFAULT NULL COMMENT \'用户头像图片路径\' AFTER current_skin_id'
        );
        
        console.log('迁移完成: avatar_image 字段已添加');
    } catch (error) {
        console.error('迁移失败:', error.message);
    } finally {
        process.exit(0);
    }
}

runMigration();
