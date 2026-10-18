"""Known-positive tests for the factory kit: each gate must go red on a seeded fault.

Run from the repo root: python3 -B -m unittest discover -s tests/factory
Each test builds a throwaway project in a temp dir from this repo's scripts and factory.json.
"""
import base64
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

KIT = Path(__file__).resolve().parents[2]
ENV = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
           GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com", GIT_CONFIG_GLOBAL="/dev/null")


def lines(n, prefix="x = 1"):
    return "".join(f"{prefix}  # {i}\n" for i in range(n))


class Project(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        shutil.copytree(KIT / "scripts", self.d / "scripts")
        shutil.copytree(KIT / ".githooks", self.d / ".githooks")
        self.cfg = json.loads((KIT / "factory.json").read_text())
        self.cfg["size"]["units"] = {"src": ["src/*"], "lib": ["lib/*"], "kit": ["scripts/*", ".githooks/*", "factory.json"]}
        soon = (datetime.date.today() + datetime.timedelta(days=30)).isoformat()
        self.cfg["size"]["exemptions"] = [{"unit": "lib", "until": soon, "reason": "test scratch files"}]
        self.save()

    def tearDown(self):
        shutil.rmtree(self.d)

    def save(self):
        (self.d / "factory.json").write_text(json.dumps(self.cfg))

    def write(self, path, text):
        p = self.d / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def run_(self, *cmd):
        r = subprocess.run(cmd, cwd=self.d, capture_output=True, text=True, env=ENV, timeout=60)
        return r.returncode, r.stdout + r.stderr

    def size(self, *args):
        return self.run_(sys.executable, "scripts/check-size", *args)

    def git(self, *args):
        return self.run_("git", *args)[1].strip()

    def repo(self, tier=("a",)):
        self.cfg["land_tier"] = "fast"
        self.cfg["tiers"] = {"fast": list(tier)}
        self.cfg["checks"] = {n: {"cmd": "true"} for n in tier}
        self.save()
        self.write("src/app.py", lines(10))
        self.git("init", "-q", "-b", "main")
        self.git("config", "core.hooksPath", ".githooks")
        self.git("add", "-A")
        self.git("commit", "-qm", "c1")
        return self.git("rev-parse", "HEAD")

    def evidence(self, sha, base=None, ci=None, dirty=False):
        tree = self.git("rev-parse", f"{sha}^{{tree}}")
        d = self.d / ".git/factory/evidence"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{sha}.json").write_text(json.dumps({
            "sha": sha, "tree": tree, "base": base or sha,
            "checks": [{"name": "a", "status": "pass"}], "review": {"verdict": "LAND"}}))
        if ci is not None:
            (d / f"{sha}.ci-fast.json").write_text(json.dumps({
                "sha": sha, "tree": tree, "tier": "fast", "dirty": dirty,
                "checks": [{"name": n, "status": "pass", "seconds": 0} for n in ci]}))

    def adopt(self, files):
        """A project as it adopts the kit: files written, ledger recorded, baseline taken."""
        self.write("src/app.py", lines(100))
        self.write("lib/__init__.py", "")
        for path, text in files.items():
            self.write(path, text)
        self.assertEqual(self.size("record", "v1")[0], 0)
        self.assertEqual(self.size("baseline", "--init")[0], 0)


