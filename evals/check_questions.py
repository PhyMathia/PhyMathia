#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""题库红线检查器（阶段三，2026-11-05）：入库前必过。

  python3 evals/check_questions.py                 # 结构＋v0 已知坑红线（默认）
  python3 evals/check_questions.py --two-way       # 好答案 pass／坏答案 fail 两向
  python3 evals/check_questions.py --verify        # sympy 独立复核（verify 字段）
  python3 evals/check_questions.py --final         # 终检：另查 配比红线 与 ≥200 题

红线（违反＝exit 1，逐条列出）：
- 结构：id 全局唯一且前缀对域、kind/difficulty 合法、solve 必配 answer_check、
  key_steps 每步有 point＋非空 evidence、solve（numeric/symbolic）必须有 verify 字段。
- v0 已知坑：evidence 含空格/乘号；²（³）与 ^2（^3）只写一个变体；any-mode 数值题
  的答案（含 alt_values）出现在题干数字里；mode=all 的值出现在题干；common_errors.wrong
  与正解/证据撞子串、或与数值目标同值。
两向：good（solution_path＋全部 evidence＋最终答案）必须 pass；bad（复述 wrong）必须 fail。
配比（--final）：总数 ≥200；错误解法覆盖（error_catch+concept）≥ 1/3。
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from graders import extract_numbers, grade_item, norm  # noqa: E402
from run_eval import DOMAIN_LABELS, load_questions  # noqa: E402

ID_PREFIX = {'calculus': 'calc', 'linear_algebra': 'la', 'probability': 'prob',
             'mechanics': 'mech', 'electromagnetism': 'em'}
KINDS = {'solve', 'error_catch', 'concept'}
DIFFS = {'basic', 'medium', 'hard'}
# evidence 里不许出现的字符（norm 两侧都会剥，写了就说明作者依赖了脆弱匹配）
BAD_EVIDENCE_CHARS = (' ', '\t', '×', '·', '⋅', '*')


def check_structure(items, path_label):
    errs = []
    seen_ids = {}
    for it in items:
        qid = it.get('id', '?')
        where = '%s[%s]' % (path_label, qid)
        dom = it.get('domain', '')
        if dom not in ID_PREFIX:
            errs.append('%s：未知 domain %r' % (where, dom))
        else:
            pref = ID_PREFIX[dom]
            if not str(qid).startswith(pref + '-'):
                errs.append('%s：id 前缀应为 %s-' % (where, pref))
        if qid in seen_ids:
            errs.append('%s：id 重复（已见于 %s）' % (where, seen_ids[qid]))
        seen_ids[qid] = where
        if it.get('kind') not in KINDS:
            errs.append('%s：kind 非法 %r' % (where, it.get('kind')))
        if it.get('difficulty') not in DIFFS:
            errs.append('%s：difficulty 非法 %r' % (where, it.get('difficulty')))
        for f in ('topic', 'question', 'solution_path'):
            if not str(it.get(f, '')).strip():
                errs.append('%s：缺 %s' % (where, f))
        steps = it.get('key_steps') or []
        if not steps:
            errs.append('%s：key_steps 为空' % where)
        for i, st in enumerate(steps, 1):
            if not str(st.get('point', '')).strip():
                errs.append('%s：第 %d 步缺 point' % (where, i))
            evs = st.get('evidence') or []
            if not evs:
                errs.append('%s：第 %d 步 evidence 为空' % (where, i))
        if it.get('kind') == 'solve':
            chk = it.get('answer_check') or {}
            if chk.get('type') not in ('numeric', 'symbolic'):
                errs.append('%s：solve 必须配 answer_check（numeric/symbolic）' % where)
            else:
                if chk['type'] == 'numeric' and chk.get('value') is None and not chk.get('values'):
                    errs.append('%s：numeric 缺 value/values' % where)
                if chk['type'] == 'symbolic' and not (it.get('expected_answer') or []):
                    errs.append('%s：symbolic 缺 expected_answer' % where)
                if not (it.get('verify') or {}).get('expr'):
                    errs.append('%s：solve 有 answer_check 就必须有 verify.expr（机器独立复核红线）' % where)
    return errs


