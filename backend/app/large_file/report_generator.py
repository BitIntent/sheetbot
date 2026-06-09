# backend/app/large_file/report_generator.py
"""
报表生成模块
- 分析文件结构
- 识别业务属性
- 推荐报表维度
- 生成报表数据
- 生成图表配置
- 生成文字解读
"""
import json
import uuid
import asyncio
import math
from typing import Dict, List, Any, Optional
from datetime import datetime
from .large_file_agent import large_file_agent_manager
from .large_file_duckdb import duckdb_manager
from .storage import large_file_storage
from ..utils.logger import get_logger

logger = get_logger('large_file.report_generator')

# 报表生成任务存储（内存中）
report_tasks: Dict[str, Dict[str, Any]] = {}


# ============================================================================
# 类型转换辅助函数
# ============================================================================
def _get_column_types(file_id: str, sheet_name: str, duckdb_manager) -> Dict[str, str]:
    """
    获取工作表的所有列及其类型
    
    Returns:
        {列名: 类型}，例如 {"下单日期": "VARCHAR", "销售额": "DOUBLE"}
    """
    table_name = duckdb_manager._get_cached_table_name(file_id, sheet_name)
    if not table_name:
        return {}
    
    try:
        columns_info = duckdb_manager.conn.execute(f'DESCRIBE "{table_name}"').fetchall()
        return {col[0]: col[1].upper() for col in columns_info}
    except Exception as e:
        logger.warning(f"获取列类型失败 {sheet_name}: {e}")
        return {}


def _convert_to_date_expr(column_expr: str, column_type: str) -> str:
    """
    将列表达式转换为日期类型表达式
    
    Args:
        column_expr: 列表达式，如 'main."下单日期"'
        column_type: 列类型，如 'VARCHAR', 'DATE', 'TIMESTAMP'
    
    Returns:
        转换后的表达式，如 'TRY_CAST(main."下单日期" AS DATE)' 或 'main."下单日期"'
    
    注意：
        - 如果列已经是日期类型，直接返回
        - 如果是VARCHAR，使用TRY_CAST尝试转换为DATE
        - TRY_CAST会自动处理常见的日期格式（如 'YYYY-MM-DD', 'YYYY/MM/DD' 等）
        - 如果转换失败，返回NULL而不是报错
    """
    # 如果已经是日期类型，直接返回
    if column_type in ['DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE']:
        return column_expr
    
    # 如果是VARCHAR或其他类型，尝试转换为DATE
    # TRY_CAST会尝试自动识别常见日期格式，失败返回NULL
    return f'TRY_CAST({column_expr} AS DATE)'


def _convert_to_numeric_expr(column_expr: str, column_type: str) -> str:
    """
    将列表达式转换为数值类型表达式
    
    Args:
        column_expr: 列表达式，如 'main."销售额"'
        column_type: 列类型，如 'VARCHAR', 'DOUBLE', 'INTEGER'
    
    Returns:
        转换后的表达式，如 'TRY_CAST(REGEXP_REPLACE(main."销售额", '[^0-9.-]', '', 'g') AS DOUBLE)' 或 'main."销售额"'
    """
    # 如果已经是数值类型，直接返回
    numeric_types = ['INTEGER', 'BIGINT', 'DOUBLE', 'FLOAT', 'DECIMAL', 'NUMERIC', 'REAL', 'SMALLINT', 'TINYINT']
    if any(t in column_type for t in numeric_types):
        return column_expr
    
    # 如果是VARCHAR，尝试转换为数值
    if column_type == 'VARCHAR':
        # 使用REGEXP_REPLACE移除货币符号等非数字字符（保留小数点和负号）
        # 然后使用TRY_CAST转换为DOUBLE
        return f'TRY_CAST(REGEXP_REPLACE({column_expr}, \'[^0-9.-]\', \'\', \'g\') AS DOUBLE)'
    
    # 其他类型，尝试强制转换
    return f'TRY_CAST({column_expr} AS DOUBLE)'


async def analyze_all_sheets_structure(file_id: str) -> Dict[str, Any]:
    """
    分析所有工作表的结构
    
    返回:
    {
        "sheets": [
            {
                "name": "工作表名",
                "columns": ["列1", "列2", ...],
                "column_types": {"列1": "text", "列2": "number", ...},
                "sample_data": {"列1": ["值1", "值2", ...], ...},
                "unique_counts": {"列1": 10, ...},
                "row_count": 1000
            }
        ]
    }
    """
    try:
        meta = large_file_storage.get_metadata(file_id)
        if not meta:
            raise ValueError(f"文件不存在: {file_id}")
        
        sheets_info = []
        
        for sheet_name in meta.sheet_names:
            # 获取工作表信息
            sheet_info = await get_sheet_structure(file_id, sheet_name)
            if sheet_info:
                sheets_info.append(sheet_info)
        
        return {
            "file_id": file_id,
            "sheets": sheets_info
        }
    except Exception as e:
        logger.error(f"分析工作表结构失败: {e}")
        raise


async def get_sheet_structure(file_id: str, sheet_name: str) -> Optional[Dict[str, Any]]:
    """获取单个工作表的结构信息"""
    try:
        # 获取预览数据
        preview = await large_file_storage.get_preview_fast(file_id, sheet_name)
        if not preview:
            return None
        
        data = preview.get('data', [])
        if not data:
            return None
        
        headers = preview.get('headers', [])
        if not headers:
            return None
        
        # 分析列类型和样本数据
        column_types = {}
        sample_data = {}
        unique_counts = {}
        
        for col_idx, header in enumerate(headers):
            if not header:
                continue
            
            col_values = []
            for row in data[:100]:  # 取前100行分析
                if col_idx < len(row):
                    val = row[col_idx]
                    if val is not None and val != '':
                        col_values.append(val)
            
            # 判断类型
            is_number = all(
                isinstance(v, (int, float)) or 
                (isinstance(v, str) and v.replace('.', '').replace('-', '').isdigit())
                for v in col_values[:10] if v is not None
            )
            
            col_type = 'number' if is_number and len(col_values) > 0 else 'text'
            column_types[header] = col_type
            
            # 样本数据（前10条）
            sample_data[header] = col_values[:10]
            
            # 唯一值数量
            unique_values = set(str(v) for v in col_values)
            unique_counts[header] = len(unique_values)
        
        return {
            "sheet_name": sheet_name,  # 确保使用sheet_name字段名
            "name": sheet_name,  # 保持兼容性
            "columns": headers,
            "column_types": column_types,
            "sample_data": sample_data,
            "unique_counts": unique_counts,
            "row_count": preview.get('preview_rows', 0)
        }
    except Exception as e:
        logger.error(f"获取工作表结构失败: file_id={file_id}, sheet={sheet_name}, error={e}")
        return None


async def identify_business_type_and_recommend_dimensions(file_id: str) -> Dict[str, Any]:
    """
    调用大模型识别业务属性并推荐报表维度
    
    返回:
    {
        "business_type": "销售数据",
        "recommended_dimensions": [
            {
                "time_dimension": "月",
                "category_dimensions": ["地区", "产品类别"],
                "statistics": ["求和"],
                "value_fields": ["销售额", "数量"],
                "reasoning": "推荐理由"
            }
        ],
        "alternative_dimensions": [...]
    }
    """
    try:
        # 获取所有工作表结构
        structure = await analyze_all_sheets_structure(file_id)
        
        # 构建提示词（强调字段名必须包含工作表前缀）
        prompt = f"""请分析以下Excel文件的结构，识别业务属性并推荐合适的报表维度组合。

文件结构：
{json.dumps(structure, ensure_ascii=False, indent=2)}

重要规则：
1. 字段名必须使用"工作表名.字段名"格式（例如："销售明细.销售额"、"产品明细.品类"）
2. 如果只有一个工作表，可以使用纯字段名（例如："销售额"）
3. 如果字段名不包含工作表前缀，系统将无法找到该字段

请：
1. 识别业务类型（销售数据/财务数据/人事数据/库存数据/其他）
2. 识别关键字段（时间字段、分类字段、数值字段），使用"工作表名.字段名"格式
3. 推荐1-3个报表维度组合方案

返回JSON格式：
{{
    "business_type": "业务类型",
    "recommended_dimensions": [
        {{
            "time_dimension": "年/月/日/季度" 或 null,
            "time_field": "工作表名.时间字段名" 或 null,
            "category_dimensions": ["工作表名.分类字段1", "工作表名.分类字段2"],
            "statistics": ["求和/平均/最大/最小/计数"],
            "value_fields": ["工作表名.数值字段1", "工作表名.数值字段2"],
            "reasoning": "推荐理由说明"
        }}
    ],
    "alternative_dimensions": [...]
}}"""
        
        # 调用大模型
        # 使用 file_id 作为 session_id
        session_id = f"report_{file_id}"
        agent = await large_file_agent_manager.get_or_create_agent(session_id, file_id)
        
        # 发送消息并获取响应
        response_content = ""
        async for msg in agent.process_command(prompt, require_export_sheet=False):
            if isinstance(msg, dict):
                if msg.get('type') == 'text':
                    response_content += msg.get('content', '')
                elif msg.get('type') == 'message':
                    content = msg.get('content', [])
                    if isinstance(content, list):
                        for item in content:
                            if isinstance(item, dict) and item.get('type') == 'text':
                                response_content += item.get('text', '')
        
        response = {'content': response_content}
        
        # 解析响应
        # 尝试从响应中提取JSON
        content = response.get('content', '')
        if isinstance(content, list):
            content = ''.join(str(item.get('text', '')) for item in content if isinstance(item, dict))
        
        # 提取JSON部分
        json_start = content.find('{')
        json_end = content.rfind('}') + 1
        if json_start >= 0 and json_end > json_start:
            json_str = content[json_start:json_end]
            result = json.loads(json_str)
            
            # 验证并修复字段名格式（确保包含工作表前缀）
            result = _normalize_dimension_fields(result, structure)
        else:
            # 如果无法解析，返回默认推荐
            logger.warning("无法解析大模型响应，使用默认推荐")
            result = generate_default_recommendations(structure)
        
        return result
    except Exception as e:
        logger.error(f"识别业务属性失败: {e}")
        # 返回默认推荐
        structure = await analyze_all_sheets_structure(file_id)
        return generate_default_recommendations(structure)


