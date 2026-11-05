# -*- coding: utf-8 -*-
"""PhyMathia 评测集 model-judge（语义判卷，2026-11-05 阶段二）。

给定 题目＋参考答案＋被评作答，让判卷模型输出结构化 JSON：五维度各 pass/fail＋一句证据。
与规则评分器（graders.py）双轨并存：报告两列都给，**gate 暂仍用规则分**（judge 稳定后再
拍板升级，拍板记录进 docs/dev/eval-harness.md）。

判卷调用走服务端 /api/models/chat **messages 直传旧格式**（与测验/知识提取等辅助调用同
通道——判卷是旁路结构化任务，不该套产品 direct 底座）；密钥/SSRF/记账都由服务端代理处理。

缓存：按（题目 id＋作答全文哈希＋判卷提示词版本＋判卷模型）落 evals/reports/judge-cache.json，
重跑同作答不重复付费；解析失败（模型没回合法 JSON）不缓存——瞬时垃圾回包不该被永久记住。
"""
import hashlib
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

JUDGE_PROMPT_VERSION = 'v1'
JUDGE_DIMENSIONS = ('final_answer', 'derivation', 'formula', 'hallucination', 'contradiction')
JUDGE_DIMENSION_LABELS = {
    'final_answer': '最终答案',
    'derivation': '推导完整性',
    'formula': '公式错误',
    'hallucination': '幻觉概念',
    'contradiction': '自相矛盾',
}

JUDGE_SYSTEM_PROMPT = (
    '你是物理数学题的严格判卷老师。只输出一个 JSON 对象，不要任何其他文字，'
    '不要 Markdown 代码围栏。格式（五个维度，一个不能少）：\n'
    '{"final_answer":{"verdict":"pass或fail","evidence":"一句中文证据"},\n'
    ' "derivation":{"verdict":"pass或fail","evidence":"一句中文证据"},\n'
    ' "formula":{"verdict":"pass或fail","evidence":"一句中文证据"},\n'
    ' "hallucination":{"verdict":"pass或fail","evidence":"一句中文证据"},\n'
    ' "contradiction":{"verdict":"pass或fail","evidence":"一句中文证据"}}\n'
    '判定口径（verdict=pass 表示该维度没问题，fail 表示有问题）：\n'
    '- final_answer：最终答案或结论与参考答案一致（数值看容差、符号看等价形式）；'
    '纠错题/概念探针题看破绽是否指出、错误前提是否纠正。\n'
    '- derivation：关键步骤是否覆盖、推导是否完整能走通；只有结论没有过程算 fail。\n'
    '- formula：作答中出现的公式、符号、单位有没有写错或用错（作答没有公式且题目不需要公式时 pass）。\n'
    '- hallucination：有没有编造不存在的概念、定律、数据或无中生有的结论。\n'
    '- contradiction：作答内部有没有前后矛盾（步骤之间、步骤与结论之间）。\n'
    'evidence 必须引用作答或参考答案的关键原文片段，一句以内。拿不准时倾向 fail 并在 evidence 说明疑点。'
)

# 作答超长截断：判卷输入封顶，防单题判卷费爆（够覆盖正常作答）
JUDGE_INPUT_MAX_RESPONSE_CHARS = 8000


class JudgeParseError(Exception):
    """判卷模型回包不是可用的五维度 JSON。"""


