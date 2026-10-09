"""T211：服务端日志轮转配置的契约测试。

覆盖三件事：_server_log_config 的形状（console 保留、单例文件句柄挂 root/
uvicorn/uvicorn.access、uvicorn.error 靠 root 传播）、真跑一遍 dictConfig 验证
uvicorn.access 与应用日志都落盘、_resolve_log_file 的建目录与不可写降级两条路。
全局 logging 状态在测试内保存并恢复，不污染同进程其他用例。
"""

import logging
import logging.config
from pathlib import Path

import pytest

import main as main_mod  # noqa: E402  conftest 已把 src/ 加进 sys.path


@pytest.fixture
def restore_logging():
    """保存/恢复 root 与 uvicorn 三 logger 的 handlers/level/propagate。

    dictConfig 会整体替换 root 句柄，不恢复会让同进程后续用例的 console 句柄丢失。
    """
    names = ["", "uvicorn", "uvicorn.error", "uvicorn.access"]
    saved = {}
    for name in names:
        lg = logging.getLogger(name)
        saved[name] = (lg.handlers[:], lg.level, lg.propagate)
    yield
    for name in names:
        lg = logging.getLogger(name)
        for h in lg.handlers:
            if h not in saved[name][0]:
                h.close()
        lg.handlers = saved[name][0]
        lg.setLevel(saved[name][1])
        lg.propagate = saved[name][2]


def test_server_log_config_shape():
    cfg = main_mod._server_log_config(Path("/tmp/phymathia-t211/server-9999.log"))
    # uvicorn 默认配置的 console 句柄与 formatter 原样保留
    assert "default" in cfg["handlers"] and "access" in cfg["handlers"]
    assert cfg["disable_existing_loggers"] is False
    spec = cfg["handlers"][main_mod._LOG_FILE_HANDLER]
    assert spec["class"] == "logging.handlers.RotatingFileHandler"
    assert spec["maxBytes"] == main_mod._LOG_MAX_BYTES
    assert spec["backupCount"] == main_mod._LOG_BACKUP_COUNT
    assert spec["encoding"] == "utf-8"
    assert spec["filename"].endswith("server-9999.log")
    assert cfg["formatters"][main_mod._LOG_FORMATTER]["format"]
    # root 必须同时带 console 与文件句柄——dictConfig 的 root 段会替换掉 basicConfig
    # 装的 console 句柄，漏列 console 控制台会直接静默
    assert set(cfg["root"]["handlers"]) == {
        main_mod._LOG_CONSOLE_HANDLER, main_mod._LOG_FILE_HANDLER
    }
    # uvicorn 两个自带 handler 的 logger 都追加同一文件句柄（共享单例才不会有
    # 两个句柄各转各的轮转混乱）
    for name in ("uvicorn", "uvicorn.access"):
        assert main_mod._LOG_FILE_HANDLER in cfg["loggers"][name]["handlers"]
    # uvicorn.error 无 handler，靠 root 传播进文件
    assert not cfg["loggers"]["uvicorn.error"].get("handlers")


def test_dictconfig_access_and_app_logs_land_in_file(tmp_path, restore_logging):
    log_file = tmp_path / "server-9998.log"
    logging.config.dictConfig(main_mod._server_log_config(log_file))
    logging.getLogger("uvicorn.access").info('127.0.0.1:5000 - "GET /health HTTP/1.1" 200')
    logging.getLogger("src.main").info("t211 banner line")
    logging.getLogger("uvicorn.error").info("t211 startup line")
    content = log_file.read_text(encoding="utf-8")
    assert "GET /health" in content
    assert "t211 banner line" in content
    # uvicorn.error 无自身 handler，验证其记录确实经 root 传播落盘
    assert "t211 startup line" in content


def test_resolve_log_file_creates_dir(tmp_path, monkeypatch):
    # _ROOT_DIR 真实类型是 str（os.path.dirname 产物），monkeypatch 也用 str，
    # 曾传 Path 掩盖过 str / Path 拼接 TypeError
    monkeypatch.setattr(main_mod, "_ROOT_DIR", str(tmp_path))
    log_file = main_mod._resolve_log_file(5050)
    assert log_file == tmp_path / "logs" / "server-5050.log"
    assert log_file.exists()


def test_resolve_log_file_unwritable_returns_none(tmp_path, monkeypatch):
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("x", encoding="utf-8")
    monkeypatch.setattr(main_mod, "_ROOT_DIR", str(blocker))
    assert main_mod._resolve_log_file(5050) is None
