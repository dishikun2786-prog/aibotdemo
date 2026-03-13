/**
 * @file captcha.js
 * @module utils/captcha
 * @description 验证码生成与校验，SVG 渲染，Redis 存储
 */
const crypto = require('crypto');
const redis = require('./redis');

/**
 * 生成随机验证码字符串
 * @param {number} [length=4] - 长度
 * @returns {string}
 */
function generateCode(length = 4) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * 生成验证码 SVG 图片并存入 Redis
 * @returns {Promise<{id: string, image: string}>}
 */
async function generateCaptcha() {
  const code = generateCode(4);
  const width = 120;
  const height = 40;
  
  // 生成SVG字符串
  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
  
  // 背景
  svg += `<rect width="${width}" height="${height}" fill="#050505"/>`;
  
  // 绘制网格线
  svg += `<g stroke="rgba(0, 243, 255, 0.1)" stroke-width="1">`;
  for (let i = 0; i < width; i += 10) {
    svg += `<line x1="${i}" y1="0" x2="${i}" y2="${height}"/>`;
  }
  for (let i = 0; i < height; i += 10) {
    svg += `<line x1="0" y1="${i}" x2="${width}" y2="${i}"/>`;
  }
  svg += `</g>`;
  
  // 绘制验证码文字
  for (let i = 0; i < code.length; i++) {
    const x = (width / (code.length + 1)) * (i + 1);
    const y = height / 2;
    const offsetX = (Math.random() - 0.5) * 2;
    const offsetY = (Math.random() - 0.5) * 2;
    const rotation = (Math.random() - 0.5) * 15; // 随机旋转-15到15度
    
    // 发光效果（使用滤镜）
    svg += `<defs>
      <filter id="glow${i}">
        <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
        <feMerge>
          <feMergeNode in="coloredBlur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>`;
    
    svg += `<text x="${x + offsetX}" y="${y + offsetY}" 
      font-family="'Share Tech Mono', monospace" 
      font-size="24" 
      font-weight="bold" 
      fill="#00f3ff" 
      text-anchor="middle" 
      dominant-baseline="middle"
      filter="url(#glow${i})"
      transform="rotate(${rotation} ${x + offsetX} ${y + offsetY})">${code[i]}</text>`;
  }
  
  // 添加干扰线
  for (let i = 0; i < 5; i++) {
    const opacity = Math.random() * 0.3;
    const x1 = Math.random() * width;
    const y1 = Math.random() * height;
    const x2 = Math.random() * width;
    const y2 = Math.random() * height;
    svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" 
      stroke="rgba(0, 243, 255, ${opacity})" stroke-width="1"/>`;
  }
  
  svg += `</svg>`;
  
  // 转换为Base64
  const base64 = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  
  // 生成唯一ID并存储到Redis（5分钟过期）
  const captchaId = crypto.randomBytes(16).toString('hex');
  await redis.set(`captcha:${captchaId}`, code.toLowerCase(), 300);
  
  return {
    id: captchaId,
    image: base64
  };
}

/**
 * 验证验证码，验证后删除 Redis 中的记录
 * @param {string} captchaId - 验证码 ID
 * @param {string} code - 用户输入
 * @returns {Promise<boolean>}
 */
async function verifyCaptcha(captchaId, code) {
  if (!captchaId || !code) {
    return false;
  }
  
  const storedCode = await redis.get(`captcha:${captchaId}`);
  if (!storedCode) {
    return false;
  }
  
  // 验证后删除
  await redis.del(`captcha:${captchaId}`);
  
  return storedCode === code.toLowerCase();
}

module.exports = {
  generateCaptcha,
  verifyCaptcha
};
