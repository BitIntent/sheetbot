# backend/app/websocket_handler.py
"""
WebSocket Handler for Excel AI Assistant
处理前端 WebSocket 连接和消息
"""
import json
import asyncio
from datetime import datetime
from typing import Dict, Any, Optional
import uuid
from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState
from .agent.excel_agent import agent_manager, ExcelAgent
from .models.schemas import MessageType, WebSocketMessage
from .utils.logger import AgentLogger


class ConnectionManager:
    """WebSocket 连接管理器"""
    
    def __init__(self):
        self.active_connections: Dict[str, Dict[str, Any]] = {}
        self._lock = asyncio.Lock()
    
    async def connect(self, websocket: WebSocket, session_id: str) -> str:
        """接受新连接"""
        await websocket.accept()
        async with self._lock:
            # 如果已有连接，优先关闭旧连接，避免断开事件误清理新连接
            if session_id in self.active_connections:
                # 避免跨任务关闭旧连接触发 cancel scope 错误
                # 旧连接会自行断开，后续通过 connection_id 去重处理
                pass
            connection_id = str(uuid.uuid4())
            self.active_connections[session_id] = {
                "websocket": websocket,
                "connection_id": connection_id,
                "send_lock": asyncio.Lock()
            }
            return connection_id
    
    async def disconnect(self, session_id: str, websocket: Optional[WebSocket] = None):
        """断开连接"""
        removed = False
        async with self._lock:
            if session_id in self.active_connections:
                # 仅当断开的是当前活跃连接时才移除
                if websocket is None or self.active_connections[session_id]["websocket"] is websocket:
                    del self.active_connections[session_id]
                    removed = True
        if removed:
            await agent_manager.remove_agent(session_id)
    
    async def send_message(self, session_id: str, message: Dict[str, Any]):
        """发送消息到指定客户端"""
        if session_id in self.active_connections:
            conn = self.active_connections[session_id]
            websocket = conn["websocket"]
            send_lock = conn["send_lock"]
            async with send_lock:
                try:
                    if (websocket.application_state != WebSocketState.CONNECTED or
                        websocket.client_state != WebSocketState.CONNECTED):
                        return
                    await websocket.send_json(message)
                except Exception:
                    pass

    async def get_connection_id(self, session_id: str) -> Optional[str]:
        async with self._lock:
            if session_id in self.active_connections:
                return self.active_connections[session_id]["connection_id"]
        return None

    async def is_active(self, session_id: str, connection_id: str) -> bool:
        async with self._lock:
            if session_id in self.active_connections:
                return self.active_connections[session_id]["connection_id"] == connection_id
        return False
    
    async def broadcast(self, message: Dict[str, Any]):
        """广播消息到所有客户端"""
        for session_id in list(self.active_connections.keys()):
            await self.send_message(session_id, message)


# 全局连接管理器
connection_manager = ConnectionManager()


