/**
 * @file init-payment-accounts.js
 * @description 支付商户多账户功能数据库迁移脚本
 * 使用方法: node server/scripts/init-payment-accounts.js
 */

require('dotenv').config();
const db = require('../utils/db');

/**
 * 创建支付账户表
 */
async function createPaymentAccountsTable() {
  console.log('开始创建支付账户表...');

  try {
    // 创建 payment_accounts 表
    await db.execute(`
      CREATE TABLE IF NOT EXISTS payment_accounts (
        id INT(11) PRIMARY KEY AUTO_INCREMENT,
        merchant_id INT(11) NOT NULL COMMENT '商户ID',
        account_type ENUM('alipay', 'wechat', 'bank') NOT NULL COMMENT '账户类型',
        account_name VARCHAR(50) COMMENT '账户名称/备注',
        qrcode_url VARCHAR(500) COMMENT '收款码URL(支付宝/微信)',
        bank_account VARCHAR(50) COMMENT '银行卡号',
        bank_name VARCHAR(100) COMMENT '银行名称',
        bank_username VARCHAR(50) COMMENT '持卡人姓名',
        bank_branch VARCHAR(100) COMMENT '支行名称',
        is_enabled TINYINT(1) DEFAULT 1 COMMENT '是否启用',
        sort_order INT(11) DEFAULT 0 COMMENT '排序(越小越靠前)',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_merchant_id (merchant_id),
        INDEX idx_account_type (account_type),
        INDEX idx_is_enabled (is_enabled),
        INDEX idx_sort_order (sort_order)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[OK] payment_accounts 表创建完成');

    // 检查并迁移旧账户数据（如果有旧数据）
    await migrateOldAccounts();

    // 添加 account_id 字段到 payment_orders 表
    try {
      await db.execute(`
        ALTER TABLE payment_orders
        ADD COLUMN account_id INT(11) DEFAULT NULL COMMENT '收款账户ID'
        AFTER payment_method
      `);
      console.log('[OK] payment_orders 表添加 account_id 字段完成');
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log('[OK] account_id 字段已存在，跳过');
      } else {
        console.log('[INFO] account_id 字段添加跳过:', err.message);
      }
    }

    console.log('\n=== 支付账户表创建完成 ===');

  } catch (error) {
    console.error('创建支付账户表失败:', error);
    throw error;
  }
}

/**
 * 迁移旧商户数据到新表
 */
async function migrateOldAccounts() {
  console.log('[INFO] 检查是否需要迁移旧账户数据...');

  try {
    // 检查旧商户是否有收款码但新表没有数据
    const merchants = await db.query(`
      SELECT pm.* FROM payment_merchants pm
      LEFT JOIN payment_accounts pa ON pm.id = pa.merchant_id
      WHERE pa.id IS NULL
      AND (pm.alipay_qrcode IS NOT NULL OR pm.wechat_qrcode IS NOT NULL OR pm.bank_account IS NOT NULL)
    `);

    if (merchants.length > 0) {
      console.log(`[INFO] 发现 ${merchants.length} 个旧商户需要迁移...);

      for (const merchant of merchants) {
        // 迁移支付宝
        if (merchant.alipay_qrcode) {
          await db.query(`
            INSERT INTO payment_accounts (merchant_id, account_type, account_name, qrcode_url, is_enabled, sort_order)
            VALUES (?, 'alipay', '默认支付宝', ?, 1, 1)
          `, [merchant.id, merchant.alipay_qrcode]);
          console.log(`[OK] 商户 ${merchant.id} 支付宝账户已迁移`);
        }

        // 迁移微信
        if (merchant.wechat_qrcode) {
          await db.query(`
            INSERT INTO payment_accounts (merchant_id, account_type, account_name, qrcode_url, is_enabled, sort_order)
            VALUES (?, 'wechat', '默认微信', ?, 1, 2)
          `, [merchant.id, merchant.wechat_qrcode]);
          console.log(`[OK] 商户 ${merchant.id} 微信账户已迁移`);
        }

        // 迁移银行
        if (merchant.bank_account) {
          await db.query(`
            INSERT INTO payment_accounts (merchant_id, account_type, account_name, bank_account, bank_name, bank_username, is_enabled, sort_order)
            VALUES (?, 'bank', '默认银行卡', ?, ?, ?, 1, 3)
          `, [merchant.id, merchant.bank_account, merchant.bank_name || '', merchant.bank_username || '']);
          console.log(`[OK] 商户 ${merchant.id} 银行账户已迁移`);
        }
      }

      console.log('[OK] 旧账户数据迁移完成');
    } else {
      console.log('[INFO] 无旧账户需要迁移');
    }

  } catch (err) {
    console.error('[WARN] 迁移旧账户数据时出错:', err.message);
    // 不中断流程，继续执行
  }
}

// 执行
(async () => {
  try {
    await createPaymentAccountsTable();
    process.exit(0);
  } catch (error) {
    console.error('初始化失败:', error);
    process.exit(1);
  }
})();
