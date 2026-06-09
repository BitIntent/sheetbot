#!/usr/bin/env python3
"""
批量更新工具函数，将 operation 放入 content 中
"""
import re
import sys
from pathlib import Path

def update_tool_function(content: str, func_name: str) -> str:
    """更新单个工具函数的返回格式"""
    
    # 匹配函数定义到 return 语句之间的内容
    pattern = rf'(async def {func_name}\(args: Dict\[str, Any\]\) -> Dict\[str, Any\]:.*?)(return \{{)'
    
    def replace_func(match):
        func_body = match.group(1)
        return_stmt = match.group(2)
        
        # 检查是否已经使用了 _create_tool_result
        if '_create_tool_result' in func_body:
            return match.group(0)  # 已经更新过，跳过
        
        # 提取 operation 类型名（从函数名推断）
        op_type = func_name.replace('_', '_')
        
        # 添加日志调用
        if '_log_tool_call' not in func_body:
            # 在函数开始处添加日志
            func_body = func_body.replace(
                f'async def {func_name}(args: Dict[str, Any]) -> Dict[str, Any]:',
                f'async def {func_name}(args: Dict[str, Any]) -> Dict[str, Any]:\n    """Tool function"""\n    _log_tool_call("{func_name}", args)'
            )
        
        return func_body + return_stmt
    
    # 匹配 return 语句及其内容
    return_pattern = r'return \{\s*"content":\s*\[\{.*?\}\],\s*"operation":\s*(\{.*?\})\s*\}'
    
    def replace_return(match):
        operation_dict = match.group(1)
        
        # 提取 operation 类型
        op_type_match = re.search(r'"type":\s*"([^"]+)"', operation_dict)
        if not op_type_match:
            return match.group(0)
        
        op_type = op_type_match.group(1)
        
        # 提取描述文本
        desc_match = re.search(r'"text":\s*"([^"]+)"', match.group(0))
        desc = desc_match.group(1) if desc_match else f'Operation: {op_type}'
        
        # 构建新的返回语句
        new_return = f'''    operation = {operation_dict}
    result = _create_tool_result(
        operation,
        f"{desc}"
    )
    _log_tool_result("{func_name}", {{"operation": operation}})
    return result'''
        
        return new_return
    
    # 先替换 return 语句
    content = re.sub(return_pattern, replace_return, content, flags=re.DOTALL)
    
    return content

def main():
    file_path = Path(__file__).parent / 'excel_tools.py'
    
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 查找所有工具函数名
    func_pattern = r'async def (\w+)\(args: Dict\[str, Any\]\) -> Dict\[str, Any\]:'
    functions = re.findall(func_pattern, content)
    
    print(f'找到 {len(functions)} 个工具函数')
    
    # 手动更新剩余的函数（使用更简单的方法）
    # 查找所有 return { "content": [...], "operation": {...} } 模式
    old_pattern = r'(\s+)return \{\s*"content":\s*\[\{\s*"type":\s*"text",\s*"text":\s*"([^"]+)"\s*\}\],\s*"operation":\s*(\{.*?\})\s*\}'
    
    def replace_all_returns(match):
        indent = match.group(1)
        desc = match.group(2)
        operation_dict = match.group(3)
        
        # 提取函数名（从上下文推断）
        # 这里我们需要从 operation 中提取 type
        op_type_match = re.search(r'"type":\s*"([^"]+)"', operation_dict)
        if not op_type_match:
            return match.group(0)
        
        op_type = op_type_match.group(1)
        func_name = op_type  # 假设函数名和 operation type 相同
        
        new_return = f'''{indent}operation = {operation_dict}
{indent}result = _create_tool_result(
{indent}    operation,
{indent}    f"{desc}"
{indent})
{indent}_log_tool_result("{func_name}", {{"operation": operation}})
{indent}return result'''
        
        return new_return
    
    # 执行替换
    new_content = re.sub(old_pattern, replace_all_returns, content, flags=re.DOTALL | re.MULTILINE)
    
    # 为还没有日志的函数添加日志调用
    for func_name in functions:
        func_pattern = rf'(async def {func_name}\(args: Dict\[str, Any\]\) -> Dict\[str, Any\]:\s*"""[^"]*"""\s*)'
        if f'_log_tool_call("{func_name}"' not in new_content:
            new_content = re.sub(
                func_pattern,
                rf'\1    _log_tool_call("{func_name}", args)\n',
                new_content
            )
    
    # 保存
    backup_path = file_path.with_suffix('.py.bak')
    with open(backup_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'已备份原文件到: {backup_path}')
    
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print(f'已更新文件: {file_path}')

if __name__ == '__main__':
    main()
