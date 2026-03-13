/**
 * @file story.js
 * @module routes/story
 * @description 剧情章节系统相关路由：章节管理、任务管理、进度查询、奖励发放
 */
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');

/**
 * 获取所有章节列表
 * GET /api/story/chapters
 */
router.get('/chapters', authenticateToken, async (req, res) => {
  try {
    const chapters = await db.query(
      `SELECT id, chapter_number, chapter_title, chapter_description, story_content, 
              completion_condition, stamina_reward, energy_reward, is_active, sort_order,
              created_at, updated_at
       FROM story_chapters 
       WHERE is_active = 1 
       ORDER BY sort_order ASC, chapter_number ASC`
    );

    // 为每个章节获取任务列表
    const chaptersWithTasks = await Promise.all(
      chapters.map(async (chapter) => {
        const tasks = await db.query(
          `SELECT id, task_type, task_title, task_description, task_hint, 
                  target_value, stamina_reward, energy_reward, is_active, sort_order
           FROM story_tasks 
           WHERE chapter_id = ? AND is_active = 1 
           ORDER BY sort_order ASC`,
          [chapter.id]
        );

        return {
          ...chapter,
          completion_condition: typeof chapter.completion_condition === 'string' 
            ? JSON.parse(chapter.completion_condition) 
            : chapter.completion_condition,
          tasks: tasks
        };
      })
    );

    res.json({
      success: true,
      chapters: chaptersWithTasks
    });
  } catch (error) {
    console.error('获取章节列表失败:', error);
    res.status(500).json({ 
      success: false,
      error: '获取章节列表失败，请稍后重试' 
    });
  }
});

/**
 * 获取章节详情
 * GET /api/story/chapters/:chapterId
 */
router.get('/chapters/:chapterId', authenticateToken, async (req, res) => {
  try {
    const chapterId = parseInt(req.params.chapterId, 10);
    const userId = req.user.id;

    // 获取章节信息
    const chapters = await db.query(
      `SELECT id, chapter_number, chapter_title, chapter_description, story_content, 
              completion_condition, stamina_reward, energy_reward, is_active, sort_order
       FROM story_chapters 
       WHERE id = ?`,
      [chapterId]
    );

    if (chapters.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: '章节不存在' 
      });
    }

    const chapter = chapters[0];

    // 获取任务列表
    const tasks = await db.query(
      `SELECT id, task_type, task_title, task_description, task_hint, 
              target_value, stamina_reward, energy_reward, is_active, sort_order
       FROM story_tasks 
       WHERE chapter_id = ? AND is_active = 1 
       ORDER BY sort_order ASC`,
      [chapterId]
    );

    // 获取用户进度
    const userProgress = await db.query(
      `SELECT task_id, progress_value, is_completed, completed_at
       FROM user_story_progress 
       WHERE user_id = ? AND chapter_id = ?`,
      [userId, chapterId]
    );

    // 获取用户任务进度
    const taskProgresses = await db.query(
      `SELECT task_id, progress_value, is_completed, completed_at
       FROM user_task_progress 
       WHERE user_id = ? AND task_id IN (?)`,
      [userId, tasks.map(t => t.id)]
    );

    // 合并任务和进度信息
    const tasksWithProgress = tasks.map(task => {
      const taskProgress = taskProgresses.find(tp => tp.task_id === task.id);
      return {
        ...task,
        progress: taskProgress ? {
          progressValue: taskProgress.progress_value,
          isCompleted: taskProgress.is_completed === 1,
          completedAt: taskProgress.completed_at
        } : {
          progressValue: 0,
          isCompleted: false,
          completedAt: null
        }
      };
    });

    res.json({
      success: true,
      chapter: {
        ...chapter,
        completion_condition: typeof chapter.completion_condition === 'string' 
          ? JSON.parse(chapter.completion_condition) 
          : chapter.completion_condition,
        tasks: tasksWithProgress,
        userProgress: userProgress.length > 0 ? {
          taskId: userProgress[0].task_id,
          progressValue: userProgress[0].progress_value,
          isCompleted: userProgress[0].is_completed === 1,
          completedAt: userProgress[0].completed_at
        } : null
      }
    });
  } catch (error) {
    console.error('获取章节详情失败:', error);
    res.status(500).json({ 
      success: false,
      error: '获取章节详情失败，请稍后重试' 
    });
  }
});