def build_judge_input(item, response):
    """拼判卷输入（题干＋参考材料＋作答）。纯函数，selftest 直测。"""
    kind = item.get('kind', 'solve')
    kind_note = {
        'solve': '这是求解题：学生作答应给出正确的最终答案与完整推导。',
        'error_catch': '这是纠错题：题干内嵌一个含错误的解法或说法，正确行为是指出破绽并说明为什么错。',
        'concept': '这是概念探针题：题干前提本身是错的，正确行为是识别并纠正错误前提。',
    }.get(kind, '')
    steps = item.get('key_steps') or []
    steps_text = '\n'.join('%d. %s' % (i + 1, st.get('point', ''))
                           for i, st in enumerate(steps)) or '（无）'
    errors = item.get('common_errors') or []
    errors_text = '\n'.join('- %s：%s' % (e.get('wrong', ''), e.get('desc', ''))
                            for e in errors) or '（无）'
    expected = '；'.join(item.get('expected_answer') or []) or '（见解法路径）'
    resp = str(response or '')
    if len(resp) > JUDGE_INPUT_MAX_RESPONSE_CHARS:
        resp = resp[:JUDGE_INPUT_MAX_RESPONSE_CHARS] + '\n…（作答超长已截断）'
    return (
        '%s\n\n【题目】\n%s\n\n【参考答案】%s\n【解法路径】%s\n\n'
        '【应覆盖的关键步骤】\n%s\n\n【常见错误（学生复述且当正确结论用应记 fail）】\n%s\n\n'
        '【学生作答】\n%s'
    ) % (kind_note, item.get('question', ''), expected,
         item.get('solution_path', ''), steps_text, errors_text, resp)


def parse_judge_reply(text):
    """解析判卷回包为五维度 dict。容错：剥代码围栏/前后杂文字；非法反斜杠转义修复
    （模型爱在 evidence 里写 \\lambda 等 LaTeX，在 JSON 字符串里是非法转义——真机
    glm-5.3 实踩）；缺维度补 fail＋证据；非法 verdict 归 fail。完全不是 JSON 抛错。"""
    t = str(text or '').strip()
    t = re.sub(r'^```[a-zA-Z]*\s*', '', t)
    t = re.sub(r'\s*```$', '', t).strip()
    m = re.search(r'\{[\s\S]*\}', t)
    if not m:
        raise JudgeParseError('回包里找不到 JSON 对象：%s' % t[:120])
    raw = m.group(0)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        # 修复通道一：把不属于合法 JSON 转义（\\" \\\\ \\/ \\b \\f \\n \\r \\t \\uXXXX 之外）
        # 的反斜杠双重化——\lambda 变 \\lambda 后能合法解析（证据文本略变形可接受）
        repaired = re.sub(r'\\(?!["\\/bfnrtu])', r'\\\\', raw)
        try:
            data = json.loads(repaired)
        except json.JSONDecodeError:
            # 修复通道二（2026-11-05 真机 16/200 实踩）：模型在 evidence 里嵌未转义
            # 引号（"学生结论"这个说法错误…），JSON 整体无解。改用正则逐维度抽
            # verdict（gate 语义的关键）＋尽力抽 evidence——判卷不因引号报废
            dims = {}
            for key in JUDGE_DIMENSIONS:
                vm = re.search(r'"%s"\s*:\s*\{\s*"verdict"\s*:\s*"(pass|fail)"' % key,
                               raw, re.I)
                if not vm:
                    raise JudgeParseError('JSON 损坏且抽不到 %s 的 verdict：%s' % (key, t[:120]))
                em = re.search(r'"%s"\s*:\s*\{[^{}]*?"evidence"\s*:\s*"((?:[^"\\]|\\.)*)"' % key,
                               raw, re.I)
                dims[key] = {'verdict': vm.group(1).lower(),
                             'evidence': (em.group(1) if em else '（证据抽取失败，verdict 由正则抢救）')[:200]}
            data = dims
    if not isinstance(data, dict):
        raise JudgeParseError('JSON 顶层不是对象：%s' % t[:120])
    dims = {}
    for key in JUDGE_DIMENSIONS:
        slot = data.get(key)
        if isinstance(slot, dict):
            verdict = 'pass' if str(slot.get('verdict', '')).lower() == 'pass' else 'fail'
            evidence = str(slot.get('evidence', '')).strip() or ('（判卷未给证据，verdict=%s）' % slot.get('verdict'))
        else:
            verdict = 'fail'
            evidence = '判卷输出缺「%s」维度' % JUDGE_DIMENSION_LABELS[key]
        dims[key] = {'verdict': verdict, 'evidence': evidence[:200]}
    return dims