def _targets(item):
    """数值判分目标全集（含 alt_values）：[(value, tol)]。"""
    chk = item.get('answer_check') or {}
    out = []
    if chk.get('type') != 'numeric':
        return out
    tol = float(chk.get('tol', 1e-6))
    if chk.get('mode') == 'all':
        out += [(float(v), tol) for v in (chk.get('values') or [chk.get('value')])]
    else:
        if chk.get('value') is not None:
            out.append((float(chk['value']), tol))
        out += [(float(a['value']), float(a.get('tol', tol))) for a in chk.get('alt_values', [])]
    return out


def check_traps(items, path_label):
    """v0 已知坑逐条：evidence 字符、上标双变体、题干撞答案、wrong 撞正解。"""
    errs = []
    for it in items:
        qid = it.get('id', '?')
        where = '%s[%s]' % (path_label, qid)
        # ① evidence 字符红线
        for i, st in enumerate(it.get('key_steps') or [], 1):
            for ev in st.get('evidence') or []:
                if not norm(ev):
                    errs.append('%s：第 %d 步 evidence「%s」规范化后为空' % (where, i, ev))
                if any(c in str(ev) for c in BAD_EVIDENCE_CHARS):
                    errs.append('%s：第 %d 步 evidence「%s」含空格/乘号（别写依赖剥除的脆弱串）' % (where, i, ev))
            joined = ''.join(st.get('evidence') or [])
            for sup, alt in (('²', '^2'), ('³', '^3')):
                if sup in joined and alt not in joined:
                    errs.append('%s：第 %d 步同时缺 %s 的 %s 变体（两种文本都要写）' % (where, i, sup, alt))
                if alt in joined and sup not in joined:
                    errs.append('%s：第 %d 步同时缺 ^%s 的 %s 变体（两种文本都要写）'
                                % (where, i, alt[-1], sup))
        # ② 数值答案撞题干（假阳性红线）
        stem_nums = extract_numbers(it.get('question', ''))
        for v, tol in _targets(it):
            if any(abs(n - v) <= tol for n in stem_nums):
                errs.append('%s：答案值 %s 出现在题干数字里（回显即假阳性；换数或改 mode=all 并换数据）' % (where, v))
        # ③ wrong 撞正解/证据/数值目标
        exps = [norm(e) for e in it.get('expected_answer') or [] if norm(e)]
        evids = [norm(ev) for st in it.get('key_steps') or []
                 for ev in st.get('evidence') or [] if norm(ev)]
        for w in it.get('common_errors') or []:
            wn = norm(w.get('wrong', ''))
            if not wn:
                continue
            for e in exps:
                if wn in e:
                    errs.append('%s：wrong「%s」是正解「%s」的子串（好作答也误报）' % (where, w.get('wrong'), e))
            for e in evids:
                if wn in e:
                    errs.append('%s：wrong「%s」是关键步骤证据「%s」的子串' % (where, w.get('wrong'), e))
            for n in extract_numbers(w.get('wrong', '')):
                if any(abs(n - v) <= tol for v, tol in _targets(it)):
                    errs.append('%s：wrong「%s」的数值 %s 与判分目标同值' % (where, w.get('wrong'), n))
    return errs


def check_two_way(items, path_label):
    """好答案 pass／坏答案 fail（与 MockAdapter 同款构造）。"""
    errs = []
    for idx, it in enumerate(items):
        qid = it.get('id', '?')
        where = '%s[%s]' % (path_label, qid)
        good_parts = [it.get('solution_path', '')]
        for st in it.get('key_steps') or []:
            good_parts.append(st.get('point', ''))
            good_parts.extend(st.get('evidence') or [])
        if it.get('expected_answer'):
            good_parts.append('最终答案：' + it['expected_answer'][0])
        good = '\n'.join(p for p in good_parts if p)
        wrong = (it.get('common_errors') or [{}])[0].get('wrong', '不知道')
        bad = '这个解法完全正确。最终答案：%s。过程从略。' % wrong
        g = grade_item(it, good)
        if g['verdict'] != 'pass':
            errs.append('%s：好答案没过（%s｜%s %s）' % (where, g['verdict'],
                                                        g['dimensions']['final_answer'], g['dimensions']['key_steps']))
        b = grade_item(it, bad)
        if b['verdict'] != 'fail':
            errs.append('%s：坏答案没拦住（%s）——evidence 太宽或 wrong 串命中不了' % (where, b['verdict']))
    return errs


