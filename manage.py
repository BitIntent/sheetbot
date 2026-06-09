#!/usr/bin/env python

# -*- coding: utf-8 -*-

"""

Excel AI Assistant 管理脚本

用于启动、停止、重启后端服务

"""

import asyncio
import json
import os
import signal
import shutil
import subprocess
import sys
import time

from pathlib import Path



# 项目根目录

BASE_DIR = Path(__file__).parent

BACKEND_DIR = BASE_DIR / "backend"

sys.path.insert(0, str(BACKEND_DIR))

FRONTEND_DIR = BASE_DIR / "frontend"
CADDY_CONFIG_FILE = Path(os.getenv("CADDY_CONFIG_FILE", str(BASE_DIR / "Caddyfile")))

BACKEND_PID_FILE = BASE_DIR / ".backend.pid"

FRONTEND_PID_FILE = BASE_DIR / ".frontend.pid"

LOG_DIR = BASE_DIR / "logs"
BACKEND_LOG_DIR = LOG_DIR / "backend"
FRONTEND_LOG_DIR = LOG_DIR / "frontend"

LEGACY_FRONTEND_LOG = BASE_DIR / "frontend.log"

ENV_PATH = os.getenv("ENV_PATH")

ENV_DIR = os.getenv("ENV_DIR")



# 服务配置

HOST = os.getenv("HOST", "0.0.0.0")

PORT = int(os.getenv("PORT", 8000))

WORKERS = int(os.getenv("WORKERS", 1))

RELOAD = os.getenv("RELOAD", "false").lower() == "true"
ACCESS_LOG = os.getenv("ACCESS_LOG", "false").lower() == "true"

FRONTEND_HOST = os.getenv("FRONTEND_HOST", "0.0.0.0")

FRONTEND_PORT = int(os.getenv("FRONTEND_PORT", 80))

TIMEOUT_KEEP_ALIVE = int(os.getenv("TIMEOUT_KEEP_ALIVE", 300))
PROD_MODE = os.getenv("PROD_MODE", "true").lower() == "true"  # SSE 连接保持超时（秒）
# 生产模式下 restart 时是否先 npm run build（默认 true，使 public/ 与源码变更写入 dist 后随 Caddy 生效）
FRONTEND_REBUILD_ON_RESTART = (
    os.getenv("FRONTEND_REBUILD_ON_RESTART", "true").lower() == "true"
)





def get_pid(pid_file):

    """获取保存的进程ID"""

    if pid_file.exists():

        try:

            with open(pid_file, 'r') as f:

                pid = int(f.read().strip())

            return pid

        except (ValueError, IOError):

            return None

    return None





def save_pid(pid_file, pid):

    """保存进程ID"""

    try:

        with open(pid_file, 'w') as f:

            f.write(str(pid))

    except IOError as e:

        print(f"❌ 保存PID失败: {e}")





def remove_pid(pid_file):

    """删除PID文件"""

    if pid_file.exists():

        try:

            pid_file.unlink()

        except IOError:

            pass





def ensure_log_dir():

    """确保日志目录存在"""

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    BACKEND_LOG_DIR.mkdir(parents=True, exist_ok=True)
    FRONTEND_LOG_DIR.mkdir(parents=True, exist_ok=True)


def get_backend_log_file() -> Path:
    """后端日志按天归档：logs/backend/backend-YYYY-MM-DD.log"""
    today = time.strftime("%Y-%m-%d")
    return BACKEND_LOG_DIR / f"backend-{today}.log"


def get_frontend_log_file() -> Path:
    """前端日志按天归档：logs/frontend/frontend-YYYY-MM-DD.log"""
    today = time.strftime("%Y-%m-%d")
    return FRONTEND_LOG_DIR / f"frontend-{today}.log"





def relocate_legacy_logs():

    """将根目录旧前端日志移动到 logs/"""

    if LEGACY_FRONTEND_LOG.exists():

        ensure_log_dir()

        try:
            shutil.move(str(LEGACY_FRONTEND_LOG), str(get_frontend_log_file()))

        except Exception:

            pass





def load_env_file():

    """从 ENV_PATH 加载环境变量"""

    if not ENV_PATH:

        return

    env_file = Path(ENV_PATH)

    if not env_file.exists():

        print(f"⚠️  ENV_PATH 不存在: {ENV_PATH}")

        return

    try:

        with open(env_file, 'r', encoding='utf-8', errors='ignore') as f:

            for line in f:

                line = line.strip()

                if not line or line.startswith('#'):

                    continue

                if '=' not in line:

                    continue

                key, value = line.split('=', 1)

                if key and key not in os.environ:

                    os.environ[key] = value.strip()

    except Exception as e:

        print(f"⚠️  加载 ENV_PATH 失败: {e}")





