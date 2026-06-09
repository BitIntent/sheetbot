#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批量更新所有工具函数
"""
import re
from pathlib import Path

def update_tool_file():
    file_path = Path(__file__).parent / 'excel_tools.py'
    
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 匹配模式：async def 函数名 ... return { "content": [...], "operation": {...} }
    # 需要匹配整个函数体
    pattern = r'(async def (\w+)\(args: Dict\[str, Any\]\) -> Dict\[str, Any\]:\s*"""[^"]*"""\s*)(.*?)(return \{\s*"content":\s*\[\{\s*"type":\s*"text",\s*"text":\s*"([^"]+)"\s*\}\],\s*"operation":\s*(\{.*?\})\s*\})'
    
    def replace_function(match):
        func_def = match.group(1)  # async def ... """
        func_name = match.group(2)  # 函数名
        func_body = match.group(3)  # 函数体（return之前的部分）
        desc = match.group(4)  # 描述文本
        operation_dict = match.group(5)  # operation字典
        
        # 检查是否已经更新过
        if '_create_tool_result' in func_body or '_log_tool_call' in func_body:
            return match.group(0)  # 已更新，跳过
        
        # 构建新函数
        new_func = func_def
        if '_log_tool_call' not in func_body:
            new_func += f'    _log_tool_call("{func_name}", args)\n'
        new_func += func_body
        new_func += f'''    operation = {operation_dict}
    result = _create_tool_result(
        operation,
        f"{desc}"
    )
    _log_tool_result("{func_name}", {{"operation": operation}})
    return result'''
        
        return new_func
    
    # 执行替换（使用 DOTALL 以匹配多行）
    new_content = re.sub(pattern, replace_function, content, flags=re.DOTALL)
    
    # 备份
    backup_path = file_path.with_suffix('.py.bak')
    with open(backup_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'已备份到: {backup_path}')
    
    # 保存
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    # 统计
    old_count = len(re.findall(r'return \{\s*"content":\s*\[.*?\],\s*"operation":', content, re.DOTALL))
    new_count = len(re.findall(r'_create_tool_result\(', new_content))
    
    print(f'更新完成！')
    print(f'旧格式: {old_count} 个')
    print(f'新格式: {new_count} 个')

if __name__ == '__main__':
    update_tool_file()
