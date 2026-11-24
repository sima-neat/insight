import hashlib
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
_SCRIPT = _REPO / "scripts" / "sha256-verify.sh"


def verify(path, expected):
    return subprocess.run(["bash", str(_SCRIPT), str(path), expected], capture_output=True, text=True)


class Sha256VerifyTest(unittest.TestCase):
    """scripts/sha256-verify.sh, the check build.sh and CI run on each MediaMTX download."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.file = Path(self.dir.name) / "mediamtx.tar.gz"
        self.file.write_bytes(b"an archive")
        self.digest = hashlib.sha256(b"an archive").hexdigest()

    def test_the_pinned_hash_passes(self):
        result = verify(self.file, self.digest)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_another_hash_fails_and_says_both(self):
        other = hashlib.sha256(b"something else").hexdigest()
        result = verify(self.file, other)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(other, result.stderr)
        self.assertIn(self.digest, result.stderr)

    def test_an_empty_or_malformed_hash_fails(self):
        for expected in ["", "abc", self.digest.upper() + "0"]:
            with self.subTest(expected=expected):
                self.assertNotEqual(verify(self.file, expected).returncode, 0)

    def test_a_missing_file_fails(self):
        self.assertNotEqual(verify(Path(self.dir.name) / "missing", self.digest).returncode, 0)


class PinnedHashesTest(unittest.TestCase):
    """build.sh pins a hash for every MediaMTX archive it downloads."""

    def test_every_platform_has_a_pin(self):
        build = (_REPO / "build.sh").read_text()
        platforms = set(re.findall(r'^\s*PLATFORM="([a-z0-9_]+)"', build, re.M))
        self.assertTrue(platforms)
        for platform in platforms:
            with self.subTest(platform=platform):
                self.assertRegex(build, re.compile(rf'^MTX_SHA256_{platform}="[0-9a-f]{{64}}"$', re.M))


if __name__ == "__main__":
    unittest.main()
