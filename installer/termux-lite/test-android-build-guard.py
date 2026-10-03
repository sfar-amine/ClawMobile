#!/data/data/com.termux/files/usr/bin/python3
import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("android_build_guard", ROOT / "android-build-guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

class AndroidBuildGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def test_apply_check_remove_roundtrip(self):
        result = guard.apply(self.home)
        self.assertEqual(result["state"], "applied")
        self.assertTrue(guard.check(self.home)["ok"])
        text = guard.gradle_file(self.home).read_text()
        self.assertIn("-Xmx768m", text)
        self.assertIn("org.gradle.workers.max=1", text)
        self.assertEqual(guard.remove(self.home)["state"], "removed")
        self.assertFalse(guard.gradle_file(self.home).exists())

    def test_preserves_unrelated_gradle_properties(self):
        path = guard.gradle_file(self.home)
        path.parent.mkdir(parents=True)
        path.write_text("android.useAndroidX=true\n")
        guard.apply(self.home)
        self.assertIn("android.useAndroidX=true", path.read_text())
        guard.remove(self.home)
        self.assertEqual(path.read_text(), "android.useAndroidX=true\n")

    def test_refuses_preexisting_managed_key_outside_block(self):
        path = guard.gradle_file(self.home)
        path.parent.mkdir(parents=True)
        path.write_text("org.gradle.jvmargs=-Xmx2048m\n")
        with self.assertRaisesRegex(RuntimeError, "managed_key_conflict"):
            guard.apply(self.home)

    def test_doctor_exposes_guard_state(self):
        self.assertIn("android-build-guard.py", (ROOT / "doctor.sh").read_text())

    def test_apply_repairs_only_owned_block(self):
        guard.apply(self.home)
        path = guard.gradle_file(self.home)
        path.write_text(path.read_text().replace("-Xmx768m", "-Xmx1536m"))
        self.assertFalse(guard.check(self.home)["ok"])
        guard.apply(self.home)
        self.assertTrue(guard.check(self.home)["ok"])

if __name__ == "__main__":
    unittest.main(verbosity=2)
