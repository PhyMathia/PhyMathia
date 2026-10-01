"""聊天主应用（src/server）与 Φ 图编辑智能体（harness）的共享底层事实源。

两侧运行时都看得见项目根（src/main.py 启动时把根插进 sys.path，打包
--paths . 覆盖根目录模块；harness 的测试也从仓库根跑），与 http_client.py
同层。收编此处前各自复制的逻辑：
- estimate_tokens：token 估算（原 context.py 与 harness/review.py 各一份）
- PROVIDER_BASE_URLS / OPENCODE_DEFAULT_API_KEY：供应商官方地址（原
  src/server/config.py 与 harness/review.py 各一份，harness 侧缺 opencode）
- resolve_api_key：.env 密钥兜底（src/server/config.resolve_api_key 委托到
  这里的窄口径；harness 侧用宽口径 + deepseek 末位回退）
- validate_model_target / _official_host：模型目标域名校验（原
  src/server/config.py），harness 导不进 src.server.*（src 不是包）也必须同
  口径校验，防「请求体指定 provider + 任意 base_url」把 .env 真实密钥外发
- thinking_request_params：思考程度→上游请求参数映射（原 main.py
  _thinking_request_params），聊天主应用与 Φ 智能体共用同一张表
- opencode_gateway_headers / PHYMATHIA_USER_AGENT：opencode.ai 网关会话头
  （原 main.py 与 harness/review.py 各一份，仅 session id 来源不同）

只依赖标准库；本模块不得 import 任何使用方。
"""

import os
import re
from urllib.parse import urlparse


# ====== 上游非 200 的用户可读文案（主聊天 /api/models/chat 与 /api/models/list、
# Φ harness _call_model 三处共用；T43：密钥失效全程不提示、文案只说「上游连接失败」
# 会让用户去查网络而不是换钥匙）======

# 命中即判定为凭证问题（401/403 之外，网关常回 200 前的其他码 + 这类正文）
_CREDENTIAL_ERROR_RE = re.compile(
    r"invalid[ _-]?api[ _-]?key|incorrect[ _-]?api[ _-]?key|invalid[ _-]?credential"
    r"|authentication|unauthorized|api[ _-]?key|access[ _-]?token",
    re.IGNORECASE,
)


def upstream_error_detail(status_code: int, body: str) -> str:
    """非 200 响应的 detail 文案：原样透传状态与正文；判定为密钥/凭证问题时
    追加「到模型设置换钥」引导，不再让用户误判为网络故障。"""
    text = f"上游返回 {status_code}: {body}"
    if status_code in (401, 403) or _CREDENTIAL_ERROR_RE.search(str(body or "")):
        text += "｜密钥可能已失效或无权限：请到「模型设置」检查或更换该模型的 API 密钥"
    return text


# ====== token 估算（与前端同一口径：CJK 1 字符≈1 token，ASCII 4 字符≈1 token）======

def estimate_tokens(text: str) -> int:
    """Cheap token estimate mirroring the frontend: CJK chars count 1, ASCII ~4/1."""
    s = str(text or "")
    cjk = sum(1 for ch in s if "\u4e00" <= ch <= "\u9fff" or "\u3000" <= ch <= "\u303f" or "\uff00" <= ch <= "\uffef")
    return (4 * cjk + (len(s) - cjk) + 3) // 4


# ====== 供应商官方地址（唯一事实源；src/server/config.AI_PROVIDERS 由此派生）======

PROVIDER_BASE_URLS = {
    "deepseek": "https://api.deepseek.com",
    "openai": "https://api.openai.com/v1",
    "opencode": "https://opencode.ai/zen/v1",
}

# 免费 opencode（zen/v1）不需要密钥；保留常量名，调用方不必硬编码空串
OPENCODE_DEFAULT_API_KEY = ""

_OPENCODE_GO_ALIASES = ("opencode-go", "opencode_go", "opencodego", "go")


# ====== 模型目标（base_url）校验：防 .env 兜底密钥外发到任意域名 ======

def _official_host(provider: str) -> str:
    base = PROVIDER_BASE_URLS.get(provider)
    if base:
        return urlparse(base).netloc
    # opencode-go 的 env 兜底 key 对应 opencode 官方域名
    if provider == "opencode-go":
        return urlparse(PROVIDER_BASE_URLS["opencode"]).netloc
    return ""


def validate_model_target(provider: str, base_url: str, env_key_used: bool) -> str:
    """校验 AI 代理目标，返回最终 base_url；非法目标抛 ValueError。

    - base_url 必须是合法 http(s) URL（本机模型允许 http://127.0.0.1|localhost）；
    - 使用 .env 兜底密钥时，目标域名必须是该 provider 的官方域名，
      防止「请求体指定 provider=deepseek + 任意 base_url」把 .env 真实密钥外发。

    唯一实现在此（原 src/server/config.py 的照搬，供 src 与 harness 共用）：
    harness 导不进 src.server.*（src 不是包），此前是唯一不校验目标域名的模块，
    请求体写任意 base_url 就能把 .env 末位兜底的 DEEPSEEK_API_KEY 发过去（T98）。
    """
    if not base_url:
        base = PROVIDER_BASE_URLS.get(provider)
        if not base:
            raise ValueError(f"Unknown provider '{provider}' and no base_url provided")
        return base
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