def sync_env_paths():

    """ENV_DIR/ENV_PATH 互推（优先 ENV_PATH）"""

    global ENV_PATH, ENV_DIR

    if ENV_PATH and not ENV_DIR:

        ENV_DIR = str(Path(ENV_PATH).parent)

        os.environ["ENV_DIR"] = ENV_DIR

    elif ENV_DIR and not ENV_PATH:

        ENV_PATH = str(Path(ENV_DIR) / ".env")

        os.environ["ENV_PATH"] = ENV_PATH





def is_process_running(pid):

    """检查进程是否运行"""

    if pid is None:

        return False

    try:

        # 发送信号0来检查进程是否存在（不实际发送信号）

        os.kill(pid, 0)

        return True

    except OSError:

        return False





def check_dependencies():

    """检查依赖是否安装"""

    try:

        import fastapi

        import uvicorn

        return True

    except ImportError:

        print("❌ 依赖未安装，请先运行: pip install -r backend/requirements.txt")

        return False





def check_env():

    """检查环境变量"""

    api_key = os.getenv("ANTHROPIC_API_KEY")

    if not api_key:

        print("⚠️  警告: 未设置 ANTHROPIC_API_KEY 环境变量")

        print("   请设置: export ANTHROPIC_API_KEY=your_api_key")

        return False

    return True





def start_backend():

    """启动后端服务（后台）"""

    if not check_dependencies():

        sys.exit(1)

    check_env()

    ensure_log_dir()



    pid = get_pid(BACKEND_PID_FILE)

    if pid and is_process_running(pid):

        print(f"⚠️  后端已在运行 (PID: {pid})")

        return



    cmd = [

        sys.executable, "-m", "uvicorn",

        "app.main:app",

        "--host", HOST,

        "--port", str(PORT),

        "--timeout-keep-alive", str(TIMEOUT_KEEP_ALIVE),  # SSE 长连接超时

    ]

    if RELOAD:

        cmd.append("--reload")

    if WORKERS > 1:

        cmd.extend(["--workers", str(WORKERS)])

    # 默认关闭 access log，避免客户端重试/401 噪音污染后端日志。
    # 如需排查网关/路由问题，可通过 ACCESS_LOG=true 临时开启。
    if not ACCESS_LOG:
        cmd.append("--no-access-log")



    # 关键：backend stdout/stderr 已重定向到与应用文件 Handler 相同的 backend 日志文件。
    # 若不关闭 console handler，会导致同一条记录写两次（一次文件 Handler，一次 stdout 重定向）。
    env = os.environ.copy()
    env["BACKEND_LOG_CONSOLE"] = "false"

    with open(get_backend_log_file(), 'a') as log_file:

        process = subprocess.Popen(

            cmd,

            stdout=log_file,

            stderr=subprocess.STDOUT,

            cwd=BACKEND_DIR,
            env=env,

            start_new_session=True

        )

    save_pid(BACKEND_PID_FILE, process.pid)

    print(f"✅ 后端已启动 (PID: {process.pid})")

    print(f"📡 后端地址: http://{HOST}:{PORT}")





def start_frontend():

    """启动前端服务（后台）"""

    ensure_log_dir()

    relocate_legacy_logs()

    pid = get_pid(FRONTEND_PID_FILE)

    if pid and is_process_running(pid):

        print(f"⚠️  前端已在运行 (PID: {pid})")

        return



    if PROD_MODE:
        # 生产模式：使用 Caddy 服务静态文件
        dist_dir = FRONTEND_DIR / "dist"
        docs_dist_dir = BASE_DIR / "docs-site" / "build"
        if not dist_dir.exists():
            print("❌ 错误：未找到 dist 目录，请先执行 npm run build")
            print("   命令：cd frontend && npm run build")
            sys.exit(1)
        if not docs_dist_dir.exists():
            print("⚠️  未找到 docs-site/build，帮助中心 /help/* 将返回 404")
            print("   命令：cd docs-site && npm run build")

        if not CADDY_CONFIG_FILE.exists():
            print(f"❌ 错误：未找到 Caddy 配置文件: {CADDY_CONFIG_FILE}")
            sys.exit(1)

        cmd = ["caddy", "run", "--config", str(CADDY_CONFIG_FILE)]
        print("🚀 前端以【生产模式】启动 (Caddy + 静态文件)")
    else:
        # 开发模式：Vite dev server
        cmd = [
            "npm", "run", "dev",
            "--",
            "--host", FRONTEND_HOST,
            "--port", str(FRONTEND_PORT)
        ]
        print("🚀 前端以【开发模式】启动 (Vite dev)")

    env = os.environ.copy()

    env["CI"] = "1"

    env["VITE_CLI_INTERACTIVE"] = "false"

    with open(get_frontend_log_file(), 'a') as log_file:

        process = subprocess.Popen(

            cmd,

            stdout=log_file,

            stderr=subprocess.STDOUT,

            stdin=subprocess.DEVNULL,

            cwd=FRONTEND_DIR,

            env=env,

            shell=False,

            start_new_session=True

        )

        save_pid(FRONTEND_PID_FILE, process.pid)

        print(f"✅ 前端已启动 (PID: {process.pid})")

        print(f"📡 前端地址: http://{FRONTEND_HOST}:{FRONTEND_PORT}")





