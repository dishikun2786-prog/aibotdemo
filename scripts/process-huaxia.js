/**
 * 华夏五千年文档处理脚本 - 最终版
 * 将 txt 文档转换为 MongoDB 导入的 JSON 格式
 */

const fs = require('fs');
const path = require('path');

// 读取文件
const filePath = 'e:\\工作\\清风\\华夏五千年-无水印.txt';
const content = fs.readFileSync(filePath, 'utf8');

// 扩展分类规则
const categories = {
  '修行觉醒': ['老奶奶考题', '念与想', '入静', '如何正确读经', '关于觉醒', '道、法', '道，法', '六边形战士', '水滴法', '向内求', '六十四象', '觉醒', '端心法', '专注与沟通', '真正的大能运道', '天一明神', '修行散聊', '修行第三课', '一楼', '正心佛', '三觉一法', '放下', '见道', '了凡四训', '承', '能量是什么'],
  '神话传说': ['伏羲', '神农', '轩辕', '黄帝', '大禹', '封神榜', '新白娘子传奇', '蜀山', '鬼谷子', '真武大帝', '济公', '陈抟', '持道', '萨守坚', '张伯端', '曹雪芹', '程白生', '女娲', '盘古', '玄武门'],
  '历史朝代': ['秦朝', '西周', '东周', '战国', '汉朝', '东汉', '两晋', '南北朝', '唐朝', '宋朝', '北宋', '南宋', '明朝', '清朝', '商朝', '三国', '元朝', '隋唐', '白莲教', '天地会'],
  '历史人物': ['谋士', '武将', '主公', '狄仁杰', '武则天', '李白', '包拯', '王安石', '苏轼', '杨家将', '邵雍', '沈括', '朱熹', '李清照', '宋慈', '朱重八', '朱元璋', '刘伯温', '沈万三', '唐伯虎', '王阳明', '吴承恩', '金瓶梅', '朱由校', '朱由检', '李自成', '秦良玉', '吴三桂', '孝庄', '金圣叹', '郑成功', '郑经', '鳌拜', '康熙', '雍正', '和珅', '刘墉', '邬思道', '慈禧', '咒娘'],
  '天地大战': ['地战', '六十四象前传', '残', '魁', '三武一宗', '灭佛', '天地大战', '第二次天地大战', '天界战场', '妖氏', '魔的由来', '符生门', '十八门', '亏孽', '日本幕府', '十难咒', '郭守真', '郭守珍'],
  '知识科普': ['文明1.0', '文明进程', '五帝', '二十四节气', '北斗七星', '七十二道', '胡黄', '天璇玑', '地璇玑', '人璇玑', '天地之法']
};

// 确定文章分类
function getCategory(title) {
  for (const [category, keywords] of Object.entries(categories)) {
    for (const keyword of keywords) {
      if (title.includes(keyword)) {
        return category;
      }
    }
  }
  return '其他';
}

// 改进的解析逻辑
function parseContent(content) {
  const lines = content.split('\n');
  const articles = [];
  
  let currentArticle = null;
  let contentLines = [];
  let pageNumber = 0;
  
  // 跳过目录页
  let afterToc = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // 检测页码
    const pageMatch = line.match(/^--- 第\s*(\d+)\s*页\s*---$/);
    if (pageMatch) {
      pageNumber = parseInt(pageMatch[1]);
      // 第6页开始是正文
      if (pageNumber >= 6) {
        afterToc = true;
      }
      continue;
    }
    
    // 跳过页码数字行
    if (line.match(/^(\d+)$/) && parseInt(line) > 100) {
      continue;
    }
    
    // 跳过目录页
    if (!afterToc) continue;
    
    // 检测带标题的日期行: 2024.10.05 老奶奶考题
    const titleDateMatch = line.match(/^(\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{1,2}\.\d{1,2})?)\s+(.+)$/);
    
    // 检测只有日期的行
    const onlyDateMatch = line.match(/^(\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{1,2}\.\d{1,2})?)$/);
    
    if (titleDateMatch) {
      // 保存之前的文章
      if (currentArticle && contentLines.length > 0) {
        const fullContent = contentLines.join('\n').trim();
        // 过滤掉目录内容
        if (fullContent.length > 100 && !fullContent.includes('目录')) {
          currentArticle.content = fullContent;
          articles.push(currentArticle);
        }
      }
      
      // 新文章 - 有完整标题
      const title = titleDateMatch[2].trim();
      currentArticle = {
        title: title,
        date: titleDateMatch[1],
        category: getCategory(title),
        content: '',
        tags: [getCategory(title)],
        page: pageNumber
      };
      
      contentLines = [];
      continue;
    } else if (onlyDateMatch && i + 1 < lines.length) {
      const nextLine = lines[i + 1].trim();
      
      // 保存之前的文章
      if (currentArticle && contentLines.length > 0) {
        const fullContent = contentLines.join('\n').trim();
        if (fullContent.length > 100 && !fullContent.includes('目录')) {
          currentArticle.content = fullContent;
          articles.push(currentArticle);
        }
      }
      
      const title = nextLine || '无标题';
      currentArticle = {
        title: title,
        date: onlyDateMatch[1],
        category: getCategory(title),
        content: '',
        tags: [getCategory(title)],
        page: pageNumber
      };
      
      contentLines = [];
      i++; // 跳过下一行
      continue;
    }
    
    // 收集内容
    if (currentArticle && line && !line.match(/^---/) && pageNumber >= 6) {
      contentLines.push(line);
    }
  }
  
  // 保存最后一篇文章
  if (currentArticle && contentLines.length > 0) {
    const fullContent = contentLines.join('\n').trim();
    if (fullContent.length > 100) {
      currentArticle.content = fullContent;
      articles.push(currentArticle);
    }
  }
  
  return articles;
}

// 主处理流程
console.log('开始处理文档...');

const articles = parseContent(content);

console.log(`共解析出 ${articles.length} 篇文章`);

// 统计分类
const categoryCount = {};
articles.forEach(article => {
  categoryCount[article.category] = (categoryCount[article.category] || 0) + 1;
});

console.log('分类统计:', categoryCount);

// 生成MongoDB导入格式
const mongoData = articles.map((article, index) => ({
  _id: index + 1,
  title: article.title,
  date: article.date,
  category: article.category,
  content: article.content,
  tags: article.tags,
  page: article.page,
  wordCount: article.content.length,
  summary: article.content.substring(0, 100).replace(/\n/g, ' '),
  createdAt: new Date()
}));

// 输出JSON
const outputPath = path.join(__dirname, 'huaxia_wushinian.json');
fs.writeFileSync(outputPath, JSON.stringify(mongoData, null, 2), 'utf8');

console.log(`\nJSON文件已生成: ${outputPath}`);
console.log(`共 ${mongoData.length} 条记录`);

// 生成统计报告
console.log('\n=== 分类统计 ===');
Object.entries(categoryCount).forEach(([cat, count]) => {
  console.log(`${cat}: ${count} 篇`);
});

// 输出文章列表
console.log('\n=== 全部文章列表 ===');
articles.forEach((article, i) => {
  console.log(`${i + 1}. [${article.date}] ${article.title} (${article.category}) - 字数: ${article.content.length}`);
});

// 生成MongoDB导入命令
console.log('\n=== MongoDB导入命令 ===');
console.log(`mongoimport --db aibot --collection huaxia_wushinian --file "${outputPath}" --jsonArray --drop`);
