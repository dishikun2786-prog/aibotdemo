/**
 * @file init-payment-tables.js
 * @description 支付商户功能数据库初始化脚本
 * 使用方法: node server/scripts/init-payment-tables.js
 */

require('dotenv').config();
const db = require('../utils/db');

/**
 * 创建支付商户相关表
 */
async function createTables() {
  console.log('开始创建支付商户数据库表...');

  try {
    // 1. 商户信息表
    await db.execute(`
      CREATE TABLE IF NOT EXISTS payment_merchants (
        id INT(11) PRIMARY KEY AUTO_INCREMENT,
        user_id INT(11) NOT NULL UNIQUE COMMENT '用户ID',
        merchant_name VARCHAR(50) COMMENT '商户名称(显示名)',
        alipay_qrcode VARCHAR(500) COMMENT '支付宝收款码URL',
        wechat_qrcode VARCHAR(500) COMMENT '微信收款码URL',
        bank_account VARCHAR(50) COMMENT '银行卡号',
        bank_name VARCHAR(100) COMMENT '银行名称',
        bank_username VARCHAR(50) COMMENT '持卡人姓名',
        api_key VARCHAR(64) NOT NULL UNIQUE COMMENT 'API秘钥(64位随机)',
        api_secret VARCHAR(128) COMMENT 'API密钥(加密存储)',
        status ENUM('active', 'inactive', 'banned') DEFAULT 'active' COMMENT '状态',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_api_key (api_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[OK] payment_merchants 表创建完成');

    // 2. 收款名目表
    await db.execute(`
      CREATE TABLE IF NOT EXISTS payment_items (
        id INT(11) PRIMARY KEY AUTO_INCREMENT,
        merchant_id INT(11) NOT NULL COMMENT '商户ID',
        item_name VARCHAR(100) NOT NULL COMMENT '收款名目名称',
        item_description VARCHAR(500) COMMENT '说明文字',
        images TEXT COMMENT '图片JSON数组',
        video_url VARCHAR(500) COMMENT '介绍视频URL',
        video_cover VARCHAR(500) COMMENT '视频封面图',
        payment_mode ENUM('fixed', 'flexible') DEFAULT 'flexible' COMMENT '收款模式: fixed固定金额, flexible随意金额',
        default_amount DECIMAL(10,2) DEFAULT 0.00 COMMENT '固定金额(固定模式必填)',
        min_amount DECIMAL(10,2) DEFAULT 0.01 COMMENT '最小金额(随意模式)',
        max_amount DECIMAL(10,2) DEFAULT 99999.99 COMMENT '最大金额(随意模式)',
        enable_custom_amount TINYINT(1) DEFAULT 1 COMMENT '允许自定义金额(仅随意模式有效)',
        payment_note VARCHAR(200) COMMENT '付款备注提示',
        status ENUM('active', 'inactive') DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_merchant_id (merchant_id),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[OK] payment_items 表创建完成');

    // 更新已存在的表：添加 payment_mode 字段
    try {
      await db.execute(`
        ALTER TABLE payment_items 
        ADD COLUMN payment_mode ENUM('fixed', 'flexible') DEFAULT 'flexible' COMMENT '收款模式: fixed固定金额, flexible随意金额'
        AFTER video_cover
      `);
      console.log('[OK] payment_items 表添加 payment_mode 字段完成');
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log('[OK] payment_mode 字段已存在，跳过');
      } else {
        console.log('[INFO] payment_mode 字段添加跳过:', err.message);
      }
    }

    // 3. 收款订单表
    await db.execute(`
      CREATE TABLE IF NOT EXISTS payment_orders (
        id INT(11) PRIMARY KEY AUTO_INCREMENT,
        order_no VARCHAR(32) NOT NULL UNIQUE COMMENT '订单号',
        item_id INT(11) NOT NULL COMMENT '收款名目ID',
        merchant_id INT(11) NOT NULL COMMENT '商户ID',
        payer_id INT(11) COMMENT '付款方用户ID(游客为空)',
        payer_username VARCHAR(50) COMMENT '付款方用户名',
        payer_phone VARCHAR(20) COMMENT '付款方手机号',
        amount DECIMAL(10,2) NOT NULL COMMENT '收款金额',
        original_amount DECIMAL(10,2) COMMENT '原始金额(自定义)',
        payment_method ENUM('alipay', 'wechat', 'bank') COMMENT '支付方式',
        remark_code VARCHAR(20) COMMENT '备注码(用于核实)',
        status ENUM('pending', 'paid', 'confirmed', 'cancelled', 'expired') DEFAULT 'pending' COMMENT '状态',
        payment_screenshot VARCHAR(500) COMMENT '付款截图URL',
        payer_note VARCHAR(200) COMMENT '付款方备注',
        merchant_note VARCHAR(200) COMMENT '商户备注',
        confirmed_by INT(11) COMMENT '确认人ID',
        confirmed_at DATETIME COMMENT '确认时间',
        cancelled_by INT(11) COMMENT '取消人ID',
        cancelled_at DATETIME COMMENT '取消时间',
        cancelled_reason VARCHAR(200) COMMENT '取消原因',
        expired_at DATETIME COMMENT '过期时间',
        paid_at DATETIME COMMENT '付款时间',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_merchant_id (merchant_id),
        INDEX idx_order_no (order_no),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at),
        INDEX idx_payer_id (payer_id),
        INDEX idx_item_id (item_id),
        INDEX idx_remark_code (remark_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[OK] payment_orders 表创建完成');

    // 检查并添加备注码索引（如果表已存在）
    try {
      await db.execute(`
        ALTER TABLE payment_orders ADD INDEX IF NOT EXISTS idx_remark_code (remark_code)
      `);
      console.log('[OK] remark_code 索引添加完成');
    } catch (err) {
      // 忽略索引已存在的错误
      if (!err.message.includes('Duplicate')) {
        console.log('[INFO] remark_code 索引可能已存在，跳过');
      }
    }

    // 4. 支付配置表
    await db.execute(`
      CREATE TABLE IF NOT EXISTS payment_config (
        id INT(11) PRIMARY KEY AUTO_INCREMENT,
        config_key VARCHAR(50) NOT NULL UNIQUE COMMENT '配置键',
        config_value TEXT COMMENT '配置值',
        description VARCHAR(200) COMMENT '说明',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[OK] payment_config 表创建完成');

    // 插入默认配置
    await db.execute(`
      INSERT IGNORE INTO payment_config (config_key, config_value, description) VALUES
      ('order_expire_hours', '24', '订单过期时间(小时)'),
      ('max_upload_size', '5242880', '最大上传文件大小(字节)'),
      ('screenshot_required', 'true', '是否必须上传付款截图')
    `);
    console.log('[OK] 默认配置插入完成');

    console.log('\n=== 所有支付商户数据库表创建完成 ===');

  } catch (error) {
    console.error('创建数据库表失败:', error);
    throw error;
  }
}

// 执行
(async () => {
  try {
    await createTables();
    process.exit(0);
  } catch (error) {
    console.error('初始化失败:', error);
    process.exit(1);
  }
})();
