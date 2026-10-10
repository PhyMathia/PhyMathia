"""模型对话路由（T163 自 main.py 收编）：/v1 兼容占位、chat 代理、
models list/probe、usage 统计与滚动会话记忆。

出网口一律经 http_client.get_http_client() 模块属性调用（T163 拍板：不再
from-import 绑定）——tests 打在 server.http_client 上的单点补丁因此对 chat、
list、probe、滚动摘要全部生效（此前 main 模块级绑定导致「打 http_client 没用、
必须打 main_mod」的坑就此消除，见 tests/test_context_preview.py 注释）。
_summary_tasks 只在本模块内读写；tests 直取 server.models_routes._summary_tasks。
"""

import asyncio
import json
import logging
import re
import time

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from . import accounts, concept, context, http_client, llm_common, profile, usage_stats
from .config import AI_PROVIDERS, LEVEL_PROMPTS, STRICT_MODULE_MAX_TOKENS, validate_model_target
from .context import (
    _branch_context_instruction,
    _delete_socratic_state,
    _graph_path_instruction,
    _is_socratic_prompt_text,
    _load_session_context,
    _read_socratic_state,
    _resolve_socratic_branch,
    resolve_context_budget,
    _socratic_state_instruction,
    _sync_socratic_state_from_prompt,
    _update_socratic_state_from_content,
    _workflow_context_parts,
    _write_socratic_state,
    estimate_tokens,
)
from .llm_common import resolve_api_key
from .prompts import MODULE_SYSTEM_PROMPT, ROLLING_SUMMARY_PROMPT, get_system_prompt
from .request_ctx import _account_id, _parse_json_object

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/v1/chat/completions")
async def openai_chat_completions(request: Request):
    """兼容占位：本地 Mock 已移除，请在「模型设置」中配置模型后经 /api/models/chat 使用。"""
    raise HTTPException(status_code=400, detail="本地 Mock 已移除，请在模型设置中配置 AI 模型")


def _opencode_session_headers(base_url: str, session_id: str) -> dict:
    """OpenCode 网关（opencode.ai）的会话标识头，唯一实现在
    llm_common.opencode_gateway_headers（harness 侧同源）；这里保留本名作
    转发，x-opencode-session 取当前聊天会话 id——同会话保持稳定，网关按它
    路由并优化 prompt 缓存。非 opencode.ai 域名不附加任何头。"""
    return llm_common.opencode_gateway_headers(base_url, session_id)


_BUCKET_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _normalize_session_bucket(value) -> str:
    """辅助调用的会话桶名白名单消毒：不合法一律退回空（落匿名桶）。"""
    text = str(value or "").strip()
    return text if _BUCKET_RE.match(text) else ""


def _chat_request_headers(provider: str, api_key: str, base_url: str, session_id: str) -> dict:
    headers = {"Content-Type": "application/json"}
    if api_key and provider != "opencode":
        headers["Authorization"] = f"Bearer {api_key}"
    headers.update(_opencode_session_headers(base_url, session_id))
    return headers


def _thinking_request_params(provider: str, level: str) -> dict:
    """「思考程度」→ 上游请求参数（薄包装）。

    唯一实现已下沉 llm_common.thinking_request_params（2026-09-30，Φ 智能体
    按相位接同一张表）；此处保留同名函数，调用方与直测它的用例零改动。
    """
    return llm_common.thinking_request_params(provider, level)


def _log_cache_hit_rate(usage) -> None:
    """前缀缓存命中率观测（2026-09-25）：供应商 usage 带命中字段时打一行，
    缺失（端点不报/没开缓存）静默。仅日志旁路，不影响主请求。"""
    parsed = usage_stats.parse_usage(usage)
    if not parsed or parsed["cache_hit_tokens"] is None:
        return
    prompt_tokens = parsed["prompt_tokens"] or 0
    hit = parsed["cache_hit_tokens"]
    pct = round(hit * 100 / prompt_tokens) if prompt_tokens > 0 else 0
    logger.info(f"AI proxy cache: hit {hit}/{prompt_tokens} tok ({pct}%)")


