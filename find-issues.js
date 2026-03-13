const fs = require('fs');

const filePath = 'd:\\phpstudy_pro\\WWW\\aibot1\\public\\novel\\js\\data.js';
const content = fs.readFileSync(filePath, 'utf8');

console.log('=== 查找语法问题 ===\n');

// 1. 查找不完整的对象 (缺少 content 的)
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // 检查是否有 content: 后面没有反引号就开始内容的情况
    if (line.match(/^\s*content:\s*`[^`]*$/)) {
        console.log(`行 ${i+1}: content 开始但未闭合 - ${line.substring(0, 60)}`);
    }
    
    // 检查是否有 title: 后面缺少引号结束的情况
    if (line.match(/title:\s*"[^"]*$/)) {
        console.log(`行 ${i+1}: title 未闭合 - ${line}`);
    }
    
    // 检查是否有 volume: 后面缺少引号结束的情况  
    if (line.match(/volume:\s*"[^"]*$/)) {
        console.log(`行 ${i+1}: volume 未闭合 - ${line}`);
    }
}

// 2. 查找反引号问题
let inTemplate = false;
let templateStart = -1;
for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const openCount = (line.match(/`/g) || []).length;
    
    if (!inTemplate && line.includes('content:')) {
        // 开始找模板字符串
        if (openCount >= 1) {
            if (openCount % 2 === 1) {
                inTemplate = true;
                templateStart = i;
            }
        }
    } else if (inTemplate && openCount > 0) {
        if (openCount % 2 === 0) {
            inTemplate = false;
            templateStart = -1;
        }
    }
}

if (inTemplate) {
    console.log(`\n警告: 模板字符串从第 ${templateStart+1} 行开始未闭合`);
}

// 3. 简单括号匹配检查
let braceCount = 0;
let bracketCount = 0;
let parenCount = 0;

for (const char of content) {
    if (char === '{') braceCount++;
    if (char === '}') braceCount--;
    if (char === '[') bracketCount++;
    if (char === ']') bracketCount--;
    if (char === '(') parenCount++;
    if (char === ')') parenCount--;
}

console.log('\n=== 括号匹配检查 ===');
console.log(`花括号: ${braceCount === 0 ? '匹配' : '不匹配 (' + braceCount + ')'}`);
console.log(`方括号: ${bracketCount === 0 ? '匹配' : '不匹配 (' + bracketCount + ')'}`);
console.log(`圆括号: ${parenCount === 0 ? '匹配' : '不匹配 (' + parenCount + ')'}`);
