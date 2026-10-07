"""本地多账号（方案二 P1：服务端账号域）。

- 账号 = 一段 id 字符串（`^[A-Za-z0-9_-]{1,64}$`，与 session id 同白名单风格）。
  `"default"` 是缺省账号：老数据迁移的目标、不带 account_id 请求的落点。
- 每账号存储：`data/users/<account_id>/{sessions.json, messages/, knowledge.json,
  formulas.json, kv_store.json, kv/}`；`data/users/accounts.json` 是服务端注册表
  镜像（allow_browse 的裁决点，条目 {id, name, allowBrowse, createdAt}）。
- 账号级墓碑区：`data/users/_trash/<id>_<删除时间戳>/`（2026-10-07 删账号回收站化，
  删除的账号整体暂存于此，保留期内可恢复；机制与拍板在 trash.py）。
- 账号存在的唯一判据＝注册表有条目（`is_registered`）：目录可以是残留物，没登记
  的 id 一律当已删（请求咽喉 404，见 main.py _account_id）。**账号登记只走显式
  路由**（创建 / 墓碑恢复 / 保留天数设置）——ensure_account 对未登记的非 default
  账号不建目录不登记，防残留页面的自动保存把彻底删掉的账号复活（T186）。
- 不分账号保持共享：uploads/、embedding_cache.json、utopia_inbox/、usage/、
  harness_feedback.json、profiles/。
- 画像不迁移：`data/profiles/<id>.json` 的 id 键语义从 device_id 升级为
  account_id（前端 P2 决定传什么值；P1 过渡期前端继续传 device_id，行为不变）。
- 旧数据迁移：首次 ensure_account 时，data/ 根下若存在旧全局文件则整体搬进
  该账号目录（只 mv 不删；`data/users/legacy_migrated.flag` 防重跑，中断后
  幂等续搬——已搬走的源文件不存在即跳过）。

【为何账号解析不回退 device_id】（方案原文曾写回退，P1 实测后拍板不回退）：
现有前端只在部分请求带 device_id——quiz-stats 的 kv **写**带（quiz-stats.js
_saveQuizStats）而**读**不带、extract_knowledge 写知识库带而知识面板读不带。
若把 device_id 当账号键，P1 上线（前端未发 account_id 的过渡期）瞬间出现
「读 default 账号、写 device-uuid 账号」的数据分家。device_id 自始至终只是
画像归因键；存储账号键只认 account_id，缺省 default。别把这里"修"回去。
"""

import json
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from . import config  # 模块属性读取：测试 patch config.DATA_DIR 即整体重定向

logger = logging.getLogger(__name__)


def _read_json(path: Path, default=None):
    # 本层是存储栈最底层（storage 反向依赖本模块的 resolve_paths），不能
    # import storage，注册表读写自带最小实现
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError, OSError):
            pass
    return default if default is not None else {}


def _write_json(path: Path, data) -> None:
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)

DEFAULT_ACCOUNT = "default"
DEFAULT_ACCOUNT_NAME = "我的"

_ACCOUNT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# 迁移清单：data/ 根下这批旧全局文件/目录整体搬进首个账号；其余（uploads 等）共享不动
_LEGACY_FILES = ("sessions.json", "knowledge.json", "formulas.json", "kv_store.json")
_LEGACY_DIRS = ("messages", "kv")
_MIGRATION_FLAG = "legacy_migrated.flag"

_LOCK = threading.RLock()
# 已确保过的 (users_dir, account_id)：命中则跳过 mkdir/注册表读——热路径每次
# 请求都要过 ensure，不能每回都碰文件系统。键含 users_dir，测试改 DATA_DIR
# 自然换键，不会串账号。
_ENSURED: set = set()


@dataclass(frozen=True)
class AccountPaths:
    """一个账号的全部存储路径（纯值对象，不触发任何 IO）。"""

    account: str
    root: Path
    sessions_path: Path
    messages_dir: Path
    knowledge_path: Path
    formulas_path: Path
    kv_path: Path
    kv_dir: Path
    trash_dir: Path


