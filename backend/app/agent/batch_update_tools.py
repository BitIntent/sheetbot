#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批量更新所有工具函数，将 operation 放入 content 中
"""
import re
from pathlib import Path

def main():
    file_path = Path(__file__).parent / 'excel_tools.py'
    
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 模式：匹配 return { "content": [{...}], "operation": {...} }
    pattern = r'(\s+)(return \{\s*"content":\s*\[\{\s*"type":\s*"text",\s*"text":\s*"([^"]+)"\s*\}\],\s*"operation":\s*(\{.*?\})\s*\})'
    
    def replace_func(match):
        indent = match.group(1)
        full_return = match.group(2)
        desc = match.group(3)
        operation_dict = match.group(4)
        
        # 提取 operation type
        op_type_match = re.search(r'"type":\s*"([^"]+)"', operation_dict)
        op_type = op_type_match.group(1) if op_type_match else 'unknown'
        
        # 查找函数名（向前查找最近的函数定义）
        before_text = content[:match.start()]
        func_match = re.search(r'async def (\w+)\(args:', before_text[-500:])
        func_name = func_match.group(1) if func_match else op_type
        
        # 检查是否已经有日志调用
        func_start = before_text.rfind(f'async def {func_name}')
        func_body = content[func_start:match.start()]
        has_log = '_log_tool_call' in func_body
        
        # 构建新的返回语句
        new_code = ''
        if not has_log:
            new_code += f'{indent}_log_tool_call("{func_name}", args)\n'
        
        new_code += f'''{indent}operation = {operation_dict}
{indent}result = _create_tool_result(
{indent}    operation,
{indent}    f"{desc}"
{indent})
{indent}_log_tool_result("{func_name}", {{"operation": operation}})
{indent}return result'''
        
        return new_code
    
    # 执行替换
    new_content = re.sub(pattern, replace_func, content, flags=re.DOTALL | re.MULTILINE)
    
    # 备份原文件
    backup_path = file_path.with_suffix('.py.bak')
    with open(backup_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'已备份原文件到: {backup_path}')
    
    # 保存新文件
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    # 统计更新数量
    old_count = len(re.findall(r'return \{\s*"content":\s*\[.*?\],\s*"operation":', content, re.DOTALL))
    new_count = len(re.findall(r'_create_tool_result\(', new_content))
    
    print(f'更新完成！')
    print(f'旧格式函数数: {old_count}')
    print(f'新格式函数数: {new_count}')

if __name__ == '__main__':
    main()