/**
 * 获取当前用户剧情进度
 * GET /api/story/my-progress
 */
router.get('/my-progress', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 获取所有章节
    const chapters = await db.query(
      `SELECT id, chapter_number, chapter_title, chapter_description, 
              stamina_reward, energy_reward
       FROM story_chapters 
       WHERE is_active = 1 
       ORDER BY sort_order ASC, chapter_number ASC`
    );

    // 获取用户所有章节进度
    const chapterProgresses = await db.query(
      `SELECT chapter_id, task_id, progress_value, is_completed, completed_at
       FROM user_story_progress 
       WHERE user_id = ?`,
      [userId]
    );

    // 获取用户所有任务进度
    const taskProgresses = await db.query(
      `SELECT task_id, progress_value, is_completed, completed_at
       FROM user_task_progress 
       WHERE user_id = ?`,
      [userId]
    );

    // 合并章节和进度信息
    const chaptersWithProgress = await Promise.all(
      chapters.map(async (chapter) => {
        const chapterProgress = chapterProgresses.find(cp => cp.chapter_id === chapter.id);
        
        // 获取章节任务列表
        const tasks = await db.query(
          `SELECT id, task_type, task_title, task_description, target_value, 
                  stamina_reward, energy_reward, sort_order
           FROM story_tasks 
           WHERE chapter_id = ? AND is_active = 1 
           ORDER BY sort_order ASC`,
          [chapter.id]
        );

        // 合并任务和进度
        const tasksWithProgress = tasks.map(task => {
          const taskProgress = taskProgresses.find(tp => tp.task_id === task.id);
          return {
            ...task,
            progress: taskProgress ? {
              progressValue: taskProgress.progress_value,
              isCompleted: taskProgress.is_completed === 1,
              completedAt: taskProgress.completed_at
            } : {
              progressValue: 0,
              isCompleted: false,
              completedAt: null
            }
          };
        });

        // 检查章节是否完成（所有任务都完成）
        const allTasksCompleted = tasks.length > 0 && tasksWithProgress.every(t => t.progress.isCompleted);

        return {
          ...chapter,
          progress: chapterProgress ? {
            taskId: chapterProgress.task_id,
            progressValue: chapterProgress.progress_value,
            isCompleted: chapterProgress.is_completed === 1 || allTasksCompleted,
            completedAt: chapterProgress.completed_at
          } : {
            taskId: null,
            progressValue: 0,
            isCompleted: false,
            completedAt: null
          },
          tasks: tasksWithProgress
        };
      })
    );

    // 找到当前章节（第一个未完成的章节）
    const currentChapter = chaptersWithProgress.find(ch => !ch.progress.isCompleted) || chaptersWithProgress[chaptersWithProgress.length - 1];

    res.json({
      success: true,
      chapters: chaptersWithProgress,
      currentChapter: currentChapter ? {
        chapterNumber: currentChapter.chapter_number,
        chapterTitle: currentChapter.chapter_title,
        chapterId: currentChapter.id
      } : null
    });
  } catch (error) {
    console.error('获取用户剧情进度失败:', error);
    res.status(500).json({ 
      success: false,
      error: '获取用户剧情进度失败，请稍后重试' 
    });
  }
});

/**
 * 完成任务
 * POST /api/story/tasks/:taskId/complete
 */