def _normalize_dimension_fields(result: Dict[str, Any], structure: Dict[str, Any]) -> Dict[str, Any]:
    """
    规范化维度字段名，确保包含工作表前缀
    
    如果字段名没有工作表前缀，自动查找该字段在哪个工作表中存在
    """
    sheets = structure.get('sheets', [])
    need_prefix = len(sheets) > 1
    
    # 构建字段名到工作表的映射
    field_to_sheet = {}
    for sheet_info in sheets:
        sheet_name = sheet_info.get('sheet_name', '')
        columns = sheet_info.get('columns', [])
        for col in columns:
            if col not in field_to_sheet:
                field_to_sheet[col] = sheet_name
    
    def normalize_field(field: str) -> str:
        """规范化字段名，添加工作表前缀"""
        if not field:
            return field
        
        # 如果已经有工作表前缀，直接返回
        if '.' in field:
            return field
        
        # 如果没有前缀，查找该字段在哪个工作表中
        if field in field_to_sheet:
            sheet = field_to_sheet[field]
            return f"{sheet}.{field}" if need_prefix else field
        
        # 如果找不到，返回原字段名（会在后续验证中失败）
        logger.warning(f"字段 '{field}' 在所有工作表中都不存在")
        return field
    
    # 规范化推荐维度
    if 'recommended_dimensions' in result:
        for dim in result['recommended_dimensions']:
            if 'time_field' in dim and dim['time_field']:
                dim['time_field'] = normalize_field(dim['time_field'])
            if 'category_dimensions' in dim:
                dim['category_dimensions'] = [normalize_field(f) for f in dim['category_dimensions']]
            if 'value_fields' in dim:
                dim['value_fields'] = [normalize_field(f) for f in dim['value_fields']]
    
    # 规范化替代维度
    if 'alternative_dimensions' in result:
        for dim in result['alternative_dimensions']:
            if 'time_field' in dim and dim['time_field']:
                dim['time_field'] = normalize_field(dim['time_field'])
            if 'category_dimensions' in dim:
                dim['category_dimensions'] = [normalize_field(f) for f in dim['category_dimensions']]
            if 'value_fields' in dim:
                dim['value_fields'] = [normalize_field(f) for f in dim['value_fields']]
    
    return result


def generate_default_recommendations(structure: Dict[str, Any]) -> Dict[str, Any]:
    """生成默认的维度推荐（确保字段名包含工作表前缀）"""
    sheets = structure.get('sheets', [])
    if not sheets:
        return {
            "business_type": "未知",
            "recommended_dimensions": [],
            "alternative_dimensions": []
        }
    
    # 收集所有工作表的字段（使用"工作表名.字段名"格式）
    all_time_fields = []
    all_category_fields = []
    all_value_fields = []
    
    # 判断是否需要添加工作表前缀
    need_prefix = len(sheets) > 1
    
    for sheet_info in sheets:
        sheet_name = sheet_info.get('sheet_name', '')
        columns = sheet_info.get('columns', [])
        column_types = sheet_info.get('column_types', {})
        unique_counts = sheet_info.get('unique_counts', {})
        row_count = sheet_info.get('row_count', 0)
        
        # 识别时间字段
        time_fields = [
            col for col in columns
            if any(keyword in col.lower() for keyword in ['日期', '时间', '年', '月', '日', 'date', 'time'])
        ]
        for col in time_fields:
            field_name = f"{sheet_name}.{col}" if need_prefix else col
            all_time_fields.append(field_name)
        
        # 识别分类字段
        category_fields = [
            col for col in columns
            if column_types.get(col) == 'text' and 
            unique_counts.get(col, 0) < row_count * 0.2 and
            unique_counts.get(col, 0) > 0
        ]
        for col in category_fields:
            field_name = f"{sheet_name}.{col}" if need_prefix else col
            all_category_fields.append(field_name)
        
        # 识别数值字段
        value_fields = [
            col for col in columns
            if column_types.get(col) == 'number'
        ]
        for col in value_fields:
            field_name = f"{sheet_name}.{col}" if need_prefix else col
            all_value_fields.append(field_name)
    
    # 选择第一个工作表作为主表（用于时间维度）
    main_sheet = sheets[0]
    main_sheet_name = main_sheet.get('sheet_name', '')
    main_time_fields = [
        col for col in main_sheet.get('columns', [])
        if any(keyword in col.lower() for keyword in ['日期', '时间', '年', '月', '日', 'date', 'time'])
    ]
    time_field = None
    if main_time_fields:
        time_field_name = main_time_fields[0]
        time_field = f"{main_sheet_name}.{time_field_name}" if need_prefix else time_field_name
    
    return {
        "business_type": "通用数据",
        "recommended_dimensions": [{
            "time_dimension": "月" if time_field else None,
            "time_field": time_field,
            "category_dimensions": all_category_fields[:5] if all_category_fields else [],
            "statistics": ["求和", "平均"],
            "value_fields": all_value_fields[:5] if all_value_fields else [],
            "reasoning": "基于数据结构自动推荐的维度组合"
        }],
        "alternative_dimensions": []
    }


async def generate_report(file_id: str, dimensions: Dict[str, Any], sheet_name: Optional[str] = None) -> str:
    """
    生成报表
    
    返回报表ID
    """
    report_id = str(uuid.uuid4())
    
    # 创建报表任务
    report_tasks[report_id] = {
        "report_id": report_id,
        "file_id": file_id,
        "status": "generating",
        "dimensions": dimensions,
        "sheet_name": sheet_name,
        "created_at": datetime.now().isoformat(),
        "charts": [],
        "insights": None,
        "title": None
    }
    
    # 异步生成报表
    asyncio.create_task(_generate_report_async(report_id, file_id, dimensions, sheet_name))
    
    return report_id


async def _generate_report_async(report_id: str, file_id: str, dimensions: Dict[str, Any], sheet_name: Optional[str]):
    """异步生成报表（分阶段更新，支持动态加载）"""
    try:
        report_tasks[report_id]["status"] = "generating"
        report_tasks[report_id]["progress"] = "正在生成报表配置..."
        
        # 1. 生成报表配置
        config = await generate_report_config(file_id, dimensions, sheet_name)
        report_tasks[report_id].update({
            "title": config.get("title", "企业级报表"),
            "progress": "正在查询数据..."
        })
        
        # 2. 查询数据
        data = await query_report_data(file_id, config)
        report_tasks[report_id].update({
            "progress": "正在生成图表..."
        })
        
        # 3. 生成图表数据（分批次更新）
        charts = []
        chart_batch = await generate_charts_data(data, config)
        if chart_batch:
            charts.extend(chart_batch)
            # 先更新已生成的图表，让前端可以展示
            report_tasks[report_id].update({
                "charts": charts.copy(),
                "progress": f"已生成 {len(charts)} 个图表，正在生成数据解读..."
            })
        
        # 4. 生成文字解读
        insights, key_metrics = await generate_insights(data, config, file_id, charts)
        
        # 5. 最终更新报表任务
        report_tasks[report_id].update({
            "status": "completed",
            "charts": charts,
            "insights": insights,
            "key_metrics": key_metrics,  # 新增：结构化指标数据
            "progress": "报表生成完成",
            "completed_at": datetime.now().isoformat()
        })
        
    except Exception as e:
        logger.error(f"生成报表失败: report_id={report_id}, error={e}")
        report_tasks[report_id].update({
            "status": "failed",
            "error": str(e),
            "progress": f"生成失败: {str(e)}"
        })


async def generate_report_config(file_id: str, dimensions: Dict[str, Any], sheet_name: Optional[str]) -> Dict[str, Any]:
    """生成报表配置（验证字段存在性）"""
    meta = large_file_storage.get_metadata(file_id)
    if not meta:
        raise ValueError(f"文件不存在: {file_id}")
    
    if not sheet_name:
        sheet_name = meta.sheet_names[0] if meta.sheet_names else None
    
    if not sheet_name:
        raise ValueError("未指定工作表")
    
    # 验证字段存在性（提前验证，避免后续SQL错误）
    from .large_file_duckdb import duckdb_manager
    file_path = large_file_storage.get_file_path(file_id)
    if not file_path:
        raise ValueError(f"文件路径不存在: {file_id}")
    
    # 获取所有字段
    all_fields = []
    if dimensions.get("time_field"):
        all_fields.append(dimensions["time_field"])
    all_fields.extend(dimensions.get("category_dimensions", []))
    all_fields.extend(dimensions.get("value_fields", []))
    
    # 获取关联字段映射（前端传递的格式：{工作表名: 关联字段名}）
    join_keys_map = dimensions.get("join_keys")  # {工作表名: 关联字段名}
    
    # 验证每个字段是否存在
    def extract_field_name(field: str) -> str:
        return field.split('.', 1)[1] if '.' in field else field
    
    def extract_sheet_name(field: str) -> Optional[str]:
        return field.split('.', 1)[0] if '.' in field else None
    
    # 确保所有涉及的工作表都已加载
    unique_sheets = set()
    for field in all_fields:
        sheet = extract_sheet_name(field)
        if sheet:
            unique_sheets.add(sheet)
        else:
            unique_sheets.add(sheet_name)
    
    for sheet in unique_sheets:
        if not duckdb_manager.is_loaded(file_id, sheet):
            duckdb_manager.load_excel(str(file_path), file_id, sheet)
    
    # 验证字段存在性
    invalid_fields = []
    for field in all_fields:
        field_name_clean = extract_field_name(field)
        field_sheet = extract_sheet_name(field) or sheet_name
        
        table_name = duckdb_manager._get_cached_table_name(file_id, field_sheet)
        if table_name:
            columns_info = duckdb_manager.conn.execute(f'DESCRIBE "{table_name}"').fetchall()
            column_names = [col[0] for col in columns_info]
            if field_name_clean not in column_names:
                invalid_fields.append(f'字段 "{field_name_clean}" 在工作表 "{field_sheet}" 中不存在')
    
    if invalid_fields:
        raise ValueError("以下字段不存在：\n" + "\n".join(invalid_fields))
    
    # 构建报表配置
    config = {
        "file_id": file_id,
        "sheet_name": sheet_name,
        "time_dimension": dimensions.get("time_dimension"),
        "time_field": dimensions.get("time_field"),
        "category_dimensions": dimensions.get("category_dimensions", []),
        "statistics": dimensions.get("statistics", ["求和"]),
        "value_fields": dimensions.get("value_fields", []),
        "join_keys": dimensions.get("join_keys"),  # 关联字段映射 {工作表名: 关联字段名}
        "title": f"{meta.original_name} - 数据分析报表"
    }
    
    return config