def validate_account_id(value) -> str:
    """账号 id 白名单消毒：非法/空值一律回 DEFAULT（与 session id 同防线口径：
    id 直接拼文件路径，杜绝路径分隔符与 Windows 反斜杠穿越）。

    `_` 前缀是服务保留名（`_trash`＝账号墓碑区，见 trash.py）：id 拼路径，
    绝不能让「账号」落进保留区——正常账号 id 由服务端生成（12 位十六进制），
    永不带下划线开头，这里收紧零代价。
    """
    text = str(value or "").strip()
    if text == DEFAULT_ACCOUNT or (_ACCOUNT_ID_RE.match(text) and not text.startswith("_")):
        return text
    return DEFAULT_ACCOUNT


def users_dir() -> Path:
    """data/users（调用时读 config.DATA_DIR，不 import 期捕获——测试补丁生效）"""
    return Path(config.DATA_DIR) / "users"


def registry_path() -> Path:
    return users_dir() / "accounts.json"


def resolve_paths(account_id=DEFAULT_ACCOUNT) -> AccountPaths:
    """账号 id → 全部存储路径。纯计算：不建目录、不迁移、不写注册表。"""
    account = validate_account_id(account_id)
    root = users_dir() / account
    return AccountPaths(
        account=account,
        root=root,
        sessions_path=root / "sessions.json",
        messages_dir=root / "messages",
        knowledge_path=root / "knowledge.json",
        formulas_path=root / "formulas.json",
        kv_path=root / "kv_store.json",
        kv_dir=root / "kv",
        trash_dir=root / "trash",
    )


# ====== 注册表（服务端镜像；P2 前端 CRUD 通道写入，P1 仅 ensure 自动登记） ======
# 读取缓存：(路径, mtime_ns, size) → 条目表。每个非 default 请求的咽喉都要问
# 一句「这账号登记过吗」（main.py _account_id 的幽灵闸门），不能每回都读盘解析
# JSON；写入经 save_registry 同步刷新缓存，外部手改文件（测试/运维）靠
# mtime/size 变键自然失效——文件不存在时不缓存（失败态便宜且自愈）。
_REGISTRY_CACHE: dict = {"key": None, "entries": {}}


def _registry_key(path: Path):
    try:
        st = path.stat()
        return (str(path), st.st_mtime_ns, st.st_size)
    except OSError:
        return (str(path), None, None)


def load_registry() -> dict:
    path = registry_path()
    key = _registry_key(path)
    if key[1] is not None and _REGISTRY_CACHE["key"] == key:
        return _REGISTRY_CACHE["entries"]
    data = _read_json(path, {})
    accounts = data.get("accounts") if isinstance(data, dict) else None
    entries = {}
    if isinstance(accounts, list):
        entries = {str(e.get("id")): e for e in accounts if isinstance(e, dict) and e.get("id")}
    _REGISTRY_CACHE["key"] = key
    _REGISTRY_CACHE["entries"] = entries
    return entries


def save_registry(entries: dict) -> None:
    registry_path().parent.mkdir(parents=True, exist_ok=True)
    _write_json(registry_path(), {"accounts": list(entries.values())})
    _REGISTRY_CACHE["key"] = _registry_key(registry_path())
    _REGISTRY_CACHE["entries"] = entries


def get_account(account_id: str) -> dict:
    return load_registry().get(validate_account_id(account_id)) or {}


def is_registered(account_id) -> bool:
    """账号是否登记过（default 恒真——它是无 account_id 请求的落点）。

    「登记过」＝账号存在的唯一权威判据（数据目录可以有，但没登记的目录不算
    账号：UI 列表来自注册表，请求咽喉与 ensure 的幽灵闸门同口径）。"""
    account = validate_account_id(account_id)
    if account == DEFAULT_ACCOUNT:
        return True
    return account in load_registry()