router.post('/tasks/:taskId/complete', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const taskId = parseInt(req.params.taskId, 10);

    // 获取任务信息
    const tasks = await db.query(
      `SELECT id, chapter_id, task_type, task_title, task_description, 
              target_value, stamina_reward, energy_reward
       FROM story_tasks 
       WHERE id = ? AND is_active = 1`,
      [taskId]
    );

    if (tasks.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: '任务不存在' 
      });
    }

    const task = tasks[0];

    // 获取用户任务进度
    const taskProgresses = await db.query(
      `SELECT progress_value, is_completed 
       FROM user_task_progress 
       WHERE user_id = ? AND task_id = ?`,
      [userId, taskId]
    );

    let taskProgress = taskProgresses.length > 0 ? taskProgresses[0] : null;

    // 检查是否已完成
    if (taskProgress && taskProgress.is_completed === 1) {
      return res.status(400).json({ 
        success: false,
        error: '任务已完成' 
      });
    }

    // 检查完成条件
    const progressValue = taskProgress ? taskProgress.progress_value : 0;
    const targetValue = task.target_value || 1;

    if (progressValue < targetValue) {
      return res.status(400).json({ 
        success: false,
        error: '任务进度不足，无法完成',
        progress: progressValue,
        target: targetValue
      });
    }

    // 使用事务处理任务完成和奖励发放
    await db.transaction(async (conn) => {
      // 更新或插入任务进度
      if (taskProgress) {
        await conn.execute(
          `UPDATE user_task_progress 
           SET is_completed = 1, completed_at = NOW() 
           WHERE user_id = ? AND task_id = ?`,
          [userId, taskId]
        );
      } else {
        await conn.execute(
          `INSERT INTO user_task_progress (user_id, task_id, progress_value, is_completed, completed_at) 
           VALUES (?, ?, ?, 1, NOW())`,
          [userId, taskId, targetValue]
        );
      }

      // 发放体力奖励（任务奖励不受上限限制）
      if (task.stamina_reward > 0) {
        await conn.execute(
          `UPDATE users 
           SET stamina = stamina + ? 
           WHERE id = ?`,
          [task.stamina_reward, userId]
        );
      }

      // 发放能量奖励（可选，有上限保护）
      if (task.energy_reward > 0) {
        await conn.execute(
          `UPDATE users 
           SET energy = LEAST(100, energy + ?) 
           WHERE id = ?`,
          [task.energy_reward, userId]
        );
      }
    });

    // 获取更新后的用户状态
    const user = await db.query(
      'SELECT stamina, energy FROM users WHERE id = ?',
      [userId]
    );

    res.json({
      success: true,
      message: '任务完成',
      rewards: {
        stamina: task.stamina_reward,
        energy: task.energy_reward
      },
      userStatus: {
        stamina: user[0].stamina,
        energy: user[0].energy
      }
    });
  } catch (error) {
    console.error('完成任务失败:', error);
    res.status(500).json({ 
      success: false,
      error: '完成任务失败，请稍后重试' 
    });
  }
});

/**
 * 更新任务进度
 * POST /api/story/tasks/:taskId/progress
 */
router.post('/tasks/:taskId/progress', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const taskId = parseInt(req.params.taskId, 10);
    const { progressValue, increment = false } = req.body;

    if (progressValue === undefined && !increment) {
      return res.status(400).json({ 
        success: false,
        error: '请提供进度值或使用增量模式' 
      });
    }

    // 获取任务信息
    const tasks = await db.query(
      `SELECT id, target_value 
       FROM story_tasks 
       WHERE id = ? AND is_active = 1`,
      [taskId]
    );

    if (tasks.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: '任务不存在' 
      });
    }

    const task = tasks[0];

    // 获取当前进度
    const taskProgresses = await db.query(
      `SELECT progress_value, is_completed 
       FROM user_task_progress 
       WHERE user_id = ? AND task_id = ?`,
      [userId, taskId]
    );

    let currentProgress = taskProgresses.length > 0 ? taskProgresses[0].progress_value : 0;
    const isCompleted = taskProgresses.length > 0 && taskProgresses[0].is_completed === 1;

    // 如果已完成，不更新进度
    if (isCompleted) {
      return res.json({
        success: true,
        message: '任务已完成，无需更新',
        progress: currentProgress
      });
    }

    // 计算新进度
    let newProgress;
    if (increment) {
      newProgress = currentProgress + (progressValue || 1);
    } else {
      newProgress = Math.max(currentProgress, progressValue);
    }

    // 确保不超过目标值（如果设置了目标值）
    if (task.target_value !== null) {
      newProgress = Math.min(newProgress, task.target_value);
    }

    // 更新或插入进度
    if (taskProgresses.length > 0) {
      await db.query(
        `UPDATE user_task_progress 
         SET progress_value = ?, updated_at = NOW() 
         WHERE user_id = ? AND task_id = ?`,
        [newProgress, userId, taskId]
      );
    } else {
      await db.query(
        `INSERT INTO user_task_progress (user_id, task_id, progress_value) 
         VALUES (?, ?, ?)`,
        [userId, taskId, newProgress]
      );
    }

    // 检查是否达到完成条件
    const targetValue = task.target_value || 1;
    const shouldComplete = newProgress >= targetValue;

    res.json({
      success: true,
      message: '进度更新成功',
      progress: newProgress,
      target: targetValue,
      canComplete: shouldComplete
    });
  } catch (error) {
    console.error('更新任务进度失败:', error);
    res.status(500).json({ 
      success: false,
      error: '更新任务进度失败，请稍后重试' 
    });
  }
});