def _verify_namespace():
    import sympy as sp
    from sympy.stats import (Binomial, Covariance, Die, Exponential, Normal,  # noqa: F401
                             P, Uniform, variance as stats_variance)
    ns = {name: getattr(sp, name) for name in dir(sp) if not name.startswith('_')}
    ns.update({'sp': sp, 'Normal': Normal, 'P': P, 'Binomial': Binomial, 'Die': Die,
               'Exponential': Exponential, 'Uniform': Uniform, 'Cov': Covariance,
               'stats_var': stats_variance})
    # eval 沙箱只给了空 builtins：枚举式复核要用 range/len 等白名单内置
    ns.update({'range': range, 'len': len, 'sum': sum, 'float': float, 'int': int,
               'abs': abs, 'min': min, 'max': max, 'sorted': sorted, 'set': set,
               'list': list, 'tuple': tuple, 'round': round, 'enumerate': enumerate})
    # 常用单符号（小写全字母安全；大写避开 sympy 既有名 E/I/N/O/S/D——S 是
    # SingletonRegistry 实踩；希腊字母给常用物理符号，λ 用 lam 拼写）
    greek = ['alpha', 'mu', 'nu', 'lam', 'sigma', 'epsilon', 'theta', 'omega', 'phi', 'tau']
    # 多字母作者符号（面积等；命名与 sympy 既有名错开：S/E/I/N/O/D 保留给 sympy）
    words = ['Area', 'E0', 'I0', 'N0']
    ns.update({n: sp.Symbol(n) for n in 'abcdefghijklmnopqrstuvwxyz'})
    ns.update({n: sp.Symbol(n) for n in 'ABFGHJKLMQRTUVWXYZ'})
    ns.update({n: sp.Symbol({'lam': 'lambda'}.get(n, n)) for n in greek})
    ns.update({n: sp.Symbol(n) for n in words})
    # 常用下标符号（v1/v2/m1/m2 等，碰撞解方程用）
    ns.update({n: sp.Symbol(n) for n in [
        'v1', 'v2', 'u1', 'u2', 'a1', 'a2', 'x1', 'x2', 'y1', 'y2',
        'm1', 'm2', 't1', 't2', 'p1', 'p2', 'n1', 'n2', 'r1', 'r2',
        'b1', 'b2', 'c1', 'c2', 'd1', 'd2', 'k1', 'k2', 'q1', 'q2']})
    return ns


def check_verify(items, path_label):
    """sympy 独立复核：verify.expr 用独立算法重算答案，与 answer_check/expected 对上。"""
    errs = []
    try:
        ns = _verify_namespace()
    except ImportError:
        return ['本机没有 sympy，--verify 跳过（装了再跑；数值复核是入库红线）']
    for it in items:
        qid = it.get('id', '?')
        where = '%s[%s]' % (path_label, qid)
        v = it.get('verify') or {}
        expr = v.get('expr')
        if not expr:
            continue   # 结构检查已要求 solve 必有；error_catch/concept 可选
        try:
            # ns 必须当 globals 传：生成器表达式/推导式会开新作用域，只看 globals
            # 不看 eval 的 locals——实踩（prob-024 的 sum(... for a in range(...))）
            val = eval(expr, {**ns, '__builtins__': {}}, ns)  # noqa: S307 —— 题库自带表达式，非外部输入
        except Exception as e:
            errs.append('%s：verify.expr 执行失败：%s: %s' % (where, type(e).__name__, e))
            continue
        mode = v.get('mode', 'assert')
        chk = it.get('answer_check') or {}
        if mode == 'value':
            nums = val if isinstance(val, (list, tuple)) else [val]
            # 只比主目标（value 或 mode=all 的 values）；alt_values 是百分比等展示
            # 变体，不该要求 verify 重算出两份
            if chk.get('mode') == 'all':
                tgts = [(float(x), float(chk.get('tol', 1e-6)))
                        for x in (chk.get('values') or [chk.get('value')])]
            else:
                tgts = [(float(chk['value']), float(chk.get('tol', 1e-6)))]
            if not tgts:
                errs.append('%s：verify.mode=value 但没有数值判分目标' % where)
                continue
            try:
                vals = [float(x) for x in nums]
            except (TypeError, ValueError):
                errs.append('%s：verify.expr 结果不是数值：%r' % (where, val))
                continue
            if len(vals) != len(tgts):
                errs.append('%s：verify 值 %d 个 ≠ 判分目标 %d 个' % (where, len(vals), len(tgts)))
                continue
            ok = all(any(abs(x - tv) <= tt for x in vals) for tv, tt in tgts) \
                and all(any(abs(x - tv) <= tt for tv, tt in tgts) for x in vals)
            if not ok:
                errs.append('%s：verify 重算 %s ≠ 判分目标 %s（以 verify 为准修题）'
                            % (where, vals, [(t, round(tt, 6)) for t, tt in tgts]))
        else:
            if val is not True:
                errs.append('%s：verify.expr 断言不为 True（结果：%s）' % (where, val))
    return errs