@router.post("/api/models/chat")
async def api_models_chat(request: Request):
    """代理请求到 AI API，流式返回 OpenAI 格式 SSE。
    支持两种调用格式：
    1. 新格式：{prompt, level, session_id, provider, api_key, model, base_url}
       → 后端构建消息（系统提示词 + 难度后缀 + 会话上下文）
       仅受理画布锚定请求（branch_id / graph_path / workflow_context 至少其一）：
       无锚普通提问是已退役线性主聊天的直调通道，2026-09-25 起硬门禁 410。
    2. 旧格式：{messages, provider, api_key, model, base_url}
       → 直接使用传入的 messages（测验 / 知识 / 大陆 / 可视化等辅助功能仍走它）
    """
    payload = await _parse_json_object(request)

    # 线性主聊天退役硬门禁（2026-09-25，见 docs/dev/linear-chat-retired.md）：
    # prompt 新格式必须带画布锚——分支/苏格拉底（branch_id / graph_path）或
    # 工作流（workflow_context）；quick 寒暄同属线性语义，即便带锚也拒绝
    # （前端寒暄通道已随线性退役，此处只防外部直调）。messages 直传不受影响。
    if payload.get("prompt"):
        has_anchor = bool(
            payload.get("branch_id") or payload.get("branchId")
            or payload.get("graph_path") or payload.get("graphPath")
            or payload.get("workflow_context") or payload.get("workflowContext")
        )
        if payload.get("quick"):
            raise HTTPException(
                status_code=410,
                detail="quick 寒暄通道已随线性主聊天退役（2026-09-25），不再受理",
            )
        if not has_anchor:
            raise HTTPException(
                status_code=410,
                detail="无锚普通 prompt 已随线性主聊天退役（2026-09-25）："
                       "分支/苏格拉底请带 branch_id 或 graph_path，工作流请带 workflow_context",
            )


    provider = payload.get("provider", "")
    api_key = payload.get("api_key", "")
    api_key, env_key_used = resolve_api_key(provider, api_key)
    model_name = payload.get("model", "")
    if not model_name and provider == "deepseek":
        model_name = "deepseek-chat"
    base_url = payload.get("base_url", "")
    stream = payload.get("stream", True)
    context_budget = resolve_context_budget(model_name)
    account = _account_id(request, payload)

    if not api_key and provider not in ("opencode", "opencode-go", "llama", "local"):
        raise HTTPException(
            status_code=400,
            detail=f"未配置 {provider} API Key：请在项目根目录 .env 中设置 DEEPSEEK_API_KEY，或在模型配置中填写密钥",
        )

    # 构建消息列表
    prompt = payload.get("prompt", "")
    session_id = payload.get("session_id", "")
    # 辅助调用会话桶（2026-09-21 分桶拍板）：旧格式直传的调用（测验/大陆/摘要
    # 优化/可视化）没有聊天会话 id，此前全部落进同一个「匿名桶」，网关侧互相
    # 挤占缓存路由。前端按功能传稳定桶名，消毒后与 session_id 二选一用作
    # x-opencode-session；新格式聊天永远以 session_id 优先。
    session_bucket = _normalize_session_bucket(
        payload.get("session_bucket") or payload.get("sessionBucket") or "")
    branch_id = payload.get("branch_id") or payload.get("branchId") or ""
    branch_type = payload.get("branch_type") or payload.get("branchType") or ""
    source_module = payload.get("source_module") or payload.get("sourceModule") or ""
    parent_id = payload.get("parent_id") or payload.get("parentId") or ""
    graph_path = payload.get("graph_path") or payload.get("graphPath") or []
    if not isinstance(graph_path, list):
        # _graph_path_instruction 会逐项 item.get，字符串/数字进来就是 500
        raise HTTPException(status_code=400, detail="graph_path must be a list")
    # T231：list 合法但项不是 dict 时，_graph_path_instruction 的第一句 item.get
    # 同样是 500（["x"] / [1] / [null]）——守卫逐项收紧，非 dict 一律 400
    for item in graph_path:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="each item of graph_path must be an object")
    workflow_context = payload.get("workflow_context") or payload.get("workflowContext") or {}
    socratic_mode = "answer"  # 显式初始化：此前靠三个前缀分支隐式保证，漏一个分支就 NameError
    socratic_ref = branch_id or session_id
    # 画像注入快照（角标用）：在函数作用域先声明——messages 旧格式不进入
    # prompt 分支，若只在分支内赋值，两个响应出口引用它会报 free variable 未绑定
    profile_usage = None
    if prompt:
        # 新格式：后端构建消息
        is_socratic_prompt = _is_socratic_prompt_text(prompt)
        if is_socratic_prompt:
            if prompt.lstrip().startswith("[苏格拉底提示]"):
                socratic_mode = "hint"
            elif prompt.lstrip().startswith("[苏格拉底讲解]"):
                socratic_mode = "explain"
            else:
                socratic_mode = "answer"
        if not branch_id and is_socratic_prompt:
            # 手动输入 [苏格拉底回答] 且未带分支时，自动定位最近仍在进行的苏格拉底分支
            resolved_branch = _resolve_socratic_branch(session_id, account)
            if resolved_branch:
                branch_id = resolved_branch
                socratic_ref = resolved_branch
                if not branch_type:
                    branch_type = "socratic"
                if not source_module:
                    source_module = "extend"
        socratic_state = _read_socratic_state(socratic_ref, account) if socratic_ref else None
        if socratic_state and not is_socratic_prompt:
            # 非苏格拉底的新提问开始时，结束当前苏格拉底支线
            _delete_socratic_state(socratic_ref, account)
            socratic_state = None
        include_socratic = bool(socratic_state) or is_socratic_prompt
        if socratic_state and is_socratic_prompt:
            # 延续中的闭环：用本次消息里的问题/等级刷新状态（保留连对次数与已答轮数）
            _sync_socratic_state_from_prompt(socratic_state, prompt)
            _write_socratic_state(socratic_ref, socratic_state, account)

        # quick 寒暄提示词分支已随退役门禁删除（QUICK_SYSTEM_PROMPT 同步移除）：
        # 能走到这里的 prompt 请求必带锚，只剩工作流与分支两条路径
        if workflow_context:
            system_content = MODULE_SYSTEM_PROMPT
        else:
            system_content = get_system_prompt()
        # 前缀缓存拍板（2026-09-21）：system 只保留场景底座。逐轮易变的注入
        # （支线状态/分支/路径/工作流/会话记忆/概念地基/画像）原来追加在 system
        # 尾部——位于历史之前，任何一处变化都会把「system+全部历史」的 provider
        # 前缀缓存整个打灭。现在统一收进「上下文块」，拼在历史之后的最后一条
        # user 消息头部：易变字节集中到请求末尾，system+历史成为稳定前缀。
        context_parts = []
        # T4 前缀缓存拍板（2026-10-01）：工作流上下文拆 shared/target 两段，shared
        # 段（question/analysis/upstream，兄弟模块逐字节相同）提到苏格拉底/分支/路径
        # 指令之前——兄弟模块公共前缀从仅 system（~698 字）延长到 system＋共享段；
        # 路径指令（含逐模块不同的自节点行与「当前聚焦气泡」行）与 target 段落到
        # 公共前缀之后的缓存断点。后文滚动记忆 context_parts.insert(0, memory_block)
        # 仍插在 shared 之前——记忆对兄弟模块也恒同字节，顺序无碍。
        _wf_shared, _wf_target = ("", "")
        if workflow_context:
            _wf_shared, _wf_target = _workflow_context_parts(workflow_context)
            if _wf_shared:
                context_parts.append(_wf_shared)
        state_instruction = _socratic_state_instruction(socratic_ref, socratic_mode, account=account) if socratic_ref and is_socratic_prompt else ""
        if state_instruction:
            context_parts.append(state_instruction)

        if branch_id:
            context_parts.append(_branch_context_instruction(branch_type, source_module, payload.get("branch_label") or payload.get("branchLabel") or "", parent_id))
        if graph_path:
            context_parts.append(_graph_path_instruction(graph_path, source_module))
            # 前缀缓存拍板（2026-09-25 三代窗）：父与祖父的 ~800 字详摘要进尾
            # 部块，与当前节点全文一起构成「当前全文 + 上两代详情」——下钻时尾
            # 部本就在缓存断点之后，细节零缓存代价；兄弟分叉时该段逐字节相同。
            _upstream_block = context.tree_upstream_detail_block(
                session_id, graph_path, source_module=source_module, branch_id=branch_id, account=account)
            if _upstream_block:
                context_parts.append(_upstream_block)
            # 前缀缓存拍板（2026-09-24）：路径历史区 assistant 一律摘要（只增不
            # 改），当前聚焦节点全文改由尾部上下文块提供——工作流模块再生成的
            # 唯一全文输入也随之落在这里。
            _active_block = context.tree_active_content_block(
                session_id, graph_path, source_module=source_module, branch_id=branch_id, account=account)
            if _active_block:
                context_parts.append(_active_block)
        # 2026-09-25 线性主聊天退役：linear_active_content_block 尾部块随现役 UI
        # 的线性通道一起删除（恢复见 docs/dev/linear-chat-retired.md）。
        # T4（2026-10-01）：target 段（当前生成目标/严格格式指令，逐模块各异）仍在
        # 路径与树尾部块之后——留在兄弟公共前缀之外，不回头挤缓存命中。
        if _wf_target:
            context_parts.append(_wf_target)
        # 概念地基（M4 / P1-A）：knowledge 条目首次作为检索基底参与 prompt——
        # 消息层管「我们聊到哪」，这一段管「这个话题的地基是什么」。
        # 与画像注入同一范围（graph_path-only 锚定请求；画布模块生成 workflow_context
        # 与支线 branch_id 不注入）：
        # 支线与模块重生成是局部动作，多这一层只会挤 token。查空返回空串 = 零回归。
        # 记忆第二步「用起来」：画像薄弱词传给检索作排序加权（只重排、不放水）。
        _device_id = payload.get("device_id") or payload.get("deviceId") or ""
        if not workflow_context and not branch_id:
            concept_text = concept.concept_context_text(
                prompt, session_id=session_id,
                weak_terms=(profile.profile_weak_terms(_device_id) if _device_id else None),
                account=account,
            )
            if concept_text:
                context_parts.append(concept_text)
        # 用户画像（记忆）注入：仅 graph_path-only 锚定请求（画布模块生成 / 支线
        # 不注入——与上方概念地基同一范围，09-20 补齐 branch_id：此前支线也会
        # 注入画像并刷新 lastUsedAt，与注释宣称的口径不一致）。
        # 契约化段落 + 注入回写：命中的事实记 lastUsedAt，长期未命中的自动休眠。
        # 同时把「本次实际注入了什么」随响应回传（角标不再按前端缓存重算）。
        if not workflow_context and not branch_id:
            if _device_id:
                _profile_ctx = profile.profile_context(_device_id, account=account)
                profile_usage = {"sections": _profile_ctx["sections"],
                                 "factCount": len(_profile_ctx["factIds"])}
                if _profile_ctx["text"]:
                    context_parts.append(_profile_ctx["text"])
                    profile.mark_profile_used(_device_id, _profile_ctx["factIds"])
        messages = [{"role": "system", "content": system_content}]

        if session_id:
            # 命名为 history：局部变量不能遮蔽模块名 context（server.context），
            # 否则后续在函数内补用 context._xxx 会拿到 list 而 AttributeError
            history = _load_session_context(
                session_id,
                include_socratic=include_socratic,
                branch_id=branch_id,
                branch_type=branch_type,
                source_module=source_module,
                parent_id=parent_id,
                graph_path=graph_path,
                max_rounds=3,
                current_prompt=prompt,
                workflow_context=workflow_context,
                budget_tokens=context_budget,
                account=account,
            )
            messages.extend(history)
            # 会话记忆并入上下文块首位（不再插在历史第 0 位，见
            # context.rolling_memory_block 的拍板说明）
            memory_block = context.rolling_memory_block(session_id, account)
            if memory_block:
                context_parts.insert(0, memory_block)

        current_text = prompt
        if context_parts:
            current_text = "<上下文>\n" + "\n\n".join(context_parts) + "\n</上下文>\n\n" + prompt

        level = payload.get("level", "university")
        level_suffix = LEVEL_PROMPTS.get(level, LEVEL_PROMPTS["university"])
        messages.append({"role": "user", "content": current_text + level_suffix})

        ctx_text = "".join(str(m.get("content") or "") for m in messages)
        logger.info(f"AI proxy (built msgs): {provider}/{model_name}, level={level}, msgs={len(messages)}, ctx_chars={len(ctx_text)}, est_tokens={estimate_tokens(ctx_text)}, budget={context_budget}")
    else:
        # 旧格式：直接使用传入的 messages（兼容向后）
        messages = payload.get("messages", [])
        if not isinstance(messages, list) or any(not isinstance(m, dict) for m in messages):
            # 逐项 m.get 前先挡掉契约外形状（字符串/数字元素），别变成 500
            raise HTTPException(status_code=400, detail="'messages' must be a list of message objects")
        raw_text = "".join(str(m.get("content") or "") for m in messages)
        logger.info(f"AI proxy (raw msgs): {provider}/{model_name}, msg_count={len(messages)}, ctx_chars={len(raw_text)}, est_tokens={estimate_tokens(raw_text)}")

    if not base_url:
        provider_info = AI_PROVIDERS.get(provider)
        if provider_info:
            base_url = provider_info["base_url"]
        else:
            raise HTTPException(status_code=400, detail=f"Unknown provider '{provider}' and no base_url provided")

    # 防 SSRF 外发 .env 密钥：env 兜底 key 只允许发往官方域名；远程端点强制 https
    try:
        base_url = validate_model_target(provider, base_url, env_key_used)
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = _chat_request_headers(provider, api_key, base_url, session_id or session_bucket)
    target = workflow_context.get("target") or {} if isinstance(workflow_context, dict) else {}
    module_key = target.get("module") or source_module
    is_strict_module = module_key in ("socratic", "learn") and (
        target.get("kind") == "module" or branch_type == "blank"
    )
    max_tokens = payload.get("max_tokens")
    if is_strict_module and not max_tokens:
        max_tokens = STRICT_MODULE_MAX_TOKENS
    body = {
        "model": model_name,
        "messages": messages,
        "stream": stream,
    }
    if stream:
        # 流式也要计量：include_usage 让上游在 [DONE] 前补一帧带 usage 的 chunk；
        # 不认识的兼容端点会整请求 400，由下方降级链剥掉重发
        body["stream_options"] = {"include_usage": True}
    if max_tokens:
        try:
            body["max_tokens"] = int(max_tokens)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="max_tokens must be an integer")
    # 思考程度（模型配置弹窗按条目设置）：仅显式选择时注入对应供应商的思考参数
    thinking_params = _thinking_request_params(provider, str(payload.get("thinking") or ""))
    if thinking_params:
        body.update(thinking_params)

    if session_id and prompt:
        _maybe_schedule_rolling_summary(session_id, provider, api_key, model_name, base_url, account=account)

    logger.info(f"AI proxy: {provider}/{model_name} -> POST {url}")

    # 上游请求先发出、拿到状态码之后再决定响应形态：
    # 旧实现把上游非 200 塞进 SSE 错误帧、HTTP 状态仍是 200，调用方无法用
    # resp.ok 分辨失败；stream=false 分支也裸吐上游 JSON 却带 event-stream 媒体类型
    client = http_client.get_http_client()

    # 计时起点（成功/失败记账共用）：覆盖首连与 400 降级重发全程
    call_t0 = time.monotonic()

    async def _send_upstream():
        req = client.build_request("POST", url, json=body, headers=headers,
                                   timeout=httpx.Timeout(180.0, connect=15.0))
        return await client.send(req, stream=True)

    try:
        resp = await _send_upstream()
    except httpx.HTTPError as e:
        logger.error(f"AI proxy connect error: {e}")
        usage_stats.record_failure(provider, model_name, "chat" if prompt else "legacy",
                                   session_id or session_bucket, f"连接失败: {e}",
                                   usage_stats.elapsed_ms(call_t0))
        raise HTTPException(status_code=502, detail=f"上游连接失败: {e}")
    if resp.status_code == 400 and "stream_options" in body:
        # 降级第一级：该供应商不认识 stream_options（整请求 400）时剥掉重发。
        # 与思考参数的降级分开两级剥——为保计量帧不该丢思考档，反之亦然
        await resp.aclose()
        body.pop("stream_options", None)
        logger.warning("AI proxy: upstream rejected stream_options, retried without it")
        try:
            resp = await _send_upstream()
        except httpx.HTTPError as e:
            logger.error(f"AI proxy connect error: {e}")
            usage_stats.record_failure(provider, model_name, "chat" if prompt else "legacy",
                                       session_id or session_bucket, f"连接失败: {e}",
                                       usage_stats.elapsed_ms(call_t0))
            raise HTTPException(status_code=502, detail=f"上游连接失败: {e}")
    if resp.status_code == 400 and thinking_params:
        # 降级安全网：该供应商不认识思考参数（整请求 400）时剥掉重发一次——
        # 配错了供应商只会「设置不生效」，绝不能把聊天本身弄坏
        await resp.aclose()
        for key in thinking_params:
            body.pop(key, None)
        logger.warning(f"AI proxy: upstream rejected thinking params {sorted(thinking_params)}, retried without them")
        try:
            resp = await _send_upstream()
        except httpx.HTTPError as e:
            logger.error(f"AI proxy connect error: {e}")
            usage_stats.record_failure(provider, model_name, "chat" if prompt else "legacy",
                                       session_id or session_bucket, f"连接失败: {e}",
                                       usage_stats.elapsed_ms(call_t0))
            raise HTTPException(status_code=502, detail=f"上游连接失败: {e}")
    logger.info(f"AI proxy response: {resp.status_code} from {url}")

    if resp.status_code != 200:
        try:
            error_body = await resp.aread()
        finally:
            await resp.aclose()
        error_text = error_body.decode(errors='replace')[:500]
        logger.error(f"AI proxy upstream error: status={resp.status_code} body={error_text} url={url}")
        usage_stats.record_failure(provider, model_name, "chat" if prompt else "legacy",
                                   session_id or session_bucket,
                                   f"HTTP {resp.status_code}: {error_text}",
                                   usage_stats.elapsed_ms(call_t0))
        # T43：401/403 或正文命中凭证错误时，文案带上「换钥」引导而非只报状态码
        raise HTTPException(status_code=502, detail=llm_common.upstream_error_detail(resp.status_code, error_text))

    if not stream:
        try:
            raw = await resp.aread()
        finally:
            await resp.aclose()
        text = raw.decode(errors="replace")
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            # 上游 200 却回非 JSON 正文（网关错误页等）：原样透传，但别让
            # 下面的状态更新/快照回填跟着裸 except 一起静默蒸发
            logger.warning("AI proxy non-stream: upstream 200 with non-JSON body")
            usage_stats.record_failure(provider, model_name, "chat" if prompt else "legacy",
                                       session_id or session_bucket, "200 但正文非 JSON",
                                       usage_stats.elapsed_ms(call_t0))
            return Response(content=raw, media_type="application/json")
        # usage 记账必须在 content 提取之前（T149）：推理型模型烧光 max_tokens
        # 时 200＋usage 齐全但 content 缺失，原先放在提取之后会被早退分支整个
        # 跳过——usage 落盘与缓存命中率双双漏计。只要 JSON 解析得开且 usage 在，
        # 就与有 content 路径同口径记账；正文透传不受影响。
        if data.get("usage"):
            logger.info(f"AI proxy usage: {data['usage']}")
            usage_stats.record_usage(provider, model_name,
                                     "chat" if prompt else "legacy",
                                     session_id or session_bucket, data["usage"],
                                     duration_ms=usage_stats.elapsed_ms(call_t0))
            _log_cache_hit_rate(data["usage"])
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            logger.warning("AI proxy non-stream: upstream JSON missing choices[0].message.content")
            return Response(content=raw, media_type="application/json")
        _update_socratic_state_from_content(content, socratic_ref, account)
        if profile_usage is not None:
            # 非流式出口同样回传注入快照；序列化失败退回原字节
            try:
                data["profile_usage"] = profile_usage
                return Response(content=json.dumps(data, ensure_ascii=False),
                                media_type="application/json")
            except (TypeError, ValueError):
                pass
        return Response(content=raw, media_type="application/json")

    async def proxy_stream():
        try:
            streamed_content = []
            streamed_len = 0
            last_usage = None
            # 注入快照先于正文下发：角标在正文渲染前就能拿到「本次实际注入」，
            # 且协议向后兼容——不认识该字段的客户端只会当作无 delta 的帧跳过
            if profile_usage is not None:
                yield f"data: {json.dumps({'profile_usage': profile_usage}, ensure_ascii=False)}\n\n"
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    data_str = line[6:].strip()
                    if data_str != "[DONE]":
                        try:
                            data = json.loads(data_str)
                            if data.get("usage"):
                                last_usage = data["usage"]
                            delta = data.get("choices", [{}])[0].get("delta", {})
                            delta_text = delta.get("content")
                            if not delta_text:
                                delta_text = delta.get("reasoning_content") or ""
                            if delta_text and streamed_len < 200_000:
                                # 仅用于结束后提取苏格拉底状态，封顶防止超长流式回复无上限累积
                                streamed_content.append(delta_text)
                                streamed_len += len(delta_text)
                        except Exception:
                            pass
                    yield line + "\n\n"
            if last_usage:
                logger.info(f"AI proxy usage: {last_usage}")
                usage_stats.record_usage(provider, model_name,
                                         "chat" if prompt else "legacy",
                                         session_id or session_bucket, last_usage,
                                         duration_ms=usage_stats.elapsed_ms(call_t0))
                _log_cache_hit_rate(last_usage)
            _update_socratic_state_from_content("".join(streamed_content), socratic_ref, account)
        except Exception as e:
            logger.error(f"AI proxy error: {e}")
            usage_stats.record_failure(provider, model_name, "chat" if prompt else "legacy",
                                       session_id or session_bucket, f"流中断: {e}",
                                       usage_stats.elapsed_ms(call_t0))
            yield f"data: {json.dumps({'error': 500, 'detail': str(e)})}\n\n"
            yield "data: [DONE]\n\n"
        finally:
            await resp.aclose()

    return StreamingResponse(proxy_stream(), media_type="text/event-stream")