/**
 * 完成章节
 * POST /api/story/chapters/:chapterId/complete
 */
router.post('/chapters/:chapterId/complete', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const chapterId = parseInt(req.params.chapterId, 10);

    // 获取章节信息
    const chapters = await db.query(
      `SELECT id, chapter_number, chapter_title, completion_condition, 
              stamina_reward, energy_reward
       FROM story_chapters 
       WHERE id = ? AND is_active = 1`,
      [chapterId]
    );

    if (chapters.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: '章节不存在' 
      });
    }

    const chapter = chapters[0];

    // 获取章节所有任务
    const tasks = await db.query(
      `SELECT id 
       FROM story_tasks 
       WHERE chapter_id = ? AND is_active = 1`,
      [chapterId]
    );

    // 检查所有任务是否完成
    if (tasks.length > 0) {
      const taskIds = tasks.map(t => t.id);
      const completedTasks = await db.query(
        `SELECT COUNT(*) as count 
         FROM user_task_progress 
         WHERE user_id = ? AND task_id IN (?) AND is_completed = 1`,
        [userId, taskIds]
      );

      if (completedTasks[0].count < tasks.length) {
        return res.status(400).json({ 
          success: false,
          error: '章节任务未全部完成，无法完成章节',
          completed: completedTasks[0].count,
          total: tasks.length
        });
      }
    }

    // 检查章节是否已完成
    const chapterProgresses = await db.query(
      `SELECT is_completed 
       FROM user_story_progress 
       WHERE user_id = ? AND chapter_id = ?`,
      [userId, chapterId]
    );

    if (chapterProgresses.length > 0 && chapterProgresses[0].is_completed === 1) {
      return res.status(400).json({ 
        success: false,
        error: '章节已完成' 
      });
    }

    // 使用事务处理章节完成和奖励发放
    await db.transaction(async (conn) => {
      // 更新或插入章节进度
      if (chapterProgresses.length > 0) {
        await conn.execute(
          `UPDATE user_story_progress 
           SET is_completed = 1, completed_at = NOW() 
           WHERE user_id = ? AND chapter_id = ?`,
          [userId, chapterId]
        );
      } else {
        await conn.execute(
          `INSERT INTO user_story_progress (user_id, chapter_id, is_completed, completed_at) 
           VALUES (?, ?, 1, NOW())`,
          [userId, chapterId]
        );
      }

      // 发放体力奖励（章节奖励不受上限限制）
      if (chapter.stamina_reward > 0) {
        await conn.execute(
          `UPDATE users 
           SET stamina = stamina + ? 
           WHERE id = ?`,
          [chapter.stamina_reward, userId]
        );
      }

      // 发放能量奖励（可选，有上限保护）
      if (chapter.energy_reward > 0) {
        await conn.execute(
          `UPDATE users 
           SET energy = LEAST(100, energy + ?) 
           WHERE id = ?`,
          [chapter.energy_reward, userId]
        );
      }
    });

    // 获取更新后的用户状态
    const user = await db.query(
      'SELECT stamina, energy FROM users WHERE id = ?',
      [userId]
    );

    res.json({
      success: true,
      message: '章节完成',
      rewards: {
        stamina: chapter.stamina_reward,
        energy: chapter.energy_reward
      },
      userStatus: {
        stamina: user[0].stamina,
        energy: user[0].energy
      }
    });
  } catch (error) {
    console.error('完成章节失败:', error);
    res.status(500).json({ 
      success: false,
      error: '完成章节失败，请稍后重试' 
    });
  }
});

module.exports = router;
