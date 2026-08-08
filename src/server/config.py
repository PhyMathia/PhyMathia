"""PhyMathia 服务端配置：路径、常量与环境变量加载。"""

import os
from pathlib import Path

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

__all__ = [
    "BASE_DIR", "ROOT_DIR", "DATA_DIR", "MESSAGES_DIR",
    "SESSIONS_PATH", "KNOWLEDGE_PATH", "KV_PATH", "FORMULAS_PATH",
    "UPLOAD_DIR", "UPLOADS_META_PATH", "UPLOAD_MAX_BYTES",
    "STATIC_DIR", "STATIC_EXTENSIONS",
    "LEVEL_PROMPTS", "STRICT_MODULE_MAX_TOKENS",
    "AI_PROVIDERS", "OPENCODE_DEFAULT_API_KEY",
]
