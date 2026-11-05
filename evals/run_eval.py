#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PhyMathia 物理数学评测集运行器。

用法：
  python3 evals/run_eval.py --selftest                 # 评分器自检（不联网）
  python3 evals/run_eval.py --adapter mock             # 离线演示（假学生，不联网）
  python3 evals/run_eval.py --adapter mock --only calculus,mechanics
  python3 evals/run_eval.py --adapter server           # 真机：走服务端工作流 direct 通道
      # 模型三选一：--slot agent（默认，服务端已配槽位）/ --model <id或模型名>（A/B 用）
      # / --provider opencode-go --model-name mock-1 --api-key mock
      #        --upstream-base-url http://127.0.0.1:5065/v1（手动直连，mock 上游口径）
报告落 evals/reports/run-<时间戳>.{md,json}。口径与限制见 docs/dev/eval-harness.md。
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from graders import grade_item  # noqa: E402
from judge import (JUDGE_DIMENSIONS, JUDGE_DIMENSION_LABELS,  # noqa: E402
                   JUDGE_PROMPT_VERSION, JudgeClient)

DOMAIN_LABELS = {
    'calculus': '高等数学',
    'linear_algebra': '线性代数',
    'probability': '概率统计',
    'mechanics': '经典力学',
    'electromagnetism': '电磁学',
}

# 工作流「直接回答」节点同款指令：与 src/static/js/graph-workflow-prompt.js 的
# direct 分支一字不差。评测作答走 /api/models/chat 新格式（prompt＋workflow_context
# 锚，过退役门禁），题目经 workflow_context.question 递入——与产品 direct 节点同一
# 条服务端路径（DIRECT_SYSTEM_PROMPT 底座＋工作流上下文块＋难度档后缀），改服务端
# 提示词对评测即时生效。评测专属要求走 requirements（产品原生「用户额外要求」通道，
# 不另造提示词）：让模型展示推导过程＋单独给最终答案，供 graders 抽步骤与答案。
DIRECT_PROMPT = (
    '请直接回答原始问题，不要拆成多个模块。先判断问题需要多大篇幅，再决定怎么写：\n'
    '- 事实、定义、单值、单一结论：用 1~3 句话或一小段直接答完；不写小标题、不推导、不举例凑数。\n'
    '- 概念解释、原因、简单比较：用 1~3 段讲清关键点；涉及机制时补一句物理直觉，涉及公式或适用条件时补一句数学本质。\n'
    '- 推导、证明、多步计算、多方比较：先给结论与核心思路，再展开必要步骤，推导要能自洽走通。\n'
    '通用要求：\n'
    '1. 拿不准时按更短的一档回答；不要输出判断过程或篇幅说明。\n'
    '2. 不为了显得完整而补背景、历史、例子或总结；只有答案确实包含三个以上并列部分时才用小标题。\n'
    '3. 物理直觉与数学本质是可选工具，不是固定栏目，不要为了双域而硬写。\n'
    '4. 公式按 <formula>纯 LaTeX</formula> 规范标注，只标注有实质数学内容的公式。\n'
    '5. 上游内容（问题分析、我的回答、素材等）是依据：可引用、可简要复述，答案要能独立读懂；发现上游有误时明确指出。\n'
    '6. 不要输出完整学习卡片 XML，不要输出 <physics>、<math>、<graph>、<viz>、<extend>、<summary> 或 <socratic_meta> 标签，不要输出「建议模块：」行。\n'
    '7. 信息不足时写明假设与适用条件，不要编造数据、历史或结论。\n'
    '8. 用户额外要求优先于以上默认篇幅与结构。'
)
EVAL_REQUIREMENT = (
    '请展示完整解题或判断过程：关键步骤逐步推导，最后单独一行给出最终答案'
    '（或对错判断／纠正后的结论）。'
)


class MockAdapter:
    """离线假学生：按题库字段拼「好/坏」两种作答，验证管道与报告，不代表任何模型水平。

    序号 i % 3 == 0 的题故意答错（复述典型错误、跳过关键步骤），其余答对。
    环境变量 PHYMATHIA_EVAL_MOCK_WRONG_EVERY=k 改成每 k 题错一题——专供验证
    「基线 diff 能红出退步题」的机制（模拟模型/提示词变差），不是作弊开关。
    """
    name = 'mock'

    def __init__(self):
        try:
            self.wrong_every = int(os.environ.get('PHYMATHIA_EVAL_MOCK_WRONG_EVERY', '3') or 3)
        except ValueError:
            self.wrong_every = 3
        if self.wrong_every < 1:
            self.wrong_every = 3

    def describe(self):
        return 'mock（离线假学生，每 %d 题故意答错 1 题，数字不代表模型水平）' % self.wrong_every

    def run(self, item, index):
        if index % self.wrong_every == 0:
            wrong = (item.get('common_errors') or [{}])[0].get('wrong', '不知道')
            return '这个解法完全正确。最终答案：%s。过程从略。' % wrong
        parts = [item.get('solution_path', '')]
        for st in item.get('key_steps') or []:
            parts.append(st.get('point', ''))
            parts.extend(st.get('evidence') or [])
        if item.get('expected_answer'):
            parts.append('最终答案：' + item['expected_answer'][0])
        return '\n'.join(p for p in parts if p)


