"""Findings from the first adopter: evidence step, multi-line config, kit version stamp."""
import json
import shutil
import tempfile
from pathlib import Path

from test_factory import KIT, Project


class Adopter(Project):
    def setUp(self):
        super().setUp()
        shutil.copy(KIT / "KIT_VERSION", self.d / "KIT_VERSION")
        self.sha = self.repo()
        self.ev = self.d / ".git/factory/evidence"

    def ci(self):
        return self.run_("sh", "scripts/ci.sh", "fast")

    def record(self, **over):
        p = self.ev / f"{self.sha}.ci-fast.json"
        r = json.loads(p.read_text())
        r.update(over)
        p.write_text(json.dumps(r))

    def evid(self, *a):
        return self.run_("sh", "scripts/evidence.sh", self.sha, *a)

    def test_happy_path_ci_evidence_pre_push(self):
        self.assertEqual(self.ci()[0], 0)
        rc, out = self.evid("LAND", "reviewer-x", "ok")
        self.assertEqual(rc, 0, out)
        e = json.loads((self.ev / f"{self.sha}.json").read_text())
        self.assertEqual(e["review"], {"verdict": "LAND", "by": "reviewer-x", "notes": "ok"})
        self.assertNotEqual(self.evid("LAND", "reviewer-x")[0], 0)  # immutable
        self.assertEqual(self.run_("sh", "scripts/land.sh", "validate", self.sha)[0], 0)
        remote = Path(tempfile.mkdtemp()) / "remote.git"
        self.addCleanup(shutil.rmtree, remote.parent)
        self.git("init", "-q", "--bare", str(remote))
        rc, out = self.run_("git", "push", "-q", str(remote), "main")
        self.assertEqual(rc, 0, out)

    def test_refuses_bad_ci_records(self):
        self.assertNotEqual(self.evid("LAND", "r")[0], 0)  # missing
        self.assertEqual(self.ci()[0], 0)
        path = self.ev / f"{self.sha}.ci-fast.json"
        good = path.read_text()
        for over in ({"dirty": True}, {"sha": "0" * 40}, {"checks": []},
                     {"checks": [{"name": "a", "status": "fail", "seconds": 0}]}):
            self.record(**over)
            rc, out = self.evid("LAND", "r")
            self.assertNotEqual(rc, 0, over)
            self.assertIn("evidence.sh:", out)
            path.write_text(good)
        self.assertFalse((self.ev / f"{self.sha}.json").exists())

    def test_verdict_from_file_and_self_review_label(self):
        self.ci()
        f = self.d / "verdict.txt"
        f.write_text("HOLD orchestrator | needs a second look\n")
        self.assertEqual(self.evid("--file", str(f))[0], 0)
        r = json.loads((self.ev / f"{self.sha}.json").read_text())["review"]
        self.assertEqual(r["verdict"], "HOLD")
        self.assertIn("self-review", r["by"])
        self.assertEqual(r["notes"], "needs a second look")
        self.assertNotEqual(self.run_("sh", "scripts/land.sh", "validate", self.sha)[0], 0)

    def test_bad_verdict_rejected(self):
        self.ci()
        self.assertNotEqual(self.evid("MAYBE", "r")[0], 0)

    def test_fifteen_check_config_passes_size(self):
        names = [f"check{i:02d}" for i in range(15)]
        self.cfg["tiers"] = {"fast": names}
        self.cfg["checks"] = {n: {"cmd": "echo " + "x" * 80 + n, "timeout": 60} for n in names}
        self.save()
        self.assertGreater(len((self.d / "factory.json").read_text().splitlines()), 30)
        self.assertGreater(len(json.dumps(self.cfg)), 2000)
        rc, out = self.size()
        self.assertNotIn("factory.json", out, out)

    def test_stale_kit_copy_warns_and_major_is_red(self):
        self.cfg["kit_version"] = "0.1.0"
        self.save()
        rc, out = self.ci()
        self.assertEqual(rc, 0, out)
        self.assertIn("kit copy is stale: v0.3.0 vs v0.1.0", out)
        self.cfg["kit_version"] = "9.0.0"
        self.save()
        rc, out = self.ci()
        self.assertNotEqual(rc, 0)
        self.assertIn("kit major version differs", out)
