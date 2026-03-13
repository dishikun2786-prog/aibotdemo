#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
胄空形仙传 TXT章节提取脚本
从水印版TXT文件中提取完整的章节数据
"""

import re
import json
from pathlib import Path

# TXT源文件路径
TXT_FILE = r"e:\工作\清风\胄空形仙传（上）水印版.txt"
OUTPUT_FILE = r"d:\phpstudy_pro\WWW\aibot1\novel_chapters.json"

def read_file(path):
    """读取TXT文件"""
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()

def parse_toc(content):
    """解析目录部分，提取章节列表"""
    chapters = []
    
    # 分割内容为行
    lines = content.split('\n')
    
    # 状态变量
    in_toc = False
    current_volume = "第一卷"
    chapter_id = 0
    
    # 用于匹配日期格式 2025.XX.XX
    date_pattern = re.compile(r'^(\d{4}\.\d{2}\.\d{2})$')
    # 用于匹配页码
    page_pattern = re.compile(r'^(\d+)$')
    
    # 临时存储
    temp_date = None
    temp_title = None
    temp_page = None
    
    # 遍历所有行
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        
        # 检测卷次开始
        if line in ["第一卷", "第二卷", "第三卷", "番外篇"]:
            current_volume = line
            # 番外篇后续可能有编号，需要特殊处理
            if line == "番外篇" and i + 1 < len(lines):
                next_line = lines[i + 1].strip()
                if next_line.isdigit():
                    # 番外篇可能有子标题如"芽修传"
                    pass
            i += 1
            continue
        
        # 匹配日期
        date_match = date_pattern.match(line)
        if date_match:
            temp_date = date_match.group(1)
            # 继续获取标题
            if i + 1 < len(lines):
                next_line = lines[i + 1].strip()
                # 标题可能是多行的，需要处理
                if next_line and not page_pattern.match(next_line) and not date_pattern.match(next_line):
                    temp_title = next_line
                    i += 1
                    # 继续获取页码
                    if i + 1 < len(lines):
                        page_line = lines[i + 1].strip()
                        page_match = page_pattern.match(page_line)
                        if page_match:
                            temp_page = int(page_match.group(1))
                            # 找到完整记录，添加到章节列表
                            chapter_id += 1
                            chapters.append({
                                'id': chapter_id,
                                'date': temp_date,
                                'title': temp_title,
                                'volume': current_volume,
                                'page': temp_page
                            })
                            # 重置临时变量
                            temp_date = None
                            temp_title = None
                            temp_page = None
            i += 1
            continue
        
        i += 1
    
    return chapters

def extract_content_by_page(content, chapters):
    """根据页码提取章节内容"""
    # 分割内容为页
    pages = re.split(r'--- 第 (\d+) 页 ---', content)
    
    # pages[0] 是第一页之前的内容，pages[1]是第1页的页码，pages[2]是第1页的内容...
    page_contents = {}
    for i in range(1, len(pages), 2):
        page_num = int(pages[i])
        page_content = pages[i + 1] if i + 1 < len(pages) else ""
        page_contents[page_num] = page_content
    
    # 为每个章节填充内容
    for chapter in chapters:
        page_num = chapter.get('page')
        if page_num and page_num in page_contents:
            chapter['content'] = page_contents[page_num].strip()
        else:
            chapter['content'] = ""
    
    return chapters

def parse_toc_v2(content):
    """更智能地解析目录"""
    chapters = []
    
    lines = content.split('\n')
    
    current_volume = "第一卷"
    chapter_id = 0
    
    # 跳过前几页的封面和目录标题
    in_toc_section = False
    i = 0
    
    while i < len(lines):
        line = lines[i].strip()
        
        # 跳过空行
        if not line:
            i += 1
            continue
        
        # 检测卷次
        if line in ["第一卷", "第二卷", "第三卷"]:
            current_volume = line
            in_toc_section = True
            i += 1
            continue
        elif "番外篇" in line:
            current_volume = "番外篇"
            in_toc_section = True
            i += 1
            continue
        
        # 如果在目录区域，尝试匹配日期
        if in_toc_section:
            # 匹配日期格式 2025.XX.XX
            date_match = re.match(r'^(\d{4}\.\d{2}\.\d{2})$', line)
            if date_match:
                date = date_match.group(1)
                
                # 下一行是标题
                if i + 1 < len(lines):
                    title = lines[i + 1].strip()
                    # 跳过可能的标题为空的情况
                    if not title or re.match(r'^\d+$', title):
                        i += 1
                        continue
                    
                    # 再下一行是页码
                    if i + 2 < len(lines):
                        page_str = lines[i + 2].strip()
                        page_match = re.match(r'^(\d+)$', page_str)
                        if page_match:
                            chapter_id += 1
                            chapters.append({
                                'id': chapter_id,
                                'date': date,
                                'title': title,
                                'volume': current_volume,
                                'page': int(page_match.group(1))
                            })
                            i += 3
                            continue
                i += 1
                continue
        
        i += 1
    
    return chapters

def main():
    print("开始读取TXT文件...")
    content = read_file(TXT_FILE)
    print(f"文件总长度: {len(content)} 字符")
    
    print("\n解析目录...")
    chapters = parse_toc_v2(content)
    print(f"找到 {len(chapters)} 个章节")
    
    # 按卷次统计
    volumes = {}
    for ch in chapters:
        vol = ch['volume']
        volumes[vol] = volumes.get(vol, 0) + 1
    
    print("\n各卷章节数量:")
    for vol, count in volumes.items():
        print(f"  {vol}: {count} 章")
    
    # 显示前10个章节
    print("\n前10个章节:")
    for ch in chapters[:10]:
        print(f"  {ch['id']}. {ch['title']} ({ch['date']}) - 第{ch['page']}页")
    
    # 保存为JSON
    print(f"\n保存到 {OUTPUT_FILE}...")
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(chapters, f, ensure_ascii=False, indent=2)
    
    print("完成!")
    return chapters

if __name__ == "__main__":
    main()