def start():

    """启动服务（前后端后台运行）"""

    print("🚀 正在启动 Excel AI Assistant 服务...")

    sync_env_paths()

    load_env_file()

    start_backend()

    start_frontend()





def stop_process(pid_file, name):

    """停止指定服务"""

    pid = get_pid(pid_file)

    if not pid:

        print(f"⚠️  未找到运行中的{name}服务")

        return



    if not is_process_running(pid):

        print(f"⚠️  进程 {pid} 不存在，清理PID文件")

        remove_pid(pid_file)

        return



    try:

        os.killpg(pid, signal.SIGTERM)

        print(f"📤 已发送停止信号到{name}进程组 {pid}")

        for _ in range(10):

            if not is_process_running(pid):

                print(f"✅ {name}服务已停止")

                remove_pid(pid_file)

                return

            time.sleep(1)

        if is_process_running(pid):

            print(f"⚠️  {name}进程未响应，强制停止...")

            os.killpg(pid, signal.SIGKILL)

            time.sleep(1)

            if not is_process_running(pid):

                print(f"✅ {name}服务已强制停止")

                remove_pid(pid_file)

            else:

                print(f"❌ 无法停止{name}服务")

        else:

            print(f"✅ {name}服务已停止")

            remove_pid(pid_file)

    except ProcessLookupError:

        print(f"⚠️  进程 {pid} 不存在")

        remove_pid(pid_file)

    except PermissionError:

        print(f"❌ 权限不足，无法停止进程 {pid}")

        print("   请手动结束进程")

    except Exception as e:

        print(f"❌ 停止失败: {e}")





def stop():

    """停止服务"""

    print("🛑 正在停止服务...")

    stop_process(FRONTEND_PID_FILE, "前端")

    stop_process(BACKEND_PID_FILE, "后端")

    cleanup_orphan_frontend_servers()
    cleanup_orphan_agents()





def _find_pids_by_keywords(keywords):

    """通过关键字从 ps 输出中查找进程 PID"""

    try:

        output = subprocess.check_output(["ps", "-ef"], text=True, stderr=subprocess.DEVNULL)

    except Exception:

        return []

    pids = []

    for line in output.splitlines():

        if not line or line.startswith("UID"):

            continue

        if all(k in line for k in keywords):

            parts = line.split()

            if len(parts) > 1 and parts[1].isdigit():

                pids.append(int(parts[1]))

    return pids





def _terminate_pids(pids, name):

    """终止指定 PID 列表"""

    for pid in pids:

        try:

            os.kill(pid, signal.SIGTERM)

            time.sleep(0.1)

            if is_process_running(pid):

                os.kill(pid, signal.SIGKILL)

            print(f"✅ 已清理{name}进程: {pid}")

        except Exception:

            pass





def cleanup_orphan_agents():

    """清理孤儿 Claude Agent 进程"""

    base_path = str(BASE_DIR)

    claude_pids = _find_pids_by_keywords([base_path, "claude_agent_sdk/_bundled/claude"])

    spawn_pids = _find_pids_by_keywords([base_path, "multiprocessing.spawn"])

    tracker_pids = _find_pids_by_keywords([base_path, "multiprocessing.resource_tracker"])

    _terminate_pids(claude_pids, "Claude")

    _terminate_pids(spawn_pids, "Python-Spawn")

    _terminate_pids(tracker_pids, "Resource-Tracker")


def cleanup_orphan_frontend_servers():

    """清理孤儿前端进程（Caddy）"""

    caddy_cfg = str(CADDY_CONFIG_FILE)

    # 精确匹配本项目启动参数，避免误杀系统级 caddy
    caddy_pids = _find_pids_by_keywords(["caddy", "run", "--config", caddy_cfg])

    _terminate_pids(caddy_pids, "Caddy")





