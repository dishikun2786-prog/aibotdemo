/**
 * @file pdf2text.js
 * @description PDF转文本API - 完整版
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Python路径
const PYTHON_PATH = 'C:\\Users\\W\\AppData\\Local\\Programs\\Python\\Python315\\python.exe';
const PROCESSOR_PATH = path.join(__dirname, '../../pdf2text/pdf_processor.py');

// 配置上传目录
const UPLOAD_DIR = path.join(__dirname, '../public/uploads/pdf2text');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 配置multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB限制
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.mimetype === 'application/x-pdf') {
      cb(null, true);
    } else {
      cb(new Error('只支持PDF文件'), false);
    }
  }
});

// 调用Python脚本
function runPythonCommand(args) {
  return new Promise((resolve, reject) => {
    const python = spawn(PYTHON_PATH, [PROCESSOR_PATH, ...args]);

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (e) {
          resolve({ success: true, text: stdout });
        }
      } else {
        console.error('[PDF2Text] Python错误:', stderr);
        reject(new Error(stderr || 'Python脚本执行失败'));
      }
    });

    python.on('error', (err) => {
      reject(err);
    });
  });
}

// 分析PDF
async function analyzePDF(pdfPath) {
  return await runPythonCommand(['analyze', pdfPath]);
}

// 提取指定页面
async function extractPages(pdfPath, pages, pageRange) {
  const args = ['extract', pdfPath];
  if (pages) {
    args.push('--pages', ...pages);
  }
  if (pageRange) {
    args.push('--range', pageRange);
  }
  return await runPythonCommand(args);
}

// 提取全部
async function extractAll(pdfPath, includeMetadata = false) {
  const args = ['extract-all', pdfPath];
  if (includeMetadata) {
    args.push('--metadata');
  }
  return await runPythonCommand(args);
}

// 简单提取文本
async function extractTextSimple(pdfPath) {
  return await runPythonCommand(['extract-text', pdfPath]);
}

// ============================================
// API路由
// ============================================

// 提取文本API (完整版)
router.post('/extract', upload.single('file'), async (req, res) => {
  let tempPdfPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: '请上传PDF文件'
      });
    }

    tempPdfPath = req.file.path;
    const originalName = req.file.originalname;

    console.log('[PDF2Text] 开始提取:', originalName);

    // 获取参数
    const includeMetadata = req.body.metadata === 'true';
    const pageSeparator = req.body.separator || '\n\n--- 第 {page} 页 ---\n\n';

    // 提取全部内容
    const result = await extractAll(tempPdfPath, includeMetadata);

    if (!result.success) {
      throw new Error(result.error || 'PDF提取失败');
    }

    res.json({
      success: true,
      data: {
        filename: originalName,
        totalPages: result.totalPages,
        totalChars: result.totalChars,
        fullText: result.fullText,
        pages: result.pages,
        metadata: result.metadata
      }
    });

  } catch (error) {
    console.error('[PDF2Text] 提取失败:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'PDF提取失败'
    });
  } finally {
    // 清理临时文件
    if (tempPdfPath && fs.existsSync(tempPdfPath)) {
      try {
        fs.unlinkSync(tempPdfPath);
      } catch (e) {
        console.warn('[PDF2Text] 清理PDF失败:', e.message);
      }
    }
  }
});

// 分析PDF（获取每页信息）
router.post('/analyze', upload.single('file'), async (req, res) => {
  let tempPdfPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: '请上传PDF文件'
      });
    }

    tempPdfPath = req.file.path;
    const originalName = req.file.originalname;

    console.log('[PDF2Text] 分析PDF:', originalName);

    // 分析PDF
    const result = await analyzePDF(tempPdfPath);

    if (!result.success) {
      throw new Error(result.error || 'PDF分析失败');
    }

    res.json({
      success: true,
      data: {
        filename: originalName,
        totalPages: result.totalPages,
        totalChars: result.totalChars,
        pages: result.pages,
        metadata: result.metadata
      }
    });

  } catch (error) {
    console.error('[PDF2Text] 分析失败:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'PDF分析失败'
    });
  } finally {
    // 清理临时文件
    if (tempPdfPath && fs.existsSync(tempPdfPath)) {
      try {
        fs.unlinkSync(tempPdfPath);
      } catch (e) {
        console.warn('[PDF2Text] 清理PDF失败:', e.message);
      }
    }
  }
});

// 提取指定页面
router.post('/extract-pages', upload.single('file'), async (req, res) => {
  let tempPdfPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: '请上传PDF文件'
      });
    }

    tempPdfPath = req.file.path;
    const originalName = req.file.originalname;

    // 获取页面参数
    const pages = req.body.pages ? JSON.parse(req.body.pages) : null;
    const pageRange = req.body.pageRange || null;

    console.log('[PDF2Text] 提取指定页面:', originalName, 'pages:', pages, 'range:', pageRange);

    // 提取指定页面
    const result = await extractPages(tempPdfPath, pages, pageRange);

    if (!result.success) {
      throw new Error(result.error || '页面提取失败');
    }

    // 合并文本
    const fullText = result.pages.map(p => p.text).join('\n\n');

    res.json({
      success: true,
      data: {
        filename: originalName,
        totalPages: result.totalPages,
        extractedPages: result.extractedPages,
        totalChars: result.totalChars,
        fullText: fullText,
        pages: result.pages
      }
    });

  } catch (error) {
    console.error('[PDF2Text] 提取指定页面失败:', error);
    res.status(500).json({
      success: false,
      error: error.message || '页面提取失败'
    });
  } finally {
    // 清理临时文件
    if (tempPdfPath && fs.existsSync(tempPdfPath)) {
      try {
        fs.unlinkSync(tempPdfPath);
      } catch (e) {
        console.warn('[PDF2Text] 清理PDF失败:', e.message);
      }
    }
  }
});

// 获取PDF信息（不提取文本）- 兼容旧版
router.post('/info', upload.single('file'), async (req, res) => {
  let tempPdfPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: '请上传PDF文件'
      });
    }

    tempPdfPath = req.file.path;
    const originalName = req.file.originalname;
    const fileSize = req.file.size;

    // 分析PDF
    const result = await analyzePDF(tempPdfPath);

    res.json({
      success: true,
      data: {
        filename: originalName,
        pageCount: result.totalPages || 0,
        fileSize: fileSize,
        totalChars: result.totalChars || 0
      }
    });

  } catch (error) {
    console.error('[PDF2Text] 获取信息失败:', error);
    res.status(500).json({
      success: false,
      error: error.message || '获取PDF信息失败'
    });
  } finally {
    // 清理临时文件
    if (tempPdfPath && fs.existsSync(tempPdfPath)) {
      try {
        fs.unlinkSync(tempPdfPath);
      } catch (e) {
        console.warn('[PDF2Text] 清理PDF失败:', e.message);
      }
    }
  }
});

module.exports = router;
