"""版本号四处同号守卫（2026-11-25）。

版本号有四个落点，手工改容易漏：
- ``src/static/js/config.js`` 的 ``APP_VERSION``（前端真相源）
- ``package.json`` / ``package-lock.json``（npm 版本）
- ``src/server/llm_common.py`` 的 ``PHYMATHIA_USER_AGENT``（opencode.ai 出网 UA）

改版本只走 ``node scripts/bump_version.mjs <x.y.z>``（或 ``npm run version:bump -- <x.y.z>``）；
本测试防止有人只改一处导致前端、产物、UA 各自报不同版本。
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _text(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def _config_version() -> str:
    match = re.search(r"const APP_VERSION = '([^']+)';", _text("src/static/js/config.js"))
    assert match, "config.js 缺少 `const APP_VERSION = 'x.y.z';`"
    return match.group(1)


def test_version_sources_in_sync():
    version = _config_version()
    assert re.fullmatch(r"\d+\.\d+\.\d+", version), f"版本号不是 x.y.z：{version}"

    package = json.loads(_text("package.json"))
    lock = json.loads(_text("package-lock.json"))
    user_agent = re.search(
        r'PHYMATHIA_USER_AGENT = "PhyMathia/([^"]+)"',
        _text("src/server/llm_common.py"),
    )
    assert user_agent, "llm_common.py 缺少 PHYMATHIA_USER_AGENT"

    assert package["version"] == version
    assert lock["version"] == version
    assert lock["packages"][""]["version"] == version
    assert user_agent.group(1) == version