class CheckSize(Project):
    def test_clean_tree_passes(self):
        self.adopt({"lib/ok.py": lines(50)})
        rc, out = self.size()
        self.assertEqual(rc, 0, out)
        self.assertIn("size: ok", out)

    def test_new_file_over_hard_limit_fails(self):
        self.adopt({})
        self.write("lib/big.py", lines(1001))
        rc, out = self.size()
        self.assertEqual(rc, 1)
        self.assertIn("lib/big.py: 1001 lines, over the 1000-line hard limit", out)

    def test_over_aim_only_warns(self):
        self.adopt({})
        self.write("lib/mid.py", lines(500))
        rc, out = self.size()
        self.assertEqual(rc, 0, out)
        self.assertIn("warn lib/mid.py: 500 lines", out)

    def test_ratchet_over_limit_file_may_only_shrink(self):
        self.adopt({"lib/old.py": lines(1200)})
        self.assertEqual(self.size()[0], 0)
        self.write("lib/old.py", lines(1201))
        rc, out = self.size()
        self.assertEqual(rc, 1)
        self.assertIn("may only shrink", out)
        self.write("lib/old.py", lines(1100))
        self.assertEqual(self.size()[0], 0)
        self.assertEqual(self.size("baseline")[0], 0)
        self.write("lib/old.py", lines(1150))
        self.assertEqual(self.size()[0], 1, "the baseline must have tightened to 1100")

    def test_baseline_cannot_admit_new_over_limit_files(self):
        self.adopt({})
        self.write("lib/big.py", lines(1500))
        self.assertEqual(self.size("baseline")[0], 0)
        self.assertEqual(self.size()[0], 1)

    def test_unit_growth_over_ten_percent_fails(self):
        self.adopt({})
        self.write("src/app.py", lines(115))
        rc, out = self.size()
        self.assertEqual(rc, 1)
        self.assertIn("unit src: bytes", out)
        self.assertIn("needs an exemption", out)

    def test_growth_exemption_with_expiry(self):
        self.adopt({})
        self.write("src/app.py", lines(115))
        tomorrow = (datetime.date.today() + datetime.timedelta(days=1)).isoformat()
        self.cfg["size"]["exemptions"].append({"unit": "src", "until": tomorrow, "reason": "test"})
        self.save()
        rc, out = self.size()
        self.assertEqual(rc, 0, out)
        self.assertIn("exempt unit src", out)
        self.cfg["size"]["exemptions"][-1]["until"] = "2000-01-01"
        self.save()
        rc, out = self.size()
        self.assertEqual(rc, 1)
        self.assertIn("exemption expired", out)

    def test_base64_blob_fails(self):
        self.adopt({})
        blob = base64.b64encode(os.urandom(600)).decode()
        self.write("lib/blob.py", f'DATA = "{blob}"\n')
        rc, out = self.size()
        self.assertEqual(rc, 1)
        self.assertIn("lib/blob.py:1: embedded base64-like blob", out)

    def test_huge_literal_fails(self):
        self.adopt({})
        self.write("lib/lit.py", 'TEXT = "' + "word " * 500 + '"\n')
        rc, out = self.size()
        self.assertEqual(rc, 1)
        self.assertIn("large literals", out)

    def test_generated_file_needs_named_generator(self):
        self.adopt({})
        self.cfg["size"]["generated"] = ["lib/gen.py"]
        self.save()
        self.write("lib/gen.py", "# Code generated by protoc. DO NOT EDIT.\n" + lines(1500))
        self.assertEqual(self.size()[0], 0)
        self.write("lib/gen.py", "# generated\n" + lines(1500))
        self.assertEqual(self.size()[0], 1)

    def test_rust_inline_test_module_not_counted(self):
        self.adopt({})
        test_mod = "#[cfg(test)]\nmod tests {\n" + lines(300, "    let x = 1;") + "}\n"
        self.write("lib/x.rs", lines(900, "let x = 1;") + test_mod)
        rc, out = self.size()
        self.assertEqual(rc, 0, out)
        self.assertIn("lib/x.rs: 900 lines", out)

    def test_netloc_reports_diff(self):
        self.adopt({})
        self.run_("git", "init", "-q", "-b", "main")
        self.run_("git", "add", "-A")
        self.run_("git", "commit", "-qm", "base")
        self.write("src/app.py", lines(90))
        rc, out = self.size("netloc", "HEAD")
        self.assertEqual(rc, 0, out)
        self.assertIn("net -10 lines (added 0, deleted 10)", out)


