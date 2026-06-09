# backend/app/pptx/schemas.py
"""
PPTX 汇报模块 — 数据模型定义
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


# ============================================================
# LLM 规划输出模型
# ============================================================

class KPISpec(BaseModel):
    """KPI 指标规格"""
    label: str = Field(..., description="指标名称")
    sql: str = Field("", description="计算 SQL")
    value: Optional[str] = Field(None, description="计算后填充的值")
    unit: str = Field("", description="单位")
    icon: str = Field("bar-chart-3", description="Lucide 图标名")


class ChartSpec(BaseModel):
    """图表规格"""
    chart_type: str = Field("bar", description="图表类型: bar/line/pie/radar/scatter 等")
    title: str = Field("", description="图表标题")
    sql: str = Field("", description="数据查询 SQL")
    x_field: str = Field("", description="X 轴字段")
    y_field: str = Field("", description="Y 轴字段")
    series_field: str = Field("", description="系列字段（分组）")
    data: Optional[List[Dict[str, Any]]] = Field(None, description="查询填充后的数据")


class TableSpec(BaseModel):
    """数据表格规格"""
    sql: str = Field("", description="数据查询 SQL")
    columns: List[str] = Field(default_factory=list, description="列名列表")
    rows: Optional[List[List[Any]]] = Field(None, description="查询填充后的行数据")
    max_rows: int = Field(10, description="最多展示行数")


class SlideSpec(BaseModel):
    """单张幻灯片规格"""
    layout: str = Field("content", description="版式: cover/toc/kpi/chart/table/summary/content")
    title: str = Field("", description="页标题")
    subtitle: str = Field("", description="页副标题")
    bullets: List[str] = Field(default_factory=list, description="要点列表")
    kpis: Optional[List[KPISpec]] = Field(None, description="KPI 指标列表")
    chart: Optional[ChartSpec] = Field(None, description="图表规格")
    table: Optional[TableSpec] = Field(None, description="表格规格")
    notes: str = Field("", description="演讲者备注")


class SlidePlan(BaseModel):
    """整份汇报规划"""
    title: str = Field("", description="汇报主标题")
    subtitle: str = Field("", description="副标题")
    author: str = Field("", description="汇报人")
    domain: str = Field("general", description="业务领域")
    slides: List[SlideSpec] = Field(default_factory=list, description="幻灯片列表")


# ============================================================
# API 请求 / 响应模型
# ============================================================

class GenerateRequest(BaseModel):
    """生成 PPTX 请求"""
    file_id: str = Field(..., description="数据源文件 ID")
    template_key: str = Field("business_blue", description="模板 key")
    custom_prompt: str = Field("", description="用户自定义汇报要求")


class SlideUpdateRequest(BaseModel):
    """更新幻灯片请求"""
    slides: List[SlideSpec] = Field(..., description="更新后的幻灯片列表")


class PptxListItem(BaseModel):
    """汇报列表条目"""
    pptx_id: str
    title: str
    template_key: str
    slide_count: int
    created_at: str
    file_id: Optional[str] = None


class PptxDetail(BaseModel):
    """汇报详情（含全部幻灯片 JSON）"""
    pptx_id: str
    title: str
    subtitle: str
    template_key: str
    slides: List[SlideSpec]
    created_at: str
    download_url: str
