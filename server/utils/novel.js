/**
 * @file novel.js
 * @module utils/novel
 * @description MongoDB 小说章节数据操作模块 - 支持多本小说
 */
const { MongoClient, ObjectId } = require('mongodb');
const config = require('../config/database');

const NOVEL_BOOKS_COLLECTION = 'novel_books';
const NOVEL_CHAPTERS_COLLECTION = 'novel_chapters';

// 默认小说ID（兼容旧数据）
const DEFAULT_BOOK_ID = 'chuanqi';

let client = null;
let mongoDb = null;

/**
 * 获取 MongoDB 客户端（懒加载）
 */
async function getClient() {
  if (!client) {
    client = new MongoClient(config.mongo.uri);
    await client.connect();
  }
  return client;
}

/**
 * 获取数据库实例
 */
async function getDb() {
  if (!mongoDb) {
    const c = await getClient();
    mongoDb = c.db(config.mongo.dbName);
  }
  return mongoDb;
}

// ============================================
// 小说书籍管理函数
// ============================================

/**
 * 获取小说书籍集合
 */
async function getNovelBooksCollection() {
  const database = await getDb();
  const coll = database.collection(NOVEL_BOOKS_COLLECTION);
  await coll.createIndex({ bookId: 1 }, { unique: true });
  return coll;
}

/**
 * 获取所有小说列表
 */
async function getBooks() {
  const coll = await getNovelBooksCollection();
  return await coll.find({}).sort({ createdAt: -1 }).toArray();
}

/**
 * 根据bookId获取小说
 * @param {string} bookId - 小说标识符
 */
async function getBookById(bookId) {
  const coll = await getNovelBooksCollection();
  return await coll.findOne({ bookId });
}

/**
 * 创建小说
 * @param {Object} bookData - 小说数据 { bookId, title, subtitle, author, cover, description, status }
 */
