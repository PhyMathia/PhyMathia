#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PhyMathia 物理数学评测集运行器（v0）。

用法：
  python3 evals/run_eval.py --selftest                 # 评分器自检（不联网）
  python3 evals/run_eval.py --adapter mock             # 离线演示（假学生，不联网）
  python3 evals/run_eval.py --adapter mock --only calculus,mechanics
报告落 evals/reports/run-<时间戳>.{md,json}。口径与限制见 docs/dev/eval-harness.md。
"""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from graders import grade_item  # noqa: E402

DOMAIN_LABELS = {
    'calculus': '高等数学',
    'linear_algebra': '线性代数',
    'probability': '概率统计',
    'mechanics': '经典力学',
    'electromagnetism': '电磁学',
}


class MockAdapter:
    """离线假学生：按题库字段拼「好/坏」两种作答，验证管道与报告，不代表任何模型水平。

    序号 i % 3 == 0 的题故意答错（复述典型错误、跳过关键步骤），其余答对。
    """
    name = 'mock'

    def run(self, item, index):
        if index % 3 == 0:
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
    """真机适配器（待接入）：计划走工作流首问通道。见 docs/dev/eval-harness.md「接入真机」。"""
    name = 'server'

    def __init__(self, base_url='http://localhost:5050'):
        self.base_url = base_url

    def run(self, item, index):
        raise NotImplementedError(
            'server 适配器待接入：工作流首问通道＋AGENTS.md 硬规则 6 发送链口径，'
            '见 docs/dev/eval-harness.md「接入真机」节')


def load_questions(path, only=None):
    items = []
    with open(path, encoding='utf-8') as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            try:
                items.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise SystemExit('%s:%d 不是合法 JSON：%s' % (path, ln, e))
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
    return {'total': total, 'passed': passed, 'by_domain': by_domain,
            'dimensions': dims, 'known_wrong_echoed': echoed}


def render_md(stamp, adapter_name, summary, results):
    L = ['# PhyMathia 评测报告 %s' % stamp, '']
    L.append('- 适配器：%s（mock=离线假学生，每 3 题故意答错 1 题，数字不代表模型水平）' % adapter_name)
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
    L.append('## 逐题')
    L.append('')
    L.append('| id | 域 | kind | 判定 | final_answer | key_steps | 破绽/概念 | 复述典型错误 |')
    L.append('|---|---|---|---|---|---|---|---|')
    for r in results:
        d = r['dimensions']
        if r['kind'] == 'error_catch':
            catch = d['error_catch']
        elif r['kind'] == 'concept':
            catch = d['concept']
        else:
            catch = '—'
        echo = '、'.join(d['known_wrong_echo']) if d.get('known_wrong_echo') else '—'
        L.append('| %s | %s | %s | %s | %s | %s(%s) | %s | %s |' % (
            r['id'], r['domain'], r['kind'], r['verdict'],
            d['final_answer'], d['key_steps'], d['steps_hit'], catch, echo))
    L.append('')
    return '\n'.join(L)


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

    print('selftest ✓ %d 项检查通过' % n)
    return 0


def main():
    ap = argparse.ArgumentParser(description='PhyMathia 物理数学评测运行器 v0')
    ap.add_argument('--adapter', choices=['mock', 'server'], default='mock',
                    help='mock=离线假学生（验证管道）；server=真机（待接入）')
    ap.add_argument('--base-url', default='http://localhost:5050')
    ap.add_argument('--questions', default=str(ROOT / 'questions' / 'core-v0.jsonl'))
    ap.add_argument('--only', default=None, help='逗号分隔的 domain 或题目 id 过滤')
    ap.add_argument('--out-dir', default=str(ROOT / 'reports'))
    ap.add_argument('--selftest', action='store_true', help='只跑评分器自检')
    args = ap.parse_args()

    if args.selftest:
        sys.exit(selftest())

    items = load_questions(args.questions, args.only)
    if not items:
        raise SystemExit('没有加载到任何题目：%s' % args.questions)

    adapter = MockAdapter() if args.adapter == 'mock' else ServerAdapter(args.base_url)
    results = []
    for i, item in enumerate(items):
        try:
            resp = adapter.run(item, i)
        except NotImplementedError as e:
            raise SystemExit('[%s] %s' % (item.get('id'), e))
        g = grade_item(item, resp)
        g['response_head'] = resp[:160].replace('\n', ' ')
        results.append(g)

    stamp = time.strftime('%Y%m%d-%H%M%S')
    summary = summarize(results)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / ('run-%s.json' % stamp)
    md_path = out_dir / ('run-%s.md' % stamp)
    json_path.write_text(json.dumps(
        {'meta': {'time': stamp, 'adapter': adapter.name,
                  'questions_file': args.questions, 'total': len(items)},
         'summary': summary, 'results': results},
        ensure_ascii=False, indent=1), encoding='utf-8')
    md_path.write_text(render_md(stamp, adapter.name, summary, results), encoding='utf-8')

    print('适配器 %s ｜ 题目 %d ｜ 通过 %d' % (adapter.name, summary['total'], summary['passed']))
    for d, s in summary['by_domain'].items():
        print('  %s %d/%d' % (DOMAIN_LABELS.get(d, d), s['pass'], s['total']))
    print('报告：%s' % md_path)
    print('      %s' % json_path)
    if adapter.name == 'mock':
        print('注意：mock 是离线假学生（每 3 题故意答错 1 题），数字不代表模型水平。')


if __name__ == '__main__':
    main()
