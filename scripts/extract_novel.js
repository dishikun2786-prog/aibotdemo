#!/usr/bin/env node
/**
 * 胄空形仙传 TXT章节提取脚本 (完整版)
 * 从水印版TXT文件中提取所有章节数据
 */

const fs = require('fs');
const path = require('path');

// TXT源文件路径
const TXT_FILE = 'e:\\工作\\清风\\胄空形仙传（上）水印版.txt';
const OUTPUT_FILE = 'd:\\phpstudy_pro\\WWW\\aibot1\\novel_chapters.json';

function readFile(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

// 根据日期确定卷次
function getVolumeByDate(date) {
    if (date >= '2025.02.05' && date < '2025.03.03') return '第一卷';
    if (date >= '2025.03.03' && date < '2025.04.30') return '第二卷';
    if (date >= '2025.04.30' && date < '2025.07.01') return '第三卷';
    return '番外篇';
}

function parseToc(content) {
    const chapters = [];
    const lines = content.split('\n');
    
    let chapterId = 0;
    let pendingDate = null;
    
    // 匹配日期格式 2025.XX.XX
    const datePattern = /^(\d{4}\.\d{2}\.\d{2})$/;
    // 匹配页码（纯数字）
    const pagePattern = /^(\d+)$/;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // 跳过空行
        if (!line) {
            pendingDate = null;
            continue;
        }
        
        // 跳过目录标题和页码标题行
        if (line === '目录' || line.includes('直播日期') || line.includes('当日内容简介') || line.includes('页码')) {
            continue;
        }
        
        // 检测卷次标记行 - 这些行只是标记，不作为章节
        if (line === '第一卷' || line === '第二卷' || line === '第三卷' || 
            (line.includes('番外篇') && !line.includes('芽修传') && !line.includes('（'))) {
            continue;
        }
        
        // 跳过特殊章节分类标题（如"芽修传"）
        if (line === '芽修传') {
            continue;
        }
        
        // 尝试匹配日期
        const dateMatch = line.match(datePattern);
        if (dateMatch) {
            pendingDate = dateMatch[1];
            
            // 继续查找标题
            if (i + 1 < lines.length) {
                const titleLine = lines[i + 1].trim();
                
                // 标题不能是纯数字或空
                if (titleLine && !pagePattern.test(titleLine) && titleLine.length > 1) {
                    // 继续查找页码
                    if (i + 2 < lines.length) {
                        const pageLine = lines[i + 2].trim();
                        const pageMatch = pageLine.match(pagePattern);
                        
                        if (pageMatch) {
                            const pageNum = parseInt(pageMatch[1], 10);
                            
                            // 正文从第6页开始
                            if (pageNum >= 6) {
                                chapterId++;
                                chapters.push({
                                    id: chapterId,
                                    date: pendingDate,
                                    title: titleLine,
                                    volume: getVolumeByDate(pendingDate),
                                    page: pageNum
                                });
                                
                                pendingDate = null;
                                i += 2; // 跳过标题和页码行
                                continue;
                            }
                        }
                    }
                }
            }
        }
        
        pendingDate = null;
    }
    
    return chapters;
}

function extractContentByPage(content, chapters) {
    // 按页分割内容
    const pageRegex = /--- 第 (\d+) 页 ---/g;
    const pageMatches = [...content.matchAll(pageRegex)];
    
    const pageContents = {};
    for (const match of pageMatches) {
        const pageNum = parseInt(match[1], 10);
        const startPos = match.index + match[0].length;
        
        // 找到下一页的开始位置
        let endPos = content.length;
        const nextMatch = pageMatches.find(m => m.index > startPos);
        if (nextMatch) {
            endPos = nextMatch.index;
        }
        
        pageContents[pageNum] = content.substring(startPos, endPos).trim();
    }
    
    // 为每个章节填充内容
    const pagePattern = /^(\d+)$/;
    const datePattern = /^(\d{4}\.\d{2}\.\d{2})$/;
    
    for (const chapter of chapters) {
        const pageNum = chapter.page;
        if (pageContents[pageNum]) {
            let rawContent = pageContents[pageNum];
            const contentLines = rawContent.split('\n');
            let contentStartIndex = 0;
            
            // 跳过前面的页码、日期、标题
            for (let j = 0; j < contentLines.length; j++) {
                const l = contentLines[j].trim();
                if (pagePattern.test(l) || datePattern.test(l)) {
                    contentStartIndex = j + 1;
                } else if (l && l !== chapter.title && l.length > 0 && !pagePattern.test(l)) {
                    break;
                }
            }
            
            chapter.content = contentLines.slice(contentStartIndex).join('\n').trim();
        } else {
            chapter.content = '';
        }
    }
    
    return chapters;
}

function main() {
    console.log('开始读取TXT文件...');
    const content = readFile(TXT_FILE);
    console.log(`文件总长度: ${content.length} 字符`);
    
    console.log('\n解析目录...');
    const chapters = parseToc(content);
    console.log(`找到 ${chapters.length} 个章节`);
    
    // 按卷次统计
    const volumes = {};
    for (const ch of chapters) {
        const vol = ch.volume;
        volumes[vol] = (volumes[vol] || 0) + 1;
    }
    
    console.log('\n各卷章节数量:');
    for (const [vol, count] of Object.entries(volumes)) {
        console.log(`  ${vol}: ${count} 章`);
    }
    
    // 显示所有章节
    console.log('\n所有章节列表:');
    let currentVol = '';
    for (const ch of chapters) {
        if (ch.volume !== currentVol) {
            currentVol = ch.volume;
            console.log(`\n=== ${currentVol} ===`);
        }
        console.log(`  ${ch.id}. ${ch.title} (${ch.date}) - 第${ch.page}页`);
    }
    
    // 提取内容
    console.log('\n\n提取章节内容...');
    const chaptersWithContent = extractContentByPage(content, chapters);
    
    // 保存为JSON
    console.log(`\n保存到 ${OUTPUT_FILE}...`);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(chaptersWithContent, null, 2), 'utf8');
    
    console.log('完成!');
    
    // 统计内容长度
    let totalContentLength = 0;
    for (const ch of chaptersWithContent) {
        totalContentLength += (ch.content || '').length;
    }
    console.log(`\n总内容长度: ${totalContentLength} 字符`);
    console.log(`平均每章长度: ${Math.round(totalContentLength / chaptersWithContent.length)} 字符`);
    
    return chaptersWithContent;
}

main();
