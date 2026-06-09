#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
最终批量更新所有剩余工具函数
将旧格式转换为新格式
"""
import re
from pathlib import Path

def main():
    file_path = Path(__file__).parent / 'excel_tools.py'
    
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 匹配所有旧格式的函数返回语句
    # 模式：return { "content": [{ "type": "text", "text": "..." }], "operation": {...} }
    pattern = r'(\s+)(return \{\s*"content":\s*\[\{\s*"type":\s*"text",\s*"text":\s*"([^"]+)"\s*\}\],\s*"operation":\s*(\{.*?\})\s*\})'
    
    def replace_return(match):
        indent = match.group(1)
        desc = match.group(2)
        operation_dict = match.group(3)
        
        # 从 operation 中提取 type 作为函数名
        op_type_match = re.search(r'"type":\s*"([^"]+)"', operation_dict)
        if not op_type_match:
            return match.group(0)  # 无法解析，跳过
        
        op_type = op_type_match.group(1)
        
        # 查找函数名（向前查找最近的函数定义）
        before_text = content[:match.start()]
        func_match = re.search(r'async def (\w+)\(args:', before_text[-300:])
        func_name = func_match.group(1) if func_match else op_type
        
        # 检查是否已经更新过
        func_start_pos = before_text.rfind(f'async def {func_name}')
        if func_start_pos >= 0:
            func_section = content[func_start_pos:match.start()]
            if '_create_tool_result' in func_section or '_log_tool_call' in func_section:
                return match.group(0)  # 已更新，跳过
        
        # 构建新的返回语句
        new_code = f'''{indent}_log_tool_call("{func_name}", args)
{indent}operation = {operation_dict}
{indent}result = _create_tool_result(
{indent}    operation,
{indent}    f"{desc}"
{indent})
{indent}_log_tool_result("{func_name}", {{"operation": operation}})
{indent}return result'''
        
        return new_code
    
    # 执行替换
    new_content = re.sub(pattern, replace_return, content, flags=re.DOTALL | re.MULTILINE)
    
    # 备份
    backup_path = file_path.with_suffix('.py.bak2')
    with open(backup_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'已备份到: {backup_path}')
    
    # 保存
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    # 统计
    old_pattern = r'return \{\s*"content":\s*\[.*?\],\s*"operation":'
    old_count = len(re.findall(old_pattern, content, re.DOTALL))
    new_count = len(re.findall(r'_create_tool_result\(', new_content))
    
    print(f'\n更新完成！')
    print(f'旧格式函数数: {old_count}')
    print(f'新格式函数数: {new_count}')
    print(f'已更新: {old_count - len(re.findall(old_pattern, new_content, re.DOTALL))} 个函数')

if __name__ == '__main__':
    main()
