"""Known positives for the v0.1 review findings 6 to 10: each reproduces a fail-open bypass.

Run from the repo root: python3 -B -m unittest discover -s tests/factory
"""
import base64
import datetime
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from test_factory import Project, lines


class FailOpen(Project):
    def on_main(self):
        """Adopted and committed on main, then work continues on a feature branch."""
        self.git("init", "-q", "-b", "main")
        self.git("add", "-A")
        self.git("commit", "-qm", "adopt")
        self.git("checkout", "-qb", "feature")

    def test_pre_push_guards_tags_remote_head_and_committed_default_branch(self):
        remote = Path(tempfile.mkdtemp()) / "remote.git"
        self.addCleanup(shutil.rmtree, remote.parent)
        self.git("init", "-q", "--bare", "-b", "trunk", str(remote))
        c1 = self.repo()
        push = lambda *a: self.run_("git", "push", "-q", str(remote), *a)
        self.assertEqual(push("--no-verify", "main:trunk")[0], 0)
        self.git("commit", "-q", "--allow-empty", "-m", "c2")
        self.cfg["default_branch"] = "elsewhere"
        self.save()
        rc, out = push("main")
        self.assertNotEqual(rc, 0, "an uncommitted default_branch must not unguard main")
        rc, out = push("main:trunk")
        self.assertNotEqual(rc, 0, "the remote's HEAD branch must be guarded")
        self.git("tag", "v1", c1)
        rc, out = push("v1")
        self.assertNotEqual(rc, 0, "a tag push must need evidence")
        self.assertEqual(push("main:feature")[0], 0, out)
        self.evidence(c1, ci=["a"])
        rc, out = push("v1")
        self.assertEqual(rc, 0, out)

    def test_ratchet_cannot_be_reset_on_a_branch(self):
        self.adopt({"lib/old.py": lines(1200)})
        self.on_main()
        self.write("lib/old.py", lines(1300))
        self.write("lib/big.py", lines(1500))
        os.remove(self.d / ".factory/size-baseline.json")
        self.assertEqual(self.size("baseline", "--init")[0], 0)
        rc, out = self.size()
        self.assertEqual(rc, 1, out)
        self.assertIn("lib/old.py: baseline cap raised 1200 -> 1300", out)
        self.assertIn("lib/big.py: new in the baseline", out)

    def test_ledger_cannot_be_reset_on_a_branch(self):
        self.adopt({})
        self.on_main()
        self.write("src/app.py", lines(115))
        self.assertEqual(self.size("record", "v2")[0], 0)
        rc, out = self.size()
        self.assertEqual(rc, 1, out)
        self.assertIn("unit src: bytes", out)

    def test_ledger_config_and_files_must_agree(self):
        self.adopt({})
        self.cfg["size"]["units"]["more"] = ["src/*"]
        self.save()
        rc, out = self.size()
        self.assertEqual(rc, 1, out)
        self.assertIn("unit more: not in the ledger", out)
        del self.cfg["size"]["units"]["more"], self.cfg["size"]["units"]["lib"]
        self.save()
        rc, out = self.size()
        self.assertEqual(rc, 1, out)
        self.assertIn("unit lib: in the ledger but not in size.units", out)
        self.assertIn("lib/__init__.py: in no size.units unit", out)

    def test_every_text_file_is_measured(self):
        self.adopt({})
        self.write("conf/huge.yaml", lines(1001, "k: v"))
        rc, out = self.size()
        self.assertEqual(rc, 1, out)
        self.assertIn("conf/huge.yaml: 1001 lines", out)
        self.assertIn("conf/huge.yaml: in no size.units unit", out)

    def test_exemption_dates_are_parsed_and_capped(self):
        self.adopt({})
        self.write("src/app.py", lines(115))
        far = (datetime.date.today() + datetime.timedelta(days=121)).isoformat()
        for until in ("9999-xx", "tomorrow", far):
            self.cfg["size"]["exemptions"].append({"unit": "src", "until": until})
            self.save()
            rc, out = self.size()
            self.assertEqual(rc, 1, f"until {until!r} must be red: {out}")
            self.assertNotIn("exempt unit src", out)
            self.cfg["size"]["exemptions"].pop()

    def test_urlsafe_and_wrapped_base64_fail(self):
        self.adopt({})
        blob = base64.urlsafe_b64encode(b"\xfb\xff" * 300).decode()
        self.write("lib/url.py", f'DATA = "{blob}"\n')
        wrapped = base64.encodebytes(os.urandom(1200)).decode()
        self.write("lib/pem.txt", wrapped)
        rc, out = self.size()
        self.assertEqual(rc, 1, out)
        self.assertIn("lib/url.py:1: embedded base64-like blob", out)
        self.assertIn("lib/pem.txt:1: 20+ lines of base64", out)


if __name__ == "__main__":
    unittest.main()
