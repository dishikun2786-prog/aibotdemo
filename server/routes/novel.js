/**
 * @file novel.js
 * @module routes/novel
 * @description 小说章节 API 路由 - 支持多本小说
 */
const express = require('express');
const router = express.Router();
const novel = require('../utils/novel');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// ============================================
// 公开 API - 小说书籍
// ============================================

/**
 * 获取小说列表
 * GET /api/novel/books
 */
router.get('/books', async (req, res) => {
  try {
    const books = await novel.getBooks();
    res.json({
      success: true,
      data: books
    });
  } catch (error) {
    console.error('获取小说列表失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取小说详情
 * GET /api/novel/books/:bookId
 */
router.get('/books/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    const book = await novel.getBookById(bookId);

    if (!book) {
      return res.status(404).json({ error: '小说不存在' });
    }

    res.json({
      success: true,
      data: book
    });
  } catch (error) {
    console.error('获取小说详情失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ============================================
// 公开 API - 卷次和章节
// ============================================

/**
 * 获取所有卷次列表
 * GET /api/novel/volumes?bookId=xxx
 */
router.get('/volumes', async (req, res) => {
  try {
    const bookId = req.query.bookId || null;
    const volumes = await novel.getVolumes(bookId);
    res.json({
      success: true,
      data: volumes
    });
  } catch (error) {
    console.error('获取卷次列表失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取章节列表（支持按卷次筛选）
 * GET /api/novel/chapters?volume=第一卷&bookId=xxx
 */
router.get('/chapters', async (req, res) => {
  try {
    const { volume, bookId } = req.query;
    let chapters;

    if (volume) {
      chapters = await novel.getChaptersByVolume(volume, bookId);
    } else {
      chapters = await novel.getAllChapters(bookId);
    }

    // 转换为前端期望的格式
    const data = chapters.map(ch => ({
      id: ch.chapterId,
      date: ch.date,
      title: ch.title,
      volume: ch.volume,
      content: ch.content
    }));

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('获取章节列表失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取单个章节详情
 * GET /api/novel/chapter/:id?bookId=xxx
 */
router.get('/chapter/:id', async (req, res) => {
  try {
    const chapterId = parseInt(req.params.id, 10);
    const bookId = req.query.bookId || null;

    if (isNaN(chapterId)) {
      return res.status(400).json({ error: '无效的章节ID' });
    }

    const chapter = await novel.getChapterById(chapterId, bookId);

    if (!chapter) {
      return res.status(404).json({ error: '章节不存在' });
    }

    // 获取上一章和下一章
    const [prevChapter, nextChapter] = await Promise.all([
      novel.getPrevChapter(chapterId, bookId),
      novel.getNextChapter(chapterId, bookId)
    ]);

    res.json({
      success: true,
      data: {
        id: chapter.chapterId,
        date: chapter.date,
        title: chapter.title,
        volume: chapter.volume,
        content: chapter.content,
        prevId: prevChapter ? prevChapter.chapterId : null,
        nextId: nextChapter ? nextChapter.chapterId : null,
        prevTitle: prevChapter ? prevChapter.title : null,
        nextTitle: nextChapter ? nextChapter.title : null
      }
    });
  } catch (error) {
    console.error('获取章节详情失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取书籍基本信息
 * GET /api/novel/book-info?bookId=xxx
 */
router.get('/book-info', async (req, res) => {
  try {
    const bookId = req.query.bookId || null;
    const bookInfo = await novel.getBookInfo(bookId);
    res.json({
      success: true,
      data: bookInfo
    });
  } catch (error) {
    console.error('获取书籍信息失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ============================================
// 管理 API - 小说书籍
// ============================================

/**
 * 获取小说列表（管理）
 * GET /api/novel/admin/books
 */
router.get('/admin/books', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const books = await novel.getBooks();

    // 为每本小说添加章节统计
    const booksWithCount = await Promise.all(books.map(async (book) => {
      const chapters = await novel.getAllChapters(book.bookId);
      return {
        ...book,
        chapterCount: chapters.length
      };
    }));

    res.json({
      success: true,
      data: booksWithCount
    });
  } catch (error) {
    console.error('获取小说列表失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 创建小说
 * POST /api/novel/admin/books
 */
router.post('/admin/books', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { bookId, title, subtitle, author, cover, description, status } = req.body;

    if (!bookId || !title || !author) {
      return res.status(400).json({ error: '请提供小说标识符、书名和作者' });
    }

    const result = await novel.createBook({
      bookId,
      title,
      subtitle,
      author,
      cover,
      description,
      status: status || 'draft'
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('创建小说失败:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * 更新小说
 * PUT /api/novel/admin/books/:bookId
 */
router.put('/admin/books/:bookId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { bookId } = req.params;
    const { title, subtitle, author, cover, description, status } = req.body;

    const result = await novel.updateBook(bookId, {
      title,
      subtitle,
      author,
      cover,
      description,
      status
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('更新小说失败:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * 删除小说
 * DELETE /api/novel/admin/books/:bookId
 */
router.delete('/admin/books/:bookId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { bookId } = req.params;

    // 不允许删除默认小说
    if (bookId === novel.DEFAULT_BOOK_ID) {
      return res.status(400).json({ error: '不能删除默认小说' });
    }

    const result = await novel.deleteBook(bookId);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('删除小说失败:', error);
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// 管理 API - 卷次和章节
// ============================================

/**
 * 获取所有卷次（含章节统计）
 * GET /api/novel/admin/volumes?bookId=xxx
 */
router.get('/admin/volumes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const bookId = req.query.bookId || null;
    const volumes = await novel.getVolumesWithCount(bookId);
    res.json({
      success: true,
      data: volumes
    });
  } catch (error) {
    console.error('获取卷次列表失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 创建卷次
 * POST /api/novel/admin/volumes?bookId=xxx
 */
router.post('/admin/volumes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { volume } = req.body;
    const bookId = req.query.bookId || null;

    if (!volume) {
      return res.status(400).json({ error: '请提供卷次名称' });
    }
    const result = await novel.createVolume(volume, bookId);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('创建卷次失败:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * 更新卷次名称
 * PUT /api/novel/admin/volumes/:oldVolume?bookId=xxx
 */
router.put('/admin/volumes/:oldVolume', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { oldVolume } = req.params;
    const { newVolume } = req.body;
    const bookId = req.query.bookId || null;

    if (!newVolume) {
      return res.status(400).json({ error: '请提供新卷次名称' });
    }

    const result = await novel.updateVolume(oldVolume, newVolume, bookId);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('更新卷次失败:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * 删除卷次
 * DELETE /api/novel/admin/volumes/:volume?bookId=xxx
 */
router.delete('/admin/volumes/:volume', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { volume } = req.params;
    const bookId = req.query.bookId || null;
    const result = await novel.deleteVolume(volume, bookId);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('删除卷次失败:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * 获取章节列表（分页）
 * GET /api/novel/admin/chapters?page=1&pageSize=20&volume=xxx&bookId=xxx
 */
router.get('/admin/chapters', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 20;
    const volume = req.query.volume || null;
    const bookId = req.query.bookId || null;

    const result = await novel.getChaptersWithPage(page, pageSize, volume, bookId);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('获取章节列表失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 创建章节
 * POST /api/novel/admin/chapters?bookId=xxx
 */
router.post('/admin/chapters', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, volume, content, date, chapterId } = req.body;
    const bookId = req.query.bookId || null;

    if (!title || !volume || !content) {
      return res.status(400).json({ error: '请提供标题、卷次和内容' });
    }

    const result = await novel.createChapter({ title, volume, content, date, chapterId, bookId });
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('创建章节失败:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * 更新章节
 * PUT /api/novel/admin/chapters/:chapterId?bookId=xxx
 */
router.put('/admin/chapters/:chapterId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const chapterId = parseInt(req.params.chapterId, 10);
    const { title, volume, content, date, newChapterId } = req.body;
    const bookId = req.query.bookId || null;

    if (isNaN(chapterId)) {
      return res.status(400).json({ error: '无效的章节ID' });
    }

    // 准备更新数据
    const updateData = { bookId };
    if (title !== undefined) updateData.title = title;
    if (volume !== undefined) updateData.volume = volume;
    if (content !== undefined) updateData.content = content;
    if (date !== undefined) updateData.date = date;

    // 如果提供了新ID，则更新chapterId
    if (newChapterId !== undefined && newChapterId !== null && newChapterId !== '') {
      updateData.chapterId = parseInt(newChapterId, 10);
    }

    const result = await novel.updateChapter(chapterId, updateData);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('更新章节失败:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * 删除章节
 * DELETE /api/novel/admin/chapters/:chapterId?bookId=xxx
 */
router.delete('/admin/chapters/:chapterId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const chapterId = parseInt(req.params.chapterId, 10);
    const bookId = req.query.bookId || null;

    if (isNaN(chapterId)) {
      return res.status(400).json({ error: '无效的章节ID' });
    }

    const result = await novel.deleteChapter(chapterId, bookId);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('删除章节失败:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * 调整章节顺序
 * PUT /api/novel/admin/chapters/:chapterId/order?bookId=xxx
 */
router.put('/admin/chapters/:chapterId/order', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const oldChapterId = parseInt(req.params.chapterId, 10);
    const { newChapterId } = req.body;
    const bookId = req.query.bookId || null;

    if (isNaN(oldChapterId)) {
      return res.status(400).json({ error: '无效的原章节ID' });
    }

    if (newChapterId === undefined || isNaN(parseInt(newChapterId, 10))) {
      return res.status(400).json({ error: '请提供新章节ID' });
    }

    const result = await novel.reorderChapter(oldChapterId, parseInt(newChapterId, 10), bookId);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('调整章节顺序失败:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * 获取下一章节ID
 * GET /api/novel/admin/next-chapter-id?volume=第一卷&bookId=xxx
 */
router.get('/admin/next-chapter-id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { volume, bookId } = req.query;
    if (!volume) {
      return res.status(400).json({ error: '请提供卷次名称' });
    }

    const nextId = await novel.getNextChapterId(volume, bookId);
    res.json({
      success: true,
      data: { nextChapterId: nextId }
    });
  } catch (error) {
    console.error('获取下一章节ID失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 修复章节ID
 * PUT /api/novel/admin/fix-chapter-id?bookId=xxx
 */
router.put('/admin/fix-chapter-id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { mongoId, newChapterId } = req.body;
    const bookId = req.query.bookId || null;

    if (!mongoId || mongoId === '') {
      return res.status(400).json({ error: '无效的MongoDB ID' });
    }

    if (!newChapterId && newChapterId !== 0) {
      return res.status(400).json({ error: '请提供新章节ID' });
    }

    const result = await novel.fixChapterIdByMongoId(mongoId, parseInt(newChapterId, 10), bookId);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('修复章节ID失败:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * 获取所有章节（含MongoDB _id）
 * GET /api/novel/admin/chapters-with-id?bookId=xxx
 */
router.get('/admin/chapters-with-id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const bookId = req.query.bookId || null;
    const chapters = await novel.getAllChaptersWithMongoId(bookId);
    res.json({
      success: true,
      data: chapters
    });
  } catch (error) {
    console.error('获取章节列表失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
