#!/usr/bin/env python3
"""Memory recall worker and SQLite handle keep-alive: pinned existing compatibility owner on the captured public SDK modules."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).parent
OWNER = HERE / "openclaw-compat/whatsapp-network-recovery.py"
MANIFEST = json.loads(OWNER.with_name("memory-retrieval-warm.json").read_text())
FIXTURE = HERE.parent.parent / "openclaw-plugin-mobile-ui/fixtures/s24-2026-10-31-memory-retrieval-warm"
VARIANT_FIXTURE = HERE.parent.parent / "openclaw-plugin-mobile-ui/fixtures/openclaw-2026.10.9-compat"
ACCESSORS = {"2026.9.6": ("dist/session-accessor-DLYTHSBj.mjs", "withOpenClawAgentDatabaseAsync"),
             "2026.10.9": ("dist/session-accessor-C3ljJ974.mjs", "withOpenClawAgentDatabaseRuntime")}
# Runs the patched runSessionCollaborationWrite itself (sliced from the module) with recorded OpenClaw owners.
COLLABORATION_HARNESS = r"""
const fs = require("node:fs");
const [source, path] = process.argv.slice(1);
const log = [];
const depth = { admission: 0, database: 0 };
const nested = (key, label) => async (options, run, ...rest) => {
	log.push(label + ":" + JSON.stringify(rest.filter((value) => typeof value !== "function")));
	depth[key] += 1;
	try { return await run({ db: { isOpen: true } }); } finally { depth[key] -= 1; }
};
const stubs = {
	resolveSqliteScope: (scope) => ({ agentId: scope.agentId, sessionKey: scope.sessionKey, env: scope.env }),
	toDatabaseOptions: (resolved) => ({ agentId: resolved.agentId, env: resolved.env }),
	cloneEnvWithPlatformSemantics: (env) => ({ ...env }),
	resolveStateDir: () => "/state",
	resolveOpenClawAgentSqlitePath: () => path,
	isIncognitoOpenClawAgentSqlitePath: (pathname) => pathname.startsWith("incognito:"),
	captureIncognitoSessionOperation: () => undefined,
	runOpenClawAgentWriteAdmission: nested("admission", "admission"),
	withOpenClawAgentDatabaseAsync: nested("database", "database"),
	withOpenClawAgentDatabaseRuntime: nested("database", "database"),
	captureOpenClawAgentDatabaseExecution: () => { log.push("execution"); return { assertCurrent() {}, release: async () => {} }; },
	openOpenClawAgentSqliteWorkerStore: async () => { log.push("worker"); throw new Error("worker-spawned"); },
	readOpenClawAgentDatabaseIdentity: () => ({ identity: "file:agent" }),
	retainSessionEntryWorkerPublication: () => ({ settle() {}, beginChanges() {}, settleChanges() {} }),
	resolveRuntimeWorkerUrl: (entry) => entry,
	runtimeProcessEntrypoints: { sessionSharingStore: "session-sharing-store.worker.js" },
	sessionChanges: { emit() {}, emitBatch() {} },
};
const write = new Function("stubs", "with (stubs) {\n" + fs.readFileSync(source, "utf8") + "\nreturn runSessionCollaborationWrite;\n}")(stubs);
const scope = { agentId: "main", sessionKey: "agent:main:main", env: {} };
const native = (captured) => { log.push("native:" + depth.admission + ":" + depth.database + ":" + captured.storePath); return "inserted"; };
const publish = () => { throw new Error("worker publication used"); };
const run = async (type, assertCurrent) => {
	log.length = 0;
	try {
		return { value: await write(scope, { type, input: { params: {} } }, native, publish, assertCurrent), log: [...log] };
	} catch (error) {
		return { error: error.message, log: [...log] };
	}
};
(async () => {
	const refused = () => { throw new Error("stale-turn"); };
	console.log(JSON.stringify({
		participant: await run("participant"),
		stale: await run("participant", refused),
		add: await run("add"),
	}));
})();
"""


class MemoryRetrievalWarm(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "dist").mkdir()
        (self.root / "package.json").write_text('{"version":"2026.9.6"}')
        for item in MANIFEST["files"]:
            raw = gzip.decompress((FIXTURE / "compat" / (Path(item["path"]).name + ".gz")).read_bytes())
            self.assertEqual(hashlib.sha256(raw).hexdigest(), item["original"])
            (self.root / item["path"]).write_bytes(raw)

    def cli(self, mode):
        return subprocess.run([sys.executable, str(OWNER), "--patch-set", "memory-retrieval-warm",
                               "--openclaw-root", str(self.root), "--" + mode], capture_output=True, text=True)

    def snapshot(self):
        return {item["path"]: (self.root / item["path"]).read_bytes() for item in MANIFEST["files"]}

    def module(self):
        return (self.root / MANIFEST["files"][0]["path"]).read_text()

    def test_captured_module_is_the_s24_and_npm_original(self):
        measured = json.loads((FIXTURE / "measurements.json").read_text())
        self.assertEqual(measured["module"]["sha256"], MANIFEST["files"][0]["original"])
        self.assertEqual(measured["module"]["npm_sha256"], MANIFEST["files"][0]["original"])
        self.assertEqual(measured["openclaw_version"], MANIFEST["package_version"])

    def test_only_the_recall_pool_gets_the_keep_alive(self):
        self.assertEqual(self.cli("apply").returncode, 0)
        text = self.module()
        retrieval = text[text.index("const retrieval = new WorkerTaskPool({"):text.index("const indexing = new WorkerTaskPool({")]
        indexing = text[text.index("const indexing = new WorkerTaskPool({"):text.index("async function runMemoryIndexState")]
        self.assertIn("idleTimeoutMs: 432e5", retrieval)
        self.assertNotIn("idleTimeoutMs", indexing)
        self.assertEqual(text.count("idleTimeoutMs"), 1)
        node = shutil.which("node")
        if node:
            checked = subprocess.run([node, "--check", str(self.root / MANIFEST["files"][0]["path"])], capture_output=True, text=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_idle_sqlite_handles_stay_open_twelve_hours(self):
        measured = json.loads((FIXTURE / "measurements.json").read_text())
        handle = next(item for item in MANIFEST["files"] if item["path"].endswith("sqlite-handle-lifecycle-dWd9h3ii.mjs"))
        self.assertEqual(measured["handle_module"]["sha256"], handle["original"])
        self.assertEqual(self.cli("apply").returncode, 0)
        text = (self.root / handle["path"]).read_text()
        self.assertIn("const SQLITE_IDLE_HANDLE_TTL_MS = 432e5;", text)
        self.assertNotIn("18e5", text)
        self.assertIn("export { SQLITE_IDLE_HANDLE_TTL_MS as t };", text)
        variant = MANIFEST["packages"]["2026.10.9"]["files"]
        self.assertIn(handle, variant, "same public module in 2026.10.9, same pinned replacement")
        node = shutil.which("node")
        if node:
            checked = subprocess.run([node, "--check", str(self.root / handle["path"])], capture_output=True, text=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)

    def collaboration(self, text, path):
        node = shutil.which("node")
        if not node:
            self.skipTest("node unavailable")
        start = text.index("async function runSessionCollaborationWrite(")
        source = self.root / "collaboration-write.js"
        source.write_text(text[start:text.index("\nfunction ", start)])
        run = subprocess.run([node, "-e", COLLABORATION_HARNESS, str(source), path], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(run.stdout)

    def test_session_participant_records_natively_on_both_versions(self):
        """The captured 2026.9.6 (S24 production) and 2026.10.9 (S24 candidate) accessors, patched by the owner's pins."""
        measured = json.loads((FIXTURE / "measurements.json").read_text())["session_accessor_module"]
        variants = {"2026.9.6": (FIXTURE / "compat", MANIFEST["files"]),
                    "2026.10.9": (VARIANT_FIXTURE, MANIFEST["packages"]["2026.10.9"]["files"])}
        for version, (directory, files) in variants.items():
            with self.subTest(version):
                path, admitted = ACCESSORS[version]
                entry = next(item for item in files if item["path"] == path)
                raw = gzip.decompress((directory / (Path(path).name + ".gz")).read_bytes())
                self.assertEqual(hashlib.sha256(raw).hexdigest(), entry["original"])
                self.assertEqual(measured[version]["s24_sha256"], entry["original"])
                self.assertEqual(measured[version]["npm_sha256"], entry["original"])
                self.assertEqual(measured[version]["bytes"], len(raw))
                text = raw.decode()
                for before, after in entry["replacements"]:
                    self.assertEqual(text.count(before), 1)
                    text = text.replace(before, after)
                self.assertEqual(hashlib.sha256(text.encode()).hexdigest(), entry["patched"])
                body = text[text.index("async function runSessionCollaborationWrite("):]
                incognito = body.index("if (isIncognitoOpenClawAgentSqlitePath(options.path, options)) return runOpenClawAgentWriteAdmission(")
                participant = body.index('if (command.type === "participant") return runOpenClawAgentWriteAdmission(options, () => ' + admitted + "(options, () => {")
                self.assertLess(incognito, participant, "incognito databases keep their own unchanged branch")
                self.assertLess(participant, body.index("const execution = captureOpenClawAgentDatabaseExecution(options);"))
                self.assertLess(participant, body.index("openOpenClawAgentSqliteWorkerStore("))
                self.assertEqual(text.count('command.type === "participant"'), 1)
                self.assertIn(admitted, text[:text.index("//#region")], "the admission helper is imported by this module")
                out = self.collaboration(text, "/state/agents/main/agent/openclaw-agent.sqlite")
                self.assertEqual(out["participant"]["value"], "inserted")
                self.assertEqual(out["participant"]["log"], ["admission:[true]", "database:[]",
                                                             "native:1:1:/state/agents/main/agent/openclaw-agent.sqlite"],
                                 "native writer inside the same write admission and admitted database, no Worker")
                self.assertEqual(out["stale"], {"error": "stale-turn", "log": ["admission:[true]", "database:[]"]})
                self.assertEqual(out["add"]["error"], "worker-spawned", "other collaboration commands keep their Worker")
                self.assertEqual(out["add"]["log"], ["execution", "admission:[true]", "database:[]", "worker"])
                incognito_out = self.collaboration(text, "incognito:main")
                self.assertEqual(incognito_out["participant"]["log"], ["admission:[true]", "native:1:0:incognito:main"])
                node = shutil.which("node")
                module = self.root / ("patched-" + Path(path).name)
                module.write_text(text)
                checked = subprocess.run([node, "--check", str(module)], capture_output=True, text=True)
                self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_deployed_thirty_minute_patch_upgrades_and_rolls_back(self):
        entry = MANIFEST["files"][0]
        previous = entry["predecessors"][0]
        target = self.root / entry["path"]
        text = target.read_text()
        for old, new in previous["replacements"]:
            text = text.replace(old, new, 1)
        target.write_text(text)
        self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), previous["patched"])
        self.assertIn("idleTimeoutMs: 18e5", text)
        self.assertNotEqual(self.cli("check").returncode, 0)
        result = self.cli("apply")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for item in MANIFEST["files"]:
            self.assertEqual(hashlib.sha256((self.root / item["path"]).read_bytes()).hexdigest(), item["patched"])
        self.assertEqual(self.cli("rollback").returncode, 0)
        self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), entry["original"])

    def test_captured_set_atomic_idempotent_and_reversible(self):
        original = self.snapshot()
        self.assertNotEqual(self.cli("check").returncode, 0)
        for mode in ("apply", "check", "apply"):
            result = self.cli(mode)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('"unchanged"', self.cli("apply").stdout)
        for item in MANIFEST["files"]:
            self.assertEqual(hashlib.sha256((self.root / item["path"]).read_bytes()).hexdigest(), item["patched"])
        self.assertEqual(self.cli("rollback").returncode, 0)
        self.assertEqual(self.snapshot(), original)
        self.assertEqual(self.cli("rollback").returncode, 0)

    def test_unknown_module_refuses_before_write(self):
        target = self.root / MANIFEST["files"][0]["path"]
        target.write_bytes(target.read_bytes() + b"// authored drift\n")
        original = self.snapshot()
        result = self.cli("apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported_module_hash", result.stdout)
        self.assertEqual(self.snapshot(), original)

    def test_unsupported_version_refuses_without_write(self):
        original = self.snapshot()
        (self.root / "package.json").write_text('{"version":"2026.10.8"}')
        result = self.cli("apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported_package_version", result.stdout)
        self.assertEqual(self.snapshot(), original)

    def test_deployment_check_and_restart_share_the_owner(self):
        sync = (HERE / "runtime-sync.sh").read_text()
        self.assertIn("--patch-set memory-retrieval-warm --check", sync)
        self.assertIn("openclaw:memory_retrieval_warm", sync)
        self.assertIn("--patch-set memory-retrieval-warm --apply) || fail memory_retrieval_warm_refused", sync)
        self.assertIn('[[ "$memory_patch" == *\'"applied"\'* ]]', sync)
        self.assertIn("--patch-set memory-retrieval-warm", (HERE / "gateway-start.sh").read_text())
        self.assertIn("--patch-set memory-retrieval-warm --rollback", (HERE / "companion-deploy.sh").read_text())

    def test_deploy_rollback_undoes_a_manifest_the_previous_checkout_does_not_own(self):
        source = (HERE / "companion-deploy.sh").read_text()
        start = source.index("  # The memory recall keep-alive set")
        block = source[start:source.index('  if [ -f "$ROOT/openclaw-compat/agent-exec-auth-scope.json" ]', start)]
        repo = self.root / "checkout"
        target = repo / "installer/termux-lite/openclaw-compat"
        target.mkdir(parents=True)
        def git(*args):
            return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()
        git("init", "-q")
        (target / "README").write_text("previous checkout without the set\n")
        git("add", "-A")
        git("-c", "user.name=Authored test", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "previous")
        previous = git("rev-parse", "HEAD")
        marker = self.root / "patch-action.txt"
        (target / OWNER.name).write_text("from pathlib import Path\nimport os,sys\nPath(os.environ['PATCH_MARKER']).write_text(' '.join(sys.argv[1:]))\n")
        env = {**os.environ, "ROOT": str(target.parent), "previous": previous, "PATCH_MARKER": str(marker), "log": str(self.root / "guard.log")}
        run = lambda: subprocess.run(["bash", "-c", block], cwd=repo, env=env, capture_output=True, text=True)
        self.assertEqual(run().returncode, 0)
        self.assertFalse(marker.exists(), "no manifest in the candidate, nothing to undo")
        (target / "memory-retrieval-warm.json").write_text('{"version":"candidate"}')
        result = run()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(marker.read_text(), "--patch-set memory-retrieval-warm --rollback")
        marker.unlink()
        git("add", "-A")
        git("-c", "user.name=Authored test", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "owns it")
        env["previous"] = git("rev-parse", "HEAD")
        self.assertEqual(run().returncode, 0)
        self.assertFalse(marker.exists(), "a previous checkout owning the same manifest keeps the patch")

    def test_gateway_follows_checkout_ownership_then_rolls_back_the_old_release(self):
        source = (HERE / "gateway-start.sh").read_text()
        block = source[source.index("MEMORY_PATCH_DIR="):source.index('echo "[lite] Starting')]
        checkout, release = self.root / "checkout", self.root / "release"
        target = checkout / "installer/termux-lite/openclaw-compat"
        for directory in (target, release / "openclaw-compat"):
            directory.mkdir(parents=True)
            (directory / "memory-retrieval-warm.json").write_text("{}")
            (directory / OWNER.name).write_text("import sys\nprint(sys.argv[-1], file=sys.stderr)\n")
        env = {**os.environ, "CLAW_CORE_REPO": str(checkout), "SCRIPT_DIR": str(release)}
        applied = subprocess.run(["bash", "-c", block], env=env, capture_output=True, text=True)
        self.assertEqual(applied.returncode, 0)
        self.assertIn("--apply", applied.stderr)
        (target / "memory-retrieval-warm.json").unlink()
        restored = subprocess.run(["bash", "-c", block], env=env, capture_output=True, text=True)
        self.assertEqual(restored.returncode, 0)
        self.assertIn("--rollback", restored.stderr)


if __name__ == "__main__":
    unittest.main()
