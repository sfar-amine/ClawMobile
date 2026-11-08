#!/usr/bin/env python3
"""gateway-secretref-exec.sh resolves the Gateway token chunk of the installed OpenClaw build (S24 31/10).

The 2026.10.9 update renamed gateway-auth-token-D8cKFnOh.mjs to gateway-auth-token-7OIpkk9l.mjs; the helper kept the
old name, exited 1 without a word and every MCP owner delegation failed (claw_execute « agenda demain » 08/11:
delegation_failed reason 1). Fake OpenClaw build and binary only; no Gateway, no real token.
"""
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).with_name("gateway-secretref-exec.sh")
NODE = shutil.which("node")
TOKEN_CHUNK = """export async function gatewayAuthTokenCommand(io, options) {
  if (!options || options.interactive !== true) throw new Error('interactive_required');
  io.writeStdout('fixture-gateway-value\\n');
}
"""
EMPTY_CHUNK = "export async function gatewayAuthTokenCommand(io) { io.writeStdout(''); }\n"


@unittest.skipUnless(NODE, "node is required")
class GatewaySecretrefExecTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.dist = self.tmp / "dist"
        self.dist.mkdir()
        self.openclaw = self.tmp / "openclaw"
        # Reports what the Gateway client would receive, without ever printing the value itself.
        self.openclaw.write_text('#!/usr/bin/env bash\n'
                                 'echo "args=$*"\n'
                                 'echo "url=$OPENCLAW_GATEWAY_URL"\n'
                                 '[ "$OPENCLAW_GATEWAY_TOKEN" = fixture-gateway-value ] && echo token=set || echo token=wrong\n')
        self.openclaw.chmod(0o755)

    def run_helper(self, *args):
        env = {**os.environ, "HOME": str(self.tmp), "CLAWMOBILE_GATEWAY_NODE": NODE,
               "CLAWMOBILE_OPENCLAW_DIST": str(self.dist), "CLAWMOBILE_OPENCLAW_BIN": str(self.openclaw)}
        env.pop("OPENCLAW_GATEWAY_TOKEN", None)
        return subprocess.run(["bash", str(HELPER), *args], env=env, capture_output=True, text=True, timeout=30)

    def test_the_renamed_chunk_of_the_installed_build_is_used(self):
        (self.dist / "gateway-auth-token-7OIpkk9l.mjs").write_text(TOKEN_CHUNK)
        out = self.run_helper("agent", "--agent", "main", "--json")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("args=agent --agent main --json", out.stdout)
        self.assertIn("url=ws://127.0.0.1:18789", out.stdout)
        self.assertIn("token=set", out.stdout)
        self.assertNotIn("fixture-gateway-value", out.stdout + out.stderr)

    def test_no_chunk_or_an_ambiguous_build_says_why(self):
        for names in ((), ("gateway-auth-token-A.mjs", "gateway-auth-token-B.mjs")):
            for name in names:
                (self.dist / name).write_text(TOKEN_CHUNK)
            with self.subTest(chunks=len(names)):
                out = self.run_helper("agent")
                self.assertEqual(out.returncode, 32)
                self.assertIn("gateway_token_resolver_unavailable", out.stderr)
                self.assertNotIn("args=", out.stdout)
            for name in names:
                (self.dist / name).unlink()

    def test_an_empty_token_never_reaches_openclaw(self):
        (self.dist / "gateway-auth-token-7OIpkk9l.mjs").write_text(EMPTY_CHUNK)
        out = self.run_helper("agent")
        self.assertEqual(out.returncode, 31)
        self.assertIn("gateway_token_unavailable", out.stderr)
        self.assertNotIn("args=", out.stdout)

    def test_no_build_hash_is_hardcoded(self):
        source = HELPER.read_text()
        code = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith("#"))
        self.assertIsNone(re.search(r"gateway-auth-token-[A-Za-z0-9_-]{6,}\.mjs", code))
        self.assertIn("gateway-auth-token-*.mjs", source)


if __name__ == "__main__":
    unittest.main()