async def query_report_data(file_id: str, config: Dict[str, Any]) -> Dict[str, Any]:
    """查询报表数据（基于全量数据的SQL聚合查询）"""
    try:
        sheet_name = config["sheet_name"]
        time_dim = config.get("time_dimension")
        category_dims = config.get("category_dimensions", [])
        statistics = config.get("statistics", ["求和"])
        value_fields = config.get("value_fields", [])
        time_field = config.get("time_field")
        join_keys_map = config.get("join_keys")  # 前端传递的关联字段映射 {工作表名: 关联字段名}
        
        # 处理字段名（可能包含"工作表名.字段名"格式）
        def extract_field_name(field: str) -> str:
            """提取字段名，去除工作表前缀"""
            if '.' in field:
                return field.split('.', 1)[1]
            return field
        
        def extract_sheet_name(field: str) -> Optional[str]:
            """提取工作表名"""
            if '.' in field:
                return field.split('.', 1)[0]
            return None
        
        meta = large_file_storage.get_metadata(file_id)
        if not meta:
            raise ValueError(f"文件不存在: {file_id}")
        
        # ========================================================================
        # 第一步：识别所有字段及其所属工作表
        # ========================================================================
        field_to_sheet_map = {}  # {字段全名: 工作表名}
        all_fields = [f for f in [time_field] + category_dims + value_fields if f]
        
        for field in all_fields:
            sheet = extract_sheet_name(field)
            if sheet:
                field_to_sheet_map[field] = sheet
            else:
                # 没有工作表前缀，需要智能查找该字段在哪个工作表中存在
                # 遍历所有工作表，查找包含该字段的工作表
                field_found = False
                for sheet in meta.sheet_names:
                    if not duckdb_manager.is_loaded(file_id, sheet):
                        duckdb_manager.load_excel(str(file_path), file_id, sheet)
                    table_name = duckdb_manager._get_cached_table_name(file_id, sheet)
                    if table_name:
                        columns_info = duckdb_manager.conn.execute(f'DESCRIBE "{table_name}"').fetchall()
                        column_names = [col[0] for col in columns_info]
                        if field in column_names:
                            field_to_sheet_map[field] = sheet
                            field_found = True
                            logger.info(f"字段 '{field}' 在工作表 '{sheet}' 中找到")
                            break
                
                if not field_found:
                    # 如果找不到，假设在主表中（但会在后续验证中失败）
                    field_to_sheet_map[field] = sheet_name
                    logger.warning(f"字段 '{field}' 未找到，假设在主表 '{sheet_name}' 中（将在验证时检查）")
        
        # 确定所有涉及的工作表
        unique_sheets = set(field_to_sheet_map.values())
        if not unique_sheets:
            unique_sheets = {sheet_name}
        
        from .large_file_duckdb import duckdb_manager
        
        # ========================================================================
        # 第二步：确保所有涉及的工作表都已加载，并验证字段存在性
        # ========================================================================
        file_path = large_file_storage.get_file_path(file_id)
        if not file_path:
            raise ValueError(f"文件路径不存在: {file_id}")
        
        # 加载所有工作表并验证字段，同时收集列类型信息
        sheet_columns = {}  # {工作表名: [列名列表]}
        sheet_column_types = {}  # {工作表名: {列名: 类型}}
        for sheet in unique_sheets:
            if not duckdb_manager.is_loaded(file_id, sheet):
                duckdb_manager.load_excel(str(file_path), file_id, sheet)
            
            # 获取该工作表的所有列名和类型
            table_name = duckdb_manager._get_cached_table_name(file_id, sheet)
            if not table_name:
                raise ValueError(f"工作表未加载: {sheet}")
            
            columns_info = duckdb_manager.conn.execute(f'DESCRIBE "{table_name}"').fetchall()
            column_names = [col[0] for col in columns_info]
            column_types = {col[0]: col[1].upper() for col in columns_info}
            sheet_columns[sheet] = column_names
            sheet_column_types[sheet] = column_types
        
        # 验证所有字段是否存在（在所有涉及的工作表中）
        missing_fields = []
        for field, field_sheet in field_to_sheet_map.items():
            field_name_clean = extract_field_name(field)
            if field_sheet not in sheet_columns:
                missing_fields.append(f'字段 "{field}" 映射到的工作表 "{field_sheet}" 不存在')
            elif field_name_clean not in sheet_columns[field_sheet]:
                # 字段不存在，尝试在其他工作表中查找
                found_in_other_sheet = None
                for other_sheet, other_columns in sheet_columns.items():
                    if field_name_clean in other_columns:
                        found_in_other_sheet = other_sheet
                        break
                
                if found_in_other_sheet:
                    # 更新映射
                    field_to_sheet_map[field] = found_in_other_sheet
                    logger.info(f"字段 '{field_name_clean}' 实际在工作表 '{found_in_other_sheet}' 中，已更新映射")
                else:
                    missing_fields.append(
                        f'字段 "{field_name_clean}" 在工作表 "{field_sheet}" 中不存在。\n'
                        f'可用字段: {", ".join(sheet_columns[field_sheet][:20])}{"..." if len(sheet_columns[field_sheet]) > 20 else ""}'
                    )
        
        if missing_fields:
            raise ValueError("以下字段不存在：\n" + "\n".join(missing_fields))
        
        # 重新确定所有涉及的工作表（因为可能更新了映射）
        unique_sheets = set(field_to_sheet_map.values())
        if not unique_sheets:
            unique_sheets = {sheet_name}
        
        # ========================================================================
        # 第三步：智能选择主表（选择包含最多字段的工作表）
        # ========================================================================
        # 统计每个工作表包含的字段数量
        sheet_field_count = {}
        for field, field_sheet in field_to_sheet_map.items():
            sheet_field_count[field_sheet] = sheet_field_count.get(field_sheet, 0) + 1
        
        # 选择包含最多字段的工作表作为主表
        # 如果数量相同，优先使用sheet_name
        if not sheet_field_count:
            # 如果没有字段映射，使用sheet_name或第一个工作表
            if sheet_name:
                main_sheet = sheet_name
            elif unique_sheets:
                main_sheet = list(unique_sheets)[0]
            else:
                raise ValueError("无法确定主工作表：没有选择任何字段且没有指定工作表")
        elif sheet_name in unique_sheets and sheet_field_count.get(sheet_name, 0) == max(sheet_field_count.values()):
            main_sheet = sheet_name
        else:
            main_sheet = max(sheet_field_count.items(), key=lambda x: x[1])[0]
        
        main_table_name = duckdb_manager._get_cached_table_name(file_id, main_sheet)
        if not main_table_name:
            raise ValueError(f"主工作表未加载: {main_sheet}")
        
        # 获取总行数（全量数据，使用主表）
        total_count_result = duckdb_manager.conn.execute(f'SELECT COUNT(*) FROM "{main_table_name}"').fetchone()
        total_row_count = total_count_result[0] if total_count_result else 0
        
        # 构建SQL聚合查询（基于全量数据）
        # 如果没有维度配置，返回全量数据的统计摘要
        if not time_field and not category_dims and not value_fields:
            # 返回所有列的统计信息（仅使用主表）
            columns_info = duckdb_manager.conn.execute(f'DESCRIBE "{main_table_name}"').fetchall()
            # 获取所有列的类型信息
            main_column_types = {col[0]: col[1].upper() for col in columns_info}
            # 检测数值列（包括可能是VARCHAR但实际是数值的列）
            numeric_columns = []
            for col_name, col_type in main_column_types.items():
                # 明确的数值类型
                if any(t in col_type for t in ['INTEGER', 'BIGINT', 'DOUBLE', 'FLOAT', 'DECIMAL', 'NUMERIC', 'REAL']):
                    numeric_columns.append(col_name)
                # VARCHAR类型也可能是数值（需要转换）
                elif col_type == 'VARCHAR':
                    # 尝试判断：如果列名包含数值相关关键词，或后续会通过TRY_CAST处理
                    numeric_columns.append(col_name)
            
            if numeric_columns:
                # 构建统计查询（应用类型转换）
                agg_exprs = []
                for col in numeric_columns[:10]:  # 限制列数避免查询过大
                    col_type = main_column_types.get(col, 'VARCHAR')
                    col_expr_raw = f'"{col}"'
                    col_expr = _convert_to_numeric_expr(col_expr_raw, col_type)
                    agg_exprs.append(f'SUM({col_expr}) AS "{col}_总计"')
                    agg_exprs.append(f'AVG({col_expr}) AS "{col}_平均"')
                    agg_exprs.append(f'MAX({col_expr}) AS "{col}_最大"')
                    agg_exprs.append(f'MIN({col_expr}) AS "{col}_最小"')
                
                sql = f'SELECT {", ".join(agg_exprs)}, COUNT(*) AS 总行数 FROM "{main_table_name}"'
                result_df = duckdb_manager.conn.execute(sql).fetchdf()
                columns = list(result_df.columns)
                data = [[row[col] for col in columns] for row in result_df.to_dict('records')]
            else:
                # 没有数值列，返回前1000行作为预览
                sql = f'SELECT * FROM "{main_table_name}" LIMIT 1000'
                result = duckdb_manager.query(file_id, sql, main_sheet)
                columns = list(result[0].keys()) if result else []
                data = [[row.get(col) for col in columns] for row in result]
        else:
            # 有维度配置，构建聚合查询（支持多表JOIN）
            select_parts = []
            group_by_parts = []
            
            # ====================================================================
            # 第四步：为每个工作表分配别名（主表使用main，其他表使用t1, t2...）
            # ====================================================================
            sheet_aliases = {}
            sheet_aliases[main_sheet] = 'main'
            alias_idx = 1
            for sheet in sorted(unique_sheets):  # 排序确保别名分配的一致性
                if sheet != main_sheet:
                    alias = f't{alias_idx}'
                    sheet_aliases[sheet] = alias
                    alias_idx += 1
            
            # ====================================================================
            # 第五步：构建SELECT和GROUP BY子句（使用正确的表别名和类型转换）
            # ====================================================================
            # 处理时间维度
            if time_field:
                time_field_clean = extract_field_name(time_field)
                time_sheet = field_to_sheet_map.get(time_field, main_sheet)
                time_alias = sheet_aliases[time_sheet]
                time_expr_raw = f'{time_alias}."{time_field_clean}"'
                
                # 获取时间字段的类型并转换为日期类型
                time_column_type = sheet_column_types.get(time_sheet, {}).get(time_field_clean, 'VARCHAR')
                time_expr = _convert_to_date_expr(time_expr_raw, time_column_type)
                
                if time_dim == '年':
                    select_parts.append(f'EXTRACT(YEAR FROM {time_expr}) AS time_dim')
                    group_by_parts.append(f'EXTRACT(YEAR FROM {time_expr})')
                elif time_dim == '季度':
                    select_parts.append(f'DATE_TRUNC(\'quarter\', {time_expr}) AS time_dim')
                    group_by_parts.append(f'DATE_TRUNC(\'quarter\', {time_expr})')
                elif time_dim == '月':
                    select_parts.append(f'DATE_TRUNC(\'month\', {time_expr}) AS time_dim')
                    group_by_parts.append(f'DATE_TRUNC(\'month\', {time_expr})')
                elif time_dim == '日':
                    select_parts.append(f'DATE_TRUNC(\'day\', {time_expr}) AS time_dim')
                    group_by_parts.append(f'DATE_TRUNC(\'day\', {time_expr})')
                else:
                    select_parts.append(f'{time_expr} AS time_dim')
                    group_by_parts.append(time_expr)
            
            # 处理分类维度
            for cat_dim in category_dims:
                cat_dim_clean = extract_field_name(cat_dim)
                cat_sheet = field_to_sheet_map.get(cat_dim, main_sheet)
                cat_alias = sheet_aliases[cat_sheet]
                cat_expr = f'{cat_alias}."{cat_dim_clean}"'
                select_parts.append(f'{cat_expr} AS category_{cat_dim_clean}')
                group_by_parts.append(cat_expr)
            
            # 处理数值字段的聚合（应用类型转换）
            for value_field in value_fields:
                value_field_clean = extract_field_name(value_field)
                value_sheet = field_to_sheet_map.get(value_field, main_sheet)
                value_alias = sheet_aliases[value_sheet]
                value_expr_raw = f'{value_alias}."{value_field_clean}"'
                
                # 获取数值字段的类型并转换为数值类型
                value_column_type = sheet_column_types.get(value_sheet, {}).get(value_field_clean, 'VARCHAR')
                value_expr = _convert_to_numeric_expr(value_expr_raw, value_column_type)
                
                for stat in statistics:
                    if stat == "求和":
                        select_parts.append(f'SUM({value_expr}) AS "{value_field_clean}_求和"')
                    elif stat == "平均":
                        select_parts.append(f'AVG({value_expr}) AS "{value_field_clean}_平均"')
                    elif stat == "最大":
                        select_parts.append(f'MAX({value_expr}) AS "{value_field_clean}_最大"')
                    elif stat == "最小":
                        select_parts.append(f'MIN({value_expr}) AS "{value_field_clean}_最小"')
                    elif stat == "计数":
                        select_parts.append(f'COUNT({value_expr}) AS "{value_field_clean}_计数"')
            
            # 添加总计数（使用主表）
            select_parts.append(f'COUNT(*) AS 行数')
            
            # ====================================================================
            # 第六步：构建FROM和JOIN子句（智能查找关联字段）
            # ====================================================================
            from_clause = None  # 初始化为None，在else分支中设置
            if len(unique_sheets) == 1:
                # 单表查询
                from_clause = f'FROM {{table:{main_sheet}}} AS main'
                join_key = None
            else:
                # 多表查询，需要构建JOIN
                # 智能查找关联字段：检查主表的所有列，看哪些列在其他表中也存在
                main_column_names = sheet_columns[main_sheet]
                
                # 候选关联字段（包含"ID"、"编号"等关键词的字段）
                candidate_keys = [col for col in main_column_names 
                                if any(keyword in col.upper() for keyword in ['ID', '编号', '代码', '订单', '客户', '产品', '行'])]
                
                # 按优先级排序：优先选择更通用的关联字段
                key_priority = {
                    'ID': 10, '订单ID': 9, '客户ID': 9, '产品ID': 9,
                    '订单行ID': 8, '行ID': 8,
                    '编号': 7, '代码': 6
                }
                candidate_keys.sort(key=lambda x: max([key_priority.get(k, 0) for k in key_priority.keys() if k in x.upper()]), reverse=True)
                
                # 查找关联字段
                join_key = None
                
                # 优先使用前端传递的关联字段映射
                if join_keys_map and isinstance(join_keys_map, dict):
                    # 检查前端传递的关联字段是否在所有表中都存在
                    # 前端格式：{工作表名: 关联字段名}，例如 {"产品明细": "产品ID", "销售明细": "产品ID"}
                    # 提取所有不同的关联字段值
                    join_key_values = list(set(join_keys_map.values()))
                    if len(join_key_values) == 1:
                        # 所有工作表使用相同的关联字段
                        candidate_join_key = join_key_values[0]
                        # 验证该字段是否在所有表中都存在
                        all_tables_have_key = True
                        for sheet in unique_sheets:
                            if sheet not in join_keys_map:
                                all_tables_have_key = False
                                break
                            expected_key = join_keys_map[sheet]
                            if expected_key not in sheet_columns[sheet]:
                                logger.warning(f"工作表 {sheet} 中不存在关联字段 {expected_key}")
                                all_tables_have_key = False
                                break
                        if all_tables_have_key:
                            join_key = candidate_join_key
                            logger.info(f"使用前端传递的关联字段: {join_key}")
                    else:
                        logger.warning(f"前端传递了不同的关联字段: {join_keys_map}，将尝试自动查找")
                
                # 如果前端没有传递或传递的关联字段无效，自动查找
                if not join_key:
                    for col in candidate_keys:
                        all_tables_have_key = True
                        for sheet in unique_sheets:
                            if col not in sheet_columns[sheet]:
                                all_tables_have_key = False
                                break
                        if all_tables_have_key:
                            join_key = col
                            logger.info(f"自动找到关联字段: {join_key}")
                            break
                
                # 如果仍然没有找到关联字段，且涉及多个工作表，抛出错误
                if not join_key and len(unique_sheets) > 1:
                    raise ValueError(
                        f"未找到表之间的关联字段。\n\n"
                        f"涉及的工作表: {', '.join(unique_sheets)}\n"
                        f"请在前端为每个工作表选择一个关联字段（如：产品ID、订单ID、客户ID等）。\n"
                        f"关联字段用于连接不同工作表的数据，避免产生大量无意义的数据组合。"
                    )
                
                # 构建FROM和JOIN子句（使用占位符）
                join_parts = []
                
                # 如果使用CROSS JOIN，限制主表数据量
                if not join_key:
                    logger.warning(f"未找到表之间的关联字段，使用CROSS JOIN（限制每个表最多500行以避免性能问题）")
                    # 将主表限制为500行，避免笛卡尔积爆炸
                    main_table_ref = f'(SELECT * FROM {{table:{main_sheet}}} LIMIT 500) AS main'
                    from_clause = f'FROM {main_table_ref}'
                else:
                    from_clause = f'FROM {{table:{main_sheet}}} AS main'
                
                for sheet in sorted(unique_sheets):  # 排序确保JOIN顺序一致
                    if sheet != main_sheet:
                        alias = sheet_aliases[sheet]
                        if join_key:
                            # 使用INNER JOIN（基于关联字段）
                            join_parts.append(f'INNER JOIN {{table:{sheet}}} AS {alias} ON main."{join_key}" = {alias}."{join_key}"')
                        else:
                            # 没有找到关联字段，使用CROSS JOIN（限制每个表最多500行）
                            # 使用子查询限制每个表最多500行，避免笛卡尔积爆炸（500*500=25万行，可接受）
                            join_parts.append(f'CROSS JOIN (SELECT * FROM {{table:{sheet}}} LIMIT 500) AS {alias}')
                
                # 添加JOIN子句
                if join_parts:
                    from_clause = from_clause + ' ' + ' '.join(join_parts)
            
            # 构建SQL（使用占位符，让duckdb_manager解析）
            if group_by_parts:
                sql = f'''
                    SELECT {', '.join(select_parts)}
                    {from_clause}
                    GROUP BY {', '.join(group_by_parts)}
                    ORDER BY {group_by_parts[0]} DESC
                '''
                # 如果没有找到JOIN键且使用了CROSS JOIN，添加LIMIT（在GROUP BY之后）
                # 注意：已经在FROM子句中限制了每个表的数据量，这里只需要限制最终结果
                if len(unique_sheets) > 1 and not join_key:
                    sql = sql.rstrip() + ' LIMIT 500'  # 限制最终结果数量
            else:
                # 没有分组，直接聚合
                sql = f'SELECT {", ".join(select_parts)} {from_clause}'
                if len(unique_sheets) > 1 and not join_key:
                    sql = sql + ' LIMIT 500'  # 限制最终结果数量
            
            # ====================================================================
            # 第七步：执行SQL查询（使用duckdb_manager.query解析占位符）
            # ====================================================================
            try:
                logger.debug(f"执行SQL查询: {sql[:500]}...")
                logger.debug(f"涉及的工作表: {unique_sheets}")
                logger.debug(f"工作表别名: {sheet_aliases}")
                logger.debug(f"字段映射: {field_to_sheet_map}")
                logger.debug(f"关联字段: {join_key}")
                
                result = duckdb_manager.query(file_id, sql, main_sheet)
                if result:
                    columns = list(result[0].keys()) if result else []
                    data = [[row.get(col) for col in columns] for row in result]
                else:
                    columns = []
                    data = []
            except Exception as sql_error:
                # 如果查询失败，记录详细的SQL和错误信息
                logger.error(f"SQL查询失败: {sql_error}")
                logger.error(f"执行的SQL: {sql}")
                logger.error(f"涉及的工作表: {unique_sheets}")
                logger.error(f"字段到工作表映射: {field_to_sheet_map}")
                logger.error(f"工作表别名: {sheet_aliases}")
                logger.error(f"各表的列: {sheet_columns}")
                
                # 提供更友好的错误信息
                error_msg = f"SQL查询失败: {sql_error}\n"
                error_msg += f"涉及的工作表: {', '.join(unique_sheets)}\n"
                error_msg += f"字段映射: {field_to_sheet_map}\n"
                if "does not have a column" in str(sql_error) or "not found" in str(sql_error):
                    error_msg += "\n提示：请检查字段名是否正确，以及字段是否存在于对应的工作表中。"
                raise ValueError(error_msg)
        
        return {
            "data": data,
            "columns": columns,
            "row_count": len(data),
            "total_row_count": total_row_count  # 全量数据总行数
        }
    except Exception as e:
        logger.error(f"查询报表数据失败: {e}")
        import traceback
        logger.debug(f"错误详情:\n{traceback.format_exc()}")
        raise


