"""PhyMathia 服务端配置：路径、常量与环境变量加载。"""

import os
import sys
from pathlib import Path

import llm_common  # 项目根共享层：供应商表 / 密钥兜底 / token 估算的唯一事实源
from llm_common import validate_model_target  # noqa: F401  下沉到 llm_common，harness 也要用同口径

# ====== .env 加载（无第三方依赖）======
def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value

# PyInstaller 打包兼容：静态资源/提示词从解包目录读取（只读），
# 数据（data/）始终写到 exe 所在目录，便于持久化且不携带开发机数据。
if getattr(sys, "frozen", False):
    _BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    BASE_DIR = _BUNDLE_DIR / "src"
    ROOT_DIR = Path(sys.executable).resolve().parent
else:
    BASE_DIR = Path(__file__).resolve().parent.parent
    ROOT_DIR = BASE_DIR.parent
DATA_DIR = ROOT_DIR / "data"
MESSAGES_DIR = DATA_DIR / "messages"
DATA_DIR.mkdir(parents=True, exist_ok=True)
MESSAGES_DIR.mkdir(parents=True, exist_ok=True)

SESSIONS_PATH = DATA_DIR / "sessions.json"
KNOWLEDGE_PATH = DATA_DIR / "knowledge.json"
KV_PATH = DATA_DIR / "kv_store.json"
# 会话级 KV 拆分层：graph:<sid>/harness_history:<sid>/graph_history:<sid> 这类
# 每会话大对象按 data/kv/<sid>.json 一会话一文件存放（storage.kv_* 路由读写），
# 避免保存任一会话都全量重写主文件；全局键仍留在 kv_store.json
KV_DIR = DATA_DIR / "kv"
KV_DIR.mkdir(parents=True, exist_ok=True)
FORMULAS_PATH = DATA_DIR / "formulas.json"
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOADS_META_PATH = DATA_DIR / "uploads.json"
UPLOAD_MAX_BYTES = 20 * 1024 * 1024
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
# Utopia 快照收件箱：桌面「双击 .pmu」启动器把文件复制到这里（唯一的写路径，
# 本机文件操作），查看器经 GET /api/utopia/inbox/{name} 只读取回。
UTOPIA_INBOX_DIR = DATA_DIR / "utopia_inbox"
UTOPIA_INBOX_DIR.mkdir(parents=True, exist_ok=True)

_load_env_file(ROOT_DIR / ".env")

# ====== 静态文件配置 ======
STATIC_DIR = BASE_DIR / "static"
STATIC_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".svg", ".gif", ".ico", ".html", ".md",
    ".webp", ".css", ".js", ".woff", ".woff2", ".ttf",
}

LEVEL_PROMPTS = {
    "middle": "（用户是初高中学生，请用最通俗易懂的语言讲解，避免使用大学水平的术语，多用生活中的类比，公式尽量简化，数学推导步骤详细不跳步）",
    "university": "（用户是大学生，请用标准大学物理/数学的教学深度讲解，可以使用专业术语但需要解释，推导步骤完整）",
    "research": "（用户是科研人员，请用学术深度讲解，可以使用高级数学工具和前沿研究视角，推导可以简略关键步骤，关注物理本质和数学结构的深层联系）",
}

STRICT_MODULE_MAX_TOKENS = 1000

# 地址唯一事实源在 llm_common.PROVIDER_BASE_URLS；这里保持
# {"provider": {"base_url": url}} 的下游访问形状（harness 侧共享同一张表）
AI_PROVIDERS = {
    name: {"base_url": url} for name, url in llm_common.PROVIDER_BASE_URLS.items()
}

OPENCODE_DEFAULT_API_KEY = llm_common.OPENCODE_DEFAULT_API_KEY


def resolve_api_key(provider: str, api_key: str) -> tuple:
    """解析 API key 的 .env 兜底，返回 (key, env_key_used)。

    env_key_used=True 表示 key 来自 .env 兜底而非用户在模型面板里填写——
    调用方必须把它传给 validate_model_target：env 密钥只允许发往该 provider
    的官方域名，防「请求体指定 provider + 任意 base_url」把 .env 真实密钥
    外发到第三方服务器。此前这段兜底在 7 处各自复制，只有部分分支跟踪
    env_key_used，deepseek 的 env 密钥因此绕过过域名锁定（09-20 修复）。

    实现在 llm_common.resolve_api_key（窄口径：只认精确 "opencode-go"）；
    harness 侧用同函数的宽口径 + deepseek 末位回退。
    """
    return llm_common.resolve_api_key(provider, api_key)


# validate_model_target / _official_host 已下沉到 llm_common（唯一实现），
# 此处 import 保持原名可导出，main/documents/knowledge 调用零改动；
# 下沉原因：harness 导不进 src.server.*（src 不是包），但必须同口径校验（T98）。

__all__ = [
    "BASE_DIR", "ROOT_DIR", "DATA_DIR", "MESSAGES_DIR",
    "SESSIONS_PATH", "KNOWLEDGE_PATH", "KV_PATH", "KV_DIR", "FORMULAS_PATH",
    "UPLOAD_DIR", "UPLOADS_META_PATH", "UPLOAD_MAX_BYTES", "UTOPIA_INBOX_DIR",
    "STATIC_DIR", "STATIC_EXTENSIONS",
    "LEVEL_PROMPTS", "STRICT_MODULE_MAX_TOKENS",
    "AI_PROVIDERS", "OPENCODE_DEFAULT_API_KEY",
    "resolve_api_key", "validate_model_target",
]