def cache_key(item_id, response, judge_model_desc, prompt_version):
    raw = '%s\n%s\n%s\n%s' % (item_id, response, judge_model_desc, prompt_version)
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


class JudgeClient:
    """判卷客户端：走服务端 messages 直传通道；带磁盘缓存（按题 id＋作答哈希＋提示词版本＋模型）。"""

    def __init__(self, base_url, model, timeout=180, cache_path=None):
        self.base_url = base_url.rstrip('/')
        self.model = model  # {'provider','model','baseUrl','apiKey'}
        self.timeout = timeout
        self.cache_path = Path(cache_path) if cache_path else None
        self.cache = {}
        self.new_count = 0
        self.cache_hit_count = 0
        self.error_count = 0
        if self.cache_path and self.cache_path.exists():
            try:
                data = json.loads(self.cache_path.read_text(encoding='utf-8'))
                if isinstance(data, dict):
                    self.cache = data
            except (OSError, json.JSONDecodeError):
                self.cache = {}   # 坏缓存不当宝贝，重判一遍就好

    @property
    def model_desc(self):
        return '%s/%s' % (self.model.get('provider'), self.model.get('model'))

    def _save_cache(self):
        if not self.cache_path:
            return
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self.cache_path.write_text(
            json.dumps(self.cache, ensure_ascii=False, indent=1), encoding='utf-8')

    def _ask(self, user_text):
        payload = {
            'messages': [
                {'role': 'system', 'content': JUDGE_SYSTEM_PROMPT},
                {'role': 'user', 'content': user_text},
            ],
            'provider': self.model.get('provider') or '',
            'api_key': self.model.get('apiKey') or '',
            'model': self.model.get('model') or '',
            'base_url': self.model.get('baseUrl') or '',
            'stream': False,
            'session_bucket': 'phymathia-eval-judge',
        }
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        req = urllib.request.Request(self.base_url + '/api/models/chat', data=data,
                                     method='POST', headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = resp.read().decode('utf-8')
        except urllib.error.HTTPError as e:
            raise RuntimeError('HTTP %s：%s' % (e.code, e.read().decode('utf-8', 'replace')[:300]))
        except urllib.error.URLError as e:
            raise RuntimeError('连不上服务：%s' % e.reason)
        try:
            content = json.loads(body)['choices'][0]['message']['content']
        except Exception:
            raise RuntimeError('判卷上游回包不是合法 OpenAI JSON：%s' % body[:200])
        return str(content or '')

    def judge(self, item, response):
        """评一道作答。返回 {'dims','overall','from_cache','error','model','prompt_version'}。
        overall ∈ pass/fail/error；error 不缓存（瞬时垃圾不该被永久记住）。"""
        key = cache_key(item.get('id', ''), response, self.model_desc, JUDGE_PROMPT_VERSION)
        base = {'model': self.model_desc, 'prompt_version': JUDGE_PROMPT_VERSION}
        if key in self.cache:
            hit = self.cache[key]
            self.cache_hit_count += 1
            return {**hit, **base, 'from_cache': True}
        try:
            reply = self._ask(build_judge_input(item, response))
            dims = parse_judge_reply(reply)
        except JudgeParseError as e:
            self.error_count += 1
            return {**base, 'dims': None, 'overall': 'error',
                    'error': '判卷回包不可用：%s' % e, 'from_cache': False}
        except Exception as e:   # 网络/HTTP 层：同样不缓存
            self.error_count += 1
            return {**base, 'dims': None, 'overall': 'error',
                    'error': '%s: %s' % (type(e).__name__, e), 'from_cache': False}
        result = {**base, 'dims': dims,
                  'overall': 'pass' if all(d['verdict'] == 'pass' for d in dims.values()) else 'fail',
                  'from_cache': False, 'judged_at': time.strftime('%Y-%m-%d %H:%M:%S')}
        self.cache[key] = result
        self.new_count += 1
        self._save_cache()
        return result
