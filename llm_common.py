"""聊天主应用（src/server）与 Φ 图编辑智能体（harness）的共享底层事实源。

两侧运行时都看得见项目根（src/main.py 启动时把根插进 sys.path，打包
--paths . 覆盖根目录模块；harness 的测试也从仓库根跑），与 http_client.py
同层。收编此处前各自复制的逻辑：
- estimate_tokens：token 估算（原 context.py 与 harness/review.py 各一份）
- PROVIDER_BASE_URLS / OPENCODE_DEFAULT_API_KEY：供应商官方地址（原
  src/server/config.py 与 harness/review.py 各一份，harness 侧缺 opencode）
- resolve_api_key：.env 密钥兜底（src/server/config.resolve_api_key 委托到
  这里的窄口径；harness 侧用宽口径 + deepseek 末位回退）
- opencode_gateway_headers / PHYMATHIA_USER_AGENT：opencode.ai 网关会话头
  （原 main.py 与 harness/review.py 各一份，仅 session id 来源不同）

只依赖标准库；本模块不得 import 任何使用方。
"""

import os


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
    DEEPSEEK_API_KEY。此时密钥来源语义已无从谈起，env_key_used 恒为 False。
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
            return os.getenv("DEEPSEEK_API_KEY", ""), False
        return "", False
    if provider == "deepseek":
        env = os.getenv("DEEPSEEK_API_KEY", "")
        return env, bool(env)
    if provider == "opencode":
        # 免费 opencode（zen/v1）不需要 key，也不应把别家密钥发给网关
        return OPENCODE_DEFAULT_API_KEY, False
    if deepseek_last_resort:
        return os.getenv("DEEPSEEK_API_KEY", ""), False
    return "", False


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