def _model_pricing_free(item: dict):
    """T60：从上游模型条目推断免费/付费——pricing 全 0 视为免费、任一非 0 视为
    付费；没有 pricing 或字段读不了返回 None（不标注，别瞎猜）。金额各家形态
    不一（OpenRouter 是字符串、有的是数值），统一 float 再比。"""
    pricing = item.get("pricing") if isinstance(item, dict) else None
    if not isinstance(pricing, dict) or not pricing:
        return None
    vals = []
    for key in ("prompt", "completion"):
        if key not in pricing or pricing[key] is None:
            continue
        try:
            vals.append(float(pricing[key]))
        except (TypeError, ValueError):
            return None
    if not vals:
        return None
    return all(v == 0 for v in vals)


@router.post("/api/models/list")
async def api_models_list(request: Request):
    """代理拉取供应商在线模型列表（OpenAI 兼容 GET {base_url}/models）。

    添加模型弹窗「获取模型列表」按钮的后端：内置预设清单只是初值会过期，
    在线列表才是事实源；本地服务（Ollama/LM Studio/llama.cpp）同样适用——
    列出的就是本机已装模型。密钥回退与 SSRF 校验与 /api/models/chat 同口径。
    """
    payload = await _parse_json_object(request)
    provider = payload.get("provider", "")
    api_key, env_key_used = resolve_api_key(provider, payload.get("api_key", ""))

    base_url = payload.get("base_url", "")
    if not base_url:
        provider_info = AI_PROVIDERS.get(provider)
        if not provider_info:
            raise HTTPException(status_code=400, detail=f"Unknown provider '{provider}' and no base_url provided")
        base_url = provider_info["base_url"]
    try:
        base_url = validate_model_target(provider, base_url, env_key_used)
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

    url = f"{base_url.rstrip('/')}/models"
    headers = {}
    # opencode 网关的 /models 清单公开可读（zen 免费与 zen/go 2026-09-25 实测均 200），
    # 反而带无效 Bearer 会 401 Invalid credential——列清单不附带密钥，与 chat 路径分开
    if api_key and provider != "opencode" and "opencode.ai" not in base_url:
        headers["Authorization"] = f"Bearer {api_key}"
    headers.update(_opencode_session_headers(base_url, ""))

    client = http_client.get_http_client()
    try:
        resp = await client.get(url, headers=headers, timeout=httpx.Timeout(20.0, connect=8.0))
    except httpx.HTTPError as e:
        # 空消息的传输异常不带上类型名就只剩「上游连接失败: 」，用户无从排查
        logger.error(f"models list connect error: {provider} {url}: {type(e).__name__}: {e}")
        raise HTTPException(status_code=502, detail=f"上游连接失败: {type(e).__name__}: {e}")
    if resp.status_code != 200:
        logger.error(f"models list upstream error: status={resp.status_code} body={resp.text[:300]} url={url}")
        # T43：拉模型清单遇 401 时用户最需要的就是「去换钥」这句话
        raise HTTPException(status_code=502, detail=llm_common.upstream_error_detail(resp.status_code, resp.text[:300]))
    try:
        data = resp.json()
    except Exception:
        raise HTTPException(status_code=502, detail="上游返回的不是 JSON")
    raw = data.get("data") if isinstance(data, dict) else data
    ids = []
    meta = {}
    if isinstance(raw, list):
        for item in raw:
            mid = item.get("id") if isinstance(item, dict) else None
            if isinstance(mid, str) and mid.strip():
                mid = mid.strip()
                ids.append(mid)
                # T60：上游带定价字段时顺手标注免费/付费（OpenRouter 等有、
                # opencode 没有——后者靠 /api/models/probe 真发探活）
                free = _model_pricing_free(item)
                if free is not None:
                    meta[mid] = {"free": free}
    return {"models": sorted(set(ids)), "meta": meta}