def rebuild_frontend_dist():

    """生产环境：构建前端静态资源到 dist（landing 等 public 资源随构建进 dist）。"""

    env = os.environ.copy()

    env["CI"] = "1"

    env["VITE_CLI_INTERACTIVE"] = "false"

    env.setdefault("NODE_OPTIONS", "--max_old_space_size=8192")

    print("📦 生产模式：执行 npm run build（跳过请设置 FRONTEND_REBUILD_ON_RESTART=false）...")

    proc = subprocess.run(

        ["npm", "run", "build"],

        cwd=str(FRONTEND_DIR),

        env=env,

    )

    if proc.returncode != 0:

        print("❌ 前端构建失败，已中止重启")

        sys.exit(1)

    print("✅ 前端构建完成")


def restart():

    """重启服务"""

    print("🔄 正在重启服务...")

    stop()

    time.sleep(2)

    if PROD_MODE and FRONTEND_REBUILD_ON_RESTART:

        rebuild_frontend_dist()

    start()





def status():

    """查看服务状态"""

    backend_pid = get_pid(BACKEND_PID_FILE)

    frontend_pid = get_pid(FRONTEND_PID_FILE)



    if backend_pid and is_process_running(backend_pid):

        print("📊 后端状态: 运行中")

        print(f"   PID: {backend_pid}")

        print(f"   地址: http://{HOST}:{PORT}")

    else:

        print("📊 后端状态: 未运行")

        if backend_pid:

            remove_pid(BACKEND_PID_FILE)



    if frontend_pid and is_process_running(frontend_pid):

        print("📊 前端状态: 运行中")

        print(f"   PID: {frontend_pid}")

        print(f"   地址: http://{FRONTEND_HOST}:{FRONTEND_PORT}")

    else:

        print("📊 前端状态: 未运行")

        if frontend_pid:

            remove_pid(FRONTEND_PID_FILE)





def logs():

    """查看日志"""

    ensure_log_dir()

    files = [get_backend_log_file(), get_frontend_log_file()]

    for log_file in files:

        if not log_file.exists():

            print(f"⚠️  日志文件不存在: {log_file}")

            continue

        try:

            print(f"\n===== {log_file.name} (last 50 lines) =====")

            with open(log_file, 'r', encoding='utf-8', errors='ignore') as f:

                lines = f.readlines()

                for line in lines[-50:]:

                    print(line, end='')

        except Exception as e:

            print(f"❌ 读取日志失败: {e}")





def cleanup_report_cache():
    """清理过期的报表缓存与快照"""

    try:
        from app.core.database import async_session_maker
        from app.report.cache import cleanup_expired_cache
    except ImportError as exc:
        print(f"❌ 导入缓存清理模块失败: {exc}")
        return

    async def _run_cleanup():
        async with async_session_maker() as session:
            await cleanup_expired_cache(session)

    print("🧹 开始清理过期的报表缓存...")
    try:
        asyncio.run(_run_cleanup())
        print("✅ 报表缓存清理完成")
    except Exception as exc:
        print(f"❌ 清理失败: {exc}")


def main():

    """主函数"""

    if len(sys.argv) < 2:

        print("Excel AI Assistant 管理脚本")

        print("\n用法: python manage.py <command>")

        print("\n可用命令:")

        print("  start    - 启动服务（前后端后台运行）")

        print("  stop     - 停止服务")

        print("  restart  - 重启服务")

        print("  status   - 查看状态")

        print("  logs     - 查看日志")
        print("  cleanup-report-cache - 清理过期的报表缓存")

        print("\n环境变量:")

        print("  HOST     - 监听地址 (默认: 0.0.0.0)")

        print("  PORT     - 监听端口 (默认: 8000)")

        print("  FRONTEND_HOST - 前端监听地址 (默认: 0.0.0.0)")

        print("  FRONTEND_PORT - 前端监听端口 (默认: 80)")

        print("  WORKERS  - 工作进程数 (默认: 1)")

        print("  RELOAD   - 自动重载 (默认: false)")

        print("  FRONTEND_REBUILD_ON_RESTART - restart 时是否先 npm run build (默认: true，仅 PROD_MODE)")

        print("  ACCESS_LOG - 是否开启 uvicorn access log (默认: false)")

        print("  TIMEOUT_KEEP_ALIVE - SSE 连接保持超时秒数 (默认: 300)")

        sys.exit(1)

    

    command = sys.argv[1].lower()

    

    if command == "start":

        start()

    elif command == "stop":

        stop()

    elif command == "restart":

        restart()

    elif command == "status":

        status()

    elif command == "logs":

        logs()

    elif command == "cleanup-report-cache":

        cleanup_report_cache()

    else:

        print(f"❌ 未知命令: {command}")

        print("   使用 'python manage.py' 查看帮助")

        sys.exit(1)





if __name__ == "__main__":

    main()

