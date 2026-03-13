/**
 * 华夏五千年小说解析脚本 v11
 * 简单策略：直接解析所有章节，日期+标题在同一行或分两行
 */
const fs = require('fs');

const SOURCE_FILE = 'e:\\工作\\清风\\华夏五千年-无水印.txt';
const OUTPUT_FILE = 'huaxia5000.json';

const content = fs.readFileSync(SOURCE_FILE, 'utf8');
const lines = content.split(/\r?\n/);

console.log('文件总行数:', lines.length);

// 正文从第6页开始
let contentStart = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i]?.trim() === '--- 第 6 页 ---') {
    contentStart = i + 1;
    break;
  }
}
console.log('正文开始于行', contentStart);

// 找到所有章节号
const chapters = [];
let currentChapter = null;
let currentContent = [];

const dateRegex = /^(\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{1,2}\.\d{1,2})?)$/;
const dateTitleRegex = /^(\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{1,2}\.\d{1,2})?)\s+(.+)$/;

for (let i = contentStart; i < lines.length; i++) {
  const line = lines[i]?.trim();
  const nextLine = lines[i + 1]?.trim();
  
  // 匹配章节号（单独数字行）
  const idMatch = line?.match(/^(\d+)$/);
  if (idMatch && line.length <= 3) {
    // 保存上一章
    if (currentChapter) {
      currentChapter.content = currentContent.join('\n').trim();
      if (currentChapter.content) {
        chapters.push(currentChapter);
      }
    }
    
    currentChapter = {
      id: parseInt(idMatch[1]),
      date: '',
      title: '',
      volume: '第一卷',
      content: []
    };
    currentContent = [];
    
    // 检查下一行是否是 "日期 标题" 格式
    if (nextLine) {
      const dateTitleMatch = nextLine.match(dateTitleRegex);
      if (dateTitleMatch) {
        currentChapter.date = dateTitleMatch[1];
        currentChapter.title = dateTitleMatch[2];
        i++; // 跳过日期标题行
      } else if (dateRegex.test(nextLine)) {
        // 只有日期，下下一行是标题
        currentChapter.date = nextLine;
        const titleLine = lines[i + 2]?.trim();
        if (titleLine && !titleLine.match(/^\d{4}\./) && !titleLine.match(/^---/)) {
          currentChapter.title = titleLine;
          i += 2; // 跳过日期和标题行
        }
      }
    }
    
    continue;
  }
  
  // 收集内容
  if (currentChapter && line) {
    if (!line.match(/^--- 第/)) {
      currentContent.push(line);
    }
  }
}

// 保存最后一章
if (currentChapter) {
  currentChapter.content = currentContent.join('\n').trim();
  if (currentChapter.content) {
    chapters.push(currentChapter);
  }
}

// 按ID排序并去重
const chapterMap = new Map();
chapters.forEach(ch => {
  if (!chapterMap.has(ch.id)) {
    chapterMap.set(ch.id, ch);
  }
});

const finalChapters = Array.from(chapterMap.values()).sort((a, b) => a.id - b.id);

console.log('解析完成:', finalChapters.length, '章');

// 显示
console.log('\n========== 前30章 ==========');
finalChapters.slice(0, 30).forEach(ch => {
  console.log(`${ch.id}. ${ch.title || '无标题'} (${ch.date}) - ${ch.content.length}字`);
});

console.log('\n========== 后15章 ==========');
finalChapters.slice(-15).forEach(ch => {
  console.log(`${ch.id}. ${ch.title || '无标题'} (${ch.date}) - ${ch.content.length}字`);
});

const noTitle = finalChapters.filter(ch => !ch.title);
console.log('\n无标题:', noTitle.length, '个');

const noContent = finalChapters.filter(ch => !ch.content || ch.content.length < 10);
console.log('无内容:', noContent.length, '个');

// 保存
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalChapters, null, 2), 'utf8');
console.log(`\n已保存到 ${OUTPUT_FILE}`);
