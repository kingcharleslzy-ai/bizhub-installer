from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("ci_artifacts", Path(__file__).parents[1] / "scripts/ci_artifacts.py")
records = importlib.util.module_from_spec(spec)
spec.loader.exec_module(records)


class LocalCandidateTests(unittest.TestCase):
    def test_exact_source_and_bytes_are_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = root / "Setup.exe"
            candidate.write_bytes(b"candidate")
            manifest = {"schema_version": "bizhub.ci-record.v1", "repository": "owner/repo",
                        "commit": "a" * 40, "run_id": "123", "attempt": "2", "name": "signed-windows",
                        "files": [{"name": "Setup.exe", "bytes": 9, "sha256": records.digest(candidate)}]}
            (root / "ci-record.json").write_text(json.dumps(manifest))
            args = argparse.Namespace(repository="owner/repo", commit="a" * 40, run_id="123",
                                      attempt="2", name="signed-windows", digest=records.digest(root / "ci-record.json"))
            records.verify(root, args)
            args.run_id = "124"
            with self.assertRaisesRegex(ValueError, "identity_mismatch:run_id"):
                records.verify(root, args)
            args.run_id = "123"
            candidate.write_bytes(b"tampered!")
            with self.assertRaisesRegex(ValueError, "file_digest_mismatch"):
                records.verify(root, args)
            candidate.write_bytes(b"candidate")
            (root / "unexpected.exe").write_bytes(b"extra")
            with self.assertRaisesRegex(ValueError, "file_set_mismatch"):
                records.verify(root, args)

    def test_record_identity_cannot_escape_sha_directory(self):
        with self.assertRaisesRegex(ValueError, "name_invalid"):
            records.record_path(Path("records"), "a" * 40, "123", "1", "../../other")
        with self.assertRaisesRegex(ValueError, "commit_invalid"):
            records.record_path(Path("records"), "main", "123", "1", "signed-macos")

    def test_manifest_digest_is_required_even_when_files_match(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "ci-record.json").write_text("{}")
            with self.assertRaisesRegex(ValueError, "manifest_digest_mismatch"):
                records.verify(root, argparse.Namespace(digest=hashlib.sha256(b"different").hexdigest()))

    def test_forced_command_only_accepts_exact_windows_candidates(self):
        request = f"read {'a' * 40} 123 2 signed-windows {'b' * 64}"
        self.assertEqual(records.windows_read_request(request).run_id, "123")
        for invalid in ("", "whoami", "sftp", "scp -t D:/", request + " & whoami",
                        request.replace("signed-windows", "../ai-trader"),
                        request.replace("signed-windows", "synthetic-windows"),
                        request.replace("a" * 40, "D:/ci-candidates/ai-trader"),
                        request.replace("read ", "write ")):
            with self.subTest(command=invalid), self.assertRaisesRegex(ValueError, "read_request_invalid"):
                records.windows_read_request(invalid)


if __name__ == "__main__":
    unittest.main()
