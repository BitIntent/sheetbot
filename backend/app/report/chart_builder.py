# backend/app/report/chart_builder.py
"""
图表构建器 — 根据 LLM plan 和 SQL 查询结果动态生成 ECharts option
支持: line, bar, bar_horizontal, bar_grouped, pie, radar,
      scatter, heatmap, gauge, funnel, treemap
"""
from typing import Dict, List, Any, Optional
from ..utils.logger import get_logger

logger = get_logger('report.chart_builder')

DEFAULT_PALETTE = [
    "#34D399", "#60A5FA", "#F59E0B", "#A78BFA", "#F87171",
    "#FB923C", "#38BDF8", "#E879F9", "#4ADE80", "#FBBF24",
]

DARK_THEME = {
    "backgroundColor": "transparent",
    "textStyle": {"color": "#E5E5E5"},
    "title": {"textStyle": {"color": "#FFFFFF", "fontSize": 16, "fontWeight": "bold"}},
    "legend": {"textStyle": {"color": "#B3B3B3"}, "top": 30},
    "tooltip": {
        "backgroundColor": "rgba(30,30,30,0.95)",
        "borderColor": "#444",
        "textStyle": {"color": "#E5E5E5"},
    },
}


def _merge_theme(option: dict) -> dict:
    for k, v in DARK_THEME.items():
        if k not in option:
            option[k] = v
        elif isinstance(v, dict) and isinstance(option.get(k), dict):
            for sk, sv in v.items():
                option[k].setdefault(sk, sv)
    return option


def _safe_val(v: Any) -> Any:
    """Ensure numeric values are JSON-safe."""
    if v is None:
        return 0
    if isinstance(v, (int, float)):
        import math
        return 0 if (math.isnan(v) or math.isinf(v)) else v
    try:
        return float(v)
    except (ValueError, TypeError):
        return str(v)


def _to_float(v: Any) -> Optional[float]:
    """宽松数值解析，失败返回 None。"""
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        import math
        f = float(v)
        return f if math.isfinite(f) else None
    if isinstance(v, str):
        raw = v.strip().replace(",", "").replace("%", "")
        if not raw:
            return None
        try:
            return float(raw)
        except Exception:
            return None
    return None


def _field_numeric_ratio(rows: List[Dict], field: Optional[str], sample_size: int = 120) -> float:
    """估算字段可被解析为数值的比例。"""
    if not field or not rows:
        return 0.0
    sample = rows[:sample_size]
    valid = [r.get(field) for r in sample if field in r]
    if not valid:
        return 0.0
    numeric = sum(1 for v in valid if _to_float(v) is not None)
    return numeric / max(len(valid), 1)


def _pick_dimension_metric_fields(
    rows: List[Dict],
    dim_field: Optional[str],
    metric_field: Optional[str],
) -> tuple[Optional[str], Optional[str]]:
    """
    对两字段做自动纠偏：维度字段倾向非数值，指标字段倾向数值。
    """
    if not rows:
        return dim_field, metric_field
    first = rows[0] if isinstance(rows[0], dict) else {}
    keys = [k for k in first.keys()]
    if not keys:
        return dim_field, metric_field

    dim = dim_field if dim_field in keys else None
    metric = metric_field if metric_field in keys else None

    # 候选补全
    if dim is None and metric is not None:
        dim = next((k for k in keys if k != metric), None)
    if metric is None and dim is not None:
        metric = next((k for k in keys if k != dim), None)
    if dim is None and metric is None and len(keys) >= 2:
        dim, metric = keys[0], keys[1]

    if not dim or not metric:
        return dim, metric

    dim_ratio = _field_numeric_ratio(rows, dim)
    metric_ratio = _field_numeric_ratio(rows, metric)

    # 显著反向时交换
    if dim_ratio >= 0.7 and metric_ratio <= 0.4:
        dim, metric = metric, dim
        dim_ratio, metric_ratio = metric_ratio, dim_ratio

    # 指标字段若仍非数值，尝试找更合理的数值列
    if metric_ratio < 0.5:
        numeric_candidates = sorted(
            ((k, _field_numeric_ratio(rows, k)) for k in keys if k != dim),
            key=lambda x: x[1],
            reverse=True,
        )
        if numeric_candidates and numeric_candidates[0][1] >= 0.6:
            metric = numeric_candidates[0][0]

    # 维度字段若看起来数值化，尝试找更合理的分类列
    if _field_numeric_ratio(rows, dim) >= 0.7:
        category_candidates = sorted(
            ((k, _field_numeric_ratio(rows, k)) for k in keys if k != metric),
            key=lambda x: x[1],
        )
        if category_candidates and category_candidates[0][1] <= 0.4:
            dim = category_candidates[0][0]

    return dim, metric


