/**
 * 解析华夏五千年小说
 */
const fs = require('fs');

const SOURCE_FILE = 'e:\\工作\\清风\\华夏五千年-无水印.txt';
const OUTPUT_FILE = 'huaxia5000.json';

const content = fs.readFileSync(SOURCE_FILE, 'utf8');
const lines = content.split(/\r?\n/);

console.log('文件总行数:', lines.length);

// 1. 解析目录 - 从第3页(行44-127)
const toc = [];
console.log('\n解析目录区域(第3页)...');

for (let i = 44; i < 127; i++) {
  const line = lines[i]?.trim();
  if (!line) continue;
  
  // 跳过页码标记
  if (line.match(/^--- 第/)) continue;
  
  // 跳过"目录"标题
  if (line === '目' || line === '录' || line === '目录') continue;
  
  // 跳过空行
  if (!line) continue;
  
  // 日期格式：2024.xx.xx 或 2024.xx.xx-xxx
  const dateMatch = line.match(/^(\d{4}\.\d{2}\.\d{2}(?:-\d{2})?)$/);
  if (dateMatch) {
    // 下一行是标题
    const nextLine = lines[i + 1]?.trim();
    if (nextLine && !nextLine.match(/^\d{4}\./) && nextLine.length > 0) {
      toc.push({
        date: dateMatch[1],
        title: nextLine
      });
    }
  }
}

console.log('目录解析:', toc.length, '条');
console.log('前10条:');
toc.slice(0, 10).forEach((t, i) => console.log(`  ${i+1}. ${t.title} - ${t.date}`));

// 2. 解析正文 - 从第4页开始
const chapters = [];
let currentChapter = null;
let inContent = false;

console.log('\n解析正文...');

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]?.trim();
  
  // 正文开始于第4页
  if (line === '--- 第 4 页 ---') {
    inContent = true;
    continue;
  }
  
  if (!inContent) continue;
  
  // 检测章节号（单独的数字）
  const chMatch = line?.match(/^(\d+)$/);
  if (chMatch) {
    // 保存上一章
    if (currentChapter && currentChapter.content.length > 0) {
      chapters.push(currentChapter);
    }
    
    const id = parseInt(chMatch[1]);
    const tocItem = toc[id - 1] || {};
    
    currentChapter = {
      id: id,
      title: tocItem.title || `第${id}章`,
      date: tocItem.date || '',
      volume: '第一卷',
      content: []
    };
    continue;
  }
  
  // 收集内容
  if (currentChapter && line) {
    // 跳过页码标记和日期行
    if (!line.match(/^--- 第/) && !line.match(/^\d{4}\./)) {
      currentChapter.content.push(line);
    }
  }
}

// 保存最后一章
if (currentChapter && currentChapter.content.length > 0) {
  chapters.push(currentChapter);
}

// 合并内容
chapters.forEach(ch => {
  ch.content = ch.content.join('\n\n').trim();
});

console.log('\n解析结果:', chapters.length, '章');
console.log('\n前15章:');
chapters.slice(0, 15).forEach((ch, i) => {
  console.log(`${i+1}. ${ch.title} - ${ch.date} - ${ch.content.length}字`);
});

console.log('\n后5章:');
chapters.slice(-5).forEach((ch, i) => {
  console.log(`${chapters.length-4+i}. ${ch.title} - ${ch.date} - ${ch.content.length}字`);
});

// 保存
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(chapters, null, 2), 'utf8');
console.log(`\n已保存到 ${OUTPUT_FILE}，共 ${chapters.length} 章`);
