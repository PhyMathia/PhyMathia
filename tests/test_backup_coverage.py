"""备份覆盖补齐回归（586，2026-11-25）。

「导出全部数据」此前只含会话/消息/知识/公式/KV/画像，缺用户技能、模型槽位、
回收站、用量账本与素材篮附件。本文件钉住三件事：

- 导出确实带上五类内容，且模型配置里的 apiKey 绝不进备份；
- 恢复按「补集只增不删」：素材/用量/回收站不删本机现有内容，技能与模型槽位
  随 replace 整包替换；
- 手编备份里的相对路径不能穿越到账号目录之外。
"""

import base64
import json
import unittest
from pathlib import Path

from route_test_base import RouteTestBase

from server import backup as backup_mod
from server import config as config_mod


def _read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


class BackupCoverageTest(RouteTestBase):
    def setUp(self):
        super().setUp()
        self.data = Path(self._td.name)
        self.root = self.data / "users" / "default"
        self.upload_dir = self.data / "uploads"
        self.upload_dir.mkdir(parents=True, exist_ok=True)

    def _write_text(self, path, text):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def _seed_everything(self):
        self._write_text(self.root / "skills" / "my-skill.md", "---\nname: my-skill\n---\n正文")
        self._write_text(self.root / "skills" / "dir-skill" / "phymathia.md", "# 目录型")
        self._write_text(self.root / "skills_state.json",
                         json.dumps({"router": False, "disabled": ["a"], "scope": {"a": ["viz"]}}))
        self._write_text(self.root / "models.json", json.dumps({
            "userModels": [{"id": "m1", "provider": "p", "model": "x", "apiKey": "SECRET"}],
            "modelGroupKeys": {},
            "activeModels": {"chat": "m1"},
            "disabledProviders": {},
            "updatedAt": 10,
        }))
        self._write_text(self.root / "trash" / "sess_x" / "meta.json", json.dumps({"id": "sess_x"}))
        self._write_text(self.data / "uploads.json", json.dumps({
            "doc_aaaaaaaaaaaa": {"id": "doc_aaaaaaaaaaaa", "filename": "笔记.txt", "savedAt": 5},
        }))
        (self.upload_dir / "doc_aaaaaaaaaaaa.bin").write_bytes(b"hello")
        self._write_text(self.upload_dir / "doc_aaaaaaaaaaaa.txt", "完整全文")
        usage_dir = Path(config_mod.DATA_DIR) / 'usage'
        usage_dir.mkdir(parents=True, exist_ok=True)
        self._write_text(usage_dir / "2026-01-01.jsonl",
                         json.dumps({"ts": "2026-01-01T10:00:00", "kind": "chat",
                                     "provider": "p", "model": "x", "prompt_tokens": 1,
                                     "completion_tokens": 2}) + "\n")

    # ---------- 导出 ----------

    def test_export_includes_new_sections(self):
        self._seed_everything()
        payload = backup_mod._build_backup_payload()
        self.assertIn("my-skill.md", payload["skills"])
        self.assertIn("dir-skill/phymathia.md", payload["skills"])
        self.assertFalse(payload["skillsState"]["router"])
        self.assertEqual(payload["trash"]["sess_x/meta.json"], '{"id": "sess_x"}')
        self.assertEqual(payload["uploads"]["meta"]["doc_aaaaaaaaaaaa"]["filename"], "笔记.txt")
        self.assertEqual(base64.b64decode(payload["uploads"]["files"]["doc_aaaaaaaaaaaa"]), b"hello")
        self.assertEqual(payload["uploads"]["fulltext"]["doc_aaaaaaaaaaaa"], "完整全文")
        self.assertEqual(payload["usage"][0]["kind"], "chat")
        self.assertEqual(payload["models"]["activeModels"], {"chat": "m1"})

    def test_export_never_carries_api_keys(self):
        self._seed_everything()
        payload = backup_mod._build_backup_payload()
        self.assertNotIn("apiKey", payload["models"]["userModels"][0])
        self.assertNotIn("SECRET", json.dumps(payload["models"], ensure_ascii=False))

    def test_export_without_files_keeps_metadata_counts(self):
        self._seed_everything()
        payload = backup_mod._build_backup_payload(include_files=False)
        self.assertEqual(payload["uploads"]["files"], {})
        self.assertIn("doc_aaaaaaaaaaaa", payload["uploads"]["meta"])
        self.assertEqual(payload["uploads"]["bytes"], 5)

    def test_upload_cap_skips_and_reports(self):
        self._write_text(self.data / "uploads.json", json.dumps({
            "doc_aaaaaaaaaaaa": {"id": "doc_aaaaaaaaaaaa", "filename": "a.bin", "savedAt": 2},
            "doc_bbbbbbbbbbbb": {"id": "doc_bbbbbbbbbbbb", "filename": "b.bin", "savedAt": 1},
        }))
        (self.upload_dir / "doc_aaaaaaaaaaaa.bin").write_bytes(b"0123456789")
        (self.upload_dir / "doc_bbbbbbbbbbbb.bin").write_bytes(b"0123456789")
        original = backup_mod._UPLOAD_BACKUP_MAX_TOTAL
        backup_mod._UPLOAD_BACKUP_MAX_TOTAL = 12
        try:
            payload = backup_mod._build_backup_payload()
        finally:
            backup_mod._UPLOAD_BACKUP_MAX_TOTAL = original
        # 新→旧收录：第一份进、第二份超限被跳过（元数据也不留，避免断卡）
        self.assertIn("doc_aaaaaaaaaaaa", payload["uploads"]["files"])
        self.assertNotIn("doc_bbbbbbbbbbbb", payload["uploads"]["files"])
        self.assertNotIn("doc_bbbbbbbbbbbb", payload["uploads"]["meta"])
        self.assertEqual(payload["uploads"]["skipped"], 1)

    # ---------- 恢复 ----------

    def _backup(self):
        return {
            "skills": {"from-backup.md": "# 备份技能"},
            "skillsState": {"router": False, "disabled": ["b"], "scope": {"b": ["quiz"]}},
            "models": {"userModels": [{"id": "m2", "provider": "p", "model": "y"}],
                       "activeModels": {"chat": "m2"}, "updatedAt": 20},
            "trash": {"sess_y/meta.json": '{"id": "sess_y"}'},
            "usage": [{"ts": "2026-01-02T10:00:00", "kind": "chat", "provider": "p",
                       "model": "x", "prompt_tokens": 3, "completion_tokens": 4}],
            "uploads": {
                "meta": {"doc_cccccccccccc": {"id": "doc_cccccccccccc",
                                              "filename": "恢复.txt", "savedAt": 7}},
                "files": {"doc_cccccccccccc": base64.b64encode(b"restored").decode("ascii")},
                "fulltext": {},
            },
        }

    def test_restore_writes_new_sections(self):
        result = backup_mod._restore_backup(self._backup(), replace=False)
        self.assertTrue(result["ok"])
        self.assertEqual((self.root / "skills" / "from-backup.md").read_text(encoding="utf-8"),
                         "# 备份技能")
        state = _read(self.root / "skills_state.json")
        self.assertFalse(state["router"])
        self.assertEqual(state["disabled"], ["b"])
        models = _read(self.root / "models.json")
        self.assertEqual(models["activeModels"], {"chat": "m2"})
        self.assertIn("sess_y/meta.json", [p.relative_to(self.root / "trash").as_posix()
                                           for p in (self.root / "trash").rglob("*.json")])
        upload_meta = _read(self.data / "uploads.json")
        self.assertEqual(upload_meta["doc_cccccccccccc"]["filename"], "恢复.txt")
        self.assertEqual((self.upload_dir / "doc_cccccccccccc.bin").read_bytes(), b"restored")
        usage_lines = (Path(config_mod.DATA_DIR) / 'usage' / "2026-01-02.jsonl").read_text(
            encoding="utf-8").strip().splitlines()
        self.assertEqual(len(usage_lines), 1)

    def test_restore_is_idempotent_for_additive_sections(self):
        backup_mod._restore_backup(self._backup(), replace=False)
        backup_mod._restore_backup(self._backup(), replace=False)
        usage_dir = Path(config_mod.DATA_DIR) / 'usage'
        lines = []
        for path in usage_dir.glob("*.jsonl"):
            lines.extend(line for line in path.read_text(encoding="utf-8").splitlines() if line.strip())
        self.assertEqual(len(lines), 1)
        self.assertEqual(len(_read(self.data / "uploads.json")), 1)

    def test_replace_replaces_skills_and_models(self):
        self._write_text(self.root / "skills" / "old.md", "# 本机旧技能")
        self._write_text(self.root / "models.json",
                         json.dumps({"userModels": [], "activeModels": {"chat": "newer"},
                                     "updatedAt": 100}))
        backup_mod._restore_backup(self._backup(), replace=True)
        self.assertFalse((self.root / "skills" / "old.md").exists())
        self.assertTrue((self.root / "skills" / "from-backup.md").exists())
        self.assertEqual(_read(self.root / "models.json")["activeModels"], {"chat": "m2"})

    def test_merge_keeps_newer_models_and_existing_skills(self):
        self._write_text(self.root / "skills" / "from-backup.md", "# 本机版本")
        self._write_text(self.root / "models.json",
                         json.dumps({"userModels": [], "activeModels": {"chat": "newer"},
                                     "updatedAt": 100}))
        backup_mod._restore_backup(self._backup(), replace=False)
        self.assertEqual((self.root / "skills" / "from-backup.md").read_text(encoding="utf-8"),
                         "# 本机版本")
        self.assertEqual(_read(self.root / "models.json")["activeModels"], {"chat": "newer"})

    def test_replace_never_deletes_uploads_usage_or_trash(self):
        self._write_text(self.root / "trash" / "sess_keep" / "meta.json", '{"id": "sess_keep"}')
        self._write_text(self.data / "uploads.json",
                         json.dumps({"doc_dddddddddddd": {"id": "doc_dddddddddddd",
                                                          "filename": "keep", "savedAt": 1}}))
        (self.upload_dir / "doc_dddddddddddd.bin").write_bytes(b"keep")
        usage_dir = Path(config_mod.DATA_DIR) / 'usage'
        usage_dir.mkdir(parents=True, exist_ok=True)
        self._write_text(usage_dir / "2025-12-31.jsonl", '{"ts": "2025-12-31T00:00:00"}\n')
        backup_mod._restore_backup(self._backup(), replace=True)
        self.assertTrue((self.root / "trash" / "sess_keep" / "meta.json").exists())
        self.assertTrue((self.upload_dir / "doc_dddddddddddd.bin").exists())
        self.assertIn("doc_dddddddddddd", _read(self.data / "uploads.json"))
        self.assertTrue((usage_dir / "2025-12-31.jsonl").exists())

    def test_path_traversal_is_rejected(self):
        evil = self.data / "evil.md"
        backup = {
            "skills": {"../evil.md": "x", "a/../../evil.md": "x", "/abs.md": "x", "ok.md": "ok"},
            "trash": {"../evil.json": "{}", "sess_z/../../evil.json": "{}"},
            "uploads": {"files": {"../../evil": base64.b64encode(b"x").decode("ascii")}},
        }
        backup_mod._restore_backup(backup, replace=False)
        self.assertFalse(evil.exists())
        self.assertTrue((self.root / "skills" / "ok.md").exists())

    def test_preview_counts_include_new_sections(self):
        self._seed_everything()
        preview = backup_mod._preview_backup(backup_mod._build_backup_payload(), False)
        self.assertEqual(preview["incoming"]["skills"], 2)
        self.assertEqual(preview["incoming"]["uploads"], 1)
        self.assertEqual(preview["incoming"]["usage"], 1)
        self.assertEqual(preview["incoming"]["trash"], 1)
        self.assertEqual(preview["incoming"]["models"], 1)
        self.assertEqual(preview["current"]["skills"], 2)

    def test_restore_targets_cover_skills_models_and_trash(self):
        self._seed_everything()
        targets = {str(path) for path in backup_mod._restore_target_paths()}
        self.assertIn(str(self.root / "models.json"), targets)
        self.assertIn(str(self.root / "skills_state.json"), targets)
        self.assertIn(str(self.root / "skills" / "my-skill.md"), targets)
        self.assertIn(str(self.root / "trash" / "sess_x" / "meta.json"), targets)


if __name__ == "__main__":
    unittest.main()