class Ci(Project):
    def ci(self, checks, tier="fast"):
        self.cfg["tiers"] = {"fast": list(checks)}
        self.cfg["checks"] = checks
        self.save()
        return self.run_("sh", "scripts/ci.sh", tier)

    def test_all_pass_is_green(self):
        rc, out = self.ci({"a": {"cmd": "true", "tools": ["sh"]}})
        self.assertEqual(rc, 0, out)
        self.assertIn("GREEN", out)

    def test_missing_tool_is_red(self):
        rc, out = self.ci({"a": {"cmd": "true", "tools": ["kk-no-such-tool"]}})
        self.assertEqual(rc, 1)
        self.assertIn("RED a: missing tool(s): kk-no-such-tool", out)

    def test_unconfigured_check_is_red(self):
        rc, out = self.ci({"a": {"cmd": "TODO"}})
        self.assertEqual(rc, 1)
        self.assertIn("no command configured", out)

    def test_undefined_check_and_unknown_tier_are_red(self):
        self.cfg["tiers"] = {"fast": ["ghost"]}
        self.save()
        self.assertEqual(self.run_("sh", "scripts/ci.sh", "fast")[0], 1)
        self.assertEqual(self.run_("sh", "scripts/ci.sh", "nope")[0], 1)

    def test_failure_and_timeout_are_red(self):
        rc, out = self.ci({"ok": {"cmd": "true"}, "bad": {"cmd": "exit 3"}, "slow": {"cmd": "sleep 5", "timeout": 1}})
        self.assertEqual(rc, 1)
        self.assertIn("RED bad: failed", out)
        self.assertIn("timed out after 1s", out)

    def test_optional_missing_tool_skips(self):
        rc, out = self.ci({"a": {"cmd": "true"}, "b": {"cmd": "true", "tools": ["kk-no"], "required": False}})
        self.assertEqual(rc, 0, out)
        self.assertIn("SKIP b (optional)", out)


class PrePush(Project):
    def test_default_branch_push_needs_evidence(self):
        remote = Path(tempfile.mkdtemp()) / "remote.git"
        self.addCleanup(shutil.rmtree, remote.parent)
        self.run_("git", "init", "-q", "--bare", str(remote))
        self.run_("git", "init", "-q", "-b", "main")
        self.run_("git", "config", "core.hooksPath", ".githooks")
        self.run_("git", "add", "-A")
        self.run_("git", "commit", "-qm", "c1")
        rc, out = self.run_("git", "push", "-q", str(remote), "main")
        self.assertNotEqual(rc, 0)
        self.assertIn("missing", out)
        sha = self.run_("git", "rev-parse", "HEAD")[1].strip()
        tree = self.run_("git", "rev-parse", "HEAD^{tree}")[1].strip()
        ev = {"sha": sha, "tree": tree, "base": sha, "checks": [{"name": "size", "status": "pass"}],
              "review": {"verdict": "HOLD"}}
        path = self.d / ".git/factory/evidence" / f"{sha}.json"
        path.parent.mkdir(parents=True)
        tier = self.cfg["land_tier"]
        (path.parent / f"{sha}.ci-{tier}.json").write_text(json.dumps({
            "sha": sha, "tree": tree, "dirty": False,
            "checks": [{"name": n, "status": "pass"} for n in self.cfg["tiers"][tier]]}))
        path.write_text(json.dumps(ev))
        rc, out = self.run_("git", "push", "-q", str(remote), "main")
        self.assertNotEqual(rc, 0)
        self.assertIn("verdict is HOLD", out)
        path.write_text("{not json")
        self.assertNotEqual(self.run_("git", "push", "-q", str(remote), "main")[0], 0)
        ev["review"]["verdict"] = "LAND"
        path.write_text(json.dumps(ev))
        rc, out = self.run_("git", "push", "-q", str(remote), "main")
        self.assertEqual(rc, 0, out)