async def generate_charts_data(data: Dict[str, Any], config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    生成图表数据，根据数据结构选择合适的图表类型，尽可能生成更多图表
    
    图表生成规则（System Prompt）：
    1. 禁止单个指标生成图表：如果只有一个指标，不生成图表
    2. 禁止不同维度指标放在同一图表：只将数值量级相近（数量级差异<=2）且范围有重叠的字段放在同一图表
       - 例如：订单总数量（10^5量级）与折扣率平均值（10^0量级）不应放在同一图表
       - 例如：销售额（10^5量级）与数量总计（10^2量级）不应放在同一图表
    3. 禁止出现不同维度的数据放在同一个图表中，对用户没有任何价值
       - 不同单位、不同量级的指标必须分开显示
       - 例如：订单总数量（笔）、销售额（元）、折扣率（%）不应放在同一图表
       - 例如：数量总计（件）、数量平均值（件/单）虽然单位相同但量级差异巨大，也不应放在同一图表
    """
    charts = []
    
    try:
        if not data.get("data") or len(data["data"]) == 0:
            return charts
        
        columns = data.get("columns", [])
        chart_data = data["data"]
        time_dim = config.get("time_dimension")
        category_dims = config.get("category_dimensions", [])
        statistics = config.get("statistics", ["求和"])
        value_fields = config.get("value_fields", [])
        time_field = config.get("time_field")
        
        # 1. 时间维度图表（优先）
        # 规则1：禁止单个指标生成图表
        # 规则2：禁止不同维度指标放在同一图表（通过 _group_compatible_fields 确保同维度分组）
        if time_dim and time_field and len(value_fields) > 1:  # 至少需要2个指标才生成图表
            # 将数值字段按数据统计特征分组（基于数值量级和范围相似度）
            compatible_groups = _group_compatible_fields(value_fields, chart_data, columns)
            for group in compatible_groups:
                # 规则1：只处理包含至少2个指标的组（时间图表可以显示多个指标的趋势对比）
                if len(group) >= 2:
                    chart = await _generate_time_chart(chart_data, columns, time_field, group, statistics)
                    if chart:
                        charts.append(chart)
        
        # 2. 分类维度图表（为每个分类维度生成图表，按数据特征分组）
        # 规则1：禁止单个指标生成图表
        # 规则2：禁止不同维度指标放在同一图表（通过 _group_compatible_fields 确保同维度分组）
        if category_dims and len(value_fields) > 1:  # 至少需要2个指标才生成图表
            # 将数值字段按数据统计特征分组（基于数值量级和范围相似度）
            compatible_groups = _group_compatible_fields(value_fields, chart_data, columns)
            for cat_dim in category_dims[:3]:  # 最多3个分类维度图表
                # 为每个兼容的字段组生成图表
                for group in compatible_groups:
                    # 规则1：只处理包含至少2个指标的组
                    if len(group) >= 2:
                        chart = await _generate_category_chart(chart_data, columns, cat_dim, group, statistics)
                        if chart:
                            charts.append(chart)
        
        # 3. 多数值字段对比图（仅当字段数值量级相似时）
        # 规则1：禁止单个指标生成图表
        # 规则2：禁止不同维度指标放在同一图表（通过 _group_compatible_fields 确保同维度分组）
        if len(value_fields) > 1:  # 至少需要2个指标才生成图表
            # 将数值字段按数据统计特征分组（基于数值量级和范围相似度）
            compatible_groups = _group_compatible_fields(value_fields, chart_data, columns)
            for group in compatible_groups:
                # 规则1：只处理包含至少2个指标的组
                if len(group) >= 2:
                    chart = await _generate_multi_value_comparison_chart(chart_data, columns, group)
                    if chart:
                        charts.append(chart)
        
        # 4. 统计汇总图（如果有多列数值，按数据特征分组）
        # 规则1：禁止单个指标生成图表
        # 规则2：禁止不同维度指标放在同一图表（通过 _group_compatible_fields 确保同维度分组）
        # 规则3：禁止出现不同维度的数据放在同一个图表中，对用户没有任何价值
        if len(value_fields) > 1:  # 至少需要2个指标才生成图表
            compatible_groups = _group_compatible_fields(value_fields, chart_data, columns)
            for group in compatible_groups:
                # 规则1：只处理包含至少2个指标的组
                # 规则2和3：_group_compatible_fields 已确保同维度分组
                if len(group) >= 2:
                    chart = await _generate_statistics_summary_chart(
                        chart_data, columns, group, statistics, 
                        config.get("file_id"), config.get("sheet_name")
                    )
                    if chart:
                        charts.append(chart)
        
        # 5. 如果没有生成任何图表，且有多于1个指标，生成一个基础数据概览图
        # 规则1：禁止单个指标生成图表
        if len(charts) == 0 and len(value_fields) > 1:
            chart = await _generate_overview_chart(chart_data, columns, value_fields)
            if chart:
                charts.append(chart)
                
    except Exception as e:
        logger.error(f"生成图表数据失败: {e}")
    
    return charts


async def _generate_time_chart(data: List[List[Any]], columns: List[str], time_field: str, value_fields: List[str], statistics: List[str]) -> Optional[Dict[str, Any]]:
    """
    生成时间趋势图（折线图）- 支持多个指标的趋势对比
    
    图表生成规则（System Prompt）：
    1. 禁止单个指标生成图表：如果只有一个指标，不生成图表
    2. 禁止不同维度指标放在同一图表：只处理已经通过 _group_compatible_fields 分组的同维度指标组
    """
    try:
        # 规则1：禁止单个指标生成图表
        if not value_fields or len(value_fields) < 2:
            return None
        
        # 处理字段名（可能包含"工作表名.字段名"格式）
        def extract_field_name(field: str) -> str:
            return field.split('.', 1)[1] if '.' in field else field
        
        time_field_clean = extract_field_name(time_field) if time_field else None
        time_idx = columns.index(time_field_clean) if time_field_clean and time_field_clean in columns else None
        if time_idx is None:
            return None
        
        # 获取第一个数值字段
        value_field = value_fields[0] if value_fields else None
        if not value_field:
            return None
        
        value_field_clean = extract_field_name(value_field)
        value_idx = columns.index(value_field_clean) if value_field_clean in columns else None
        if value_idx is None:
            return None
        
        # 提取时间和数值数据（使用聚合后的数据，不再采样）
        time_data = []
        value_data = []
        # 查找聚合结果中的统计列（优先使用求和，如果没有则使用平均）
        stat_col = None
        for stat in statistics:
            stat_col_candidate = f"{value_field_clean}_{stat}"
            if stat_col_candidate in columns:
                stat_col = stat_col_candidate
                break
        
        if stat_col:
            stat_idx = columns.index(stat_col)
        else:
            stat_idx = value_idx  # 回退到原始字段
        
        # 使用所有聚合后的数据点，不再限制为50个
        for row in data:
            if time_idx < len(row) and stat_idx < len(row):
                time_val = row[time_idx]
                value_val = row[stat_idx]
                if time_val is not None and value_val is not None:
                    try:
                        num_val = float(value_val) if isinstance(value_val, (int, float)) else float(str(value_val).replace(',', ''))
                        time_data.append(str(time_val))
                        value_data.append(num_val)
                    except:
                        continue
        
        if len(time_data) == 0:
            return None
        
        return {
            "title": f"{value_field_clean}趋势分析",
            "type": "line",
            "option": {
                "title": {
                    "text": f"{value_field_clean}趋势分析",
                    "left": "center",
                    "textStyle": {
                        "fontSize": 18,
                        "fontWeight": "bold"
                    }
                },
                "tooltip": {
                    "trigger": "axis"
                },
                "xAxis": {
                    "type": "category",
                    "data": time_data,
                    "name": time_field_clean,
                    "nameLocation": "middle",
                    "nameGap": 30,
                    "axisLabel": {
                        "rotate": 45
                    }
                },
                "yAxis": {
                    "type": "value",
                    "name": value_field_clean,
                    "nameLocation": "middle",
                    "nameGap": 50
                },
                "series": [{
                    "name": value_field_clean,
                    "data": value_data,
                    "type": "line",
                    "smooth": True,
                    "itemStyle": {
                        "color": "#217346"
                    }
                }]
            }
        }
    except Exception as e:
        logger.error(f"生成时间图表失败: {e}")
        return None


async def _generate_category_chart(data: List[List[Any]], columns: List[str], category_field: str, value_fields: List[str], statistics: List[str]) -> Optional[Dict[str, Any]]:
    """
    生成分类统计图（柱状图或饼图）
    
    图表生成规则（System Prompt）：
    1. 禁止单个指标生成图表：如果只有一个指标，不生成图表
    """
    try:
        # 规则1：禁止单个指标生成图表
        if not value_fields or len(value_fields) < 1:
            return None
        
        # 处理字段名（可能包含"工作表名.字段名"格式）
        def extract_field_name(field: str) -> str:
            return field.split('.', 1)[1] if '.' in field else field
        
        category_field_clean = extract_field_name(category_field)
        cat_idx = columns.index(category_field_clean) if category_field_clean in columns else None
        if cat_idx is None:
            return None
        
        value_field = value_fields[0] if value_fields else None
        if not value_field:
            return None
        
        value_field_clean = extract_field_name(value_field)
        value_idx = columns.index(value_field_clean) if value_field_clean in columns else None
        if value_idx is None:
            return None
        
        # 按分类聚合数据
        category_stats = {}
        for row in data:
            if cat_idx < len(row) and value_idx < len(row):
                cat_val = str(row[cat_idx]) if row[cat_idx] is not None else "未知"
                value_val = row[value_idx]
                if value_val is not None:
                    try:
                        num_val = float(value_val) if isinstance(value_val, (int, float)) else float(str(value_val).replace(',', ''))
                        if cat_val not in category_stats:
                            category_stats[cat_val] = []
                        category_stats[cat_val].append(num_val)
                    except:
                        continue
        
        if len(category_stats) == 0:
            return None
        
        # 计算统计值（求和）
        stat_func = statistics[0] if statistics else "求和"
        category_values = {}
        for cat, values in category_stats.items():
            if not values:  # 防止空列表
                continue
            if stat_func == "求和":
                category_values[cat] = sum(values)
            elif stat_func == "平均":
                category_values[cat] = sum(values) / len(values)
            elif stat_func == "最大":
                category_values[cat] = max(values)
            elif stat_func == "最小":
                category_values[cat] = min(values)
            elif stat_func == "计数":
                category_values[cat] = len(values)
            else:
                category_values[cat] = sum(values)
        
        # 排序并取前10个
        sorted_items = sorted(category_values.items(), key=lambda x: x[1], reverse=True)[:10]
        categories = [item[0] for item in sorted_items]
        values = [item[1] for item in sorted_items]
        
        # 如果分类数量 <= 5，使用饼图；否则使用柱状图
        chart_type = "pie" if len(categories) <= 5 else "bar"
        
        if chart_type == "pie":
            return {
                "title": f"{value_field_clean}按{category_field_clean}分布",
                "type": "pie",
                "option": {
                    "title": {
                        "text": f"{value_field_clean}按{category_field_clean}分布",
                        "left": "center",
                        "textStyle": {
                            "fontSize": 18,
                            "fontWeight": "bold"
                        }
                    },
                    "tooltip": {
                        "trigger": "item",
                        "formatter": "{a} <br/>{b}: {c} ({d}%)"
                    },
                    "legend": {
                        "orient": "vertical",
                        "left": "left"
                    },
                    "series": [{
                        "name": value_field_clean,
                        "type": "pie",
                        "radius": "50%",
                        "data": [{"value": v, "name": k} for k, v in zip(categories, values)],
                        "emphasis": {
                            "itemStyle": {
                                "shadowBlur": 10,
                                "shadowOffsetX": 0,
                                "shadowColor": "rgba(0, 0, 0, 0.5)"
                            }
                        }
                    }]
                }
            }
        else:
            return {
                "title": f"{value_field_clean}按{category_field_clean}统计",
                "type": "bar",
                "option": {
                    "title": {
                        "text": f"{value_field_clean}按{category_field_clean}统计",
                        "left": "center",
                        "textStyle": {
                            "fontSize": 18,
                            "fontWeight": "bold"
                        }
                    },
                    "tooltip": {
                        "trigger": "axis"
                    },
                    "xAxis": {
                        "type": "category",
                        "data": categories,
                        "name": category_field_clean,
                        "nameLocation": "middle",
                        "nameGap": 30,
                        "axisLabel": {
                            "rotate": 45
                        }
                    },
                    "yAxis": {
                        "type": "value",
                        "name": f"{value_field_clean}({stat_func})",
                        "nameLocation": "middle",
                        "nameGap": 50
                    },
                    "series": [{
                        "name": value_field_clean,
                        "data": values,
                        "type": "bar",
                        "itemStyle": {
                            "color": "#217346"
                        }
                    }]
                }
            }
    except Exception as e:
        logger.error(f"生成分类图表失败: {e}")
        return None


async def _generate_multi_value_comparison_chart(data: List[List[Any]], columns: List[str], value_fields: List[str]) -> Optional[Dict[str, Any]]:
    """
    生成多数值字段对比图（柱状图）- 仅用于同类型字段
    
    图表生成规则（System Prompt）：
    1. 禁止单个指标生成图表：如果只有一个指标，不生成图表
    2. 禁止不同维度指标放在同一图表：只处理已经通过 _group_compatible_fields 分组的同维度指标组
    """
    try:
        # 规则1：禁止单个指标生成图表
        if len(value_fields) < 2:
            return None
        
        # 处理字段名（可能包含"工作表名.字段名"格式）
        def extract_field_name(field: str) -> str:
            return field.split('.', 1)[1] if '.' in field else field
        
        # 使用所有聚合后的数据，不再采样
        # 提取各数值字段的数据
        series_data = []
        for value_field in value_fields[:4]:  # 最多4个字段
            value_field_clean = extract_field_name(value_field)
            value_idx = columns.index(value_field_clean) if value_field_clean in columns else None
            if value_idx is None:
                continue
            
            values = []
            for row in data:  # 使用所有数据，不再限制为20行
                if value_idx < len(row):
                    val = row[value_idx]
                    if val is not None:
                        try:
                            num_val = float(val) if isinstance(val, (int, float)) else float(str(val).replace(',', ''))
                            values.append(num_val)
                        except:
                            values.append(0)
                    else:
                        values.append(0)
                else:
                    values.append(0)
            
            if len(values) > 0:
                series_data.append({
                    "name": value_field_clean,
                    "data": values,
                    "type": "bar"
                })
        
        if len(series_data) == 0:
            return None
        
        categories = [str(i + 1) for i in range(len(data))]
        
        # 根据字段类型生成合适的标题
        field_names_clean = [extract_field_name(f) for f in value_fields[:4]]
        chart_title = f"{'、'.join(field_names_clean)}对比分析"
        
        return {
            "title": chart_title,
            "type": "bar",
            "option": {
                "title": {
                    "text": chart_title,
                    "left": "center",
                    "textStyle": {
                        "fontSize": 18,
                        "fontWeight": "bold"
                    }
                },
                "tooltip": {
                    "trigger": "axis",
                    "axisPointer": {
                        "type": "shadow"
                    }
                },
                "legend": {
                    "data": [s["name"] for s in series_data],
                    "top": 30
                },
                "grid": {
                    "left": "3%",
                    "right": "4%",
                    "bottom": "3%",
                    "containLabel": True
                },
                "xAxis": {
                    "type": "category",
                    "data": categories,
                    "name": "数据序号",
                    "nameLocation": "middle",
                    "nameGap": 30
                },
                "yAxis": {
                    "type": "value",
                    "name": "数值",
                    "nameLocation": "middle",
                    "nameGap": 50
                },
                "series": series_data
            }
        }
    except Exception as e:
        logger.error(f"生成多指标对比图失败: {e}")
        return None


async def _generate_statistics_summary_chart(data: List[List[Any]], columns: List[str], value_fields: List[str], statistics: List[str], file_id: str = None, sheet_name: str = None) -> Optional[Dict[str, Any]]:
    """
    生成统计汇总图（柱状图，展示各字段的统计值）- 基于SQL聚合结果
    
    图表生成规则（System Prompt）：
    1. 禁止单个指标生成图表：如果只有一个指标，不生成图表，直接返回None
    2. 禁止不同维度指标放在同一图表：只处理已经通过 _group_compatible_fields 分组的同维度指标组
    """
    try:
        # 规则1：禁止单个指标生成图表
        if len(value_fields) < 2:
            return None
        
        # 处理字段名（可能包含"工作表名.字段名"格式）
        def extract_field_name(field: str) -> str:
            return field.split('.', 1)[1] if '.' in field else field
        
        stat_func = statistics[0] if statistics else "求和"
        
        # 从SQL聚合结果中提取统计值，或使用SQL查询全量统计
        summary_data = []
        for value_field in value_fields[:5]:  # 最多5个字段
            value_field_clean = extract_field_name(value_field)
            
            # 尝试从聚合结果中提取
            stat_col = f"{value_field_clean}_{stat_func}"
            stat_value = None
            
            if stat_col in columns and len(data) > 0:
                # 从聚合结果的第一行提取（如果是汇总行）
                col_idx = columns.index(stat_col)
                if col_idx < len(data[0]):
                    stat_value = data[0][col_idx]
            
            # 如果没有聚合结果，使用SQL查询全量统计（应用类型转换）
            if stat_value is None and file_id and sheet_name:
                from .large_file_duckdb import duckdb_manager
                table_name = duckdb_manager._get_cached_table_name(file_id, sheet_name)
                if table_name:
                    try:
                        # 获取字段类型并转换为数值类型
                        column_types = _get_column_types(file_id, sheet_name, duckdb_manager)
                        value_column_type = column_types.get(value_field_clean, 'VARCHAR')
                        value_expr_raw = f'"{value_field_clean}"'
                        value_expr = _convert_to_numeric_expr(value_expr_raw, value_column_type)
                        
                        if stat_func == "求和":
                            sql = f'SELECT SUM({value_expr}) FROM "{table_name}"'
                        elif stat_func == "平均":
                            sql = f'SELECT AVG({value_expr}) FROM "{table_name}"'
                        elif stat_func == "最大":
                            sql = f'SELECT MAX({value_expr}) FROM "{table_name}"'
                        elif stat_func == "最小":
                            sql = f'SELECT MIN({value_expr}) FROM "{table_name}"'
                        elif stat_func == "计数":
                            sql = f'SELECT COUNT({value_expr}) FROM "{table_name}"'
                        else:
                            sql = f'SELECT SUM({value_expr}) FROM "{table_name}"'
                        
                        result = duckdb_manager.conn.execute(sql).fetchone()
                        if result and result[0] is not None:
                            stat_value = result[0]
                    except Exception as e:
                        logger.warning(f"查询字段 {value_field_clean} 统计失败: {e}")
            
            if stat_value is not None:
                summary_data.append({
                    "name": value_field_clean,
                    "value": float(stat_value) if stat_value is not None else 0
                })
        
        if len(summary_data) == 0:
            return None
        
        # 根据字段类型生成合适的标题
        field_names_clean = [extract_field_name(f) for f in value_fields[:5]]
        chart_title = f"{'、'.join(field_names_clean)}{stat_func}汇总"
        
        return {
            "title": chart_title,
            "type": "bar",
            "option": {
                "title": {
                    "text": chart_title,
                    "left": "center",
                    "textStyle": {
                        "fontSize": 18,
                        "fontWeight": "bold"
                    }
                },
                "tooltip": {
                    "trigger": "axis",
                    "formatter": "{b}: {c}"
                },
                "xAxis": {
                    "type": "category",
                    "data": [item["name"] for item in summary_data],
                    "name": "指标名称",
                    "nameLocation": "middle",
                    "nameGap": 30,
                    "axisLabel": {
                        "rotate": 45
                    }
                },
                "yAxis": {
                    "type": "value",
                    "name": f"{stat_func}值",
                    "nameLocation": "middle",
                    "nameGap": 50
                },
                "series": [{
                    "name": stat_func,
                    "data": [item["value"] for item in summary_data],
                    "type": "bar",
                    "itemStyle": {
                        "color": "#217346"
                    },
                    "label": {
                        "show": True,
                        "position": "top"
                    }
                }]
            }
        }
    except Exception as e:
        logger.error(f"生成统计汇总图失败: {e}")
        return None


def _group_compatible_fields(value_fields: List[str], data: List[List[Any]], columns: List[str]) -> List[List[str]]:
    """
    基于数据统计特征将数值字段分组，确保数值量级相近的字段才放在一起对比
    
    分组规则（通用，适用于任何行业和数据类型）：
    - 计算每个字段的统计特征（均值、标准差、最大值、最小值）
    - 根据数值量级（数量级）和数值范围相似度进行分组
    - 避免将数量级差异过大的字段放在同一图表中
    
    图表生成规则（System Prompt）：
    1. 禁止单个指标生成图表：如果只有一个指标，不生成图表
    2. 禁止不同维度指标放在同一图表：只将数值量级相近（数量级差异<=2）且范围有重叠的字段放在同一组
       - 例如：订单总数量（10^5量级）与折扣率平均值（10^0量级）不应放在同一图表
       - 例如：销售额（10^5量级）与数量总计（10^2量级）不应放在同一图表
    3. 禁止出现不同维度的数据放在同一个图表中，对用户没有任何价值
       - 不同单位、不同量级的指标必须分开显示
       - 例如：订单总数量（笔）、销售额（元）、折扣率（%）不应放在同一图表
       - 例如：数量总计（件）、数量平均值（件/单）虽然单位相同但量级差异巨大，也不应放在同一图表
       - 严格限制：数量级差异必须<=1（更严格），且范围必须有实际重叠（ratio > 0.1，更严格）
    """
    if not value_fields or not data or not columns:
        return [[f] for f in value_fields] if value_fields else []
    
    def extract_field_name(field: str) -> str:
        """提取字段名，去除工作表前缀"""
        return field.split('.', 1)[1] if '.' in field else field
    
    # 计算每个字段的统计特征
    field_stats = {}
    for field in value_fields:
        field_clean = extract_field_name(field)
        field_idx = columns.index(field_clean) if field_clean in columns else None
        if field_idx is None:
            continue
        
        # 提取该字段的所有数值
        values = []
        for row in data:
            if field_idx < len(row):
                val = row[field_idx]
                if val is not None:
                    try:
                        num_val = float(val) if isinstance(val, (int, float)) else float(str(val).replace(',', ''))
                        if not (math.isnan(num_val) or math.isinf(num_val)):
                            values.append(num_val)
                    except:
                        continue
        
        if len(values) == 0:
            continue
        
        # 计算统计特征
        mean_val = sum(values) / len(values)
        variance = sum((x - mean_val) ** 2 for x in values) / len(values) if len(values) > 1 else 0
        std_dev = math.sqrt(variance)
        max_val = max(values)
        min_val = min(values)
        range_val = max_val - min_val if max_val != min_val else 1
        
        # 计算数量级（使用对数的整数部分，处理边界情况）
        if mean_val == 0:
            magnitude = 0
        elif abs(mean_val) < 1:
            # 对于小于1的数值，使用负数数量级
            magnitude = math.floor(math.log10(abs(mean_val)))
        else:
            magnitude = math.floor(math.log10(abs(mean_val)))
        
        field_stats[field] = {
            'mean': mean_val,
            'std': std_dev,
            'max': max_val,
            'min': min_val,
            'range': range_val,
            'magnitude': magnitude,
            'values': values
        }
    
    if not field_stats:
        return [[f] for f in value_fields]
    
    # 根据数量级和数值范围相似度分组
    groups = []
    processed = set()
    
    for field, stats in field_stats.items():
        if field in processed:
            continue
        
        # 创建新组
        current_group = [field]
        processed.add(field)
        
        # 寻找相似量级的字段
        for other_field, other_stats in field_stats.items():
            if other_field in processed:
                continue
            
            # 判断是否适合组合（通用规则，适用于任何行业）：
            # 1. 数量级差异不超过2（例如：10^3 和 10^5 可以组合，但 10^3 和 10^7 不适合）
            # 2. 数值范围重叠度较高（避免完全不同的尺度）
            magnitude_diff = abs(stats['magnitude'] - other_stats['magnitude'])
            
            # 计算数值范围的重叠度
            range_overlap = min(stats['max'], other_stats['max']) - max(stats['min'], other_stats['min'])
            max_range = max(stats['range'], other_stats['range'])
            range_overlap_ratio = range_overlap / max_range if max_range > 0 else 0
            
            # 规则2和3：禁止不同维度指标放在同一图表
            # 如果数量级差异小（<=1，更严格）且范围有重叠，可以组合
            # 这个规则适用于任何行业：金融、零售、制造、医疗等
            # 严格限制：数量级差异必须<=1（更严格），且范围必须有实际重叠（ratio > 0.1，更严格）
            # 禁止出现不同维度的数据放在同一个图表中，对用户没有任何价值
            if magnitude_diff <= 1 and range_overlap_ratio > 0.1:  # 更严格的限制：数量级差异<=1，重叠度>10%
                current_group.append(other_field)
                processed.add(other_field)
        
        groups.append(current_group)
    
    # 如果所有字段都不适合组合，每个字段单独一组
    return groups if groups else [[f] for f in value_fields]


async def _generate_overview_chart(data: List[List[Any]], columns: List[str], value_fields: List[str]) -> Optional[Dict[str, Any]]:
    """
    生成数据概览图
    
    图表生成规则（System Prompt）：
    1. 禁止单个指标生成图表：如果只有一个指标，不生成图表
    """
    try:
        # 规则1：禁止单个指标生成图表
        if not value_fields or len(value_fields) < 2:
            return None
        
        # 处理字段名（可能包含"工作表名.字段名"格式）
        def extract_field_name(field: str) -> str:
            return field.split('.', 1)[1] if '.' in field else field
        
        value_field = value_fields[0]
        value_field_clean = extract_field_name(value_field)
        value_idx = columns.index(value_field_clean) if value_field_clean in columns else None
        if value_idx is None:
            return None
        
        # 提取数值数据（使用所有聚合后的数据，不再采样）
        values = []
        for row in data:
            if value_idx < len(row):
                val = row[value_idx]
                if val is not None:
                    try:
                        num_val = float(val) if isinstance(val, (int, float)) else float(str(val).replace(',', ''))
                        values.append(num_val)
                    except:
                        continue
        
        if len(values) == 0:
            return None
        
        return {
            "title": f"{value_field_clean}数据概览",
            "type": "bar",
            "option": {
                "title": {
                    "text": f"{value_field_clean}数据概览",
                    "left": "center",
                    "textStyle": {
                        "fontSize": 18,
                        "fontWeight": "bold"
                    }
                },
                "tooltip": {
                    "trigger": "axis"
                },
                "xAxis": {
                    "type": "category",
                    "data": [str(i + 1) for i in range(len(values))],
                    "name": "序号",
                    "nameLocation": "middle",
                    "nameGap": 30
                },
                "yAxis": {
                    "type": "value",
                    "name": value_field_clean,
                    "nameLocation": "middle",
                    "nameGap": 50
                },
                "series": [{
                    "name": value_field_clean,
                    "data": values,
                    "type": "bar",
                    "itemStyle": {
                        "color": "#217346"
                    }
                }]
            }
        }
    except Exception as e:
        logger.error(f"生成概览图表失败: {e}")
        return None


async def generate_insights(data: Dict[str, Any], config: Dict[str, Any], file_id: str, charts: List[Dict[str, Any]] = None) -> tuple[str, List[Dict[str, Any]]]:
    """调用大模型生成文字解读，返回 (insights文本, key_metrics数组)"""
    try:
        charts_info = []
        if charts:
            charts_info = [{"title": c.get("title"), "type": c.get("type")} for c in charts]
        
        # 计算关键指标用于生成表格（基于SQL聚合结果）
        key_metrics = []
        if data.get("data") and len(data["data"]) > 0:
            columns = data.get("columns", [])
            value_fields = config.get("value_fields", [])
            total_row_count = data.get('total_row_count', 0)  # 全量数据总行数
            row_count = data.get('row_count', 0)  # 聚合后的行数
            
            # 添加订单总数量（使用全量数据）
            if total_row_count > 0:
                key_metrics.append({
                    "name": "订单总数量",
                    "value": f"{total_row_count:,}",
                    "numeric_value": float(total_row_count),
                    "unit": "笔",
                    "description": "全部数据的交易笔数"
                })
            
            # 处理数值字段（从SQL聚合结果中提取）
            for value_field in value_fields[:5]:  # 最多5个字段
                value_field_clean = value_field.split('.', 1)[1] if '.' in value_field else value_field
                
                # 查找聚合结果中的统计值
                total_col = f"{value_field_clean}_求和"
                avg_col = f"{value_field_clean}_平均"
                max_col = f"{value_field_clean}_最大"
                min_col = f"{value_field_clean}_最小"
                count_col = f"{value_field_clean}_计数"
                
                # 从聚合结果中提取统计值
                total = None
                avg = None
                max_val = None
                min_val = None
                count_val = None
                
                # 如果数据是聚合结果，从第一行提取汇总值
                if row_count > 0 and len(data["data"]) > 0:
                    first_row = data["data"][0]
                    if total_col in columns:
                        col_idx = columns.index(total_col)
                        if col_idx < len(first_row):
                            total = first_row[col_idx]
                    if avg_col in columns:
                        col_idx = columns.index(avg_col)
                        if col_idx < len(first_row):
                            avg = first_row[col_idx]
                    if max_col in columns:
                        col_idx = columns.index(max_col)
                        if col_idx < len(first_row):
                            max_val = first_row[col_idx]
                    if min_col in columns:
                        col_idx = columns.index(min_col)
                        if col_idx < len(first_row):
                            min_val = first_row[col_idx]
                    if count_col in columns:
                        col_idx = columns.index(count_col)
                        if col_idx < len(first_row):
                            count_val = first_row[col_idx]
                
                # 如果没有聚合结果，使用SQL直接查询全量统计（应用类型转换）
                if total is None:
                    # 使用SQL聚合查询全量统计
                    from .large_file_duckdb import duckdb_manager
                    table_name = duckdb_manager._get_cached_table_name(file_id, config.get("sheet_name"))
                    if table_name:
                        try:
                            # 获取字段类型并转换为数值类型
                            column_types = _get_column_types(file_id, config.get("sheet_name"), duckdb_manager)
                            value_column_type = column_types.get(value_field_clean, 'VARCHAR')
                            value_expr_raw = f'"{value_field_clean}"'
                            value_expr = _convert_to_numeric_expr(value_expr_raw, value_column_type)
                            
                            stats_sql = f'''
                                SELECT 
                                    SUM({value_expr}) as total,
                                    AVG({value_expr}) as avg_val,
                                    MAX({value_expr}) as max_val,
                                    MIN({value_expr}) as min_val,
                                    COUNT({value_expr}) as count_val
                                FROM "{table_name}"
                            '''
                            stats_result = duckdb_manager.conn.execute(stats_sql).fetchone()
                            if stats_result:
                                total = stats_result[0]
                                avg = stats_result[1]
                                max_val = stats_result[2]
                                min_val = stats_result[3]
                                count_val = stats_result[4]
                        except Exception as e:
                            logger.warning(f"查询字段 {value_field_clean} 统计失败: {e}")
                
                # 如果仍然没有值，跳过
                if total is None and avg is None:
                    continue
                
                # 判断单位
                unit = ""
                if "额" in value_field or "金额" in value_field or "价格" in value_field or "单价" in value_field:
                    unit = "元"
                elif "数量" in value_field or "件" in value_field or "个" in value_field:
                    unit = "件"
                elif "率" in value_field or "折扣" in value_field:
                    unit = "%"
                
                # 销售额净额总计
                if total is not None:
                    key_metrics.append({
                        "name": f"{value_field_clean}总计",
                        "value": f"{total:,.2f}",
                        "numeric_value": float(total) if total is not None else 0,
                        "unit": unit,
                        "description": "全部数据的累计值"
                    })
                
                # 平均成交单价 / 单均销售额
                if avg is not None:
                    if "单价" in value_field_clean or "价格" in value_field_clean:
                        metric_name = "平均成交单价"
                    elif "额" in value_field_clean or "金额" in value_field_clean:
                        metric_name = "单均销售额"
                    else:
                        metric_name = f"{value_field_clean}平均值"
                    
                    key_metrics.append({
                        "name": metric_name,
                        "value": f"{avg:,.2f}",
                        "numeric_value": float(avg) if avg is not None else 0,
                        "unit": unit,
                        "description": "单件产品的平均销售价格" if "单价" in metric_name else "每笔订单的平均金额" if "单均" in metric_name else "数据的平均值"
                    })
                
                # 最高单笔销售额
                if max_val is not None:
                    key_metrics.append({
                        "name": f"最高单笔{value_field_clean}",
                        "value": f"{max_val:,.2f}",
                        "numeric_value": float(max_val) if max_val is not None else 0,
                        "unit": unit,
                        "description": "单笔交易最大金额" if "额" in value_field_clean else "数据中的最大值"
                    })
                
                # 最低单笔销售额
                if min_val is not None:
                    key_metrics.append({
                        "name": f"最低单笔{value_field_clean}",
                        "value": f"{min_val:,.2f}",
                        "numeric_value": float(min_val) if min_val is not None else 0,
                        "unit": unit,
                        "description": "单笔交易最小金额" if "额" in value_field_clean else "数据中的最小值"
                    })
            
            # 计算平均折扣率（如果有折扣字段，使用SQL聚合，应用类型转换）
            discount_fields = [col for col in columns if "折扣" in col or "discount" in col.lower()]
            if discount_fields and total_row_count > 0:
                discount_field = discount_fields[0]
                # 使用SQL聚合查询全量平均折扣率
                from .large_file_duckdb import duckdb_manager
                table_name = duckdb_manager._get_cached_table_name(file_id, config.get("sheet_name"))
                if table_name:
                    try:
                        # 获取字段类型并转换为数值类型
                        column_types = _get_column_types(file_id, config.get("sheet_name"), duckdb_manager)
                        discount_column_type = column_types.get(discount_field, 'VARCHAR')
                        discount_expr_raw = f'"{discount_field}"'
                        discount_expr = _convert_to_numeric_expr(discount_expr_raw, discount_column_type)
                        
                        discount_sql = f'SELECT AVG({discount_expr}) as avg_discount FROM "{table_name}"'
                        discount_result = duckdb_manager.conn.execute(discount_sql).fetchone()
                        if discount_result and discount_result[0] is not None:
                            avg_discount = discount_result[0]
                            key_metrics.append({
                                "name": "平均折扣率",
                                "value": f"{avg_discount:.2f}",
                                "numeric_value": float(avg_discount),
                                "unit": "%",
                                "description": "整体促销力度适中"
                            })
                    except Exception as e:
                        logger.warning(f"查询平均折扣率失败: {e}")
            
            # 计算单均数量（如果有数量字段，使用SQL聚合，应用类型转换）
            quantity_fields = [col for col in columns if "数量" in col or "quantity" in col.lower() or "件" in col]
            if quantity_fields and total_row_count > 0:
                quantity_field = quantity_fields[0]
                # 使用SQL聚合查询全量平均数量
                from .large_file_duckdb import duckdb_manager
                table_name = duckdb_manager._get_cached_table_name(file_id, config.get("sheet_name"))
                if table_name:
                    try:
                        # 获取字段类型并转换为数值类型
                        column_types = _get_column_types(file_id, config.get("sheet_name"), duckdb_manager)
                        quantity_column_type = column_types.get(quantity_field, 'VARCHAR')
                        quantity_expr_raw = f'"{quantity_field}"'
                        quantity_expr = _convert_to_numeric_expr(quantity_expr_raw, quantity_column_type)
                        
                        quantity_sql = f'SELECT AVG({quantity_expr}) as avg_quantity FROM "{table_name}"'
                        quantity_result = duckdb_manager.conn.execute(quantity_sql).fetchone()
                        if quantity_result and quantity_result[0] is not None:
                            avg_quantity = quantity_result[0]
                            key_metrics.append({
                                "name": "单均数量",
                                "value": f"{avg_quantity:.2f}",
                                "numeric_value": float(avg_quantity),
                                "unit": "件",
                                "description": "每笔订单平均购买产品件数"
                            })
                    except Exception as e:
                        logger.warning(f"查询单均数量失败: {e}")
        
        # 为指标添加说明（如果还没有）
        for m in key_metrics:
            if not m.get('description'):
                if '总计' in m['name']:
                    m['description'] = '全部数据的累计值'
                elif '平均值' in m['name']:
                    m['description'] = '数据的平均值'
                elif '最大值' in m['name'] or '最高' in m['name']:
                    m['description'] = '数据中的最大值'
                elif '最小值' in m['name'] or '最低' in m['name']:
                    m['description'] = '数据中的最小值'
                elif '订单总数量' in m['name']:
                    m['description'] = '分析样本的交易笔数'
                else:
                    m['description'] = '关键业务指标'
        
        metrics_table = "\n".join([
            f"| {m['name']} | {m['value']}{m['unit']} | {m.get('description', '')} |"
            for m in key_metrics[:10]  # 最多10个指标
        ])
        
        prompt = f"""请基于以下数据分析结果，生成一份专业的数据解读报告。

数据概览：
- 数据行数: {data.get('row_count', 0)}
- 数据列数: {len(data.get('columns', []))}

报表配置：
{json.dumps(config, ensure_ascii=False, indent=2)}

已生成的图表：
{json.dumps(charts_info, ensure_ascii=False, indent=2)}

关键指标数据（必须使用Markdown表格格式展示）：
| 指标名称 | 数值 | 说明 |
|---------|------|------|
{metrics_table}

请生成一份结构化的数据解读报告，必须遵循以下Markdown格式：

## 一、数据总体概况

使用段落和列表说明数据的基本情况。

## 二、关键发现和趋势

### 2.1 核心指标分析
**必须使用Markdown表格格式展示关键指标**，参考上面的指标数据表格。每个指标都要有清晰的说明。

### 2.2 趋势分析
结合图表数据说明趋势变化，引用已生成的图表进行分析。

## 三、深度洞察

### 3.1 业务洞察
使用列表和表格展示洞察：

- 洞察点1：详细说明
- 洞察点2：详细说明

| 维度 | 发现 | 影响 |
|------|------|------|
| 维度1 | 发现1 | 影响1 |
| 维度2 | 发现2 | 影响2 |

### 3.2 异常识别
如有异常数据，使用表格展示：

| 异常项 | 异常值 | 正常范围 | 建议 |
|--------|--------|---------|------|
| 项1 | 值1 | 范围1 | 建议1 |

## 四、行动建议

使用有序列表展示建议：

1. **建议标题1**
   - 具体措施1
   - 具体措施2

2. **建议标题2**
   - 具体措施1
   - 具体措施2

要求：
- 严格遵循上述Markdown结构（使用 ## 和 ### 标题层级）
- **核心指标必须使用Markdown表格格式**，不要用纯文字描述
- 大量使用表格展示数据（至少3-5个表格）
- 使用列表展示要点
- 语言专业、简洁，不要使用表情符号
- 每个章节都要有实质性内容
- 表格要包含实际数据，不要只是模板
- 指标数值要格式化（千分位、单位等）"""
        
        # 使用 file_id 作为 session_id
        session_id = f"report_{file_id}"
        agent = await large_file_agent_manager.get_or_create_agent(session_id, file_id)
        
        # 发送消息并获取响应
        response_content = ""
        async for msg in agent.process_command(prompt, require_export_sheet=False):
            if isinstance(msg, dict):
                if msg.get('type') == 'text':
                    response_content += msg.get('content', '')
                elif msg.get('type') == 'message':
                    content = msg.get('content', [])
                    if isinstance(content, list):
                        for item in content:
                            if isinstance(item, dict) and item.get('type') == 'text':
                                response_content += item.get('text', '')
        
        insights = response_content or "数据解读生成中..."
        
        # 返回元组 (insights文本, key_metrics数组)
        return insights, key_metrics
    except Exception as e:
        logger.error(f"生成文字解读失败: {e}")
        return f"数据解读生成失败: {str(e)}", []


def get_report(report_id: str) -> Optional[Dict[str, Any]]:
    """获取报表"""
    return report_tasks.get(report_id)