@router.post("/api/models/probe")
async def api_models_probe(request: Request):
    """T60：单模型探活——真发一条最小对话验证「列表里有」≠「能用」。

    免费网关清单常混付费档模型（免费模式下诱导踩坑）；200 但 content 为空的
    「假活」也在这里拦下。密钥回退与 SSRF 校验与 /api/models/list 同口径。
    故意不带 max_tokens（部分新系列拒收该参数会造成假阴性），ping 一句成本可忽略。
    """
    payload = await _parse_json_object(request)
    provider = payload.get("provider", "")
    api_key, env_key_used = resolve_api_key(provider, payload.get("api_key", ""))
    model_name = str(payload.get("model", "") or "").strip()
    if not model_name:
        raise HTTPException(status_code=400, detail="缺少 model")

    base_url = payload.get("base_url", "")
    if not base_url:
        provider_info = AI_PROVIDERS.get(provider)
        if not provider_info:
            raise HTTPException(status_code=400, detail=f"Unknown provider '{provider}' and no base_url provided")
        base_url = provider_info["base_url"]
    try:
        base_url = validate_model_target(provider, base_url, env_key_used)
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    headers.update(_opencode_session_headers(base_url, "models-probe"))
    body = {"model": model_name, "messages": [{"role": "user", "content": "ping"}], "stream": False}

    client = http_client.get_http_client()
    try:
        resp = await client.post(url, json=body, headers=headers,
                                 timeout=httpx.Timeout(25.0, connect=8.0))
    except httpx.HTTPError as e:
        logger.error(f"models probe connect error: {provider} {model_name} {url}: {type(e).__name__}: {e}")
        return {"ok": False, "detail": f"连接失败: {type(e).__name__}"}
    if resp.status_code != 200:
        return {"ok": False, "detail": llm_common.upstream_error_detail(resp.status_code, resp.text[:200])}
    try:
        data = resp.json()
        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        content = str(message.get("content") or "")
        reasoning = str(message.get("reasoning_content") or message.get("reasoning") or "")
    except Exception:
        return {"ok": False, "detail": "返回 200 但不是标准补全 JSON"}
    if not content.strip() and not reasoning.strip():
        # T60：200 但内容为空的「假活」——列表在、实际不可用，标注出来别误导
        return {"ok": False, "detail": "返回 200 但内容为空（疑似不可用）"}
    return {"ok": True, "detail": "可用"}


