"""PhyMathia 服务端配置：路径、常量与环境变量加载。"""

import os
import sys
from pathlib import Path
from urllib.parse import urlparse

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
FORMULAS_PATH = DATA_DIR / "formulas.json"
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOADS_META_PATH = DATA_DIR / "uploads.json"
UPLOAD_MAX_BYTES = 20 * 1024 * 1024
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

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

AI_PROVIDERS = {
    "deepseek": {"base_url": "https://api.deepseek.com"},
    "openai": {"base_url": "https://api.openai.com/v1"},
    "opencode": {"base_url": "https://opencode.ai/zen/v1"},
}

OPENCODE_DEFAULT_API_KEY = ""


def _official_host(provider: str) -> str:
    info = AI_PROVIDERS.get(provider)
    if info:
        return urlparse(info["base_url"]).netloc
    # opencode-go 的 env 兜底 key 对应 opencode 官方域名
    if provider == "opencode-go":
        return urlparse(AI_PROVIDERS["opencode"]["base_url"]).netloc
    return ""


def resolve_api_key(provider: str, api_key: str) -> tuple:
    """解析 API key 的 .env 兜底，返回 (key, env_key_used)。

    env_key_used=True 表示 key 来自 .env 兜底而非用户在模型面板里填写——
    调用方必须把它传给 validate_model_target：env 密钥只允许发往该 provider
    的官方域名，防「请求体指定 provider + 任意 base_url」把 .env 真实密钥
    外发到第三方服务器。此前这段兜底在 7 处各自复制，只有部分分支跟踪
    env_key_used，deepseek 的 env 密钥因此绕过过域名锁定（09-20 修复）。
    """
    if api_key:
        return api_key, False
    if provider == "deepseek":
        env = os.getenv("DEEPSEEK_API_KEY", "")
        return env, bool(env)
    if provider == "opencode-go":
        env = os.getenv("OPENCODE_GO_API_KEY", "") or os.getenv("OPENCODE_API_KEY", "")
        return env, bool(env)
    if provider == "opencode":
        return OPENCODE_DEFAULT_API_KEY, False
    return api_key, False


def validate_model_target(provider: str, base_url: str, env_key_used: bool) -> str:
    """校验 AI 代理目标，返回最终 base_url；非法目标抛 ValueError。

    - base_url 必须是合法 http(s) URL（本机模型允许 http://127.0.0.1|localhost）；
    - 使用 .env 兜底密钥时，目标域名必须是该 provider 的官方域名，
      防止「请求体指定 provider=deepseek + 任意 base_url」把 .env 真实密钥外发。
    """
    if not base_url:
        info = AI_PROVIDERS.get(provider)
        if not info:
            raise ValueError(f"Unknown provider '{provider}' and no base_url provided")
        base_url = info["base_url"]
        return base_url
    try:
        parsed = urlparse(base_url)
    except Exception:
        raise ValueError("Invalid base_url")
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Invalid base_url: must be a valid http(s) URL")
    host = parsed.netloc.rsplit("@", 1)[-1].rsplit(":", 1)[0].strip("[]").lower()
    is_local = parsed.scheme == "http" and (
        host in ("127.0.0.1", "localhost", "::1", "localhost.localdomain")
        or host.startswith("192.168.")
        or host.startswith("10.")
        or host.startswith("169.254.")
        # 172.16.0.0 – 172.31.255.255 私网段
        or (host.startswith("172.") and host.split(".")[1].isdigit() and 16 <= int(host.split(".")[1]) <= 31)
    )
    if parsed.scheme != "https" and not is_local:
        raise ValueError("Invalid base_url: remote endpoints must use https")
    if env_key_used:
        official = _official_host(provider)
        if official and host != official:
            raise ValueError("Env fallback API key can only be sent to the provider's official endpoint")
    return base_url

__all__ = [
    "BASE_DIR", "ROOT_DIR", "DATA_DIR", "MESSAGES_DIR",
    "SESSIONS_PATH", "KNOWLEDGE_PATH", "KV_PATH", "FORMULAS_PATH",
    "UPLOAD_DIR", "UPLOADS_META_PATH", "UPLOAD_MAX_BYTES",
    "STATIC_DIR", "STATIC_EXTENSIONS",
    "LEVEL_PROMPTS", "STRICT_MODULE_MAX_TOKENS",
    "AI_PROVIDERS", "OPENCODE_DEFAULT_API_KEY",
    "resolve_api_key", "validate_model_target",
]