def _extract_dim_metric_series(
    rows: List[Dict],
    dim_field: Optional[str],
    metric_field: Optional[str],
) -> tuple[List[str], List[float]]:
    """提取可渲染的维度与数值序列，自动过滤无效点。"""
    dim, metric = _pick_dimension_metric_fields(rows, dim_field, metric_field)
    if not dim or not metric:
        return [], []
    labels: List[str] = []
    values: List[float] = []
    for r in rows:
        val = _to_float(r.get(metric))
        if val is None:
            continue
        labels.append(str(r.get(dim, "")))
        values.append(val)
    return labels, values


# ─────────────────────────────────────────────────────────
# 核心入口：从 LLM plan item + SQL 结果构建图表
# ─────────────────────────────────────────────────────────

def build_chart_from_plan(
    plan_item: Dict[str, Any],
    query_result: Dict[str, Any],
    palette: List[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    统一入口：根据 plan_item 描述和 query_result 数据构建 ECharts option。

    plan_item 结构:
        title, chart_type, x_field, y_field, series_field,
        name_field, value_field, insight_hint

    query_result 结构:
        columns: [...], rows: [{...}, ...], row_count: int
    """
    colors = palette or DEFAULT_PALETTE
    chart_type = plan_item.get("chart_type", "bar")
    title = plan_item.get("title", "未命名图表")
    rows = query_result.get("rows", [])

    if not rows:
        logger.warning("图表数据为空: title=%s", title)
        return None

    builder_map = {
        "line": _build_line,
        "bar": _build_bar,
        "bar_horizontal": _build_bar_horizontal,
        "bar_grouped": _build_bar_grouped,
        "pie": _build_pie,
        "radar": _build_radar,
        "scatter": _build_scatter,
        "heatmap": _build_heatmap,
        "gauge": _build_gauge,
        "funnel": _build_funnel,
        "treemap": _build_treemap,
    }

    builder = builder_map.get(chart_type, _build_bar)

    try:
        option = builder(plan_item, rows, colors)
        if option is None:
            return None
        return {
            "title": title,
            "type": chart_type,
            "option": _merge_theme(option),
            "insight_hint": plan_item.get("insight_hint", ""),
        }
    except Exception as e:
        logger.error("构建图表失败: title=%s type=%s err=%s", title, chart_type, e)
        return None


# ─────────────────────────────────────────────────────────
# 具体图表类型构建器
# ─────────────────────────────────────────────────────────

def _build_line(plan: Dict, rows: List[Dict], colors: List[str]) -> Optional[dict]:
    x_field = plan.get("x_field")
    y_field = plan.get("y_field")
    series_field = plan.get("series_field")

    if not x_field or not y_field:
        return None

    if series_field:
        return _build_multi_series_line(plan, rows, colors)

    labels, values = _extract_dim_metric_series(rows, x_field, y_field)
    if not labels or not values:
        return None

    return {
        "title": {"text": plan["title"], "left": "center"},
        "tooltip": {"trigger": "axis"},
        "grid": {"left": "3%", "right": "4%", "bottom": "12%", "containLabel": True},
        "xAxis": {"type": "category", "data": labels, "axisLabel": {"rotate": 30 if len(labels) > 12 else 0, "color": "#B3B3B3"}},
        "yAxis": {"type": "value", "splitLine": {"lineStyle": {"color": "#333"}}, "axisLabel": {"color": "#B3B3B3"}},
        "series": [{
            "name": y_field,
            "type": "line",
            "data": values,
            "smooth": True,
            "lineStyle": {"width": 2},
            "itemStyle": {"color": colors[0]},
            "areaStyle": {"opacity": 0.08},
            "animationDuration": 1200,
        }],
        "color": colors,
    }


def _build_multi_series_line(plan: Dict, rows: List[Dict], colors: List[str]) -> Optional[dict]:
    x_field = plan.get("x_field")
    y_field = plan.get("y_field")
    series_field = plan.get("series_field")
    if not x_field or not y_field or not series_field:
        return None

    x_field, y_field = _pick_dimension_metric_fields(rows, x_field, y_field)
    if not x_field or not y_field:
        return None

    series_map: Dict[str, Dict[str, Any]] = {}
    x_labels_set = []

    for r in rows:
        x_val = str(r.get(x_field, ""))
        s_val = str(r.get(series_field, ""))
        y_val = _to_float(r.get(y_field))
        if y_val is None:
            continue
        if x_val not in x_labels_set:
            x_labels_set.append(x_val)
        if s_val not in series_map:
            series_map[s_val] = {}
        series_map[s_val][x_val] = y_val

    series = []
    for i, (s_name, x_data) in enumerate(series_map.items()):
        series.append({
            "name": s_name,
            "type": "line",
            "data": [x_data.get(x, 0) for x in x_labels_set],
            "smooth": True,
            "lineStyle": {"width": 2},
            "itemStyle": {"color": colors[i % len(colors)]},
            "areaStyle": {"opacity": 0.05},
            "animationDuration": 1200,
        })
    if not series or not x_labels_set:
        return None

    return {
        "title": {"text": plan["title"], "left": "center"},
        "tooltip": {"trigger": "axis"},
        "legend": {"data": list(series_map.keys()), "top": 30},
        "grid": {"left": "3%", "right": "4%", "bottom": "12%", "containLabel": True},
        "xAxis": {"type": "category", "data": x_labels_set, "axisLabel": {"rotate": 30 if len(x_labels_set) > 12 else 0, "color": "#B3B3B3"}},
        "yAxis": {"type": "value", "splitLine": {"lineStyle": {"color": "#333"}}, "axisLabel": {"color": "#B3B3B3"}},
        "series": series,
        "color": colors,
    }


def _build_bar(plan: Dict, rows: List[Dict], colors: List[str]) -> Optional[dict]:
    x_field = plan.get("x_field")
    y_field = plan.get("y_field")
    series_field = plan.get("series_field")

    if not x_field or not y_field:
        return None

    if series_field:
        return _build_bar_grouped(plan, rows, colors)

    labels, values = _extract_dim_metric_series(rows, x_field, y_field)
    if not labels or not values:
        return None

    return {
        "title": {"text": plan["title"], "left": "center"},
        "tooltip": {"trigger": "axis"},
        "grid": {"left": "3%", "right": "4%", "bottom": "8%", "containLabel": True},
        "xAxis": {"type": "category", "data": labels, "axisLabel": {"color": "#B3B3B3"}},
        "yAxis": {"type": "value", "splitLine": {"lineStyle": {"color": "#333"}}, "axisLabel": {"color": "#B3B3B3"}},
        "series": [{
            "name": y_field,
            "type": "bar",
            "data": values,
            "barMaxWidth": 40,
            "itemStyle": {"color": colors[0], "borderRadius": [4, 4, 0, 0]},
            "animationDuration": 1000,
        }],
        "color": colors,
    }


def _build_bar_horizontal(plan: Dict, rows: List[Dict], colors: List[str]) -> Optional[dict]:
    x_field = plan.get("x_field") or plan.get("name_field")
    y_field = plan.get("y_field") or plan.get("value_field")
    if not x_field or not y_field:
        return None

    labels, values = _extract_dim_metric_series(rows, x_field, y_field)
    if not labels or not values:
        return None

    return {
        "title": {"text": plan["title"], "left": "center"},
        "tooltip": {"trigger": "axis"},
        "grid": {"left": "3%", "right": "4%", "bottom": "8%", "containLabel": True},
        "xAxis": {"type": "value", "splitLine": {"lineStyle": {"color": "#333"}}, "axisLabel": {"color": "#B3B3B3"}},
        "yAxis": {"type": "category", "data": labels, "axisLabel": {"color": "#B3B3B3"}},
        "series": [{
            "name": y_field,
            "type": "bar",
            "data": values,
            "barMaxWidth": 40,
            "itemStyle": {"color": colors[0], "borderRadius": [0, 4, 4, 0]},
            "animationDuration": 1000,
        }],
        "color": colors,
    }


def _build_bar_grouped(plan: Dict, rows: List[Dict], colors: List[str]) -> Optional[dict]:
    x_field = plan.get("x_field")
    y_field = plan.get("y_field")
    series_field = plan.get("series_field")
    if not x_field or not y_field or not series_field:
        return _build_bar(plan, rows, colors)

    x_field, y_field = _pick_dimension_metric_fields(rows, x_field, y_field)
    if not x_field or not y_field:
        return _build_bar(plan, rows, colors)

    series_map: Dict[str, Dict[str, Any]] = {}
    x_labels = []

    for r in rows:
        x_val = str(r.get(x_field, ""))
        s_val = str(r.get(series_field, ""))
        y_val = _to_float(r.get(y_field))
        if y_val is None:
            continue
        if x_val not in x_labels:
            x_labels.append(x_val)
        if s_val not in series_map:
            series_map[s_val] = {}
        series_map[s_val][x_val] = y_val

    series = []
    for i, (s_name, data) in enumerate(series_map.items()):
        series.append({
            "name": s_name,
            "type": "bar",
            "data": [data.get(x, 0) for x in x_labels],
            "barMaxWidth": 30,
            "itemStyle": {"color": colors[i % len(colors)], "borderRadius": [4, 4, 0, 0]},
        })
    if not series or not x_labels:
        return _build_bar(plan, rows, colors)

    return {
        "title": {"text": plan["title"], "left": "center"},
        "tooltip": {"trigger": "axis"},
        "legend": {"data": list(series_map.keys()), "top": 30},
        "grid": {"left": "3%", "right": "4%", "bottom": "8%", "containLabel": True},
        "xAxis": {"type": "category", "data": x_labels, "axisLabel": {"color": "#B3B3B3"}},
        "yAxis": {"type": "value", "splitLine": {"lineStyle": {"color": "#333"}}, "axisLabel": {"color": "#B3B3B3"}},
        "series": series,
        "color": colors,
    }


def _build_pie(plan: Dict, rows: List[Dict], colors: List[str]) -> Optional[dict]:
    name_field = plan.get("name_field") or plan.get("x_field")
    value_field = plan.get("value_field") or plan.get("y_field")
    if not name_field or not value_field:
        return None
    name_field, value_field = _pick_dimension_metric_fields(rows, name_field, value_field)
    if not name_field or not value_field:
        return None

    data = []
    for r in rows:
        name = str(r.get(name_field, ""))
        val = _to_float(r.get(value_field))
        if val is not None and val != 0:
            data.append({"value": val, "name": name})

    if not data:
        return None

    return {
        "title": {"text": plan["title"], "left": "center"},
        "tooltip": {"trigger": "item", "formatter": "{b}: {c} ({d}%)"},
        "legend": {"orient": "vertical", "right": "5%", "top": "middle", "textStyle": {"color": "#B3B3B3"}},
        "series": [{
            "type": "pie",
            "radius": ["40%", "70%"],
            "center": ["40%", "55%"],
            "data": data,
            "emphasis": {"itemStyle": {"shadowBlur": 10, "shadowOffsetX": 0, "shadowColor": "rgba(0,0,0,0.5)"}},
            "label": {"color": "#E5E5E5"},
            "animationDuration": 1200,
        }],
        "color": colors,
    }


def _build_radar(plan: Dict, rows: List[Dict], colors: List[str]) -> Optional[dict]:
    name_field = plan.get("name_field") or plan.get("x_field")
    value_field = plan.get("value_field") or plan.get("y_field")
    series_field = plan.get("series_field")

    if not name_field or not value_field:
        return None

    name_field, value_field = _pick_dimension_metric_fields(rows, name_field, value_field)
    if not name_field or not value_field:
        return None

    if series_field:
        indicator_names = sorted(set(str(r.get(name_field, "")) for r in rows))
        series_names = sorted(set(str(r.get(series_field, "")) for r in rows))

        lookup: Dict[str, Dict[str, float]] = {}
        for r in rows:
            s = str(r.get(series_field, ""))
            n = str(r.get(name_field, ""))
            v = _to_float(r.get(value_field))
            if v is None:
                continue
            lookup.setdefault(s, {})[n] = v

        all_vals = [v for sd in lookup.values() for v in sd.values() if isinstance(v, (int, float))]
        max_val = max(all_vals, default=100) * 1.2

        indicator = [{"name": n, "max": max_val} for n in indicator_names]
        series_data = []
        for s in series_names:
            series_data.append({
                "value": [lookup.get(s, {}).get(n, 0) for n in indicator_names],
                "name": s,
                "areaStyle": {"opacity": 0.15},
            })
    else:
        indicator_names = [str(r.get(name_field, "")) for r in rows]
        values = []
        for r in rows:
            v = _to_float(r.get(value_field))
            if v is not None:
                values.append(v)
        if not values:
            return None
        max_val = max(values, default=100) * 1.2 if values else 100
        indicator = [{"name": n, "max": max_val} for n in indicator_names]
        series_data = [{"value": values, "name": value_field, "areaStyle": {"opacity": 0.15}}]
        series_names = [value_field]

    return {
        "title": {"text": plan["title"], "left": "center"},
        "tooltip": {},
        "legend": {"data": series_names, "top": 30, "textStyle": {"color": "#B3B3B3"}},
        "radar": {"indicator": indicator, "axisName": {"color": "#B3B3B3"}, "splitLine": {"lineStyle": {"color": "#333"}}},
        "series": [{"type": "radar", "data": series_data, "animationDuration": 1200}],
        "color": colors,
    }


def _build_scatter(plan: Dict, rows: List[Dict], colors: List[str]) -> Optional[dict]:
    x_field = plan.get("x_field")
    y_field = plan.get("y_field")
    if not x_field or not y_field:
        return None

    x_ratio = _field_numeric_ratio(rows, x_field)
    y_ratio = _field_numeric_ratio(rows, y_field)
    if x_ratio < 0.5 and y_ratio >= 0.5:
        x_field, y_field = y_field, x_field

    data = []
    for r in rows:
        xv = _to_float(r.get(x_field))
        yv = _to_float(r.get(y_field))
        if xv is None or yv is None:
            continue
        data.append([xv, yv])
    if not data:
        return None

    return {
        "title": {"text": plan["title"], "left": "center"},
        # ECharts 模板字符串不支持 {c[0]} 这种写法，使用默认 item 提示避免占位符泄漏。
        "tooltip": {"trigger": "item"},
        "grid": {"left": "3%", "right": "4%", "bottom": "12%", "containLabel": True},
        "xAxis": {"type": "value", "name": x_field, "splitLine": {"lineStyle": {"color": "#333"}}, "axisLabel": {"color": "#B3B3B3"}},
        "yAxis": {"type": "value", "name": y_field, "splitLine": {"lineStyle": {"color": "#333"}}, "axisLabel": {"color": "#B3B3B3"}},
        "series": [{
            "type": "scatter",
            "data": data,
            "symbolSize": 8,
            "itemStyle": {"color": colors[0]},
            "animationDuration": 1000,
        }],
        "color": colors,
    }


def _build_heatmap(plan: Dict, rows: List[Dict], colors: List[str]) -> Optional[dict]:
    x_field = plan.get("x_field")
    y_field = plan.get("y_field")
    value_field = plan.get("value_field") or plan.get("series_field")
    if not x_field or not y_field or not value_field:
        return None

    # value_field 必须是数值列；x/y 尽量是分类列
    candidates = [x_field, y_field, value_field]
    scores = {k: _field_numeric_ratio(rows, k) for k in candidates}
    value_field = max(candidates, key=lambda k: scores[k])
    axis_fields = [k for k in candidates if k != value_field]
    if len(axis_fields) < 2:
        return None
    x_field, y_field = axis_fields[0], axis_fields[1]

    x_cats = sorted(set(str(r.get(x_field, "")) for r in rows))
    y_cats = sorted(set(str(r.get(y_field, "")) for r in rows))
    x_idx = {v: i for i, v in enumerate(x_cats)}
    y_idx = {v: i for i, v in enumerate(y_cats)}

    data = []
    max_val = 0
    for r in rows:
        xi = x_idx.get(str(r.get(x_field, "")))
        yi = y_idx.get(str(r.get(y_field, "")))
        val = _to_float(r.get(value_field))
        if xi is not None and yi is not None and val is not None:
            data.append([xi, yi, val])
            if val > max_val:
                max_val = val

    return {
        "title": {"text": plan["title"], "left": "center"},
        "tooltip": {"position": "top"},
        "grid": {"left": "3%", "right": "8%", "bottom": "12%", "containLabel": True},
        "xAxis": {"type": "category", "data": x_cats, "axisLabel": {"color": "#B3B3B3"}},
        "yAxis": {"type": "category", "data": y_cats, "axisLabel": {"color": "#B3B3B3"}},
        "visualMap": {"min": 0, "max": max_val or 100, "calculable": True, "orient": "horizontal", "left": "center", "bottom": "0%", "textStyle": {"color": "#B3B3B3"}, "inRange": {"color": ["#1a3a2a", "#34D399", "#F59E0B", "#F87171"]}},
        "series": [{
            "type": "heatmap",
            "data": data,
            "label": {"show": True, "color": "#E5E5E5"},
            "animationDuration": 1000,
        }],
    }


def _build_gauge(plan: Dict, rows: List[Dict], colors: List[str]) -> Optional[dict]:
    value_field = plan.get("value_field") or plan.get("y_field")
    if not value_field or not rows:
        return None

    val = _to_float(rows[0].get(value_field))
    if val is None:
        return None
    name = plan.get("title", "")

    return {
        "title": {"text": plan["title"], "left": "center"},
        "tooltip": {"formatter": "{a} <br/>{b} : {c}%"},
        "series": [{
            "name": name,
            "type": "gauge",
            "detail": {"formatter": "{value}", "textStyle": {"color": "#E5E5E5", "fontSize": 20}},
            "data": [{"value": val, "name": name}],
            "axisLine": {"lineStyle": {"color": [[0.3, colors[2]], [0.7, colors[0]], [1, colors[4]]], "width": 15}},
            "axisTick": {"lineStyle": {"color": "#666"}},
            "axisLabel": {"color": "#B3B3B3"},
            "pointer": {"itemStyle": {"color": "#E5E5E5"}},
            "animationDuration": 1200,
        }],
    }


def _build_funnel(plan: Dict, rows: List[Dict], colors: List[str]) -> Optional[dict]:
    name_field = plan.get("name_field") or plan.get("x_field")
    value_field = plan.get("value_field") or plan.get("y_field")
    if not name_field or not value_field:
        return None
    name_field, value_field = _pick_dimension_metric_fields(rows, name_field, value_field)
    if not name_field or not value_field:
        return None

    data = []
    for r in rows:
        val = _to_float(r.get(value_field))
        if val is None:
            continue
        data.append({"name": str(r.get(name_field, "")), "value": val})
    if not data:
        return None

    data.sort(key=lambda x: x["value"], reverse=True)

    return {
        "title": {"text": plan["title"], "left": "center"},
        "tooltip": {"trigger": "item", "formatter": "{b}: {c}"},
        "legend": {"data": [d["name"] for d in data], "orient": "vertical", "right": "5%", "top": "middle", "textStyle": {"color": "#B3B3B3"}},
        "series": [{
            "type": "funnel",
            "left": "10%",
            "width": "60%",
            "data": data,
            "label": {"color": "#E5E5E5"},
            "animationDuration": 1200,
        }],
        "color": colors,
    }


def _build_treemap(plan: Dict, rows: List[Dict], colors: List[str]) -> Optional[dict]:
    name_field = plan.get("name_field") or plan.get("x_field")
    value_field = plan.get("value_field") or plan.get("y_field")
    if not name_field or not value_field:
        return None
    name_field, value_field = _pick_dimension_metric_fields(rows, name_field, value_field)
    if not name_field or not value_field:
        return None

    data = []
    for r in rows:
        val = _to_float(r.get(value_field))
        if val is not None and val > 0:
            data.append({"name": str(r.get(name_field, "")), "value": val})

    if not data:
        return None

    return {
        "title": {"text": plan["title"], "left": "center"},
        "tooltip": {"trigger": "item", "formatter": "{b}: {c}"},
        "series": [{
            "type": "treemap",
            "data": data,
            "label": {"show": True, "color": "#fff", "fontSize": 12},
            "breadcrumb": {"show": False},
            "itemStyle": {"borderColor": "#1e1e1e", "borderWidth": 2},
            "animationDuration": 1000,
        }],
        "color": colors,
    }


# ─────────────────────────────────────────────────────────
# 向后兼容: 旧 build_charts_for_template (保留但不再主用)
# ─────────────────────────────────────────────────────────

def build_charts_for_template(
    template_key: str,
    structure: Dict[str, Any],
    aggregated_data: Dict[str, Any],
    palette: List[str] = None,
) -> List[Dict[str, Any]]:
    """向后兼容入口，新流程使用 build_chart_from_plan。"""
    from .analyzer import group_compatible_fields, is_business_metric_field

    charts = []
    colors = palette or DEFAULT_PALETTE

    time_series = aggregated_data.get("time_series")
    category_aggs = aggregated_data.get("category_aggregations", {})

    if time_series and time_series.get("labels"):
        ts = time_series
        ts["datasets"] = [ds for ds in ts.get("datasets", []) if is_business_metric_field(ds.get("field", ""))]
        if ts["datasets"]:
            all_fields = [ds["field"] for ds in ts["datasets"]]
            sheets = structure.get("sheets", [])
            numeric_stats = {}
            for s in sheets:
                numeric_stats.update(s.get("numeric_stats", {}))
            groups = group_compatible_fields(all_fields, numeric_stats)
            for group in groups:
                group_datasets = [ds for ds in ts["datasets"] if ds["field"] in group]
                if len(group_datasets) >= 1:
                    chart = _compat_build_line_chart(
                        f"{'、'.join(group[:2])} 趋势分析",
                        ts["labels"], group_datasets, colors,
                    )
                    if chart:
                        charts.append(chart)

    for cat_field, cat_data in category_aggs.items():
        if not cat_data.get("labels"):
            continue
        cat_data["datasets"] = [
            ds for ds in cat_data.get("datasets", [])
            if is_business_metric_field(ds.get("field", ""))
        ]
        if not cat_data["datasets"]:
            continue
        chart = _compat_build_bar_chart(
            f"{cat_field} TOP 排行",
            cat_data["labels"], cat_data["datasets"],
            horizontal=True, palette=colors,
        )
        if chart:
            charts.append(chart)

        if cat_data["datasets"]:
            first_ds = cat_data["datasets"][0]
            pie = _compat_build_pie_chart(
                f"{cat_field} 占比分布",
                cat_data["labels"], first_ds["data"], colors,
            )
            if pie:
                charts.append(pie)

    return charts


def _compat_build_line_chart(title, labels, datasets, palette):
    colors = palette or DEFAULT_PALETTE
    series = []
    for i, ds in enumerate(datasets):
        series.append({
            "name": ds["field"], "type": "line", "data": ds["data"],
            "smooth": True, "lineStyle": {"width": 2},
            "itemStyle": {"color": colors[i % len(colors)]},
            "areaStyle": {"opacity": 0.08}, "animationDuration": 1200,
        })
    option = {
        "title": {"text": title, "left": "center"},
        "tooltip": {"trigger": "axis"},
        "legend": {"data": [ds["field"] for ds in datasets], "top": 30},
        "grid": {"left": "3%", "right": "4%", "bottom": "12%", "containLabel": True},
        "xAxis": {"type": "category", "data": labels, "axisLabel": {"rotate": 30 if len(labels) > 12 else 0, "color": "#B3B3B3"}},
        "yAxis": {"type": "value", "splitLine": {"lineStyle": {"color": "#333"}}, "axisLabel": {"color": "#B3B3B3"}},
        "series": series, "color": colors,
    }
    return {"title": title, "type": "line", "option": _merge_theme(option)}


def _compat_build_bar_chart(title, labels, datasets, horizontal=False, palette=None):
    colors = palette or DEFAULT_PALETTE
    series = []
    for i, ds in enumerate(datasets):
        series.append({
            "name": ds["field"], "type": "bar", "data": ds["data"], "barMaxWidth": 40,
            "itemStyle": {"color": colors[i % len(colors)], "borderRadius": [0, 4, 4, 0] if horizontal else [4, 4, 0, 0]},
        })
    x_axis = {"type": "category", "data": labels, "axisLabel": {"color": "#B3B3B3"}}
    y_axis = {"type": "value", "splitLine": {"lineStyle": {"color": "#333"}}, "axisLabel": {"color": "#B3B3B3"}}
    if horizontal:
        x_axis, y_axis = y_axis, x_axis
    option = {
        "title": {"text": title, "left": "center"}, "tooltip": {"trigger": "axis"},
        "legend": {"data": [ds["field"] for ds in datasets], "top": 30},
        "grid": {"left": "3%", "right": "4%", "bottom": "8%", "containLabel": True},
        "xAxis": x_axis, "yAxis": y_axis, "series": series, "color": colors,
    }
    return {"title": title, "type": "bar", "option": _merge_theme(option)}


def _compat_build_pie_chart(title, labels, values, palette=None):
    colors = palette or DEFAULT_PALETTE
    data = [{"value": v, "name": l} for l, v in zip(labels, values) if v is not None]
    if not data:
        return None
    option = {
        "title": {"text": title, "left": "center"},
        "tooltip": {"trigger": "item", "formatter": "{b}: {c} ({d}%)"},
        "legend": {"orient": "vertical", "right": "5%", "top": "middle", "textStyle": {"color": "#B3B3B3"}},
        "series": [{"type": "pie", "radius": ["40%", "70%"], "center": ["40%", "55%"], "data": data, "label": {"color": "#E5E5E5"}}],
        "color": colors,
    }
    return {"title": title, "type": "pie", "option": _merge_theme(option)}
