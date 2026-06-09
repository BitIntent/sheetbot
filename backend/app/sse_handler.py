"""

SSE Handler for Excel AI Assistant

使用 Server-Sent Events 代替 WebSocket

"""

import json

import asyncio

import re

from datetime import datetime

from typing import Dict, Any, Optional

import uuid

from fastapi.responses import StreamingResponse

from fastapi import HTTPException

from .agent.excel_agent import agent_manager, ExcelAgent

from .agent.query_bridge import QueryBridge, set_current_bridge

from .agent.ask_detector import is_asking_user

from .models.schemas import MessageType

from .utils.logger import AgentLogger, get_logger





class SSEConnectionManager:

    """SSE 连接管理器"""



    def __init__(self):

        self.active_connections: Dict[str, Dict[str, Any]] = {}

        self._lock = asyncio.Lock()

        # session_id -> "username"（轻量用户标识，供日志使用）
        self._session_users: Dict[str, str] = {}



    async def connect(self, session_id: str) -> Dict[str, Any]:

        """创建 SSE 连接"""

        async with self._lock:

            connection_id = str(uuid.uuid4())

            queue: asyncio.Queue = asyncio.Queue()

            self.active_connections[session_id] = {

                "queue": queue,

                "connection_id": connection_id,

                "handler": None

            }

            return self.active_connections[session_id]



    def bind_user(self, session_id: str, user_tag: str) -> None:
        """绑定用户标识到 session（首次收到含 auth 的请求时调用，无需 lock）"""
        if user_tag and session_id not in self._session_users:
            self._session_users[session_id] = user_tag

    def get_user_tag(self, session_id: str) -> str:
        """获取 session 绑定的用户标识"""
        return self._session_users.get(session_id, "")

    async def disconnect(self, session_id: str):

        """断开 SSE 连接"""

        async with self._lock:

            if session_id in self.active_connections:

                del self.active_connections[session_id]

        self._session_users.pop(session_id, None)

        await agent_manager.remove_agent(session_id)



    async def send_message(self, session_id: str, message: Dict[str, Any]):

        """推送消息到 SSE 队列"""

        async with self._lock:

            conn = self.active_connections.get(session_id)

            if not conn:

                return

            queue: asyncio.Queue = conn["queue"]

        await queue.put(message)



    async def get_handler(self, session_id: str) -> Optional["SSEHandler"]:

        async with self._lock:

            conn = self.active_connections.get(session_id)

            if not conn:

                return None

            return conn.get("handler")



    async def set_handler(self, session_id: str, handler: "SSEHandler"):

        async with self._lock:

            if session_id in self.active_connections:

                self.active_connections[session_id]["handler"] = handler



    async def get_connection_id(self, session_id: str) -> Optional[str]:

        async with self._lock:

            if session_id in self.active_connections:

                return self.active_connections[session_id]["connection_id"]

        return None





sse_connection_manager = SSEConnectionManager()