class ServerAdapter:
    """真机适配器：纯 HTTP 走 /api/models/chat 新格式（工作流 direct 通道）。

    - 不开浏览器页面（避开 localStorage 整包推真源的坑），模型三来源：
      ①--slot（默认 agent）：读服务端账号配置 GET /api/models/config 解析槽位；
      ②--model <id或模型名>：同份配置里直取指定模型（A/B DeepSeek vs Doubao 用）；
      ③--provider/--model-name/--api-key/--upstream-base-url 手动直连（mock 上游口径）。
    - stream:false：服务端回上游整包 JSON，取 choices[0].message.content 即收口全文。
    - 发送失败不炸整轮：返回 '[发送失败] 原因' 文本落报告（判 fail、可见可数）；
      preflight 先探一发（健康＋模型解析＋最小提问），上游调不动早停不白跑 20 题。
    """

    name = 'server'
    FAIL_PREFIX = '[发送失败]'

    def __init__(self, base_url='http://localhost:5050', slot='agent', model_ref=None,
                 provider=None, model_name=None, api_key=None, upstream_base_url=None,
                 level='university', timeout=300):
        self.base_url = base_url.rstrip('/')
        self.slot = slot
        self.model_ref = model_ref
        self.provider = provider
        self.model_name = model_name
        self.api_key = api_key
        self.upstream_base_url = upstream_base_url
        self.level = level
        self.timeout = timeout
        self.model = None       # 解析后的模型条目 dict
        self.model_desc = ''    # 人话描述（进报告 meta）
        self.sent_ok = 0
        self.sent_fail = 0

    # ---- HTTP 基础 ----

    def _http_json(self, path, payload=None, timeout=None):
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8') if payload is not None else None
        req = urllib.request.Request(
            self.base_url + path, data=data, method='POST' if data is not None else 'GET',
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))

    # ---- 模型解析 ----

    def _resolve_model(self):
        if self.provider or self.model_name or self.upstream_base_url:
            if not (self.provider and self.model_name and self.upstream_base_url):
                raise SystemExit('手动直连模式：--provider/--model-name/--upstream-base-url 要一起给')
            self.model = {'provider': self.provider, 'model': self.model_name,
                          'baseUrl': self.upstream_base_url, 'apiKey': self.api_key or ''}
            self.model_desc = '手动直连 %s/%s → %s' % (self.provider, self.model_name, self.upstream_base_url)
            return
        cfg = self._http_json('/api/models/config', timeout=15)
        models = [m for m in cfg.get('userModels') or [] if isinstance(m, dict)]
        active = cfg.get('activeModels') or {}
        group_keys = cfg.get('modelGroupKeys') or {}
        entry = None
        if self.model_ref:
            entry = next((m for m in models
                          if m.get('id') == self.model_ref or m.get('model') == self.model_ref), None)
            if entry is None:
                avail = '、'.join('%s(%s)' % (m.get('model'), m.get('id')) for m in models[:8])
                raise SystemExit('服务端模型配置里找不到 --model %s。可用：%s' % (self.model_ref, avail or '（空）'))
            how = '--model 指定'
        else:
            # 槽位键兼容：前端存的是 agent_model/html_model…（带 _model 后缀），
            # 也接受裸键 agent/html——实踩：真机 activeModels 用的是前一种
            mid = (active.get(self.slot) or active.get(self.slot + '_model')
                   or active.get('agent') or active.get('agent_model') or '')
            entry = next((m for m in models if m.get('id') == mid), None)
            if entry is None and models:
                entry = models[0]
            if entry is None:
                raise SystemExit('服务端没配任何模型：在应用「模型设置」里配置，或用 '
                                 '--provider/--model-name/--api-key/--upstream-base-url 手动直连')
            hit = ('%s' % self.slot if active.get(self.slot)
                   else '%s（实际键 %s_model）' % (self.slot, self.slot))
            how = '槽位 %s' % hit
        key = entry.get('apiKey') or group_keys.get(entry.get('provider')) or ''
        self.model = {'provider': entry.get('provider') or '', 'model': entry.get('model') or '',
                      'baseUrl': entry.get('baseUrl') or '', 'apiKey': key}
        self.model_desc = '%s：%s/%s' % (how, self.model['provider'], self.model['model'])

    # ---- 发送与作答 ----

    def _payload(self, question):
        return {
            'prompt': DIRECT_PROMPT,
            'level': self.level,
            'workflow_context': {
                'mode': 'direct',
                'question': question,
                'requirements': EVAL_REQUIREMENT,
                'target': {'kind': 'direct', 'label': '直接回答'},
                'upstream': [],
            },
            'provider': self.model['provider'],
            'api_key': self.model.get('apiKey') or '',
            'model': self.model['model'],
            'base_url': self.model.get('baseUrl') or '',
            'stream': False,
            'session_bucket': 'phymathia-eval',
        }

    def _ask(self, question, timeout=None):
        data = json.dumps(self._payload(question), ensure_ascii=False).encode('utf-8')
        req = urllib.request.Request(self.base_url + '/api/models/chat', data=data,
                                     method='POST', headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                body = resp.read().decode('utf-8')
        except urllib.error.HTTPError as e:
            raise RuntimeError('HTTP %s：%s' % (e.code, e.read().decode('utf-8', 'replace')[:300]))
        except urllib.error.URLError as e:
            raise RuntimeError('连不上服务 %s：%s' % (self.base_url, e.reason))
        try:
            content = json.loads(body)['choices'][0]['message']['content']
        except Exception:
            raise RuntimeError('上游回包不是合法 OpenAI JSON：%s' % body[:200])
        if not str(content or '').strip():
            raise RuntimeError('上游回了空 content（可能 finish_reason=length 烧光 max_tokens）')
        return str(content)

    def preflight(self):
        """开跑前探三步：服务健康、模型解析、真发一发。不通早停，别白跑一整轮。"""
        self._http_json('/health', timeout=10)
        self._resolve_model()
        self._ask('1+1 等于几？只回答数字。', timeout=60)

    def describe(self):
        return 'server（真机工作流 direct 通道；模型 %s；难度档 %s）' % (self.model_desc, self.level)

    def run(self, item, index):
        try:
            text = self._ask(item['question'])
        except Exception as e:
            self.sent_fail += 1
            return '%s %s' % (self.FAIL_PREFIX, e)
        self.sent_ok += 1
        return text


def load_questions(path, only=None):
    """加载题库：path 可以是单个 .jsonl 文件或目录（目录按文件名序吃全部 *.jsonl）。"""
    p = Path(path)
    files = sorted(p.glob('*.jsonl')) if p.is_dir() else [p]
    if not files:
        raise SystemExit('题库路径没有可加载的 .jsonl：%s' % path)
    items = []
    for f in files:
        with open(f, encoding='utf-8') as fh:
            for ln, line in enumerate(fh, 1):
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                try:
                    items.append(json.loads(line))
                except json.JSONDecodeError as e:
                    raise SystemExit('%s:%d 不是合法 JSON：%s' % (f, ln, e))
    if only:
        want = {x.strip() for x in only.split(',') if x.strip()}
        items = [it for it in items if it.get('domain') in want or it.get('id') in want]
    return items


def summarize(results):
    total = len(results)
    passed = sum(1 for r in results if r['verdict'] == 'pass')
    by_domain = {}
    for r in results:
        d = by_domain.setdefault(r['domain'], {'total': 0, 'pass': 0})
        d['total'] += 1
        d['pass'] += 1 if r['verdict'] == 'pass' else 0
    dims = {}
    for r in results:
        for k, v in r['dimensions'].items():
            if k in ('steps_hit', 'known_wrong_echo'):
                continue
            s = dims.setdefault(k, {'applicable': 0, 'pass': 0})
            if v in ('pass', 'fail', 'caught', 'missed', 'corrected'):
                s['applicable'] += 1
                if v in ('pass', 'caught', 'corrected'):
                    s['pass'] += 1
    echoed = sum(1 for r in results if r['dimensions'].get('known_wrong_echo'))
    out = {'total': total, 'passed': passed, 'by_domain': by_domain,
           'dimensions': dims, 'known_wrong_echoed': echoed}
    # judge 双轨汇总（开了 --judge 才有）：overall 三态＋五维度通过率
    judged = [r for r in results if isinstance(r.get('judge'), dict)]
    if judged:
        jdims = {k: {'pass': 0, 'applicable': 0} for k in JUDGE_DIMENSIONS}
        joverall = {'pass': 0, 'fail': 0, 'error': 0}
        for r in judged:
            j = r['judge']
            joverall[j['overall']] = joverall.get(j['overall'], 0) + 1
            if j.get('dims'):
                for k in JUDGE_DIMENSIONS:
                    jdims[k]['applicable'] += 1
                    if j['dims'][k]['verdict'] == 'pass':
                        jdims[k]['pass'] += 1
        out['judge'] = {'judged': len(judged), 'overall': joverall, 'dims': jdims}
    return out


def render_md(stamp, adapter_desc, summary, results):
    L = ['# PhyMathia 评测报告 %s' % stamp, '']
    L.append('- 适配器：%s' % adapter_desc)
    L.append('- 总通过：%d/%d' % (summary['passed'], summary['total']))
    L.append('')
    L.append('## 分域')
    L.append('')
    L.append('| 域 | 通过/总数 |')
    L.append('|---|---|')
    for d, s in summary['by_domain'].items():
        L.append('| %s | %d/%d |' % (DOMAIN_LABELS.get(d, d), s['pass'], s['total']))
    L.append('')
    L.append('## 分维度（仅统计适用题）')
    L.append('')
    L.append('| 维度 | 通过/适用 |')
    L.append('|---|---|')
    for k, s in summary['dimensions'].items():
        L.append('| %s | %d/%d |' % (k, s['pass'], s['applicable']))
    L.append('')
    L.append('- known_wrong_echo（作答复述典型错误式子，仅警示不判分）：%d 题' % summary['known_wrong_echoed'])
    L.append('')
    if summary.get('judge'):
        js = summary['judge']
        L.append('## 判卷模型双轨（judge，语义评分）')
        L.append('')
        L.append('- **gate 仍用规则分**（上方「判定」列）；judge 列是语义判卷参考，'
                 '稳定后才拍板升级 gate（口径见 docs/dev/eval-harness.md）')
        L.append('- overall：%d pass / %d fail / %d error（共判 %d 题）' % (
            js['overall'].get('pass', 0), js['overall'].get('fail', 0),
            js['overall'].get('error', 0), js['judged']))
        L.append('')
        L.append('| judge 维度 | pass/适用 |')
        L.append('|---|---|')
        for k in JUDGE_DIMENSIONS:
            s = js['dims'][k]
            L.append('| %s | %d/%d |' % (JUDGE_DIMENSION_LABELS[k], s['pass'], s['applicable']))
        L.append('')
    L.append('## 逐题')
    L.append('')
    has_judge = bool(summary.get('judge'))
    head = '| id | 域 | kind | 判定 | final_answer | key_steps | 破绽/概念 | 复述典型错误 |'
    if has_judge:
        head += ' judge |'
    L.append(head)
    sep = '|---|---|---|---|---|---|---|---|' + ('---|' if has_judge else '')
    L.append(sep)
    for r in results:
        d = r['dimensions']
        if r['kind'] == 'error_catch':
            catch = d['error_catch']
        elif r['kind'] == 'concept':
            catch = d['concept']
        else:
            catch = '—'
        echo = '、'.join(d['known_wrong_echo']) if d.get('known_wrong_echo') else '—'
        row = '| %s | %s | %s | %s | %s | %s(%s) | %s | %s |' % (
            r['id'], r['domain'], r['kind'], r['verdict'],
            d['final_answer'], d['key_steps'], d['steps_hit'], catch, echo)
        if has_judge:
            j = r.get('judge')
            row += ' %s |' % (j['overall'] if isinstance(j, dict) else '—（发送失败）')
        L.append(row)
    L.append('')
    if has_judge:
        L.append('## 判卷证据（每题一句/维度）')
        L.append('')
        for r in results:
            j = r.get('judge')
            if not isinstance(j, dict):
                continue
            if j['overall'] == 'error':
                L.append('- **%s**：判卷失败——%s' % (r['id'], j.get('error', '')))
                continue
            for k in JUDGE_DIMENSIONS:
                slot = j['dims'][k]
                if slot['verdict'] != 'pass':
                    L.append('- **%s**·%s fail：%s' % (r['id'], JUDGE_DIMENSION_LABELS[k], slot['evidence']))
        L.append('')
    return '\n'.join(L)


# ===== 基线与回归 diff（阶段四）：改 prompt/换模型后跑一次，报告自动对比基线 =====

BASELINE_PATH = ROOT / 'baseline.json'
LABEL_SAFE = re.compile(r'^[A-Za-z0-9._-]{1,64}$')


def lean_results(results):
    """落基线/标签用的瘦身结果：只留判定与维度，不带作答片段与判卷证据。"""
    return [{'id': r['id'], 'domain': r['domain'], 'kind': r['kind'],
             'verdict': r['verdict'], 'dimensions': r['dimensions'],
             'sent_ok': bool(r.get('sent_ok', True)),
             'judge_overall': r['judge']['overall'] if isinstance(r.get('judge'), dict) else None}
            for r in results]


def save_baseline(meta, summary, results, path=BASELINE_PATH):
    blob = {'saved_at': time.strftime('%Y-%m-%d %H:%M:%S'), 'meta': meta,
            'summary': summary, 'results': lean_results(results)}
    Path(path).write_text(json.dumps(blob, ensure_ascii=False, indent=1), encoding='utf-8')
    return path


def _load_runs(labels, out_dir):
    """按标签取 run：'baseline' 别名指 evals/baseline.json，其余在 reports/runs/ 下。"""
    loaded = []
    for label in labels:
        p = BASELINE_PATH if label == 'baseline' else Path(out_dir) / 'runs' / (label + '.json')
        if not p.exists():
            raise SystemExit('找不到 run 标签 %s（找了 %s）' % (label, p))
        loaded.append((label, json.loads(p.read_text(encoding='utf-8'))))
    return loaded


def diff_baseline(base_results, new_results):
    """基线 diff：分域/分维度涨跌＋退步题/改善题逐条。只比两边都有的题 id。"""
    old = {r['id']: r for r in base_results}
    new = {r['id']: r for r in new_results}
    common = [qid for qid in new if qid in old]
    regressed, improved = [], []
    dom = {}
    dims = {}
    for qid in common:
        o, n = old[qid], new[qid]
        if o['verdict'] == 'pass' and n['verdict'] == 'fail':
            regressed.append({'id': qid, 'domain': n['domain'], 'kind': n['kind'],
                              'old': o['dimensions'], 'new': n['dimensions']})
        elif o['verdict'] == 'fail' and n['verdict'] == 'pass':
            improved.append({'id': qid, 'domain': n['domain']})
        d = dom.setdefault(n['domain'], {'old_pass': 0, 'new_pass': 0, 'total': 0})
        d['total'] += 1
        d['old_pass'] += 1 if o['verdict'] == 'pass' else 0
        d['new_pass'] += 1 if n['verdict'] == 'pass' else 0
        for k in set(list((o.get('dimensions') or {}).keys()) + list((n.get('dimensions') or {}).keys())):
            if k in ('steps_hit', 'known_wrong_echo'):
                continue
            s = dims.setdefault(k, {'old_pass': 0, 'new_pass': 0, 'total': 0})
            ov = (o.get('dimensions') or {}).get(k)
            nv = (n.get('dimensions') or {}).get(k)
            if ov in ('pass', 'caught', 'corrected') or nv in ('pass', 'caught', 'corrected'):
                s['total'] += 1
                s['old_pass'] += 1 if ov in ('pass', 'caught', 'corrected') else 0
                s['new_pass'] += 1 if nv in ('pass', 'caught', 'corrected') else 0
    return {'common': len(common), 'only_new': len(new) - len(common),
            'only_old': len(old) - len(common),
            'regressed': regressed, 'improved': improved,
            'domain': dom, 'dims': dims,
            'old_total_pass': sum(1 for q in common if old[q]['verdict'] == 'pass'),
            'new_total_pass': sum(1 for q in common if new[q]['verdict'] == 'pass')}


def _delta(old_pass, new_pass, total):
    if not total:
        return '—'
    do, dn = old_pass / total, new_pass / total
    return '%+.1f%%（%d/%d → %d/%d）' % ((dn - do) * 100, old_pass, total, new_pass, total)


def render_diff_md(base_label, diff):
    L = ['', '## 基线 diff（对比 %s）' % base_label, '']
    L.append('- 共同题 %d 道：通过 %d → %d（%s）；退步 %d 题、改善 %d 题%s' % (
        diff['common'], diff['old_total_pass'], diff['new_total_pass'],
        _delta(diff['old_total_pass'], diff['new_total_pass'], diff['common']),
        len(diff['regressed']), len(diff['improved']),
        '；本次新增 %d 题、基线独有 %d 题（不参与比较）' % (diff['only_new'], diff['only_old'])
        if diff['only_new'] or diff['only_old'] else ''))
    if diff['regressed']:
        L.append('')
        L.append('**⚠ 退步题（基线 pass → 本次 fail）：**')
        for r in diff['regressed']:
            flips = [k for k in ('final_answer', 'key_steps', 'error_catch', 'concept')
                     if r['old'].get(k) in ('pass', 'caught', 'corrected')
                     and r['new'].get(k) not in ('pass', 'caught', 'corrected')]
            L.append('- %s（%s，%s）：%s 翻转' % (r['id'], DOMAIN_LABELS.get(r['domain'], r['domain']),
                                                 r['kind'], '、'.join(flips) or '判定'))
    if diff['improved']:
        L.append('')
        L.append('改善题（基线 fail → 本次 pass）：%s' % '、'.join(r['id'] for r in diff['improved']))
    L.append('')
    L.append('| 维度 | 基线 → 本次 |')
    L.append('|---|---|')
    for k, s in diff['dims'].items():
        L.append('| %s | %s |' % (k, _delta(s['old_pass'], s['new_pass'], s['total'])))
    L.append('')
    L.append('| 域 | 基线 → 本次 |')
    L.append('|---|---|')
    for k, s in diff['domain'].items():
        L.append('| %s | %s |' % (DOMAIN_LABELS.get(k, k), _delta(s['old_pass'], s['new_pass'], s['total'])))
    L.append('')
    return '\n'.join(L)


def compare_runs(label_a, data_a, label_b, data_b, out_dir):
    """--compare：两标签 run 的对比表（选型依据）。"""
    ra, rb = data_a['results'], data_b['results']
    A = {r['id']: r for r in ra}
    B = {r['id']: r for r in rb}
    common = [q for q in A if q in B]
    pa = sum(1 for q in common if A[q]['verdict'] == 'pass')
    pb = sum(1 for q in common if B[q]['verdict'] == 'pass')
    L = ['# 模型对比：%s vs %s' % (label_a, label_b), '']
    L.append('- 共同题 %d 道：%s 通过 %d（%.1f%%）；%s 通过 %d（%.1f%%）' % (
        len(common), label_a, pa, 100.0 * pa / len(common) if common else 0,
        label_b, pb, 100.0 * pb / len(common) if common else 0))
    L.append('- 模型：%s ｜ %s' % (data_a.get('meta', {}).get('model', {}).get('model', '—') if isinstance(data_a.get('meta', {}).get('model'), dict) else data_a.get('meta', {}).get('model', '—'),
                                  data_b.get('meta', {}).get('model', {}).get('model', '—') if isinstance(data_b.get('meta', {}).get('model'), dict) else data_b.get('meta', {}).get('model', '—')))
    L.append('')
    doms = sorted({r['domain'] for r in ra} | {r['domain'] for r in rb})
    L.append('| 域 | %s | %s |' % (label_a, label_b))
    L.append('|---|---|---|')
    for d in doms:
        ids = [q for q in common if A[q]['domain'] == d]
        da = sum(1 for q in ids if A[q]['verdict'] == 'pass')
        db = sum(1 for q in ids if B[q]['verdict'] == 'pass')
        L.append('| %s | %d/%d | %d/%d |' % (DOMAIN_LABELS.get(d, d), da, len(ids), db, len(ids)))
    L.append('')
    only_a_win = [q for q in common if A[q]['verdict'] == 'pass' and B[q]['verdict'] == 'fail']
    only_b_win = [q for q in common if B[q]['verdict'] == 'pass' and A[q]['verdict'] == 'fail']
    L.append('- 仅 %s 通过（%d）：%s' % (label_a, len(only_a_win), '、'.join(only_a_win) or '无'))
    L.append('- 仅 %s 通过（%d）：%s' % (label_b, len(only_b_win), '、'.join(only_b_win) or '无'))
    # judge 双轨对比（两边都有时）
    ja = {r['id']: r for r in ra if isinstance(r.get('judge_overall'), str)}
    jb = {r['id']: r for r in rb if isinstance(r.get('judge_overall'), str)}
    both = [q for q in ja if q in jb]
    if both:
        L.append('')
        L.append('- judge overall：%s %d/%d pass ｜ %s %d/%d pass' % (
            label_a, sum(1 for q in both if ja[q]['judge_overall'] == 'pass'), len(both),
            label_b, sum(1 for q in both if jb[q]['judge_overall'] == 'pass'), len(both)))
    text = '\n'.join(L)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    out = Path(out_dir) / ('compare-%s-vs-%s-%s.md' % (label_a, label_b, stamp))
    out.write_text(text, encoding='utf-8')
    return text, out


def rejudge(run_json, base_url, out_dir):
    """对已存报告重判 judge error/缺失的题：学生作答取自报告里留档的全文，
    判卷层重试（可反复跑，判卷成功即入缓存）。产出 *-rejudged 报告。"""
    import judge as judge_mod
    src = json.loads(Path(run_json).read_text(encoding='utf-8'))
    meta = src.get('meta') or {}
    jm = meta.get('judge') or {}
    if not jm.get('model'):
        raise SystemExit('该报告没开 judge，无从重判')
    provider, model_name = jm['model'].split('/', 1)
    resolver = ServerAdapter(base_url, model_ref=model_name)
    resolver._resolve_model()
    client = judge_mod.JudgeClient(base_url, resolver.model,
                                   cache_path=Path(out_dir) / 'judge-cache.json')
    items = {it.get('id'): it for f in sorted(Path(ROOT / 'questions').glob('*.jsonl'))
             for it in load_questions(f)} if (ROOT / 'questions').exists() else {}
    fixed, still = 0, 0
    for r in src['results']:
        need = (not isinstance(r.get('judge'), dict)) or r['judge'].get('overall') == 'error'
        if not need:
            continue
        if not r.get('response'):
            still += 1
            continue
        item = items.get(r['id'])
        if item is None:
            still += 1
            continue
        res = client.judge(item, r['response'])
        if res['overall'] == 'error':
            still += 1
        else:
            fixed += 1
        r['judge'] = res
    summary = summarize(src['results'])
    stamp = time.strftime('%Y%m%d-%H%M%S')
    out = Path(out_dir) / ('run-%s-rejudged' % stamp)
    (Path(str(out) + '.json')).write_text(
        json.dumps({'meta': meta, 'summary': summary, 'results': src['results']},
                   ensure_ascii=False, indent=1), encoding='utf-8')
    (Path(str(out) + '.md')).write_text(
        render_md(stamp, 'server 重判 %s（判卷 %s）' % (meta.get('adapter', '?'), jm['model']),
                  summary, src['results']), encoding='utf-8')
    print('重判完成：修复 %d 题、仍失败 %d 题（judge new=%d cache=%d err=%d）' % (
        fixed, still, client.new_count, client.cache_hit_count, client.error_count))
    print('报告：%s.md' % out)
    return 0


def selftest():

    from graders import extract_numbers, norm

    n = 0

    def ok(cond, msg):
        nonlocal n
        assert cond, '自检失败：%s' % msg
        n += 1

    ok(norm('E^{X²} + C') == 'e^x²+c', 'norm 大小写/花括号/空格')
    ok(any(abs(v - 1 / 6) < 1e-9 for v in extract_numbers('概率是 \\frac{1}{6}')), 'frac 数值抽取')
    ok(-2.5 in extract_numbers('答案：−2.5'), 'unicode 负号抽取')

    it_num = {'id': 't1', 'kind': 'solve', 'domain': 't', 'question': 'q',
              'expected_answer': ['1/6'],
              'answer_check': {'type': 'numeric', 'value': 0.1667, 'tol': 0.002,
                               'alt_values': [{'value': 16.67, 'tol': 0.5}]},
              'key_steps': [{'point': 'p1', 'evidence': ['36']},
                            {'point': 'p2', 'evidence': ['6种', '共6']},
                            {'point': 'p3', 'evidence': ['\\frac{1}{6}', '1/6', '0.167', '16.7']}],
              'common_errors': [{'wrong': '1/9', 'desc': 'x'}]}
    g = grade_item(it_num, '样本空间36，和为7的组合共6种，概率6/36=\\frac{1}{6}，即16.7%。')
    ok(g['verdict'] == 'pass', '数值题全维度通过：%s' % json.dumps(g, ensure_ascii=False))
    g = grade_item(it_num, '答案是 1/9。')
    ok(g['verdict'] == 'fail', '错答案判 fail')
    ok(g['dimensions']['known_wrong_echo'] == ['1/9'], '复述典型错误被标警示')

    it_sym = {'id': 't2', 'kind': 'solve', 'domain': 't', 'question': 'q',
              'expected_answer': ['e^{x^2}+C', 'exp(x^2)+C'],
              'answer_check': {'type': 'symbolic'},
              'key_steps': [{'point': 'a', 'evidence': ['d(x^2)']},
                            {'point': 'b', 'evidence': ['e^u']},
                            {'point': 'c', 'evidence': ['+C']}],
              'common_errors': []}
    g = grade_item(it_sym, '凑微分 2x dx=d(x^2)，令 u=x^2，∫e^u du=e^u+C，回代得 e^{x^2}+C。')
    ok(g['verdict'] == 'pass', '符号题通过')
    g = grade_item(it_sym, '最终答案 e^{x^2}+C（过程略）。')
    ok(g['verdict'] == 'fail' and g['dimensions']['steps_hit'] != '3/3', '答案对但关键步骤缺失→fail')

    it_catch = {'id': 't3', 'kind': 'error_catch', 'domain': 't', 'question': 'q',
                'expected_answer': [], 'answer_check': {},
                'key_steps': [{'point': 'x', 'evidence': ['发散', '瑕点']},
                              {'point': 'y', 'evidence': ['反例', '零因子']}],
                'common_errors': [{'wrong': '=-1', 'desc': 'x'}]}
    g = grade_item(it_catch, '这个解法完全正确，结果就是 −1。')
    ok(g['verdict'] == 'fail' and g['dimensions']['error_catch'] == 'missed', '破绽未指出→missed')
    g = grade_item(it_catch, '不对：x=0 是瑕点，反常积分发散；这就和矩阵零因子的反例一样，不能把无界当0。')
    ok(g['verdict'] == 'pass' and g['dimensions']['error_catch'] == 'caught', '破绽指出→caught')

    it_all = {'id': 't4', 'kind': 'solve', 'domain': 't', 'question': 'q',
              'expected_answer': ['λ=4；λ=−1'],
              'answer_check': {'type': 'numeric', 'mode': 'all', 'values': [4, -1], 'tol': 0.001},
              'key_steps': [{'point': 'p', 'evidence': ['特征多项式']}],
              'common_errors': []}
    g = grade_item(it_all, '特征多项式 λ²−3λ−4，得 λ=4 与 λ=−1。')
    ok(g['verdict'] == 'pass', 'mode=all 双值命中')
    g = grade_item(it_all, '特征多项式 λ²−3λ−4，得 λ=4 与 λ=1。')
    ok(g['verdict'] == 'fail', 'mode=all 丢负根→fail')

    # server 适配器（纯函数部分，不联网）：payload 走工作流 direct 锚、手动直连解析
    sa = ServerAdapter('http://x')
    sa.model = {'provider': 'p', 'model': 'm', 'baseUrl': 'u', 'apiKey': 'k'}
    pl = sa._payload('求 ∫2x dx')
    ok(pl['prompt'] == DIRECT_PROMPT and pl['stream'] is False and pl['session_bucket'] == 'phymathia-eval',
       'server payload：direct 同款指令＋非流式＋评测会话桶')
    wf = pl['workflow_context']
    ok(wf['mode'] == 'direct' and wf['question'] == '求 ∫2x dx'
       and wf['target']['kind'] == 'direct' and wf['requirements'] == EVAL_REQUIREMENT,
       'workflow_context 锚：direct 模式携带题目与评测要求')
    sa2 = ServerAdapter('http://x', provider='opencode-go', model_name='mock-1', api_key='mock',
                        upstream_base_url='http://127.0.0.1:5065/v1')
    sa2._resolve_model()
    ok(sa2.model['model'] == 'mock-1' and sa2.model['baseUrl'] == 'http://127.0.0.1:5065/v1',
       '手动直连模型解析（mock 上游口径）')

    # judge（打桩单测，不联网）：回包解析、输入拼装、缓存命中/不缓存垃圾
    from judge import (JudgeParseError, build_judge_input,  # noqa: E402
                       parse_judge_reply)
    good_json = ('{"final_answer":{"verdict":"pass","evidence":"答案一致"},'
                 '"derivation":{"verdict":"fail","evidence":"跳步"},'
                 '"formula":{"verdict":"pass"},'
                 '"hallucination":{"verdict":"PASS","evidence":"无编造"},'
                 '"contradiction":{"verdict":"fail","evidence":"前后矛盾"}}')
    dims = parse_judge_reply('```json\n%s\n```' % good_json)
    ok(dims['derivation']['verdict'] == 'fail' and dims['hallucination']['verdict'] == 'pass'
       and '判卷未给证据' in dims['formula']['evidence'],
       '判卷解析：剥围栏＋大小写归一＋缺证据补注')
    dims2 = parse_judge_reply('前置废话 {"final_answer":{"verdict":"pass","evidence":"x"}} 后置废话')
    ok(dims2['contradiction']['verdict'] == 'fail' and '缺' in dims2['contradiction']['evidence'],
       '判卷解析：缺维度补 fail 带证据')
    try:
        parse_judge_reply('完全不是 JSON 的回包')
        ok(False, '垃圾回包应抛 JudgeParseError')
    except JudgeParseError:
        ok(True, '垃圾回包抛 JudgeParseError')
    it_j = {'id': 'tj', 'kind': 'error_catch', 'question': '题干内容', 'expected_answer': ['-1'],
            'solution_path': '解法路径文本', 'key_steps': [{'point': '指出瑕点', 'evidence': ['x']}],
            'common_errors': [{'wrong': '14', 'desc': '符号错'}]}
    inp = build_judge_input(it_j, '学生作答原文')
    ok(all(s in inp for s in ('纠错题', '题干内容', '-1', '指出瑕点', '14', '学生作答原文')),
       '判卷输入拼装：题型说明＋题干＋参考＋步骤＋常见错误＋作答')

    jc = JudgeClient('http://x', {'provider': 'p', 'model': 'm', 'baseUrl': 'u', 'apiKey': 'k'})
    calls = []

    def fake_ask(u):
        calls.append(u)
        return good_json

    jc._ask = fake_ask
    it_s = {'id': 't1', 'kind': 'solve', 'question': 'q', 'expected_answer': [],
            'key_steps': [], 'common_errors': []}
    r1 = jc.judge(it_s, 'ans')
    r2 = jc.judge(it_s, 'ans')
    ok(r1['from_cache'] is False and r2['from_cache'] is True and len(calls) == 1
       and r2['overall'] == 'fail', 'judge 缓存：同作答二判命中零付费（overall 按维度聚合）')

    def bad_ask(u):
        raise JudgeParseError('bad')

    jc._ask = bad_ask
    r3 = jc.judge(it_s, 'ans2')
    r4 = jc.judge(it_s, 'ans2')
    ok(r3['overall'] == 'error' and r4['from_cache'] is False and jc.error_count == 2,
       'judge 垃圾回包：error 不缓存，重判会再调用')

    # 基线 diff：退步/改善/新增题、涨跌计算（纯函数）
    def _r(qid, verdict, dom='calculus'):
        return {'id': qid, 'domain': dom, 'kind': 'solve', 'verdict': verdict,
                'dimensions': {'final_answer': verdict, 'key_steps': verdict},
                'sent_ok': True, 'judge_overall': None}

    old = [_r('a', 'pass'), _r('b', 'fail'), _r('c', 'pass'), _r('gone', 'pass')]
    new = [_r('a', 'fail'), _r('b', 'pass'), _r('c', 'pass'), _r('fresh', 'pass')]
    dd = diff_baseline(old, new)
    ok(dd['common'] == 3 and [x['id'] for x in dd['regressed']] == ['a']
       and [x['id'] for x in dd['improved']] == ['b']
       and dd['only_new'] == 1 and dd['only_old'] == 1,
       '基线 diff：退步/改善/新旧差集')
    ok(dd['old_total_pass'] == 2 and dd['new_total_pass'] == 2,
       '基线 diff：通过数 2→2')
    ok(dd['dims']['final_answer']['old_pass'] == 2 and dd['dims']['final_answer']['new_pass'] == 2,
       '基线 diff：维度涨跌统计')

    print('selftest ✓ %d 项检查通过' % n)
    return 0


def main():
    ap = argparse.ArgumentParser(description='PhyMathia 物理数学评测运行器')
    ap.add_argument('--adapter', choices=['mock', 'server'], default='mock',
                    help='mock=离线假学生（验证管道）；server=真机工作流 direct 通道')
    ap.add_argument('--base-url', default='http://localhost:5050')
    ap.add_argument('--questions', default=str(ROOT / 'questions'),
                    help='题库：.jsonl 文件或目录（目录＝全部 *.jsonl，按域拆分后的常态）')
    ap.add_argument('--only', default=None, help='逗号分隔的 domain 或题目 id 过滤')
    ap.add_argument('--out-dir', default=str(ROOT / 'reports'))
    ap.add_argument('--slot', default='agent',
                    help='[server] 从服务端模型配置取哪个槽位（agent/branch/html/graph/quiz/descriptor）')
    ap.add_argument('--model', default=None,
                    help='[server] 按 id 或模型名直取服务端已配模型（优先于 --slot；A/B 对比用）')
    ap.add_argument('--provider', default=None, help='[server] 手动直连：上游供应商（如 opencode-go）')
    ap.add_argument('--model-name', default=None, help='[server] 手动直连：上游模型名（如 mock-1）')
    ap.add_argument('--api-key', default=None, help='[server] 手动直连：上游密钥（mock 用 mock 即可）')
    ap.add_argument('--upstream-base-url', default=None,
                    help='[server] 手动直连：上游 base_url（mock 上游 http://127.0.0.1:5065/v1）')
    ap.add_argument('--level', default='university', help='[server] 难度档位（LEVEL_PROMPTS 键）')
    ap.add_argument('--timeout', type=int, default=300, help='[server] 单题超时秒数')
    ap.add_argument('--judge', action='store_true',
                    help='开启 model-judge 双轨（语义判卷；gate 仍用规则分）')
    ap.add_argument('--judge-model', default=None,
                    help='[judge] 判卷模型（服务端配置里的 id 或模型名；缺省＝学生同款模型。'
                         '建议 A/B 对比时固定同一强判卷模型）')
    ap.add_argument('--save-baseline', action='store_true',
                    help='把本次 run 存为基线 evals/baseline.json（后续每次报告自动 diff 它）')
    ap.add_argument('--label', default=None,
                    help='给本次 run 命名（如 deepseek-20261112），存 reports/runs/<label>.json 供 --compare')
    ap.add_argument('--compare', nargs=2, metavar=('LABEL_A', 'LABEL_B'), default=None,
                    help='不跑评测，直接对比两个已存标签（"baseline" 指基线）出模型对比表')
    ap.add_argument('--rejudge', metavar='RUN_JSON', default=None,
                    help='不跑学生：重判已存报告里 judge error/缺失的题（判卷层重试，省学生费）')
    ap.add_argument('--selftest', action='store_true', help='只跑评分器自检')
    args = ap.parse_args()

    if args.selftest:
        sys.exit(selftest())

    if args.compare:
        (la, da), (lb, db) = _load_runs(args.compare, args.out_dir)
        text, out = compare_runs(la, da, lb, db, args.out_dir)
        print(text)
        print('对比表：%s' % out)
        return

    if args.rejudge:
        sys.exit(rejudge(args.rejudge, args.base_url, args.out_dir))

    items = load_questions(args.questions, args.only)
    if not items:
        raise SystemExit('没有加载到任何题目：%s' % args.questions)

    if args.adapter == 'mock':
        adapter = MockAdapter()
    else:
        adapter = ServerAdapter(
            args.base_url, slot=args.slot, model_ref=args.model,
            provider=args.provider, model_name=args.model_name, api_key=args.api_key,
            upstream_base_url=args.upstream_base_url, level=args.level, timeout=args.timeout)
        adapter.preflight()   # 健康＋模型解析＋一发探针：上游调不动早停
        print('真机就绪：%s' % adapter.describe())

    judge_client = None
    if args.judge:
        if args.judge_model:
            resolver = ServerAdapter(args.base_url, model_ref=args.judge_model)
            resolver._resolve_model()   # 只借模型解析，不发题
            judge_model = resolver.model
        elif args.adapter == 'server':
            judge_model = adapter.model
        else:
            raise SystemExit('--adapter mock 开 --judge 需给 --judge-model（判卷要有模型）')
        judge_client = JudgeClient(
            args.base_url, judge_model, cache_path=Path(args.out_dir) / 'judge-cache.json')
        print('判卷就绪：%s（提示词 %s；缓存已有 %d 条）' % (
            judge_client.model_desc, JUDGE_PROMPT_VERSION, len(judge_client.cache)))

    results = []
    for i, item in enumerate(items):
        resp = adapter.run(item, i)
        sent_ok = not resp.startswith(ServerAdapter.FAIL_PREFIX)
        g = grade_item(item, resp)
        g['response'] = resp                      # 作答全文：本地留档供 --rejudge
        g['response_head'] = resp[:160].replace('\n', ' ')
        g['sent_ok'] = sent_ok
        if judge_client is not None:
            # 发送失败的题不判卷（没作答可判）；判卷结果带缓存命中标记
            g['judge'] = judge_client.judge(item, resp) if sent_ok else None
        if args.adapter == 'server':
            jtxt = ''
            if isinstance(g.get('judge'), dict):
                jtxt = '｜ judge %s%s' % (g['judge']['overall'],
                                          '（缓存）' if g['judge']['from_cache'] else '')
            print('  %s %s ｜ 判定 %s%s' % (item.get('id'),
                                            '已发通' if sent_ok else '发送失败', g['verdict'], jtxt))
        results.append(g)

    stamp = time.strftime('%Y%m%d-%H%M%S')
    summary = summarize(results)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / ('run-%s.json' % stamp)
    md_path = out_dir / ('run-%s.md' % stamp)
    meta = {'time': stamp, 'adapter': adapter.name,
            'questions_file': args.questions, 'total': len(items)}
    if args.adapter == 'server':
        meta.update({'adapter_desc': adapter.describe(), 'model': adapter.model,
                     'level': args.level,
                     'sent_ok': adapter.sent_ok, 'sent_fail': adapter.sent_fail})
    if judge_client is not None:
        meta['judge'] = {'model': judge_client.model_desc,
                         'prompt_version': JUDGE_PROMPT_VERSION,
                         'new': judge_client.new_count,
                         'cache_hit': judge_client.cache_hit_count,
                         'error': judge_client.error_count}
    json_path.write_text(json.dumps(
        {'meta': meta, 'summary': summary, 'results': results},
        ensure_ascii=False, indent=1), encoding='utf-8')
    base_diff = None
    if BASELINE_PATH.exists():
        base = json.loads(BASELINE_PATH.read_text(encoding='utf-8'))
        base_diff = {'base_saved_at': base.get('saved_at'), **diff_baseline(base['results'], results)}
    md_path.write_text(render_md(stamp, adapter.describe(), summary, results)
                       + (render_diff_md('基线 %s' % (base_diff['base_saved_at'] or ''), base_diff)
                          if base_diff else ''),
                       encoding='utf-8')
    if args.save_baseline:
        save_baseline(meta, summary, results)
        print('基线已存：%s' % BASELINE_PATH)
    if args.label:
        if not LABEL_SAFE.match(args.label):
            raise SystemExit('--label 只能含字母/数字/点/下划线/连字符（≤64）')
        runs_dir = Path(args.out_dir) / 'runs'
        runs_dir.mkdir(parents=True, exist_ok=True)
        (runs_dir / (args.label + '.json')).write_text(
            json.dumps({'meta': meta, 'summary': summary,
                        'results': lean_results(results)}, ensure_ascii=False, indent=1),
            encoding='utf-8')
        print('标签已存：reports/runs/%s.json' % args.label)

    print('适配器 %s ｜ 题目 %d ｜ 通过 %d' % (adapter.name, summary['total'], summary['passed']))
    if args.adapter == 'server':
        print('发送：%d 发通 / %d 失败' % (adapter.sent_ok, adapter.sent_fail))
    for d, s in summary['by_domain'].items():
        print('  %s %d/%d' % (DOMAIN_LABELS.get(d, d), s['pass'], s['total']))
    print('报告：%s' % md_path)
    print('      %s' % json_path)
    if adapter.name == 'mock':
        print('注意：mock 是离线假学生（每 %d 题故意答错 1 题），数字不代表模型水平。'
              % adapter.wrong_every)
    if base_diff:
        print('基线 diff：退步 %d 题、改善 %d 题（共同 %d 题：%d → %d）' % (
            len(base_diff['regressed']), len(base_diff['improved']), base_diff['common'],
            base_diff['old_total_pass'], base_diff['new_total_pass']))
        for r in base_diff['regressed'][:10]:
            print('  ⚠ 退步：%s（%s）' % (r['id'], DOMAIN_LABELS.get(r['domain'], r['domain'])))
        if len(base_diff['regressed']) > 10:
            print('  …另有 %d 题退步，见报告 md' % (len(base_diff['regressed']) - 10))


if __name__ == '__main__':
    main()