@router.get("/api/usage/stats")
async def api_usage_stats(days: int = 7, records: int = 0):
    """token 用量与缓存命中率汇总（前缀缓存改造的观测口）。

    数据来自 data/usage/YYYY-MM-DD.jsonl；hitRate 只在「上游确实回报了
    命中字段」的请求上累计（hitKnownRequests 可分辨供应商是否回报）。
    records>0 时附带返回最近 N 条调用明细（时间倒序，服务端上限 500）。
    """
    return usage_stats.summarize(days=days, records=records)



# ====== 滚动会话记忆（长会话后台摘要，不阻塞当前请求） ======
# key -> asyncio.Task：必须存任务对象的强引用——只存 key 时 create_task 返回的
# Task 可能被 GC 中途取消（asyncio 官方文档警告）；key 用于同会话去重
_summary_tasks = {}


def _maybe_schedule_rolling_summary(session_id, provider, api_key, model_name, base_url, account=accounts.DEFAULT_ACCOUNT):
    """长会话后台滚动记忆：不阻塞当前请求，下次提问即可用上。"""
    if not session_id:
        return
    try:
        generation = context._rolling_memory_generation(session_id)
        due = context._rolling_summary_due(session_id, account)
    except Exception:
        return
    if not due:
        return
    key = f"{session_id}:{model_name}"
    if key in _summary_tasks:
        return
    task = asyncio.create_task(
        _run_rolling_summary(session_id, provider, api_key, model_name, base_url, due, generation=generation, account=account)
    )
    _summary_tasks[key] = task
    task.add_done_callback(lambda _t, _key=key: _summary_tasks.pop(_key, None))