class SSEHandler:

    """SSE 消息处理器"""



    def __init__(self, session_id: str):

        self.session_id = session_id

        self.agent: Optional[ExcelAgent] = None

        self.excel_state: Dict[str, Any] = {}

        self.log = AgentLogger(session_id)

        self.connection_id: Optional[str] = None

        self._handled_request_ids: Dict[str, datetime] = {}
        self._context_version: int = 0

    def _ingest_context(self, context: Any, context_version: Any, source: str) -> bool:
        """统一上下文接入网关：只接受最新版本快照，拒绝旧包覆盖。"""
        if not isinstance(context, dict) or not context:
            return False

        try:
            incoming_version = int(context_version) if context_version is not None else self._context_version + 1
        except (TypeError, ValueError):
            incoming_version = self._context_version + 1

        if incoming_version < self._context_version:
            self.log.logger.warning(
                f'[{self.session_id}] 忽略过期上下文: source={source}, incoming={incoming_version}, current={self._context_version}'
            )
            return False

        self.excel_state.update(context)
        self._context_version = incoming_version

        from .agent.excel_tools import set_tool_excel_state_snapshot
        set_tool_excel_state_snapshot(self.session_id, self.excel_state)

        ctx_sheets = context.get("sheets") if isinstance(context.get("sheets"), list) else []
        self.log.logger.info(
            f'[{self.session_id}] 上下文接入: source={source}, version={incoming_version}, keys={list(context.keys())}, sheets={len(ctx_sheets)}, activeSheet={context.get("activeSheet")}'
        )
        return True

    def bind_user_tag(self, user_tag: str) -> None:
        """延迟注入用户标识（由 router 层在首次 command 时调用），同时传播到 Agent"""
        self.log.set_user_tag(user_tag)
        if self.agent and hasattr(self.agent, 'log'):
            self.agent.log.set_user_tag(user_tag)



    async def initialize(self):

        """初始化处理器"""

        try:

            self.agent = await agent_manager.get_agent(self.session_id)
            # Agent 创建后继承 SSEHandler 已绑定的用户标识
            if self.log.user_tag and self.agent and hasattr(self.agent, 'log'):
                self.agent.log.set_user_tag(self.log.user_tag)

        except Exception as e:

            self.log.ws_error(f"Agent 初始化失败: {str(e)}")

            await self._send_error("抱歉，系统繁忙，请稍后重试。")

            raise



    def _get_query_bridge(self) -> Optional[QueryBridge]:
        return getattr(self, "_query_bridge", None)

    async def resolve_data_query(self, query_id: str, result: Dict[str, Any]):
        """前端 POST 回来的只读查询结果"""
        bridge = self._get_query_bridge()
        if bridge:
            bridge.resolve(query_id, result)

    async def handle_user_command(self, payload: Dict[str, Any]):

        """处理用户命令"""

        command = payload.get("command", "")

        context = payload.get("context", {})
        context_version = payload.get("contextVersion")

        request_id = payload.get("requestId")



        if not command:

            await self._send_error("命令为空")

            return



        if request_id:

            if request_id in self._handled_request_ids:

                await self._send_message(MessageType.OPERATION_COMPLETE, {

                    "success": True,

                    "message": "请求已处理（去重）"

                }, request_id=request_id)

                return

            self._handled_request_ids[request_id] = datetime.now()

            if len(self._handled_request_ids) > 200:

                cutoff = datetime.now().timestamp() - 300

                self._handled_request_ids = {

                    rid: ts for rid, ts in self._handled_request_ids.items()

                    if ts.timestamp() > cutoff

                }



        accepted = self._ingest_context(context, context_version, source="command")
        if not accepted:
            cached_sheets = self.excel_state.get("sheets") if isinstance(self.excel_state.get("sheets"), list) else []
            self.log.logger.warning(
                f'[{self.session_id}] 命令侧未接入新上下文，回退会话缓存: version={self._context_version}, sheets={len(cached_sheets)}, activeSheet={self.excel_state.get("activeSheet")}'
            )



        await self._send_message(MessageType.AI_THINKING, {

            "status": "processing",

            "message": "正在分析您的请求..."

        }, request_id=request_id)



        asked_user = False

        is_followup_execution = False
        completion_sent = False
        ops_sent_count = 0

        try:

            # 检查是否为补充信息后的执行（在调用 process_command 之前检查 _awaiting_followup 状态）

            if self.agent:

                # 检查是否正在等待补充信息，如果是，则这次执行是补充信息后的执行

                awaiting_followup = getattr(self.agent, "_awaiting_followup", False)

                has_last_request = getattr(self.agent, "_last_user_request", None) is not None

                has_last_question = getattr(self.agent, "_last_question", None) is not None

                

                if awaiting_followup and has_last_request and has_last_question:

                    is_followup_execution = True

                    self.log.logger.info(f'[{self.session_id}] 🔄 检测到补充信息后的执行，将保持会话连续性')

                    self.log.logger.info(f'[{self.session_id}] 📋 原始任务: "{getattr(self.agent, "_last_user_request", "")}"')

            

            # ── 建立 QueryBridge：让只读工具能向前端请求数据 ──
            conn = sse_connection_manager.active_connections.get(self.session_id)
            sse_queue = conn["queue"] if conn else None
            if sse_queue:
                bridge = QueryBridge(sse_queue, self.session_id)
                self._query_bridge = bridge
                set_current_bridge(bridge)

            async for response in self.agent.process_command(command, self.excel_state):

                if response["type"] == "text":

                    text_content = response["content"]

                    # 追问判定委托给独立模块 ask_detector
                    if not asked_user and text_content and is_asking_user(text_content):

                        asked_user = True

                        if self.agent:

                            self.agent._awaiting_followup = True

                            self.agent._last_user_request = command

                            self.agent._last_question = text_content

                            self.log.logger.info(f'[{self.session_id}] ask_detector: awaiting_followup=True')

                    await self._send_message(MessageType.AI_RESPONSE, {

                        "message": response["content"],

                        "streaming": True

                    }, request_id=request_id)



                elif response["type"] == "thinking":

                    self.log.ai_thinking(response["content"])

                    await self._send_message(MessageType.AI_THINKING, {

                        "status": "executing",

                        "message": response["content"]

                    }, request_id=request_id)

                    await self._send_message(MessageType.AI_RESPONSE, {

                        "message": f"🔧 正在执行：{response['content']}",

                        "streaming": False

                    }, request_id=request_id)



                elif response["type"] == "operations":
                    ops = response["content"]
                    total = len(ops)
                    for idx, operation in enumerate(ops):
                        self.log.operation_sent(operation.get('type', 'unknown'))
                        await self._send_message(MessageType.EXCEL_OPERATION, {
                            "operation": operation
                        }, request_id=request_id)
                        if idx < total - 1:
                            await asyncio.sleep(0.05)
                    ops_sent_count += total



                elif response["type"] == "ask":

                    asked_user = True

                    await self._send_message(MessageType.AI_RESPONSE, {

                        "message": response["content"],

                        "streaming": False

                    }, request_id=request_id)



                elif response["type"] == "complete":
                    complete_content = str(response.get("content", "") or "").strip()
                    # complete 语义既用于“执行完成”，也用于“查询直答（0 操作）”。
                    # 只要有文本结果，都应推送到聊天区，避免前端“无变化”。
                    if complete_content:
                        await self._send_message(MessageType.AI_RESPONSE, {
                            "message": complete_content,
                            "streaming": False,
                        }, request_id=request_id)
                    # 兼容操作型任务：无明确内容时，补一条友好的完成提示。
                    elif ops_sent_count > 0:
                        await self._send_message(MessageType.AI_RESPONSE, {
                            "message": f"已完成全部 {ops_sent_count} 个操作。",
                            "streaming": False,
                        }, request_id=request_id)
                    await self._send_message(MessageType.OPERATION_COMPLETE, {
                        "success": True,
                        "message": "操作已成功完成"
                    }, request_id=request_id)
                    completion_sent = True

                elif response["type"] == "error":
                    # 发送错误消息到前端
                    await self._send_error(response["content"], request_id=request_id)
                    # 同时发送操作完成消息，标记操作失败
                    await self._send_message(MessageType.OPERATION_COMPLETE, {
                        "success": False,
                        "message": response["content"]
                    }, request_id=request_id)
                    completion_sent = True



        except asyncio.CancelledError:
            self.log.logger.info(f'[{self.session_id}] SSE 请求已取消（客户端断开）')
            return

        except Exception as e:

            self.log.ws_error(f"处理命令时出错: {str(e)}")

            await self._send_error("抱歉，操作执行遇到问题，请稍后重试。", request_id=request_id)
            try:
                if not completion_sent:
                    await self._send_message(MessageType.OPERATION_COMPLETE, {
                        "success": False,
                        "message": "处理异常结束"
                    }, request_id=request_id)
                    completion_sent = True
            except Exception:
                # 避免错误路径再次抛异常导致 SSE 中断
                pass

        finally:
            # 清理 QueryBridge，避免泄漏
            set_current_bridge(None)
            _qb = getattr(self, "_query_bridge", None)
            if _qb:
                _qb.cleanup()

            # 关闭 Agent 的条件：

            # 1. 启用了 per_request_close

            # 2. 且没有问用户问题

            # 3. 且不是补充信息后的执行（补充信息后的执行需要保持会话连续性，以便 Claude 记住之前的对话历史）

            # 关键：补充信息后的执行完成后，不应该立即关闭 Agent，因为 ClaudeSDKClient 需要保持会话连续性

            

            # 记录当前状态用于调试

            # 关键：重新读取 Agent 的状态，因为 process_command 可能已经修改了这些标志

            if self.agent:

                per_request_close = getattr(self.agent, "_per_request_close", False)

                agent_is_followup = getattr(self.agent, "_is_followup_execution", False)

                agent_awaiting = getattr(self.agent, "_awaiting_followup", False)

                self.log.logger.info(f'[{self.session_id}] 📊 Agent 关闭检查：asked_user={asked_user}, is_followup_execution={is_followup_execution}, per_request_close={per_request_close}, agent._is_followup_execution={agent_is_followup}, agent._awaiting_followup={agent_awaiting}')

                

                # 关键：使用 Agent 的实际状态，而不是局部变量

                # 如果 Agent 的 _is_followup_execution 已经被重置为 False，说明任务已完成，可以关闭

                if agent_is_followup:

                    is_followup_execution = True

                    self.log.logger.info(f'[{self.session_id}] 🔄 确认：Agent 的 _is_followup_execution 标志为 True，保持连接')

                else:

                    # Agent 的 _is_followup_execution 已经被重置为 False，说明任务已完成

                    is_followup_execution = False

                    self.log.logger.info(f'[{self.session_id}] ✅ Agent 的 _is_followup_execution 标志为 False，任务已完成，可以关闭')

                

                # 如果 Agent 正在等待补充信息，也不应该关闭

                if agent_awaiting:

                    self.log.logger.info(f'[{self.session_id}] 🔄 确认：Agent 的 _awaiting_followup 标志为 True，保持连接以等待用户补充信息')

            

            should_close = (

                self.agent and 

                getattr(self.agent, "_per_request_close", False) and 

                not asked_user and 

                not is_followup_execution and

                not (self.agent and getattr(self.agent, "_awaiting_followup", False))

            )

            

            if should_close:

                self.log.logger.info(f'[{self.session_id}] 🔴 关闭 Agent（per_request_close={getattr(self.agent, "_per_request_close", False)}, asked_user={asked_user}, is_followup_execution={is_followup_execution}）')

                try:
                    await self.agent.close()
                except asyncio.CancelledError:
                    # 关闭阶段被取消时（例如客户端已断开）直接吞掉，避免升级为 500。
                    self.log.logger.info(f'[{self.session_id}] Agent 关闭阶段被取消，按连接断开处理')
                except Exception as close_error:
                    self.log.logger.warning(f'[{self.session_id}] Agent 关闭失败（已忽略）: {close_error}')

            else:

                reason = []

                if asked_user:

                    reason.append("asked_user=True")

                if is_followup_execution:

                    reason.append("is_followup_execution=True")

                if self.agent and getattr(self.agent, "_awaiting_followup", False):

                    reason.append("_awaiting_followup=True")

                if not getattr(self.agent, "_per_request_close", False):

                    reason.append("per_request_close=False")

                self.log.logger.info(f'[{self.session_id}] ✅ 保持 Agent 连接，原因: {", ".join(reason) if reason else "未知"}')

                

                # 如果是补充信息后的执行，重置标志以便下次正常执行时可以关闭

                if is_followup_execution and self.agent:

                    self.agent._is_followup_execution = False



    async def handle_excel_state(self, payload: Dict[str, Any]):

        """处理 Excel 状态更新"""

        context = payload.get("context") if isinstance(payload, dict) else None
        context_version = payload.get("contextVersion") if isinstance(payload, dict) else None
        self._ingest_context(context, context_version, source="state")

        if self.agent:
            self.agent.update_context(self.excel_state)



    async def _send_message(self, msg_type: MessageType, payload: Dict[str, Any], request_id: Optional[str] = None):

        """发送消息到客户端"""

        self.log.ws_message_sent(msg_type.value)

        message_id = str(uuid.uuid4())

        message = {

            "type": msg_type.value,

            "payload": payload,

            "timestamp": datetime.now().isoformat(),

            "messageId": message_id,

            "connectionId": self.connection_id

        }

        if request_id:

            message["requestId"] = request_id

        await sse_connection_manager.send_message(self.session_id, message)



    async def _send_error(self, error_message: str, request_id: Optional[str] = None):

        """发送错误消息"""

        self.log.ai_error(error_message)

        await self._send_message(MessageType.AI_ERROR, {"error": error_message}, request_id=request_id)





