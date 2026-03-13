/**
 * 数据库迁移脚本 - 能量交易担保表
 */
const mysql = require('mysql2/promise');

async function migrate() {
  const connection = await mysql.createConnection({
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '123456',
    database: 'aibot1',
    charset: 'utf8mb4',
    multipleStatements: true
  });

  console.log('已连接到数据库 aibot1');

  const sql = `
-- 能量广告表
CREATE TABLE IF NOT EXISTS energy_ads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL COMMENT '发布者用户ID',
  username VARCHAR(50) NOT NULL COMMENT '发布者用户名',
  avatar VARCHAR(255) DEFAULT '' COMMENT '头像',
  energy_amount INT NOT NULL COMMENT '能量数量',
  price_per_energy DECIMAL(10,2) NOT NULL COMMENT '单价(元/能量)',
  total_price DECIMAL(10,2) NOT NULL COMMENT '总价',
  payment_qr_code VARCHAR(500) NOT NULL COMMENT '收款码图片URL',
  description VARCHAR(500) DEFAULT '' COMMENT '广告描述',
  status ENUM('active', 'sold', 'cancelled', 'expired') DEFAULT 'active' COMMENT '状态',
  view_count INT DEFAULT 0 COMMENT '浏览次数',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  expires_at DATETIME COMMENT '过期时间',
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at),
  INDEX idx_price_per_energy (price_per_energy)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 担保交易表
CREATE TABLE IF NOT EXISTS energy_trades (
  id INT AUTO_INCREMENT PRIMARY KEY,
  trade_no VARCHAR(32) NOT NULL COMMENT '交易编号',
  ad_id INT NOT NULL COMMENT '广告ID',
  seller_id INT NOT NULL COMMENT '卖家ID',
  seller_username VARCHAR(50) NOT NULL COMMENT '卖家用户名',
  buyer_id INT NOT NULL COMMENT '买家ID',
  buyer_username VARCHAR(50) NOT NULL COMMENT '买家用户名',
  energy_amount INT NOT NULL COMMENT '能量数量',
  price DECIMAL(10,2) NOT NULL COMMENT '交易价格',
  status ENUM('pending_payment', 'payment_submitted', 'payment_confirmed', 'energy_released', 'cancelled', 'disputed', 'resolved_seller', 'resolved_buyer', 'refunded') DEFAULT 'pending_payment' COMMENT '交易状态',
  payment_image VARCHAR(500) COMMENT '买家付款凭证图片',
  payment_time DATETIME COMMENT '买家付款时间',
  confirm_time DATETIME COMMENT '卖家确认时间',
  complete_time DATETIME COMMENT '完成时间',
  dispute_reason TEXT COMMENT '纠纷原因',
  dispute_evidence TEXT COMMENT '纠纷证据',
  admin_handle_note TEXT COMMENT '管理员处理备注',
  handled_by INT COMMENT '处理管理员ID',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_trade_no (trade_no),
  INDEX idx_ad_id (ad_id),
  INDEX idx_seller_id (seller_id),
  INDEX idx_buyer_id (buyer_id),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 交易消息表
CREATE TABLE IF NOT EXISTS energy_trade_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  trade_id INT NOT NULL COMMENT '交易ID',
  sender_id INT NOT NULL COMMENT '发送者ID',
  sender_username VARCHAR(50) NOT NULL COMMENT '发送者用户名',
  sender_role ENUM('seller', 'buyer', 'system', 'admin') NOT NULL COMMENT '发送者角色',
  message_type ENUM('text', 'image', 'system') DEFAULT 'text' COMMENT '消息类型',
  content TEXT NOT NULL COMMENT '消息内容',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_trade_id (trade_id),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 纠纷记录表
CREATE TABLE IF NOT EXISTS energy_disputes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  trade_id INT NOT NULL COMMENT '交易ID',
  complainant_id INT NOT NULL COMMENT '申诉方ID',
  complainant_username VARCHAR(50) NOT NULL COMMENT '申诉方用户名',
  dispute_type ENUM('non_payment', 'non_energy_release', 'fake_payment', 'other') NOT NULL COMMENT '纠纷类型',
  description TEXT NOT NULL COMMENT '申诉描述',
  evidence_images TEXT COMMENT '证据图片(JSON数组)',
  status ENUM('pending', 'investigating', 'resolved_seller', 'resolved_buyer', 'rejected') DEFAULT 'pending' COMMENT '处理状态',
  admin_note TEXT COMMENT '管理员处理备注',
  admin_result ENUM('seller_wins', 'buyer_wins', 'cancelled') COMMENT '处理结果',
  handled_by INT COMMENT '处理管理员ID',
  handled_at DATETIME COMMENT '处理时间',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_trade_id (trade_id),
  INDEX idx_complainant_id (complainant_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  try {
    await connection.query(sql);
    console.log('能量交易表创建成功！');

    // 检查frozen_energy字段是否存在，不存在则添加
    try {
      await connection.query('SELECT frozen_energy FROM users LIMIT 1');
      console.log('frozen_energy字段已存在');
    } catch (e) {
      await connection.query('ALTER TABLE users ADD COLUMN frozen_energy INT DEFAULT 0 COMMENT "冻结能量（交易中）" AFTER energy');
      console.log('frozen_energy字段添加成功');
    }
  } catch (err) {
    console.error('迁移失败:', err.message);
  } finally {
    await connection.end();
  }
}

migrate();
