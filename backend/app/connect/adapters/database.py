# ============================================================================
# 数据库适配器 - MySQL / PostgreSQL 查询同步
# 执行用户配置的 SQL 查询并返回结果集
# ============================================================================
from __future__ import annotations

from decimal import Decimal
from datetime import datetime
from typing import Any, Dict, List, Optional

from .base import BaseAdapter


class DatabaseAdapter(BaseAdapter):
    """数据库连接器适配器（MySQL / PostgreSQL）"""

    async def test_connection(self, config: Dict[str, Any]) -> bool:
        db_type = config.get("db_type", "mysql")
        required_keys = ["host", "database", "username"]
        missing = [k for k in required_keys if not str(config.get(k, "")).strip()]
        if missing:
            raise ValueError(f"缺少必填配置: {', '.join(missing)}")

        if db_type == "mysql":
            return await self._test_mysql(config)
        if db_type == "postgresql":
            return await self._test_pg(config)
        raise ValueError(f"不支持的数据库类型: {db_type}")

    async def fetch_data(
        self,
        config: Dict[str, Any],
        last_sync_at: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        db_type = config.get("db_type", "mysql")
        query = (config.get("query", "") or "").strip()
        if not query:
            return []

        incremental_column = (config.get("incremental_column", "") or "").strip()
        cursor_strategy = (config.get("cursor_strategy", "time") or "time").strip().lower()
        batch_size = int(config.get("batch_size", 1000) or 1000)
        if batch_size <= 0:
            batch_size = 1000

        # 优先使用持久化 cursor；若没有则 time 策略回退到 last_sync_at
        cursor_value = config.get("last_cursor")
        if cursor_value in ("", None) and cursor_strategy == "time" and last_sync_at:
            cursor_value = last_sync_at.isoformat()

        if db_type == "mysql":
            rows = await self._query_mysql(
                config, query,
                incremental_column=incremental_column,
                cursor_strategy=cursor_strategy,
                cursor_value=cursor_value,
                batch_size=batch_size,
            )
            self._store_next_cursor(config, rows, incremental_column, cursor_strategy)
            return rows
        if db_type == "postgresql":
            rows = await self._query_pg(
                config, query,
                incremental_column=incremental_column,
                cursor_strategy=cursor_strategy,
                cursor_value=cursor_value,
                batch_size=batch_size,
            )
            self._store_next_cursor(config, rows, incremental_column, cursor_strategy)
            return rows
        raise ValueError(f"不支持的数据库类型: {db_type}")

    def get_available_fields(self, config: Dict[str, Any]) -> List[str]:
        # 字段在首次拉取后通过结果集的 keys 动态获取
        return ["(执行查询后自动识别列名)"]

    async def preview_fields(self, config: Dict[str, Any]) -> List[str]:
        """
        在“测试连接”阶段直接预览 SQL 返回字段名。
        不依赖实际数据行，优先读取游标/语句元数据。
        """
        db_type = config.get("db_type", "mysql")
        query = (config.get("query", "") or "").strip()
        if not query:
            return []

        if db_type == "mysql":
            return await self._query_mysql_columns(config, query)
        if db_type == "postgresql":
            return await self._query_pg_columns(config, query)
        return []

    # ── MySQL ──

    async def _test_mysql(self, config: Dict[str, Any]) -> bool:
        import aiomysql
        port = int(config.get("port", 3306))
        conn = await aiomysql.connect(
            host=config.get("host", "127.0.0.1"),
            port=port,
            db=config.get("database", ""),
            user=config.get("username", ""),
            password=config.get("password", ""),
            connect_timeout=10,
        )
        conn.close()
        return True

    async def _query_mysql(
        self,
        config: Dict[str, Any],
        query: str,
        *,
        incremental_column: str = "",
        cursor_strategy: str = "time",
        cursor_value: Any = None,
        batch_size: int = 1000,
    ) -> List[Dict[str, Any]]:
        import aiomysql
        port = int(config.get("port", 3306))
        conn = await aiomysql.connect(
            host=config.get("host", "127.0.0.1"),
            port=port,
            db=config.get("database", ""),
            user=config.get("username", ""),
            password=config.get("password", ""),
            connect_timeout=10,
        )
        try:
            async with conn.cursor(aiomysql.DictCursor) as cur:
                sql, args = self._build_incremental_sql(
                    query,
                    incremental_column=incremental_column,
                    cursor_strategy=cursor_strategy,
                    cursor_value=cursor_value,
                    batch_size=batch_size,
                    db_type="mysql",
                )
                await cur.execute(sql, args)
                rows = await cur.fetchall()
                return [dict(r) for r in rows]
        finally:
            conn.close()

    async def _query_mysql_columns(self, config: Dict[str, Any], query: str) -> List[str]:
        import aiomysql
        port = int(config.get("port", 3306))
        conn = await aiomysql.connect(
            host=config.get("host", "127.0.0.1"),
            port=port,
            db=config.get("database", ""),
            user=config.get("username", ""),
            password=config.get("password", ""),
            connect_timeout=10,
        )
        try:
            q = query.rstrip().rstrip(";")
            probe = f"SELECT * FROM ({q}) AS t LIMIT 0"
            async with conn.cursor() as cur:
                await cur.execute(probe)
                desc = cur.description or []
                return [c[0] for c in desc if c and c[0]]
        finally:
            conn.close()

    # ── PostgreSQL ──

    async def _test_pg(self, config: Dict[str, Any]) -> bool:
        import asyncpg
        port = int(config.get("port", 5432))
        conn = await asyncpg.connect(
            host=config.get("host", "127.0.0.1"),
            port=port,
            database=config.get("database", ""),
            user=config.get("username", ""),
            password=config.get("password", ""),
            timeout=10,
        )
        await conn.close()
        return True

    async def _query_pg(
        self,
        config: Dict[str, Any],
        query: str,
        *,
        incremental_column: str = "",
        cursor_strategy: str = "time",
        cursor_value: Any = None,
        batch_size: int = 1000,
    ) -> List[Dict[str, Any]]:
        import asyncpg
        port = int(config.get("port", 5432))
        conn = await asyncpg.connect(
            host=config.get("host", "127.0.0.1"),
            port=port,
            database=config.get("database", ""),
            user=config.get("username", ""),
            password=config.get("password", ""),
            timeout=10,
        )
        try:
            sql, args = self._build_incremental_sql(
                query,
                incremental_column=incremental_column,
                cursor_strategy=cursor_strategy,
                cursor_value=cursor_value,
                batch_size=batch_size,
                db_type="postgresql",
            )
            records = await conn.fetch(sql, *args)
            return [dict(r) for r in records]
        finally:
            await conn.close()

    async def _query_pg_columns(self, config: Dict[str, Any], query: str) -> List[str]:
        import asyncpg
        port = int(config.get("port", 5432))
        conn = await asyncpg.connect(
            host=config.get("host", "127.0.0.1"),
            port=port,
            database=config.get("database", ""),
            user=config.get("username", ""),
            password=config.get("password", ""),
            timeout=10,
        )
        try:
            q = query.rstrip().rstrip(";")
            probe = f"SELECT * FROM ({q}) AS t LIMIT 0"
            stmt = await conn.prepare(probe)
            attrs = stmt.get_attributes() or []
            return [a.name for a in attrs if getattr(a, "name", None)]
        finally:
            await conn.close()

    def _build_incremental_sql(
        self,
        base_query: str,
        *,
        incremental_column: str,
        cursor_strategy: str,
        cursor_value: Any,
        batch_size: int,
        db_type: str,
    ) -> tuple[str, list[Any]]:
        q = base_query.rstrip().rstrip(";")
        wrapped = f"SELECT * FROM ({q}) AS src"

        # 未配置增量列 -> 全量（可带 limit）
        if not incremental_column:
            return f"{wrapped} LIMIT {batch_size}", []

        col = incremental_column.strip()
        where_clause = ""
        args: list[Any] = []
        if cursor_value not in (None, ""):
            if db_type == "mysql":
                where_clause = f" WHERE src.`{col}` > %s"
                args = [cursor_value]
            else:
                where_clause = f' WHERE src."{col}" > $1'
                args = [cursor_value]

        order_col = f"src.`{col}`" if db_type == "mysql" else f'src."{col}"'
        sql = f"{wrapped}{where_clause} ORDER BY {order_col} ASC LIMIT {batch_size}"
        return sql, args

    def _store_next_cursor(
        self,
        config: Dict[str, Any],
        rows: List[Dict[str, Any]],
        incremental_column: str,
        cursor_strategy: str,
    ) -> None:
        if not rows or not incremental_column:
            return

        values = [r.get(incremental_column) for r in rows if r.get(incremental_column) is not None]
        if not values:
            return

        if cursor_strategy == "numeric":
            numeric_values: list[float] = []
            for v in values:
                if isinstance(v, (int, float, Decimal)):
                    numeric_values.append(float(v))
                else:
                    try:
                        numeric_values.append(float(str(v)))
                    except Exception:
                        continue
            if not numeric_values:
                return
            max_val = max(numeric_values)
            config["_next_cursor"] = int(max_val) if max_val.is_integer() else max_val
            return

        # time 策略：统一存字符串，便于跨驱动参数化
        normalized = [v.isoformat() if isinstance(v, datetime) else str(v) for v in values]
        normalized = [v for v in normalized if v]
        if normalized:
            config["_next_cursor"] = max(normalized)