async function createBook(bookData) {
  const coll = await getNovelBooksCollection();

  // 检查bookId是否已存在
  const existing = await coll.findOne({ bookId: bookData.bookId });
  if (existing) {
    throw new Error(`小说标识符 ${bookData.bookId} 已存在`);
  }

  const doc = {
    bookId: bookData.bookId,
    title: bookData.title,
    subtitle: bookData.subtitle || '',
    author: bookData.author,
    cover: bookData.cover || '',
    description: bookData.description || '',
    status: bookData.status || 'draft',
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const result = await coll.insertOne(doc);
  return { insertedId: result.insertedId, ...doc };
}

/**
 * 更新小说
 * @param {string} bookId - 小说标识符
 * @param {Object} bookData - 要更新的数据
 */
async function updateBook(bookId, bookData) {
  const coll = await getNovelBooksCollection();

  const updateData = { updatedAt: new Date() };
  if (bookData.title !== undefined) updateData.title = bookData.title;
  if (bookData.subtitle !== undefined) updateData.subtitle = bookData.subtitle;
  if (bookData.author !== undefined) updateData.author = bookData.author;
  if (bookData.cover !== undefined) updateData.cover = bookData.cover;
  if (bookData.description !== undefined) updateData.description = bookData.description;
  if (bookData.status !== undefined) updateData.status = bookData.status;

  const result = await coll.updateOne(
    { bookId },
    { $set: updateData }
  );

  if (result.matchedCount === 0) {
    throw new Error('小说不存在');
  }

  return { modifiedCount: result.modifiedCount };
}

/**
 * 删除小说（同时删除所有章节）
 * @param {string} bookId - 小说标识符
 */
async function deleteBook(bookId) {
  const booksColl = await getNovelBooksCollection();
  const chaptersColl = await getNovelChaptersCollection();

  // 删除小说
  const bookResult = await booksColl.deleteOne({ bookId });
  if (bookResult.deletedCount === 0) {
    throw new Error('小说不存在');
  }

  // 删除该小说的所有章节
  const chaptersResult = await chaptersColl.deleteMany({ bookId });

  return {
    deletedBookCount: bookResult.deletedCount,
    deletedChapterCount: chaptersResult.deletedCount
  };
}

/**
 * 确保默认小说存在（迁移旧数据）
 */
async function ensureDefaultBook() {
  const existing = await getBookById(DEFAULT_BOOK_ID);
  if (!existing) {
    await createBook({
      bookId: DEFAULT_BOOK_ID,
      title: '胄空形仙传',
      subtitle: '上',
      author: '清风',
      cover: '',
      description: '',
      status: 'published'
    });
    console.log('已创建默认小说: 胄空形仙传');
  }

  // 迁移旧章节数据（没有bookId的章节）
  await migrateOldChapters();
}

/**
 * 迁移旧章节数据（没有bookId的章节）
 */
async function migrateOldChapters() {
  const coll = await getNovelChaptersCollection();

  // 查找没有bookId的章节
  const oldChapters = await coll.find({ bookId: { $exists: false } }).toArray();

  if (oldChapters.length > 0) {
    console.log(`发现 ${oldChapters.length} 个旧章节需要迁移`);

    // 批量更新，添加bookId
    for (const chapter of oldChapters) {
      await coll.updateOne(
        { _id: chapter._id },
        { $set: { bookId: DEFAULT_BOOK_ID } }
      );
    }

    console.log('旧章节迁移完成');
  }
}

/**
 * 为旧章节数据添加bookId（迁移用）
 */
async function migrateChaptersBookId(bookId) {
  const coll = await getNovelChaptersCollection();
  const result = await coll.updateMany(
    { bookId: { $exists: false } },
    { $set: { bookId } }
  );
  return result.modifiedCount;
}

/**
 * 获取小说章节集合，并确保索引存在
 */
async function getNovelChaptersCollection() {
  const database = await getDb();
  const coll = database.collection(NOVEL_CHAPTERS_COLLECTION);
  await coll.createIndex({ bookId: 1, chapterId: 1 }, { unique: true });
  await coll.createIndex({ bookId: 1, volume: 1, chapterId: 1 });
  return coll;
}

/**
 * 获取查询条件（支持 bookId 参数）
 */
function buildQuery(query = {}) {
  const result = {};
  if (query.bookId) {
    result.bookId = query.bookId;
  } else if (!query.noDefault) {
    // 默认使用 DEFAULT_BOOK_ID，兼容旧数据
    result.bookId = DEFAULT_BOOK_ID;
  }
  return result;
}

/**
 * 插入单个章节
 * @param {Object} chapter - 章节数据
 */
async function insertChapter(chapter, bookId = DEFAULT_BOOK_ID) {
  const coll = await getNovelChaptersCollection();
  return await coll.insertOne({
    ...chapter,
    bookId: bookId || chapter.bookId || DEFAULT_BOOK_ID,
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

/**
 * 批量插入章节
 * @param {Array} chapters - 章节数组
 * @param {string} bookId - 小说ID
 */
async function insertChapters(chapters, bookId = DEFAULT_BOOK_ID) {
  const coll = await getNovelChaptersCollection();
  const docs = chapters.map(ch => ({
    chapterId: ch.id,
    date: ch.date,
    title: ch.title,
    volume: ch.volume,
    content: ch.content,
    bookId: bookId || ch.bookId || DEFAULT_BOOK_ID,
    createdAt: new Date(),
    updatedAt: new Date()
  }));
  return await coll.insertMany(docs, { ordered: false });
}

/**
 * 获取所有章节
 * @param {string} bookId - 小说ID（可选，默认DEFAULT_BOOK_ID）
 */
async function getAllChapters(bookId = null) {
  const coll = await getNovelChaptersCollection();
  const query = bookId ? { bookId } : { bookId: DEFAULT_BOOK_ID };
  return await coll.find(query).sort({ chapterId: 1 }).toArray();
}

/**
 * 按卷次获取章节列表
 * @param {string} volume - 卷次名称
 * @param {string} bookId - 小说ID（可选）
 */
async function getChaptersByVolume(volume, bookId = null) {
  const coll = await getNovelChaptersCollection();
  const query = { volume };
  if (bookId) {
    query.bookId = bookId;
  } else {
    query.bookId = DEFAULT_BOOK_ID;
  }
  return await coll.find(query).sort({ chapterId: 1 }).toArray();
}

/**
 * 获取单个章节详情
 * @param {number} chapterId - 章节ID
 * @param {string} bookId - 小说ID（可选）
 */
async function getChapterById(chapterId, bookId = null) {
  const coll = await getNovelChaptersCollection();
  const query = { chapterId };
  if (bookId) {
    query.bookId = bookId;
  } else {
    query.bookId = DEFAULT_BOOK_ID;
  }
  return await coll.findOne(query);
}

/**
 * 获取所有卷次列表
 * @param {string} bookId - 小说ID（可选）
 */
async function getVolumes(bookId = null) {
  const coll = await getNovelChaptersCollection();
  const query = bookId ? { bookId } : { bookId: DEFAULT_BOOK_ID };
  const volumes = await coll.distinct('volume', query);
  return volumes.sort();
}

/**
 * 获取书籍基本信息
 * @param {string} bookId - 小说ID（可选）
 */
async function getBookInfo(bookId = null) {
  const targetBookId = bookId || DEFAULT_BOOK_ID;

  // 先尝试从 books 集合获取
  const book = await getBookById(targetBookId);
  if (book) {
    const coll = await getNovelChaptersCollection();
    const totalChapters = await coll.countDocuments({ bookId: targetBookId });
    const volumes = await getVolumes(targetBookId);

    return {
      bookId: book.bookId,
      title: book.title,
      subtitle: book.subtitle,
      author: book.author,
      cover: book.cover,
      description: book.description,
      status: book.status,
      totalChapters,
      volumes
    };
  }

  // 兼容旧数据（没有 bookId 的情况）
  const coll = await getNovelChaptersCollection();
  const totalChapters = await coll.countDocuments({});
  const volumes = await getVolumes();

  return {
    title: '胄空形仙传',
    subtitle: '上',
    author: '清风',
    totalChapters,
    volumes
  };
}

/**
 * 获取上一章
 * @param {number} currentChapterId - 当前章节ID
 * @param {string} bookId - 小说ID（可选）
 */
async function getPrevChapter(currentChapterId, bookId = null) {
  const coll = await getNovelChaptersCollection();
  const query = { chapterId: { $lt: currentChapterId } };
  if (bookId) {
    query.bookId = bookId;
  } else {
    query.bookId = DEFAULT_BOOK_ID;
  }
  return await coll.findOne(query, { sort: { chapterId: -1 } });
}

/**
 * 获取下一章
 * @param {number} currentChapterId - 当前章节ID
 * @param {string} bookId - 小说ID（可选）
 */
async function getNextChapter(currentChapterId, bookId = null) {
  const coll = await getNovelChaptersCollection();
  const query = { chapterId: { $gt: currentChapterId } };
  if (bookId) {
    query.bookId = bookId;
  } else {
    query.bookId = DEFAULT_BOOK_ID;
  }
  return await coll.findOne(query, { sort: { chapterId: 1 } });
}

/**
 * 清空所有章节（用于重新导入）
 * @param {string} bookId - 小说ID（可选）
 */
async function clearAllChapters(bookId = null) {
  const coll = await getNovelChaptersCollection();
  const query = bookId ? { bookId } : { bookId: DEFAULT_BOOK_ID };
  return await coll.deleteMany(query);
}

// ============================================
// 管理函数 - 卷次管理
// ============================================

/**
 * 获取所有卷次（含章节统计）
 * @param {string} bookId - 小说ID（可选）
 */
async function getVolumesWithCount(bookId = null) {
  const coll = await getNovelChaptersCollection();
  const match = bookId ? { bookId } : { bookId: DEFAULT_BOOK_ID };

  const pipeline = [
    { $match: match },
    { $group: { _id: "$volume", count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ];
  const results = await coll.aggregate(pipeline).toArray();
  return results.map(r => ({ volume: r._id, count: r.count }));
}

/**
 * 创建卷次
 * @param {string} volumeName - 卷次名称
 * @param {string} bookId - 小说ID（可选）
 */
async function createVolume(volumeName, bookId = null) {
  const coll = await getNovelChaptersCollection();
  const targetBookId = bookId || DEFAULT_BOOK_ID;

  // 检查是否已存在
  const existing = await coll.distinct('volume', { bookId: targetBookId });
  if (existing.includes(volumeName)) {
    throw new Error('卷次已存在');
  }
  return { volume: volumeName, message: '卷次已创建' };
}

/**
 * 更新卷次名称
 * @param {string} oldName - 原卷次名称
 * @param {string} newName - 新卷次名称
 * @param {string} bookId - 小说ID（可选）
 */
async function updateVolume(oldName, newName, bookId = null) {
  const coll = await getNovelChaptersCollection();
  const targetBookId = bookId || DEFAULT_BOOK_ID;

  const result = await coll.updateMany(
    { volume: oldName, bookId: targetBookId },
    { $set: { volume: newName, updatedAt: new Date() } }
  );
  return { modifiedCount: result.modifiedCount };
}

/**
 * 删除卷次（同时删除该卷下所有章节）
 * @param {string} volumeName - 卷次名称
 * @param {string} bookId - 小说ID（可选）
 */
async function deleteVolume(volumeName, bookId = null) {
  const coll = await getNovelChaptersCollection();
  const targetBookId = bookId || DEFAULT_BOOK_ID;

  const result = await coll.deleteMany({ volume: volumeName, bookId: targetBookId });
  return { deletedCount: result.deletedCount };
}

// ============================================
// 管理函数 - 章节管理
// ============================================

/**
 * 获取某卷下一章节ID
 * @param {string} volume - 卷次名称
 * @param {string} bookId - 小说ID（可选）
 */
async function getNextChapterId(volume, bookId = null) {
  const coll = await getNovelChaptersCollection();
  const targetBookId = bookId || DEFAULT_BOOK_ID;

  const query = { volume, bookId: targetBookId };
  const chapters = await coll.find(query).sort({ chapterId: -1 }).limit(1).toArray();

  if (chapters.length === 0) {
    // 如果是新卷，查找该小说最大章节ID
    const allChapters = await coll.find({ bookId: targetBookId }).sort({ chapterId: -1 }).limit(1).toArray();
    return allChapters.length === 0 ? 1 : allChapters[0].chapterId + 1;
  }
  return chapters[0].chapterId + 1;
}

/**
 * 创建章节
 * @param {Object} chapterData - 章节数据 { title, volume, content, date, bookId }
 */
async function createChapter(chapterData) {
  const coll = await getNovelChaptersCollection();
  const bookId = chapterData.bookId || DEFAULT_BOOK_ID;

  // 如果没有指定chapterId，自动生成
  let chapterId = chapterData.chapterId;
  if (!chapterId) {
    chapterId = await getNextChapterId(chapterData.volume, bookId);
  }

  // 检查chapterId是否已存在
  const existing = await coll.findOne({ chapterId, bookId });
  if (existing) {
    throw new Error(`章节ID ${chapterId} 已存在，请使用其他ID或先删除现有章节`);
  }

  const doc = {
    chapterId,
    title: chapterData.title,
    volume: chapterData.volume,
    content: chapterData.content,
    date: chapterData.date || new Date().toISOString().split('T')[0].replace(/-/g, '.'),
    bookId,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const result = await coll.insertOne(doc);
  return { insertedId: result.insertedId, chapterId };
}

/**
 * 更新章节
 * @param {number} chapterId - 章节ID
 * @param {Object} chapterData - 要更新的数据 { title, volume, content, date, bookId }
 */
async function updateChapter(chapterId, chapterData) {
  const coll = await getNovelChaptersCollection();
  const bookId = chapterData.bookId || DEFAULT_BOOK_ID;

  const updateData = { updatedAt: new Date() };
  if (chapterData.title !== undefined) updateData.title = chapterData.title;
  if (chapterData.volume !== undefined) updateData.volume = chapterData.volume;
  if (chapterData.content !== undefined) updateData.content = chapterData.content;
  if (chapterData.date !== undefined) updateData.date = chapterData.date;
  if (chapterData.chapterId !== undefined) updateData.chapterId = chapterData.chapterId;

  const result = await coll.updateOne(
    { chapterId, bookId },
    { $set: updateData }
  );

  if (result.matchedCount === 0) {
    throw new Error('章节不存在');
  }

  return { modifiedCount: result.modifiedCount };
}

/**
 * 删除章节
 * @param {number} chapterId - 章节ID
 * @param {string} bookId - 小说ID（可选）
 */
async function deleteChapter(chapterId, bookId = null) {
  const coll = await getNovelChaptersCollection();
  const targetBookId = bookId || DEFAULT_BOOK_ID;

  const result = await coll.deleteOne({ chapterId, bookId: targetBookId });

  if (result.deletedCount === 0) {
    throw new Error('章节不存在');
  }

  return { deletedCount: result.deletedCount };
}

/**
 * 通过ID修复章节ID（用于修复被误设为null的情况）
 * @param {string} mongoId - MongoDB的_id
 * @param {number} newChapterId - 新的章节ID
 * @param {string} bookId - 小说ID（可选）
 */
async function fixChapterIdByMongoId(mongoId, newChapterId, bookId = null) {
  const coll = await getNovelChaptersCollection();
  const targetBookId = bookId || DEFAULT_BOOK_ID;

  const result = await coll.updateOne(
    { _id: new ObjectId(mongoId), bookId: targetBookId },
    { $set: { chapterId: newChapterId, updatedAt: new Date() } }
  );

  if (result.matchedCount === 0) {
    throw new Error('文档不存在');
  }

  return { modifiedCount: result.modifiedCount };
}

/**
 * 获取所有章节（含MongoDB _id，用于修复）
 * @param {string} bookId - 小说ID（可选）
 */
async function getAllChaptersWithMongoId(bookId = null) {
  const coll = await getNovelChaptersCollection();
  const query = bookId ? { bookId } : { bookId: DEFAULT_BOOK_ID };
  return await coll.find(query).sort({ chapterId: 1 }).toArray();
}

/**
 * 调整章节顺序（修改chapterId）
 * @param {number} oldChapterId - 原章节ID
 * @param {number} newChapterId - 新章节ID
 * @param {string} bookId - 小说ID（可选）
 */
async function reorderChapter(oldChapterId, newChapterId, bookId = null) {
  const coll = await getNovelChaptersCollection();
  const targetBookId = bookId || DEFAULT_BOOK_ID;

  // 检查新ID是否已存在
  const existing = await coll.findOne({ chapterId: newChapterId, bookId: targetBookId });
  if (existing) {
    throw new Error(`目标章节ID ${newChapterId} 已存在`);
  }

  // 暂时使用一个临时ID来避免冲突
  const tempId = 999999999;

  // 第一步：将原ID改为临时ID
  await coll.updateOne(
    { chapterId: oldChapterId, bookId: targetBookId },
    { $set: { chapterId: tempId, updatedAt: new Date() } }
  );

  // 第二步：将临时ID改为新ID
  const result = await coll.updateOne(
    { chapterId: tempId, bookId: targetBookId },
    { $set: { chapterId: newChapterId, updatedAt: new Date() } }
  );

  return { modifiedCount: result.modifiedCount };
}

/**
 * 分页获取章节列表
 * @param {number} page - 页码（从1开始）
 * @param {number} pageSize - 每页数量
 * @param {string} volume - 卷次筛选（可选）
 * @param {string} bookId - 小说ID（可选）
 */
async function getChaptersWithPage(page = 1, pageSize = 20, volume = null, bookId = null) {
  const coll = await getNovelChaptersCollection();
  const targetBookId = bookId || DEFAULT_BOOK_ID;

  const query = { bookId: targetBookId };
  if (volume) {
    query.volume = volume;
  }

  const total = await coll.countDocuments(query);

  const chapters = await coll.find(query)
    .sort({ chapterId: 1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .toArray();

  return {
    chapters: chapters.map(ch => ({
      id: ch.chapterId,
      date: ch.date,
      title: ch.title,
      volume: ch.volume,
      content: ch.content,
      bookId: ch.bookId
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize)
  };
}

/**
 * 关闭 MongoDB 连接
 */
async function close() {
  if (client) {
    await client.close();
    client = null;
    mongoDb = null;
  }
}

module.exports = {
  // 小说书籍管理
  getBooks,
  getBookById,
  createBook,
  updateBook,
  deleteBook,
  ensureDefaultBook,
  migrateChaptersBookId,
  // 章节操作
  getClient,
  getDb,
  getNovelChaptersCollection,
  insertChapter,
  insertChapters,
  getAllChapters,
  getChaptersByVolume,
  getChapterById,
  getVolumes,
  getBookInfo,
  getPrevChapter,
  getNextChapter,
  clearAllChapters,
  // 管理函数 - 卷次
  getVolumesWithCount,
  createVolume,
  updateVolume,
  deleteVolume,
  // 管理函数 - 章节
  getNextChapterId,
  createChapter,
  updateChapter,
  deleteChapter,
  reorderChapter,
  getChaptersWithPage,
  fixChapterIdByMongoId,
  getAllChaptersWithMongoId,
  close,
  // 常量
  DEFAULT_BOOK_ID
};