def register_account(account_id: str, name: str = None) -> dict:
    """登记（幂等 upsert）：已存在时只补缺字段，不改已有名字/开关。"""
    account = validate_account_id(account_id)
    with _LOCK:
        entries = load_registry()
        entry = entries.get(account)
        if entry is None:
            entry = {
                "id": account,
                "name": str(name if name is not None else (DEFAULT_ACCOUNT_NAME if account == DEFAULT_ACCOUNT else account)),
                "allowBrowse": False,
                "createdAt": int(time.time() * 1000),
            }
            entries[account] = entry
            save_registry(entries)
        else:
            changed = False
            if name is not None and entry.get("name") != name:
                entry["name"] = str(name)
                changed = True
            for key in ("allowBrowse", "createdAt"):
                if key not in entry:
                    entry[key] = False if key == "allowBrowse" else int(time.time() * 1000)
                    changed = True
            if "devices" not in entry:  # 画像设备归属（account_devices），旧条目补空
                entry["devices"] = []
                changed = True
            if changed:
                save_registry(entries)
        return entry


def rename_account(account_id: str, name: str) -> dict:
    account = validate_account_id(account_id)
    with _LOCK:
        entries = load_registry()
        if account not in entries:
            raise KeyError(f"account not found: {account}")
        entries[account]["name"] = str(name or "").strip()[:40] or entries[account].get("name") or account
        save_registry(entries)
        return entries[account]


def set_allow_browse(account_id: str, allow: bool) -> dict:
    account = validate_account_id(account_id)
    with _LOCK:
        entries = load_registry()
        if account not in entries:
            raise KeyError(f"account not found: {account}")
        entries[account]["allowBrowse"] = bool(allow)
        save_registry(entries)
        return entries[account]


ACCOUNT_DEVICES_LIMIT = 8


def account_devices(account_id: str) -> list:
    """账号绑定的画像设备键（data/profiles/ 文件名 stem）列表。

    画像归因键是 device_id（P1 拍板不回退账号），画像文件天然按设备分家；
    这里存的是「这个账号用过哪些设备」的归属快照，供备份按账号圈定画像与
    删账号彻底清除消费。登记入口在 profile.note_device_binding（画像事件/
    注入/面板/备份路由都会路过，随正常使用自然长全）。
    """
    devices = get_account(account_id).get("devices")
    if not isinstance(devices, list):
        return []
    return [d for d in devices if isinstance(d, str) and d]


def add_account_devices(account_id: str, devices: list) -> bool:
    """把画像设备键并入账号条目（幂等，上限 8 个丢最旧——同账号多浏览器/换机
    的现实上限，防注册表被脏 device 灌爆）。未登记的账号不凭空建条目：绑定
    发生时账号必已 ensure（画像活动的前提是页面在跑）。返回是否发生写入。"""
    account = validate_account_id(account_id)
    clean = []
    for d in devices or []:
        if isinstance(d, str) and d and d not in clean:
            clean.append(d)
    if not clean:
        return False
    with _LOCK:
        entries = load_registry()
        entry = entries.get(account)
        if entry is None:
            return False
        existing = [d for d in (entry.get("devices") or []) if isinstance(d, str) and d]
        merged = existing + [d for d in clean if d not in existing]
        merged = merged[-ACCOUNT_DEVICES_LIMIT:]
        if merged != existing:
            entry["devices"] = merged
            save_registry(entries)
            return True
    return False


def can_browse(target_account_id: str) -> bool:
    """只读查阅裁决：目标账号登记过且 allowBrowse=True。

    P3 落地后的实际消费点在前端面板（GET /api/accounts 已带 allowBrowse，进门前
    再重查一遍防缓存过期）；服务端无身份概念、无法强执法——本地无认证，allow_browse
    是 UI 层礼节性隔离（诚实声明口径），服务端兜底闸门只认 X-Phymathia-Readonly 头
    （main.py _readonly_browse_gate），这里保留给测试与未来可能的强执法位。
    """
    entry = get_account(target_account_id)
    return bool(entry.get("allowBrowse"))


def remove_account(account_id: str) -> None:
    """注册表除名（幂等）。default 账号拒删——它是无 account_id 请求的兜底
    落点，删了数据就丢。只动注册表不动磁盘：数据目录的处置（移入账号墓碑区
    data/users/_trash/ 保留期内可恢复，或保留天数 0 时彻底清除）由调用方走
    trash.capture_account / trash.purge_account_data——删账号已回收站化
    （2026-10-07），硬删不再是本层的职责。"""
    account = validate_account_id(account_id)
    if account == DEFAULT_ACCOUNT:
        raise ValueError("default 账号不可删除")
    with _LOCK:
        entries = load_registry()
        entries.pop(account, None)
        save_registry(entries)