def resolve_api_key(provider, api_key, base_url="", wide_go=False, deepseek_last_resort=False):
    """解析 API key 的 .env 兜底，返回 (key, env_key_used)。

    env_key_used=True 表示 key 来自 .env 兜底而非用户在模型面板里填写——
    调用方必须把它传给 validate_model_target：env 密钥只允许发往该 provider
    的官方域名，防「请求体指定 provider + 任意 base_url」把 .env 真实密钥
    外发到第三方服务器。

    wide_go：harness 侧的宽口径 opencode-go 识别（provider 别名 + base_url
    含 "zen/go" 嗅探）；窄口径（wide_go=False）只认精确 "opencode-go"，
    供 src/server/config.resolve_api_key 委托使用。
    deepseek_last_resort：harness 历史行为——其他分支都没拿到 key 时最后退
    DEEPSEEK_API_KEY。该末位回退拿到的同样是 .env 密钥，env_key_used 照常置
    True（2026-09-30 安全收紧：此前恒为 False，会让 DEEPSEEK 真实密钥随任意
    base_url 外发）；env 未配置、key 为空串时不算 env 密钥，返回 False。
    """
    if api_key:
        return api_key, False
    if wide_go:
        p = str(provider or "").lower()
        is_go = p in _OPENCODE_GO_ALIASES or "zen/go" in str(base_url or "").lower()
    else:
        is_go = provider == "opencode-go"
    if is_go:
        env = os.getenv("OPENCODE_GO_API_KEY", "") or os.getenv("OPENCODE_API_KEY", "")
        if env:
            return env, True
        if deepseek_last_resort:
            env = os.getenv("DEEPSEEK_API_KEY", "")
            return env, bool(env)
        return "", False
    if provider == "deepseek":
        env = os.getenv("DEEPSEEK_API_KEY", "")
        return env, bool(env)
    if provider == "opencode":
        # 免费 opencode（zen/v1）不需要 key，也不应把别家密钥发给网关
        return OPENCODE_DEFAULT_API_KEY, False
    if deepseek_last_resort:
        env = os.getenv("DEEPSEEK_API_KEY", "")
        return env, bool(env)
    return "", False


# ====== 思考程度 → 上游请求参数（src/main.py 与 harness/review.py 共用）======

def thinking_request_params(provider: str, level: str) -> dict:
    """「思考程度」→ 上游请求参数（纯函数，tests 直测）。

    用户档位 default('')/low/high/max：default 不发送任何思考参数——现状行为
    零变化。各家 OpenAI 兼容端点的思考字段不统一：OpenAI 系（含 Gemini/
    OpenRouter/Groq/自定义网关）用 reasoning_effort，千问百炼用 enable_thinking，
    智谱用 thinking.type，Ollama 用 think。reasoning_effort 只有 low/medium/high
    三档，low/high/max 按序拉伸映射（low→low、high→medium、max→high），
    三档在每个 reasoning_effort 供应商上都有区分度；布尔开关族（qwen/zhipu/
    ollama）三档同为「开启」。上游不认识注入字段而拒绝整个请求时，由调用方
    剥掉参数降级重试一次（主应用与 harness 各有一级——后者是 2026-09-30 接入的
    相位档位，Φ 的 evaluate/preset/apply 深、chat 浅，见 harness/review.py
    PHASE_THINKING）。
    """
    p = (provider or "").strip().lower()
    if level not in ("low", "high", "max"):
        return {}
    if p == "qwen":
        return {"enable_thinking": True}
    if p == "zhipu":
        return {"thinking": {"type": "enabled"}}
    if p == "ollama":
        return {"think": True}
    return {"reasoning_effort": {"low": "low", "high": "medium", "max": "high"}[level]}


# ====== opencode.ai 网关会话头 ======

PHYMATHIA_USER_AGENT = "PhyMathia/1.5.1"


def opencode_gateway_headers(base_url: str, session_id: str = "") -> dict:
    """OpenCode 网关（opencode.ai）的会话标识头。

    x-opencode-session 标识调用方：聊天主应用传当前聊天会话 id——同会话保持
    稳定，网关按它路由并优化 prompt 缓存（官方文档：缺失会被列入 problematic
    clients，缓存降级并受滥用监控）；harness 无会话上下文，传进程派生 id
    （同进程内的重试与自检落在同一缓存桶）。User-Agent 按其文档要求标明
    客户端身份而非通用 http 库名（与前端 config.js APP_VERSION 同步）。
    非 opencode.ai 域名不附加任何头。
    """
    if "opencode.ai" not in str(base_url or ""):
        return {}
    return {
        "x-opencode-session": session_id or "phymathia-anonymous",
        "User-Agent": PHYMATHIA_USER_AGENT,
    }