async def _run_rolling_summary(session_id, provider, api_key, model_name, base_url, count, generation=None, account=accounts.DEFAULT_ACCOUNT):
    try:
        if generation is None:
            generation = context._rolling_memory_generation(session_id)
        elif generation != context._rolling_memory_generation(session_id):
            return
        snapshot = context._rolling_memory_snapshot(session_id, account=account)
        input_text = snapshot["text"]
        if not input_text:
            return
        url = f"{base_url.rstrip('/')}/chat/completions"
        headers = _chat_request_headers(provider, api_key, base_url, session_id)
        body = {
            "model": model_name,
            "messages": [
                {"role": "system", "content": ROLLING_SUMMARY_PROMPT},
                {"role": "user", "content": input_text},
            ],
            "stream": False,
            "max_tokens": 300,
        }
        client = http_client.get_http_client()
        summary_t0 = time.monotonic()
        try:
            resp = await client.post(url, json=body, headers=headers, timeout=30.0)
            if resp.status_code != 200:
                usage_stats.record_failure(provider, model_name, "summary", session_id,
                                           f"HTTP {resp.status_code}", usage_stats.elapsed_ms(summary_t0))
                return
            data = resp.json()
        except Exception as e:
            # 只包 AI 调用段：连接/超时/解析失败都算调用失败进账，再抛给外层记日志；
            # 记忆写入段的异常仍归外层 except，不冒充调用失败
            usage_stats.record_failure(provider, model_name, "summary", session_id,
                                       f"请求异常: {e}", usage_stats.elapsed_ms(summary_t0))
            raise
        if data.get("usage"):
            usage_stats.record_usage(provider, model_name, "summary", session_id, data["usage"],
                                     duration_ms=usage_stats.elapsed_ms(summary_t0))
        content = data["choices"][0]["message"]["content"]
        if context._write_rolling_memory(session_id, content, snapshot["messageCount"],
                                         expected_generation=generation, snapshot=snapshot,
                                         account=account):
            logger.info("rolling memory updated: session=%s count=%d", session_id, count)
    except Exception as e:
        logger.warning("rolling memory update failed: %s", e)
