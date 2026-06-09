# backend/app/large_file/report_exporter.py
"""
报表导出模块（Python包装器）
调用Node.js脚本进行PDF/Word/PNG导出
"""
import json
import subprocess
import tempfile
import os
from pathlib import Path
from typing import Dict, Any, Optional
from ..utils.logger import get_logger

logger = get_logger('large_file.report_exporter')

# Node.js脚本路径
SCRIPT_DIR = Path(__file__).parent
EXPORTER_SCRIPT = SCRIPT_DIR / "report_exporter.js"


async def export_report(report_data: Dict[str, Any], format_type: str, output_dir: Optional[str] = None) -> str:
    """
    导出报表
    
    Args:
        report_data: 报表数据（包含title, key_metrics, charts, insights等）
        format_type: 导出格式（pdf/word/png）
        output_dir: 输出目录（可选）
    
    Returns:
        输出文件路径
    """
    if format_type not in ['pdf', 'png']:
        raise ValueError(f"不支持的导出格式: {format_type}")
    
    # 创建临时目录
    if output_dir:
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
    else:
        output_path = Path(tempfile.gettempdir())
    
    # 生成输出文件名
    from datetime import datetime
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"报表_{timestamp}.{format_type}"
    
    output_file = output_path / filename
    
    # 创建临时JSON文件存储报表数据
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False, encoding='utf-8') as f:
        json.dump(report_data, f, ensure_ascii=False, indent=2)
        temp_json_path = f.name
    
    try:
        # 检查脚本文件是否存在
        if not EXPORTER_SCRIPT.exists():
            raise RuntimeError(f"Node.js导出脚本不存在: {EXPORTER_SCRIPT}")
        
        # 调用Node.js脚本
        # 查找Node.js可执行文件
        node_cmd = _find_node_executable()
        if not node_cmd:
            raise RuntimeError("未找到Node.js，请先安装Node.js 18+")
        
        logger.info(f"使用Node.js: {node_cmd}")
        
        # 确定工作目录：查找frontend目录（包含node_modules）
        # 从脚本路径向上查找项目根目录，然后查找frontend目录
        script_dir = EXPORTER_SCRIPT.parent  # backend/app/large_file
        project_root = script_dir.parent.parent.parent  # backend/app/large_file -> backend/app -> backend -> 项目根目录
        
        # 查找frontend目录
        frontend_dir = project_root / "frontend"
        if not frontend_dir.exists():
            # 如果找不到，尝试从当前文件位置向上查找
            current_file = Path(__file__)
            project_root = current_file.parent.parent.parent.parent  # backend/app/large_file -> backend/app -> backend -> 项目根目录
            frontend_dir = project_root / "frontend"
        
        frontend_dir = frontend_dir.resolve()
        node_modules_path = frontend_dir / "node_modules"
        
        if not node_modules_path.exists():
            raise RuntimeError(
                f"未找到node_modules目录: {node_modules_path}\n"
                f"请在 {frontend_dir} 目录下运行 'npm install' 安装依赖"
            )
        
        logger.info(f"Node.js工作目录: {frontend_dir}")
        logger.info(f"node_modules路径: {node_modules_path}")
        
        # 执行导出命令
        # 使用绝对路径或相对于工作目录的路径
        # 确保路径使用正斜杠（Node.js在Windows上也支持）
        script_path = str(EXPORTER_SCRIPT.resolve()).replace('\\', '/')
        json_path = str(Path(temp_json_path).resolve()).replace('\\', '/')
        output_path = str(output_file.resolve()).replace('\\', '/')
        
        cmd = [
            node_cmd,
            script_path,
            format_type,
            json_path,
            output_path
        ]
        
        logger.info(f"执行导出命令: {' '.join(cmd)}")
        logger.info(f"脚本路径: {EXPORTER_SCRIPT}, 是否存在: {EXPORTER_SCRIPT.exists()}")
        logger.info(f"临时JSON路径: {temp_json_path}")
        logger.info(f"输出文件路径: {output_file}")
        
        # 设置环境变量，确保ES模块能找到node_modules
        # 注意：ES模块不支持NODE_PATH，但设置工作目录为frontend应该能帮助解析
        env = os.environ.copy()
        # 虽然ES模块不支持NODE_PATH，但保留以防某些工具需要
        env['NODE_PATH'] = str(node_modules_path.resolve())
        # 配置 puppeteer 使用淘宝镜像下载 Chromium（加速下载）
        env['PUPPETEER_DOWNLOAD_HOST'] = 'https://npmmirror.com/mirrors'
        
        # 对于ES模块，还需要设置工作目录
        # ES模块解析从脚本文件位置开始，但NODE_PATH可以帮助找到模块
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=300,  # 5分钟超时
            cwd=str(frontend_dir),  # 设置工作目录为frontend，确保能找到node_modules
            env=env  # 设置NODE_PATH环境变量
        )
        
        # 记录输出（用于调试）
        if result.stdout:
            logger.info(f"Node.js脚本stdout: {result.stdout[:1000]}")
        if result.stderr:
            logger.error(f"Node.js脚本stderr: {result.stderr[:1000]}")
        logger.info(f"Node.js脚本返回码: {result.returncode}")
        
        # 解析输出
        try:
            # 尝试从stdout解析JSON（Node.js脚本会将JSON输出到stdout）
            stdout_lines = result.stdout.strip().split('\n')
            json_output = None
            
            # 查找最后一行JSON输出（可能前面有调试信息）
            for line in reversed(stdout_lines):
                line = line.strip()
                if line.startswith('{') and line.endswith('}'):
                    try:
                        json_output = json.loads(line)
                        break
                    except json.JSONDecodeError:
                        continue
            
            if json_output:
                if not json_output.get('success'):
                    error_msg = json_output.get('error', '未知错误')
                    error_stack = json_output.get('stack', '')
                    logger.error(f"导出失败: {error_msg}")
                    if error_stack:
                        logger.error(f"错误堆栈: {error_stack[:500]}")
                    raise RuntimeError(f"导出失败: {error_msg}")
            else:
                # 如果没有JSON输出，检查返回码和文件是否存在
                if result.returncode != 0:
                    error_msg = result.stderr or result.stdout or "未知错误"
                    logger.error(f"导出失败 (returncode={result.returncode}): {error_msg}")
                    logger.error(f"完整stdout: {result.stdout}")
                    logger.error(f"完整stderr: {result.stderr}")
                    raise RuntimeError(f"导出失败: {error_msg}")
                
                if not output_file.exists():
                    error_msg = result.stderr or result.stdout or "文件未生成"
                    logger.error(f"导出失败: 文件未生成，错误信息: {error_msg}")
                    logger.error(f"完整stdout: {result.stdout}")
                    logger.error(f"完整stderr: {result.stderr}")
                    raise RuntimeError(f"导出失败: 文件未生成")
        except json.JSONDecodeError as e:
            # JSON解析失败，但文件可能已经生成
            if output_file.exists():
                logger.warning(f"JSON解析失败，但文件已生成: {e}")
            else:
                error_msg = result.stderr or result.stdout or f"JSON解析失败: {e}"
                logger.error(f"导出失败: {error_msg}")
                raise RuntimeError(f"导出失败: {error_msg}")
        
        logger.info(f"导出成功: {output_file}")
        return str(output_file)
        
    finally:
        # 清理临时文件
        try:
            os.unlink(temp_json_path)
        except:
            pass


def _find_node_executable() -> Optional[str]:
    """查找Node.js可执行文件"""
    import shutil
    
    # 常见的Node.js命令名
    node_names = ['node', 'nodejs']
    
    for name in node_names:
        node_path = shutil.which(name)
        if node_path:
            # 验证版本
            try:
                result = subprocess.run(
                    [node_path, '--version'],
                    capture_output=True,
                    text=True,
                    timeout=5
                )
                if result.returncode == 0:
                    version_str = result.stdout.strip()
                    # 提取主版本号
                    major_version = int(version_str.lstrip('v').split('.')[0])
                    if major_version >= 18:
                        return node_path
            except:
                continue
    
    return None
