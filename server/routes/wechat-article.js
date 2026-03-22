/**
 * 微信公众号文章解析路由
 * 用于采集微信文章标题，内容和图片
 * 使用阿里云百炼AI提取网页内容
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const bailian = require('../utils/bailian');
const oss = require('../utils/oss');

/**
 * POST /api/plaza/parse-wechat-article
 * 解析微信公众号文章链接
 * 需要登录认证
 * 使用百炼AI提取网页内容
 */
router.post('/parse-wechat-article', authenticateToken, async (req, res) => {
  try {
    const { url } = req.body;

    // 验证URL格式
    if (!url || !url.trim()) {
      return res.status(400).json({ success: false, error: '请输入微信公众号文章链接' });
    }

    const urlStr = url.trim();
    if (!urlStr.includes('mp.weixin.qq.com')) {
      return res.status(400).json({ success: false, error: '请输入有效的微信公众号文章链接' });
    }

    console.log('[parse-wechat-article] 开始使用百炼提取:', urlStr);

    // 1. 调用百炼提取文章内容
    const article = await bailian.extractWechatArticle(urlStr);

    // 2. 处理内容中的图片，替换为OSS URL
    // 使用 content_blocks 数组来构建内容，保持图片位置
    const contentBlocks = article.content_blocks || [];
    const processedBlocks = [];
    const imageMapping = {};

    // 优先使用 content_blocks 处理
    if (contentBlocks.length > 0) {
      console.log('[parse-wechat-article] 使用 content_blocks 构建内容');

      for (let i = 0; i < contentBlocks.length; i++) {
        const block = contentBlocks[i];

        if (block.type === 'text') {
          // 文本块直接添加
          processedBlocks.push({ type: 'text', content: block.content || '' });
        } else if (block.type === 'image' && block.url) {
          // 图片块需要上传到 OSS
          const imgUrl = block.url;
          console.log(`[parse-wechat-article] 处理图片 ${processedBlocks.length}:`, imgUrl.substring(0, 50));

          try {
            // 下载图片
            const imgResponse = await axios.get(imgUrl, {
              responseType: 'arraybuffer',
              timeout: 15000,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              }
            });

            // 获取图片类型
            const contentType = imgResponse.headers['content-type'] || 'image/jpeg';
            const extMap = {
              'image/jpeg': '.jpg',
              'image/png': '.png',
              'image/gif': '.gif',
              'image/webp': '.webp'
            };
            const ext = extMap[contentType] || '.jpg';

            // 生成OSS存储路径
            const timestamp = Date.now() + i;
            const random = Math.random().toString(36).substring(2, 8);
            const objectName = `plaza/wechat/${timestamp}_${random}${ext}`;

            // 上传到OSS
            const buffer = Buffer.from(imgResponse.data);
            await oss.uploadBuffer(objectName, buffer, { contentType });

            // 获取公开访问URL（不带签名，直接访问）
            const ossUrl = oss.getFileUrl(objectName);
            imageMapping[imgUrl] = ossUrl;

            // 添加图片块（使用 OSS URL）
            processedBlocks.push({ type: 'image', url: ossUrl, alt: block.alt || '' });
            console.log(`[parse-wechat-article] 图片上传成功:`, ossUrl.substring(0, 50));
          } catch (imgErr) {
            console.error(`[parse-wechat-article] 图片上传失败:`, imgErr.message);
            // 保留原 URL
            processedBlocks.push({ type: 'image', url: imgUrl, alt: block.alt || '' });
          }
        }
      }

      console.log('[parse-wechat-article] 处理后的 blocks 数量:', processedBlocks.length);
    } else if (article.content && article.content.length > 0) {
      // 完全没有 blocks 和 images 时，直接使用原始内容
      console.log('[parse-wechat-article] 无 content_blocks 和 images，使用原始内容');
      processedBlocks.push({ type: 'text', content: article.content });
    } else if (article.images && article.images.length > 0) {
      // 降级处理：没有 content_blocks 时使用原来的方式
      console.log('[parse-wechat-article] 无 content_blocks，使用降级处理');

      for (let i = 0; i < article.images.length; i++) {
        const imgUrl = article.images[i];
        if (!imgUrl) continue;

        try {
          console.log(`[parse-wechat-article] 上传图片 ${i + 1}/${article.images.length}:`, imgUrl.substring(0, 50));

          const imgResponse = await axios.get(imgUrl, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });

          const contentType = imgResponse.headers['content-type'] || 'image/jpeg';
          const extMap = {
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/gif': '.gif',
            'image/webp': '.webp'
          };
          const ext = extMap[contentType] || '.jpg';

          const timestamp = Date.now() + i;
          const random = Math.random().toString(36).substring(2, 8);
          const objectName = `plaza/wechat/${timestamp}_${random}${ext}`;

          const buffer = Buffer.from(imgResponse.data);
          await oss.uploadBuffer(objectName, buffer, { contentType });

          const ossUrl = oss.getFileUrl(objectName);
          imageMapping[imgUrl] = ossUrl;

          console.log(`[parse-wechat-article] 图片上传成功:`, ossUrl.substring(0, 50));
        } catch (imgErr) {
          console.error(`[parse-wechat-article] 图片上传失败:`, imgErr.message);
          imageMapping[imgUrl] = imgUrl;
        }
      }

      // 替换内容中的图片 URL
      let processedContent = article.content || '';
      const entries = Object.entries(imageMapping);
      for (let i = 0; i < entries.length; i++) {
        const originalUrl = entries[i][0];
        const ossUrl = entries[i][1];
        if (originalUrl !== ossUrl) {
          const regex1 = new RegExp(escapeRegExp(originalUrl), 'g');
          processedContent = processedContent.replace(regex1, ossUrl);
          const encodedOriginal = encodeURIComponent(originalUrl);
          const encodedOss = encodeURIComponent(ossUrl);
          const regex2 = new RegExp(escapeRegExp(encodedOriginal), 'g');
          processedContent = processedContent.replace(regex2, encodedOss);
        }
      }

      // 检查并插入图片到内容开头（使用 HTML 格式）
      const hasImageInContent = /<img\s+src=/.test(processedContent);
      if (!hasImageInContent && entries.length > 0) {
        const imagesHtml = entries.map(([originalUrl, ossUrl]) => {
          return `<p><img src="${ossUrl}" alt="" style="max-width:100%;"></p>`;
        }).join('');
        processedContent = imagesHtml + '<p>' + processedContent.replace(/\n/g, '<br>') + '</p>';
      } else {
        // 转换换行符
        processedContent = '<p>' + processedContent.replace(/\n/g, '<br>') + '</p>';
      }

      // 转换为 blocks 格式
      processedBlocks.push({ type: 'text', content: processedContent });
    }

    // 将 blocks 转换为最终的 HTML 内容（前端 wangEditor 需要）
    let finalContent = '';
    for (const block of processedBlocks) {
      if (block.type === 'text' && block.content) {
        // 跳过空文本块
        const text = (block.content || '').trim();
        if (!text) continue;
        // 将换行符转换为 HTML <br> 标签
        finalContent += '<p>' + text.replace(/\n/g, '<br>') + '</p>';
      } else if (block.type === 'image' && block.url) {
        finalContent += `<p><img src="${block.url}" alt="" style="max-width:100%;"></p>`;
      }
    }
    finalContent = finalContent.trim();

    console.log('[parse-wechat-article] 提取成功, 标题:', article.title);
    console.log('[parse-wechat-article] 处理后内容长度:', finalContent.length);
    console.log('[parse-wechat-article] 处理后内容预览:', finalContent.substring(0, 500));

    res.json({
      success: true,
      data: {
        title: article.title,
        author: article.author,
        content: finalContent,
        summary: article.summary,
        originalUrl: urlStr
      }
    });

  } catch (err) {
    console.error('[parse-wechat-article] 提取失败:', err.message);

    // 检查是否是百炼API Key未配置
    if (err.message && err.message.includes('API Key')) {
      return res.status(503).json({
        success: false,
        error: '百炼API未配置，请联系管理员配置'
      });
    }

    res.status(500).json({
      success: false,
      error: '提取失败: ' + (err.message || '未知错误')
    });
  }
});

/**
 * GET /api/plaza/parse-wechat-article/status
 * 检查百炼配置状态
 */
router.get('/parse-wechat-article/status', async (req, res) => {
  try {
    const result = await bailian.testConnection();
    res.json({
      success: result.success,
      data: {
        configured: result.apiKeyConfigured || false,
        message: result.success ? '百炼API已配置' : (result.errors?.[0] || '百炼API未配置')
      }
    });
  } catch (err) {
    res.json({
      success: false,
      data: {
        configured: false,
        message: err.message
      }
    });
  }
});

// 转义正则特殊字符
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;