def restore_entry(entry: dict) -> dict:
    """按快照原样回写一条注册表条目（账号墓碑恢复用）：id/name/allowBrowse/
    createdAt/trashRetentionDays 全量还原，不做缺省补齐。"""
    if not isinstance(entry, dict) or not entry.get("id"):
        raise ValueError("restore_entry: entry.id required")
    account = str(entry["id"])
    if account != validate_account_id(account):
        raise ValueError(f"invalid account id in entry: {entry['id']!r}")
    with _LOCK:
        entries = load_registry()
        restored = dict(entry)
        restored["id"] = account
        entries[account] = restored
        save_registry(entries)
        return restored


def forget_ensured(account_id: str) -> None:
    """账号删除/墓碑化后清 _ENSURED 缓存：缓存命中但目录已被移走时，后续打到
    该账号的请求会走 ensure 重建空目录并重新登记（复活出一个同名空账号），
    墓碑恢复反而撞 409——删完立刻忘掉它。"""
    _ENSURED.discard((str(users_dir()), validate_account_id(account_id)))


def has_account_tombstone(account_id: str) -> bool:
    """该账号是否已有墓碑（data/users/_trash/<id>_<纯数字时间戳>/）。

    ensure_account 用它拦「已删账号的迟到请求」——典型是删除页面 reload 时
    beforeunload 的 sendBeacon 冲刷，信封还带着已删账号的 account_id；没有
    这道闸账号会在空目录上复活（真机实操抓出），墓碑恢复反而撞 409。
    目录名约定与 trash.capture_account 一致（后缀必须纯数字，防下划线账号
    前缀互撞）；id 拼路径安全由 validate_account_id 保证。
    """
    account = validate_account_id(account_id)
    if account == DEFAULT_ACCOUNT:
        return False
    area = users_dir() / "_trash"
    if not area.is_dir():
        return False
    prefix = account + "_"
    for p in area.iterdir():
        if p.is_dir() and p.name.startswith(prefix) and p.name[len(prefix):].isdigit():
            return True
    return False


# ====== 旧数据迁移（一次性，只 mv 不删） ======

def _migrate_legacy_into(paths: AccountPaths) -> int:
    """data/ 根的旧全局文件搬进首个账号目录；返回搬运文件数。

    flag 缺席才执行（防重跑）；执行完无论是否搬到东西都落 flag——「首个账号
    已初始化」本身就是迁移时机的终点，之后无论谁再建账号都不许再扫根目录
    （否则手动放进根目录的文件会被后来的新账号偷走）。逐文件 os.replace，
    中断后重跑对已搬文件自然跳过（源不存在）。
    """
    data_dir = Path(config.DATA_DIR)
    users = users_dir()
    flag = users / _MIGRATION_FLAG
    if flag.exists():
        return 0
    users.mkdir(parents=True, exist_ok=True)
    paths.root.mkdir(parents=True, exist_ok=True)
    moved = 0
    for name in _LEGACY_FILES:
        src = data_dir / name
        if src.is_file():
            os.replace(src, paths.root / name)
            moved += 1
    for name in _LEGACY_DIRS:
        src = data_dir / name
        if src.is_dir():
            dst = paths.root / name
            dst.mkdir(parents=True, exist_ok=True)
            for child in sorted(src.iterdir()):
                if child.is_file():
                    os.replace(child, dst / child.name)
                    moved += 1
            try:
                src.rmdir()  # 只删空壳目录；非空（异常残留）留着不动
            except OSError:
                pass
    flag.write_text(json.dumps({"migratedAt": int(time.time() * 1000),
                                "account": paths.account,
                                "files": moved}, ensure_ascii=False), encoding="utf-8")
    if moved:
        logger.info("legacy data migrated into account %s: %d file(s)", paths.account, moved)
    return moved


