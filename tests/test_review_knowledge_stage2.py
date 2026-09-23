"""Bounded Stage-2 E regressions; copied source, temporary stores, no models.

Run this file alone. Importing main normally mutates knowledge at import time,
so the subprocess imports a temporary source copy instead of the live tree.
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def evidence(tmp_path_factory):
    root = tmp_path_factory.mktemp("review-e")
    shutil.copytree(ROOT / "src", root / "src",
                    ignore=shutil.ignore_patterns("__pycache__", "static"))
    shutil.copy2(ROOT / "http_client.py", root / "http_client.py")
    shutil.copy2(ROOT / "llm_common.py", root / "llm_common.py")  # server.config 顶层 import 它，沙箱子进程只插 src 路径
    shutil.copy2(ROOT / "usage_stats.py", root / "usage_stats.py")  # main/knowledge 顶层 import 它，同上
    (root / "src" / "static").symlink_to(ROOT / "src" / "static", target_is_directory=True)
    shutil.copytree(ROOT / "harness", root / "harness",
                    ignore=shutil.ignore_patterns("__pycache__"))
    script = r'''
import asyncio, json, socket, sys
sys.path.insert(0, str(__import__('pathlib').Path.cwd() / 'src'))
def no_network(*a, **k):
    raise AssertionError('network is forbidden in E review')
socket.socket.connect = no_network
import main
from server import knowledge, storage, concept, continent
class Request:
    # 不能用 self.body 存数据——会遮蔽 body() 方法（_parse_json_object 现在调它）
    def __init__(self, body): self._body = body
    async def json(self): return self._body
    async def body(self): return json.dumps(self._body).encode('utf-8')
async def run():
    sid = 'sess_review_e'
    storage._write_json(main.SESSIONS_PATH, {sid: {'id': sid, 'title': 'E 复审'}})
    msgs = [{'role':'user','content':'胡克定律'},
            {'role':'assistant','timestamp':1,'content':'# 胡克定律\n<physics><formula>F=-kx</formula></physics><summary>弹簧回复力</summary>'}]
    result = await main.api_extract_knowledge(Request({'messages':msgs,'sessionId':sid}))
    item = dict(result['items'][0], id='k', sessionId=sid, createdAt=1)
    await main.api_save_knowledge(Request({'items':{'k':item}}))
    projected = await main.api_get_continent()
    formulas = await main.api_get_formulas()
    grounding = concept.concept_context_text('胡克定律', session_id=sid)
    baseline = (projected['itemCount'] == 1 and formulas['count'] == 1
                and '胡克定律' in grounding and item['anchorSummary'] == '弹簧回复力')
    manual = dict(item, summary='人工核实的摘要', summarySource='manual', formulas=['$F=-kx$', '$E=kx^2/2$'])
    await main.api_save_knowledge(Request({'items':{'k':manual}}))
    await main.api_save_knowledge(Request({'items':{'k':item}}))
    saved = storage._read_json(main.KNOWLEDGE_PATH, {})['k']
    after = await main.api_get_continent()
    await main.api_save_formulas(Request({'items':[{'id':'prose','latex':'能量守恒','sessionId':sid}]}))
    prose = storage._read_json(main.FORMULAS_PATH, {}).get('prose')
    print(json.dumps({'baseline':baseline, 'saved':saved,
        'projectedSummary':after['clusters'][0]['items'][0]['summary'],
        'prose':prose}, ensure_ascii=False))
asyncio.run(run())
'''
    run = subprocess.run([sys.executable, "-B", "-c", script], cwd=root,
                         text=True, capture_output=True, timeout=60)
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout.splitlines()[-1])


def test_local_extraction_store_projection_and_grounding(evidence):
    assert evidence["baseline"]


@pytest.mark.xfail(strict=True, raises=AssertionError, reason="E1: same-ID upload overwrites priority summary and formula union")
def test_stale_local_upload_preserves_manual_summary(evidence):
    assert (evidence["saved"]["summarySource"], len(evidence["saved"]["formulas"]),
            evidence["projectedSummary"]) == ("manual", 2, "人工核实的摘要"), evidence


def test_formula_ingest_rejects_prose(evidence):
    assert evidence["prose"] is None
