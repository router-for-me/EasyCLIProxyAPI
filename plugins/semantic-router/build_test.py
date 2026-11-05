#!/usr/bin/env python3
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent


class BuildTests(unittest.TestCase):
    def test_checksum_fallback(self):
        with tempfile.TemporaryDirectory(prefix="semantic-router-build-") as temporary:
            temporary = Path(temporary)
            plugin = temporary / "plugins/semantic-router"
            plugin.mkdir(parents=True)
            shutil.copy2(ROOT / "build.sh", plugin)
            for name in ("manifest.json", "README.zh-CN.md"):
                shutil.copy2(ROOT / name, plugin)
            shutil.copy2(ROOT.parent.parent / "LICENSE", temporary)
            dependency = temporary / "dependency"
            dependency.mkdir()
            (dependency / "LICENSE").write_text("test dependency license\n")
            helpers = temporary / "bin"
            helpers.mkdir()
            for command in ("bash", "dirname", "mkdir", "rm", "cp", "tar", "gzip", "basename", "shasum"):
                executable = shutil.which(command)
                self.assertIsNotNone(executable, command)
                (helpers / command).symlink_to(executable)
            fake_go = helpers / "go"
            fake_go.write_text('''#!/bin/bash
set -eu
case "$1" in
  mod|test) ;;
  env)
    case "$2" in
      GOOS) echo linux ;;
      GOARCH) echo amd64 ;;
      GOROOT) echo "$TEST_DEPENDENCY" ;;
    esac ;;
  list) echo "$TEST_DEPENDENCY" ;;
  build)
    while [[ "$1" != -o ]]; do shift; done
    printf 'test shared library\\n' > "$2" ;;
  *) exit 1 ;;
esac
''')
            fake_go.chmod(0o755)
            environment = {**os.environ, "PATH": str(helpers), "TEST_DEPENDENCY": str(dependency)}
            environment.pop("CPA_SDK_DIR", None)
            self.assertIsNone(shutil.which("sha256sum", path=str(helpers)))
            subprocess.run([str(helpers / "bash"), "build.sh"], cwd=plugin, env=environment, check=True)
            package = plugin / "dist/semantic-router-0.1.0-linux-amd64"
            digest = hashlib.sha256((package / "semantic-router.so").read_bytes()).hexdigest()
            self.assertEqual((package / "SHA256SUMS").read_text(), f"{digest}  semantic-router.so\n")
            self.assertTrue(Path(f"{package}.tar.gz").is_file())
            self.assertFalse((plugin / ".build").exists())

    @unittest.skipUnless(os.environ.get("CPA_CORE"), "Set CPA_CORE for real clean-state smoke")
    def test_clean_state_smoke(self):
        with tempfile.TemporaryDirectory(prefix="semantic-router-clean-") as temporary:
            plugin = Path(temporary)
            shutil.copy2(ROOT / "smoke_test.py", plugin)
            shutil.copytree(ROOT / "dist", plugin / "dist")
            self.assertFalse((plugin / ".build").exists())
            environment = dict(os.environ)
            environment.pop("CPA_SDK_DIR", None)
            subprocess.run([shutil.which("python3"), str(plugin / "smoke_test.py")], env=environment, check=True)
            self.assertFalse((plugin / ".build").exists())


if __name__ == "__main__":
    unittest.main()