def report_distribution(items, final):
    total = len(items)
    by_dom = {}
    for it in items:
        d = by_dom.setdefault(it.get('domain'), {'total': 0, 'kind': {}, 'diff': {}})
        d['total'] += 1
        d['kind'][it.get('kind')] = d['kind'].get(it.get('kind'), 0) + 1
        d['diff'][it.get('difficulty')] = d['diff'].get(it.get('difficulty'), 0) + 1
    cov = sum(1 for it in items if it.get('kind') in ('error_catch', 'concept'))
    print('题量分布：共 %d 题；错误解法覆盖 %d（%.1f%%，红线 ≥33.3%%）' % (total, cov, 100.0 * cov / total if total else 0))
    for dom, d in sorted(by_dom.items()):
        print('  %-16s %3d 题  solve %d / error_catch %d / concept %d ｜ basic %d / medium %d / hard %d' % (
            DOMAIN_LABELS.get(dom, dom), d['total'],
            d['kind'].get('solve', 0), d['kind'].get('error_catch', 0), d['kind'].get('concept', 0),
            d['diff'].get('basic', 0), d['diff'].get('medium', 0), d['diff'].get('hard', 0)))
    errs = []
    if final:
        if total < 200:
            errs.append('终检：总数 %d < 200' % total)
        if total and cov * 3 < total:
            errs.append('终检：错误解法覆盖 %d/%d 不足 1/3' % (cov, total))
    return errs


def main():
    ap = argparse.ArgumentParser(description='题库红线检查器')
    ap.add_argument('--questions', default=str(ROOT / 'questions'))
    ap.add_argument('--two-way', action='store_true', help='好答案 pass／坏答案 fail 两向')
    ap.add_argument('--verify', action='store_true', help='sympy 独立复核 verify 字段')
    ap.add_argument('--final', action='store_true', help='终检：配比红线＋总数 ≥200')
    args = ap.parse_args()

    p = Path(args.questions)
    files = sorted(p.glob('*.jsonl')) if p.is_dir() else [p]
    all_errs = []
    total = 0
    for f in files:
        items = load_questions(f)
        total += len(items)
        label = f.name
        all_errs += check_structure(items, label)
        all_errs += check_traps(items, label)
        if args.two_way:
            all_errs += check_two_way(items, label)
        if args.verify:
            all_errs += check_verify(items, label)
    all_errs += report_distribution(load_questions(p), args.final)

    if all_errs:
        print('\n❌ %d 条红线违例：' % len(all_errs))
        for e in all_errs:
            print('  - %s' % e)
        sys.exit(1)
    print('✓ 红线检查通过（%d 题；%s%s%s）' % (
        total,
        '结构＋坑线', '＋两向' if args.two_way else '',
        '＋sympy复核' if args.verify else ''))


if __name__ == '__main__':
    main()