class Hardening(Project):
    """Known positives for the fail-open findings: each reproduces a bypass of v0."""

    def validate(self, *args):
        return self.run_("sh", "scripts/land.sh", "validate", *args)

    def test_evidence_needs_a_clean_full_ci_record_and_an_ancestor_base(self):
        sha = self.repo(("a", "b"))
        self.evidence(sha)
        rc, out = self.validate(sha)
        self.assertNotEqual(rc, 0, "self-written evidence without a ci record must be refused")
        self.assertIn("ci-fast", out)
        self.evidence(sha, ci=["a"])
        rc, out = self.validate(sha)
        self.assertNotEqual(rc, 0)
        self.assertIn("missing checks: b", out)
        self.evidence(sha, ci=["a", "b"], dirty=True)
        self.assertNotEqual(self.validate(sha)[0], 0, "a dirty ci record must be refused")
        self.evidence(sha, ci=["a", "b"], base="anything")
        self.assertNotEqual(self.validate(sha)[0], 0, "a base that is not an ancestor must be refused")
        self.evidence(sha, ci=["a", "b"])
        rc, out = self.validate(sha)
        self.assertEqual(rc, 0, out)

    def test_pre_push_refuses_a_rewind_of_main(self):
        remote = Path(tempfile.mkdtemp()) / "remote.git"
        self.addCleanup(shutil.rmtree, remote.parent)
        self.git("init", "-q", "--bare", str(remote))
        c1 = self.repo()
        self.evidence(c1, ci=["a"])
        self.git("commit", "-q", "--allow-empty", "-m", "c2")
        c2 = self.git("rev-parse", "HEAD")
        self.evidence(c2, base=c1, ci=["a"])
        rc, out = self.run_("git", "push", "-q", str(remote), "main")
        self.assertEqual(rc, 0, out)
        self.git("reset", "-q", "--hard", c1)
        rc, out = self.run_("git", "push", "-q", "--force", str(remote), "main")
        self.assertNotEqual(rc, 0, "a force push that rewinds main must be refused")
        self.assertIn("not an ancestor", out)

    def test_ci_writes_no_evidence_when_the_tree_changes_mid_run(self):
        self.repo()
        for cmd in ("echo y >> src/app.py", "git commit -q --allow-empty -m mid"):
            self.cfg["checks"] = {"a": {"cmd": cmd}}
            self.save()
            self.git("commit", "-qam", "cfg")
            rc, out = self.run_("sh", "scripts/ci.sh", "fast")
            self.assertEqual(rc, 1, out)
            self.assertIn("changed during the run", out)
            ev = list((self.d / ".git/factory/evidence").glob("*.ci-fast.json"))
            self.assertEqual(ev, [], "no evidence for a commit the checks did not test")
            self.git("reset", "-q", "--hard")

    def test_generated_exemption_needs_glob_marker_and_no_baseline(self):
        self.adopt({"lib/old.py": lines(1200)})
        self.write("lib/gen.py", "# generated by hand\n" + lines(1500))
        self.assertEqual(self.size()[0], 1, "a loose 'generated by' comment must not exempt")
        self.write("lib/gen.py", "# Code generated by protoc. DO NOT EDIT.\n" + lines(1500))
        self.assertEqual(self.size()[0], 1, "the marker alone, outside size.generated, must not exempt")
        self.cfg["size"]["generated"] = ["lib/*"]
        self.save()
        self.write("lib/old.py", "# Code generated by protoc. DO NOT EDIT.\n" + lines(1300))
        rc, out = self.size()
        self.assertEqual(rc, 1, "a baselined path is never exempt")
        self.assertIn("lib/old.py", out)
        self.write("lib/old.py", lines(1200))
        rc, out = self.size()
        self.assertEqual(rc, 0, out)

    def test_rust_braces_in_literals_and_comments_do_not_hide_code(self):
        self.adopt({})
        self.write("lib/a.rs", "#[cfg(test)]\nmod tests {\n    fn t() { tok('{'); s(\"{\"); } // {\n}\n"
                   + lines(1001, "let x = 1;"))
        rc, out = self.size()
        self.assertEqual(rc, 1, out)
        self.assertIn("lib/a.rs: 1001 lines", out)
        self.write("lib/a.rs", "#[cfg(test)]\nmod tests {\n    let s = \"\n{\n\";\n}\n" + lines(1001, "let x = 1;"))
        rc, out = self.size()
        self.assertEqual(rc, 1, "an unclosed test module at EOF must count its lines back in")
        self.assertIn("lib/a.rs: 1007 lines", out)

    def test_non_ascii_paths_are_measured(self):
        self.adopt({})
        self.git("init", "-q", "-b", "main")
        self.git("add", "-A")
        self.git("commit", "-qm", "base")
        self.write("lib/café.py", lines(1001))
        rc, out = self.size()
        self.assertEqual(rc, 1, out)
        self.assertIn("lib/café.py: 1001 lines", out)
        self.git("add", "-A")
        self.git("commit", "-qm", "cafe")
        rc, out = self.size("netloc", "HEAD~1..HEAD")
        self.assertEqual(rc, 0, out)
        self.assertIn("net +1001 lines (added 1001, deleted 0) across 1", out)


if __name__ == "__main__":
    unittest.main()
