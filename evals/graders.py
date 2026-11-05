# -*- coding: utf-8 -*-
"""PhyMathia 评测集规则评分器（v0）。

口径与已知限制见 docs/dev/eval-harness.md。要点：
- norm()：lower、去空格/$/花括号/LaTeX 定界符/中文标点，unicode 负号归一，乘号删除；
  evidence 与 symbolic accept 都在规范化文本上做子串匹配。
- extract_numbers()：裸数字 + a/b + \\frac{a}{b} 求值（unicode 负号先归一）。
- known_wrong_echo（作答复述典型错误式子）只警示不 gate：模型可能是在对比提醒。
"""
import re

_MINUS = {'−': '-', '–': '-', '—': '-'}

_STRIP = ('$', '\\(', '\\)', '\\[', '\\]', '\\left', '\\right', '{', '}',
          '\\,', '\\;', '\\!', '\\ ', ' ', '\t', '\n', '\r', '`', '"', "'",
          '，', '、', '：', '；', '。', '（', '）', '“', '”', '‘', '’',
          '*', '·', '×', '⋅')


def norm(s):
    """规范化文本：用于 evidence / symbolic accept 的子串匹配（两侧同函数处理）。"""
    if s is None:
        return ''
    s = str(s).lower()
    for a, b in _MINUS.items():
        s = s.replace(a, b)
    for tok in _STRIP:
        s = s.replace(tok, '')
    return s


def extract_numbers(text):
    """从作答原文抽取数值候选：裸数字、a/b、\\frac{a}{b} 求值。"""
    t = str(text)
    for a, b in _MINUS.items():
        t = t.replace(a, b)
    out = []
    for m in re.finditer(r'\\[dt]?frac\s*\{\s*([-+]?\d+(?:\.\d+)?)\s*\}\s*\{\s*([-+]?\d+(?:\.\d+)?)\s*\}', t):
        a, b = float(m.group(1)), float(m.group(2))
        if b != 0:
            out.append(a / b)
    for m in re.finditer(r'([-+]?\d+(?:\.\d+)?)\s*/\s*([-+]?\d+(?:\.\d+)?)(?!\d)', t):
        a, b = float(m.group(1)), float(m.group(2))
        if b != 0:
            out.append(a / b)
    for m in re.finditer(r'[-+]?\d+(?:\.\d+)?', t):
        out.append(float(m.group()))
    return out


def check_answer(response, item):
    """final_answer 维度：数值题比容差（mode=any/all），符号题规范化子串匹配，未配置返回 na。"""
    chk = item.get('answer_check') or {}
    kind = chk.get('type')
    if kind == 'numeric':
        if chk.get('value') is None and not chk.get('values'):
            return 'na'
        nums = extract_numbers(response)
        tol = float(chk.get('tol', 1e-6))
        if chk.get('mode') == 'all':
            vals = chk.get('values') or [chk.get('value')]
            ok = all(any(abs(n - float(v)) <= tol for n in nums) for v in vals)
            return 'pass' if ok else 'fail'
        targets = [(float(chk['value']), tol)]
        targets += [(float(a['value']), float(a.get('tol', tol))) for a in chk.get('alt_values', [])]
        ok = any(abs(n - v) <= t for n in nums for v, t in targets)
        return 'pass' if ok else 'fail'
    if kind == 'symbolic':
        r = norm(response)
        ok = any(norm(a) and norm(a) in r for a in item.get('expected_answer') or [])
        return 'pass' if ok else 'fail'
    return 'na'


def check_steps(response, item):
    """key_steps 维度：每步 evidence 任一 token 命中即算该步命中。"""
    steps = item.get('key_steps') or []
    if not steps:
        return 'na', 0, 0
    r = norm(response)
    hit = sum(1 for st in steps
              if any(norm(ev) and norm(ev) in r for ev in st.get('evidence') or []))
    if hit == len(steps):
        return 'pass', hit, len(steps)
    return ('partial' if hit else 'fail'), hit, len(steps)


def check_known_wrong(response, item):
    """作答里复述了 common_errors 的典型错误式子 → 返回命中的串（仅警示，不判分）。"""
    r = norm(response)
    return [w.get('wrong', '') for w in item.get('common_errors') or []
            if norm(w.get('wrong', '')) and norm(w['wrong']) in r]


def grade_item(item, response):
    """评一道题。solve 题 gate＝final_answer 且 key_steps 全过；error_catch/concept 题 gate＝key_steps 全命中。"""
    kind = item.get('kind', 'solve')
    ans = check_answer(response, item)
    steps, hit, total = check_steps(response, item)
    echoed = check_known_wrong(response, item)
    dims = {
        'final_answer': ans,
        'key_steps': steps,
        'steps_hit': '%d/%d' % (hit, total),
        'known_wrong_echo': echoed or None,
        'error_catch': ('caught' if steps == 'pass' else 'missed') if kind == 'error_catch' else 'na',
        'concept': ('corrected' if steps == 'pass' else 'missed') if kind == 'concept' else 'na',
    }
    if kind == 'solve':
        verdict = 'pass' if ans == 'pass' and steps == 'pass' else 'fail'
    else:
        verdict = 'pass' if steps == 'pass' else 'fail'
    return {'id': item.get('id'), 'kind': kind, 'domain': item.get('domain'),
            'verdict': verdict, 'dimensions': dims}