class WebSocketHandler:
    """WebSocket 消息处理器"""
    
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.agent: Optional[ExcelAgent] = None
        self.excel_state: Dict[str, Any] = {}
        self.log = AgentLogger(session_id)
        self.connection_id: Optional[str] = None
        self._pending_ack_tasks: Dict[str, asyncio.Task] = {}
        self._handled_request_ids: Dict[str, datetime] = {}
    
    async def initialize(self):
        """初始化处理器"""
        try:
            self.agent = await agent_manager.get_agent(self.session_id)
            self.log.ws_connected()
        except Exception as e:
            self.log.ws_error(f"Agent 初始化失败: {str(e)}")
            await self._send_error(f"Agent 初始化失败: {str(e)}")
            raise
    
    async def handle_message(self, data: Dict[str, Any]) -> None:
        """处理接收到的 WebSocket 消息"""
        msg_type = data.get("type")
        payload = data.get("payload", {})
        
        self.log.ws_message_received(msg_type)
        
        try:
            if msg_type == MessageType.USER_COMMAND.value:
                await self._handle_user_command(payload)
            elif msg_type == MessageType.EXCEL_STATE.value:
                await self._handle_excel_state(payload)
            elif msg_type == MessageType.SAVE_REQUEST.value:
                await self._handle_save_request(payload)
            elif msg_type == MessageType.ACK.value:
                await self._handle_ack(payload)
            else:
                await self._send_error(f"未知消息类型: {msg_type}")
        except Exception as e:
            self.log.ws_error(str(e))
            await self._send_error(str(e))
    
    async def _handle_user_command(self, payload: Dict[str, Any]):
        """处理用户命令"""
        command = payload.get("command", "")
        context = payload.get("context", {})
        request_id = payload.get("requestId")
        
        if not command:
            await self._send_error("命令为空")
            return
        
        # 请求级锁：重复 requestId 直接忽略
        if request_id:
            if request_id in self._handled_request_ids:
                await self._send_message(MessageType.OPERATION_COMPLETE, {
                    "success": True,
                    "message": "请求已处理（去重）"
                }, require_ack=True, request_id=request_id)
                return
            self._handled_request_ids[request_id] = datetime.now()
            # 清理过期 requestId（防止内存增长）
            if len(self._handled_request_ids) > 200:
                cutoff = datetime.now().timestamp() - 300
                self._handled_request_ids = {
                    rid: ts for rid, ts in self._handled_request_ids.items()
                    if ts.timestamp() > cutoff
                }
        
        if context:
            self.excel_state.update(context)
        
        await self._send_message(MessageType.AI_THINKING, {
            "status": "processing",
            "message": "正在分析您的请求..."
        }, request_id=request_id)
        
        asked_user = False
        try:
            operation_notified = False
            async for response in self.agent.process_command(command, self.excel_state):
                if response["type"] == "text":
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
                    for operation in response["content"]:
                        self.log.operation_sent(operation.get('type', 'unknown'))
                        await self._send_message(MessageType.EXCEL_OPERATION, {
                            "operation": operation
                        }, request_id=request_id)
                
                elif response["type"] == "ask":
                    asked_user = True
                    await self._send_message(MessageType.AI_RESPONSE, {
                        "message": response["content"],
                        "streaming": False
                    }, request_id=request_id)

                elif response["type"] == "complete":
                    await self._send_message(MessageType.OPERATION_COMPLETE, {
                        "success": True,
                        "message": "操作已成功完成"
                    }, require_ack=True, request_id=request_id)
                
                elif response["type"] == "error":
                    await self._send_error(response["content"], request_id=request_id)
        except Exception as e:
            self.log.ws_error(f"处理命令时出错: {str(e)}")
            await self._send_error(f"处理命令时出错: {str(e)}", request_id=request_id)
        finally:
            if self.agent and getattr(self.agent, "_per_request_close", False) and not asked_user:
                await self.agent.close()
    
    async def _handle_excel_state(self, payload: Dict[str, Any]):
        """处理 Excel 状态更新"""
        self.excel_state = payload
        if self.agent:
            self.agent.update_context(payload)
    
    async def _handle_save_request(self, payload: Dict[str, Any]):
        """处理保存请求"""
        await self._send_message(MessageType.SAVE_RESULT, {
            "success": True,
            "message": "保存请求已接收"
        })
    
    async def _send_message(self, msg_type: MessageType, payload: Dict[str, Any], require_ack: bool = False, request_id: Optional[str] = None):
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
        await connection_manager.send_message(self.session_id, message)
        if require_ack and message_id:
            self._schedule_ack_retry(message_id, message, max_retries=3, delay=1.0)
    
    async def _send_error(self, error_message: str, request_id: Optional[str] = None):
        """发送错误消息"""
        self.log.ai_error(error_message)
        await self._send_message(MessageType.AI_ERROR, {"error": error_message}, require_ack=True, request_id=request_id)

    async def _handle_ack(self, payload: Dict[str, Any]):
        message_id = payload.get("messageId")
        connection_id = payload.get("connectionId")
        if not message_id:
            return
        if self.connection_id and connection_id and connection_id != self.connection_id:
            return
        task = self._pending_ack_tasks.pop(message_id, None)
        if task:
            task.cancel()

    def _schedule_ack_retry(self, message_id: str, message: Dict[str, Any], max_retries: int = 3, delay: float = 1.0):
        async def _retry():
            retries = 0
            while retries < max_retries:
                await asyncio.sleep(delay)
                if self.connection_id is None:
                    return
                active = await connection_manager.is_active(self.session_id, self.connection_id)
                if not active:
                    return
                if message_id not in self._pending_ack_tasks:
                    return
                await connection_manager.send_message(self.session_id, message)
                retries += 1
            self._pending_ack_tasks.pop(message_id, None)

        task = asyncio.create_task(_retry())
        self._pending_ack_tasks[message_id] = task

    async def cleanup(self):
        for task in list(self._pending_ack_tasks.values()):
            try:
                task.cancel()
            except Exception:
                pass
        self._pending_ack_tasks.clear()


async def websocket_endpoint(websocket: WebSocket, session_id: str):
    """WebSocket 端点处理函数"""
    log = AgentLogger(session_id)
    
    connection_id = await connection_manager.connect(websocket, session_id)
    handler = WebSocketHandler(session_id)
    handler.connection_id = connection_id
    
    try:
        await handler.initialize()
        
        await handler._send_message(MessageType.CONNECTION_READY, {
            "connectionId": connection_id
        })
        
        await handler._send_message(MessageType.AI_RESPONSE, {
            "message": "AI 助手已就绪，可以开始使用。",
            "streaming": False
        })
        
        while True:
            data = await websocket.receive_json()
            await handler.handle_message(data)
            
    except WebSocketDisconnect:
        log.ws_disconnected()
        await handler.cleanup()
        await connection_manager.disconnect(session_id, websocket)
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        log.ws_error(f"会话出错: {e}")
        log.logger.debug(f'[{session_id}] 错误详情:\n{error_details}')
        
        try:
            await handler._send_error(f"连接错误: {str(e)}")
        except:
            pass
        
        await handler.cleanup()
        await connection_manager.disconnect(session_id, websocket)