async def sse_endpoint(session_id: str):

    """SSE 端点处理函数"""

    # FastAPI 会自动解码 URL 编码的路径参数，所以 session_id 已经是解码后的值

    # 但为了安全，我们验证一下 session_id 的格式

    if not session_id or not isinstance(session_id, str):

        raise HTTPException(status_code=400, detail="无效的 session_id")

    

    # 验证 session_id 格式（UUID 格式）

    uuid_pattern = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.IGNORECASE)

    if not uuid_pattern.match(session_id):

        # 如果不是标准 UUID 格式，记录警告但允许继续（可能是自定义格式）

        get_logger('sse').logger.warning(f'收到非标准格式的 session_id: {session_id[:50]}')

    

    conn = await sse_connection_manager.connect(session_id)

    handler = SSEHandler(session_id)

    handler.connection_id = conn["connection_id"]

    # 若 create_session 已提前绑定用户标识，继承到 handler
    pre_user_tag = sse_connection_manager.get_user_tag(session_id)
    if pre_user_tag:
        handler.bind_user_tag(pre_user_tag)

    await sse_connection_manager.set_handler(session_id, handler)



    try:

        await handler.initialize()

        await handler._send_message(MessageType.CONNECTION_READY, {

            "connectionId": handler.connection_id

        })

        await handler._send_message(MessageType.AI_RESPONSE, {

            "message": "AI 助手已就绪，可以开始使用。",

            "streaming": False

        })



        async def event_generator():

            try:

                while True:
                    try:
                        message = await asyncio.wait_for(conn["queue"].get(), timeout=10.0)
                        yield f"data: {json.dumps(message, ensure_ascii=False)}\n\n"
                    except asyncio.TimeoutError:
                        # 心跳包：保持中间层代理连接活跃，避免闲置被断开
                        yield ": heartbeat\n\n"
            except asyncio.CancelledError:
                # 客户端断开属于正常场景，避免升级为服务端异常
                get_logger('sse').info(f'[{session_id}] SSE 流已取消（客户端断开）')
                return
            except Exception as stream_err:
                get_logger('sse').warning(f'[{session_id}] SSE 流异常结束: {stream_err}')
                return

            finally:

                await sse_connection_manager.disconnect(session_id)



        return StreamingResponse(event_generator(), media_type="text/event-stream")

    except Exception:

        await sse_connection_manager.disconnect(session_id)

        raise

