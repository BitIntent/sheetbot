# backend/app/batch_word/schemas.py
"""
批量转 Word - Pydantic 请求/响应模型
"""
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field


# ==================== 请求 ====================

class AutoAnnotateRequest(BaseModel):
    """AI 自动标注请求"""
    template_id: str = Field(..., description="模板文件 ID")
    excel_columns: List[str] = Field(..., description="Excel 列头列表")


class MappingItem(BaseModel):
    """单条标注映射"""
    placeholder: str = Field(..., description="Word 中的标注符，如 {姓名}")
    column: str = Field(..., description="对应 Excel 列名")
    type: str = Field(default="text", description="类型：text / image")
    original_text: Optional[str] = Field(default=None, description="命中的原始 demo 文本（用于标注预览）")


class GenerateRequest(BaseModel):
    """批量生成请求"""
    template_id: str = Field(..., description="模板文件 ID")
    mappings: List[MappingItem] = Field(..., description="标注映射列表")
    rows: List[Dict[str, Any]] = Field(..., description="Excel 行数据（含 image_base64）")
    filename_pattern: str = Field(default="文档_{_index}", description="输出文件名模式")
    template_file_name: Optional[str] = Field(default=None, description="上传模板文件名")
    source_file_id: Optional[str] = Field(default=None, description="来源 Excel 文件ID")
    source_file_name: Optional[str] = Field(default=None, description="来源 Excel 文件名")


class PreviewRequest(BaseModel):
    """预览请求（单行）"""
    template_id: str = Field(..., description="模板文件 ID")
    mappings: List[MappingItem] = Field(..., description="标注映射列表")
    row_data: Dict[str, Any] = Field(..., description="单行数据")


# ==================== 响应 ====================

class UploadTemplateResponse(BaseModel):
    """上传模板响应"""
    template_id: str
    placeholders: List[str] = Field(default_factory=list, description="检测到的 {标注}")
    text_summary: str = Field(default="", description="文档纯文本摘要（前 500 字）")
    has_images: bool = Field(default=False, description="模板中是否存在可替换图片位")
    has_saved_config: bool = Field(default=False, description="是否已有保存配置")
    saved_mappings: List[MappingItem] = Field(default_factory=list, description="已保存的映射")
    saved_filename_pattern: str = Field(default="文档_{_index}", description="已保存的文件名模式")
    saved_editor_html: str = Field(default="", description="已保存的在线编辑文档 HTML")


class AnnotationSuggestion(BaseModel):
    """单条 AI 标注建议"""
    original_text: str = Field(..., description="原文片段")
    placeholder: str = Field(..., description="建议的标注符")
    column: str = Field(..., description="对应的 Excel 列名")
    confidence: float = Field(default=0.8, description="置信度 0-1")


class AutoAnnotateResponse(BaseModel):
    """AI 自动标注响应"""
    suggestions: List[AnnotationSuggestion]
    annotated_text_preview: str = Field(default="", description="标注后的文本预览")


class SaveMappingsRequest(BaseModel):
    """保存映射请求"""
    template_id: str = Field(..., description="模板文件 ID")
    mappings: List[MappingItem] = Field(default_factory=list, description="映射列表")
    filename_pattern: Optional[str] = Field(default=None, description="文件名模式")
    editor_html: Optional[str] = Field(default=None, description="在线编辑文档 HTML")
    record_history: bool = Field(default=False, description="是否写入历史清单（仅手动保存时启用）")
    template_file_name: Optional[str] = Field(default=None, description="模板文件名")
    source_file_id: Optional[str] = Field(default=None, description="来源 Excel 文件ID")
    source_file_name: Optional[str] = Field(default=None, description="来源 Excel 文件名")


class SaveMappingsResponse(BaseModel):
    """保存映射响应"""
    ok: bool = True
    saved_count: int = 0
    saved_filename_pattern: str = "文档_{_index}"


class PreviewHtmlRequest(BaseModel):
    """在线预览请求（HTML）"""
    template_id: str = Field(..., description="模板文件 ID")
    mappings: List[MappingItem] = Field(default_factory=list, description="映射列表")
    row_data: Dict[str, Any] = Field(default_factory=dict, description="单行数据")
    mode: str = Field(default="filled", description="预览模式：filled / annotated")


class PreviewHtmlResponse(BaseModel):
    """在线预览响应（HTML）"""
    html: str = Field(default="", description="在线预览 HTML")


class AIAnnotateDocRequest(BaseModel):
    """AI 一键标注请求（直接修改 docx）"""
    template_id: str = Field(..., description="模板文件 ID")
    excel_columns: List[str] = Field(..., description="Excel 列头列表")
    sample_row: Dict[str, Any] = Field(default_factory=dict, description="样本行数据（用于精确匹配 demo 值）")


class AIAnnotateDocResponse(BaseModel):
    """AI 一键标注响应"""
    html: str = Field(default="", description="标注后的高保真 HTML")
    mappings: List[MappingItem] = Field(default_factory=list, description="生成的映射列表")


class ManualAnnotateRequest(BaseModel):
    """手工标注请求（单次文本替换）"""
    template_id: str = Field(..., description="模板文件 ID")
    original_text: str = Field(..., description="编辑区选中的原始文本")
    field_name: str = Field(..., description="要替换成的字段名")


class ManualAnnotateResponse(BaseModel):
    """手工标注响应"""
    html: str = Field(default="", description="替换后的高保真 HTML")


class ManualAnnotateImageRequest(BaseModel):
    """手工图片标注请求"""
    template_id: str = Field(..., description="模板文件 ID")
    field_name: str = Field(..., description="图片字段名")
    embed_id: Optional[str] = Field(default=None, description="编辑区图片 embed id")


class RestoreTemplateRequest(BaseModel):
    """一键还原模板请求"""
    template_id: str = Field(..., description="模板文件 ID")


class RestoreTemplateResponse(BaseModel):
    """一键还原模板响应"""
    template_id: str
    placeholders: List[str] = Field(default_factory=list, description="检测到的 {标注}")
    text_summary: str = Field(default="", description="文档纯文本摘要")
    has_images: bool = Field(default=False, description="模板中是否存在可替换图片位")
    html: str = Field(default="", description="还原后的高保真 HTML")


class GenerateResponse(BaseModel):
    """批量生成响应"""
    task_id: str
    total: int = Field(..., description="生成文档总数")
    download_url: str


class BatchWordHistoryItem(BaseModel):
    """历史转换记录"""
    task_id: str
    template_id: str = ""
    template_file_name: str = ""
    source_file_id: str = ""
    source_file_name: str = ""
    filename_pattern: str = ""
    total: int = 0
    created_at: str = ""
    download_url: str = ""


class BatchWordHistoryResponse(BaseModel):
    """历史转换列表响应"""
    items: List[BatchWordHistoryItem] = Field(default_factory=list)


class BatchWordHistoryDeleteResponse(BaseModel):
    """删除历史记录响应"""
    ok: bool = True
    deleted_task_id: str = ""