def ensure_account(account_id=DEFAULT_ACCOUNT, name: str = None) -> AccountPaths:
    """建目录（幂等）+ 首次触发的旧数据迁移 + 注册表登记，返回路径组。

    每个存储请求都会过这里：_ENSURED 命中即直接回路径，不碰文件系统。

    幽灵闸门（T186 2026-10-07）：非 default 账号「未登记且无墓碑」时不建目录、
    不登记——账号登记只走显式路由（创建 / 墓碑恢复 / 保留天数设置），残留页面
    （另一浏览器/标签还开着已删账号）的自动保存不能再把彻底删掉的账号拼回来
    （保留 0 天的即删与墓碑到期清理之后墓碑消失，此前 ensure 会 mkdir＋
    register 复活出一个昵称回落为 id 的空账号）。default 例外：它是无
    account_id 请求的落点，首启即自登记。请求侧还有一道更早的闸（main.py
    _account_id 对未登记账号 404），这里防的是绕过请求咽喉的直调。
    """
    account = validate_account_id(account_id)
    with _LOCK:
        paths = resolve_paths(account)
        key = (str(users_dir()), account)
        if key in _ENSURED and paths.root.is_dir():
            return paths
        if has_account_tombstone(account):
            # 已删账号的迟到请求：不建目录、不重新登记（见 has_account_tombstone
            # 注释）。读请求自然落空文件默认值；写请求因目录缺失失败——
            # sendBeacon 是 fire-and-forget，无感。
            return paths
        if account != DEFAULT_ACCOUNT and account not in load_registry():
            return paths
        # 迁移门槛是 flag 不是「目录不存在」：中断续搬（目录已建、文件没搬完、
        # flag 未落）时重跑必须继续搬；flag 在则这里是零开销 no-op
        _migrate_legacy_into(paths)
        paths.messages_dir.mkdir(parents=True, exist_ok=True)
        paths.kv_dir.mkdir(parents=True, exist_ok=True)
        register_account(account, name=name)
        _ENSURED.add(key)
        return paths


# ====== 回收站保留天数（2026-10-07，按账号存注册表；读写函数供 trash.py 调用） ======

TRASH_RETENTION_DEFAULT_DAYS = 7
TRASH_RETENTION_MAX_DAYS = 365


def get_trash_retention(account_id: str) -> int:
    """读保留天数：未登记/脏值一律回默认 7（0 合法＝关闭回收站）。"""
    entry = get_account(account_id)
    try:
        days = int(entry.get("trashRetentionDays", TRASH_RETENTION_DEFAULT_DAYS))
    except (TypeError, ValueError):
        return TRASH_RETENTION_DEFAULT_DAYS
    return days if 0 <= days <= TRASH_RETENTION_MAX_DAYS else TRASH_RETENTION_DEFAULT_DAYS


def set_trash_retention(account_id: str, days) -> dict:
    """写保留天数（0–365 整数；0＝删除即彻底清除）。非法值抛 ValueError，路由层转 400。"""
    account = validate_account_id(account_id)
    try:
        days_int = int(days)
    except (TypeError, ValueError):
        raise ValueError(f"retention days must be an integer, got {days!r}")
    if not 0 <= days_int <= TRASH_RETENTION_MAX_DAYS:
        raise ValueError(f"retention days out of range 0..{TRASH_RETENTION_MAX_DAYS}: {days_int}")
    with _LOCK:
        register_account(account)  # 幂等：未登记过（含 default 首启前）先登记
        entries = load_registry()
        entries[account]["trashRetentionDays"] = days_int
        save_registry(entries)
        return entries[account]


__all__ = [
    "DEFAULT_ACCOUNT", "DEFAULT_ACCOUNT_NAME", "AccountPaths",
    "validate_account_id", "users_dir", "registry_path", "resolve_paths",
    "ensure_account", "load_registry", "save_registry", "get_account", "is_registered",
    "register_account", "rename_account", "set_allow_browse", "can_browse",
    "remove_account", "restore_entry", "forget_ensured", "has_account_tombstone",
    "get_trash_retention", "set_trash_retention",
    "account_devices", "add_account_devices", "ACCOUNT_DEVICES_LIMIT",
    "TRASH_RETENTION_DEFAULT_DAYS", "TRASH_RETENTION_MAX_DAYS",
]
