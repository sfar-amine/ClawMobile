#!/data/data/com.termux/files/usr/bin/python3
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).with_name("android-network-mutation-guard.py")
spec = importlib.util.spec_from_file_location("guard", MODULE)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

def blank():
    return {k: {"exists": False, "value": None} for k in guard.KEYS}

class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old = (guard.ROOT, guard.LEASES, guard.RECEIPT)
        guard.ROOT = root / "network-mutation"
        guard.LEASES = guard.ROOT / "leases"
        guard.RECEIPT = root / "health" / "receipt.json"

    def tearDown(self):
        guard.ROOT, guard.LEASES, guard.RECEIPT = self.old
        self.tmp.cleanup()

    def test_restore_absent_keys_uses_delete_not_literal_null(self):
        expected = blank()
        calls = []
        def fake_adb(*args, **kwargs):
            calls.append(args)
            class P: returncode=0; stdout=""
            return P()
        with patch.object(guard, "adb", side_effect=fake_adb), patch.object(guard, "settings_state", return_value=expected):
            guard.restore_state(expected)
        deletes = [c for c in calls if c[:4] == ("shell","settings","delete","global")]
        puts = [c for c in calls if c[:4] == ("shell","settings","put","global")]
        self.assertEqual(len(deletes), len(guard.KEYS))
        self.assertEqual(puts, [])

    def test_restore_existing_sentinel_is_exact(self):
        expected = blank()
        expected["http_proxy"] = {"exists": True, "value": ":0"}
        calls = []
        def fake_adb(*args, **kwargs):
            calls.append(args)
            class P: returncode=0; stdout=""
            return P()
        with patch.object(guard, "adb", side_effect=fake_adb), patch.object(guard, "settings_state", return_value=expected):
            guard.restore_state(expected)
        self.assertIn(("shell","settings","put","global","http_proxy",":0"), calls)

    def test_stale_owned_lease_is_restored_and_removed(self):
        guard.LEASES.mkdir(parents=True)
        lease = guard.LEASES / "stale.json"
        lease.write_text(json.dumps({"created_at": 1, "owner_pid": 999999, "settings": blank()}))
        with patch.object(guard, "lease_alive", return_value=False),              patch.object(guard, "restore_state") as restore,              patch.object(guard, "settings_state", return_value=blank()):
            rc = guard.check_and_reconcile(False)
        self.assertEqual(rc, 0)
        restore.assert_called_once()
        self.assertFalse(lease.exists())
        receipt = json.loads(guard.RECEIPT.read_text())
        self.assertEqual(receipt["reason"], "stale_lease_restored")

    def test_unmanaged_proxy_is_detected_not_cleared(self):
        state = blank()
        state["global_http_proxy_host"] = {"exists": True, "value": "127.0.0.1"}
        state["global_http_proxy_port"] = {"exists": True, "value": "8888"}
        with patch.object(guard, "settings_state", return_value=state),              patch.object(guard, "restore_state") as restore:
            rc = guard.check_and_reconcile(False)
        self.assertEqual(rc, 2)
        restore.assert_not_called()
        receipt = json.loads(guard.RECEIPT.read_text())
        self.assertEqual(receipt["reason"], "unmanaged_global_proxy_detected")

    def test_active_owned_lease_is_not_reconciled(self):
        guard.LEASES.mkdir(parents=True)
        lease = guard.LEASES / "active.json"
        lease.write_text(json.dumps({"created_at": 9999999999, "owner_pid": 1, "settings": blank()}))
        active_state = blank()
        active_state["http_proxy"] = {"exists": True, "value": "127.0.0.1:8888"}
        with patch.object(guard, "lease_alive", return_value=True),              patch.object(guard, "settings_state", return_value=active_state),              patch.object(guard, "restore_state") as restore:
            rc = guard.check_and_reconcile(False)
        self.assertEqual(rc, 0)
        restore.assert_not_called()
        self.assertTrue(lease.exists())
        receipt = json.loads(guard.RECEIPT.read_text())
        self.assertEqual(receipt["reason"], "temporary_lease_active")


    def test_termux_background_repair_is_bounded_and_verified(self):
        bad = {
            "healthy": False,
            "packages": {
                "com.termux": {"uid":10554,"doze_whitelisted":False,"run_any_in_background":False,
                                "run_in_background":False,"inactive":True,"standby_bucket":40,
                                "hibernation_supported":True,"hibernated":True,"healthy":False}
            },
            "data_saver_whitelisted": {"10554": False},
        }
        good = {
            "healthy": True,
            "packages": {
                "com.termux": {"uid":10554,"doze_whitelisted":True,"run_any_in_background":True,
                                "run_in_background":True,"inactive":False,"standby_bucket":5,
                                "hibernation_supported":True,"hibernated":False,"healthy":True}
            },
            "data_saver_whitelisted": {"10554": True},
        }
        calls=[]
        def fake_adb(*args, **kwargs):
            calls.append(args)
            class P: returncode=0; stdout=""
            return P()
        with patch.object(guard,"termux_background_state",side_effect=[bad,good]), patch.object(guard,"adb",side_effect=fake_adb):
            out=guard.ensure_termux_background_network()
        self.assertEqual(out["mutation"],"repaired")
        self.assertIn(("shell","dumpsys","deviceidle","whitelist","+com.termux"),calls)
        self.assertIn(("shell","cmd","appops","set","com.termux","RUN_ANY_IN_BACKGROUND","allow"),calls)
        self.assertIn(("shell","cmd","appops","set","com.termux","RUN_IN_BACKGROUND","allow"),calls)
        self.assertIn(("shell","am","set-inactive","com.termux","false"),calls)
        self.assertIn(("shell","am","set-standby-bucket","com.termux","active"),calls)
        self.assertIn(("shell","cmd","app_hibernation","set-state","com.termux","false"),calls)
        self.assertIn(("shell","cmd","netpolicy","add","restrict-background-whitelist","10554"),calls)

    def test_termux_background_healthy_state_has_no_mutation(self):
        good={"healthy":True,"packages":{},"data_saver_whitelisted":{}}
        with patch.object(guard,"termux_background_state",return_value=good), patch.object(guard,"repair_termux_background") as repair:
            out=guard.ensure_termux_background_network()
        self.assertEqual(out["mutation"],"none"); repair.assert_not_called()

    def test_wifi_state_parser(self):
        class P: returncode=0
        with patch.object(guard,"adb") as adb:
            P.stdout="Wi-Fi is enabled\n"; adb.return_value=P(); self.assertTrue(guard.wifi_enabled())
            P.stdout="Wi-Fi is disabled\n"; adb.return_value=P(); self.assertFalse(guard.wifi_enabled())

    def test_wifi_lease_restores_initial_enabled_state(self):
        row={"type":"wifi_off","settings":blank(),"wifi_enabled":True}
        with patch.object(guard,"restore_state"), patch.object(guard,"wifi_enabled",side_effect=[False,True]), patch.object(guard,"set_wifi") as set_wifi:
            guard.restore_lease(row)
        set_wifi.assert_called_once_with(True)

    def test_with_wifi_off_restores_even_after_child(self):
        guard.LEASES.mkdir(parents=True,exist_ok=True)
        lease=guard.LEASES/"wifi.json"
        lease.write_text(json.dumps({"type":"wifi_off","created_at":1,"owner_pid":1,"purpose":"test","settings":blank(),"wifi_enabled":True}))
        child=type("P",(),{"returncode":0})()
        with patch.object(guard,"create_lease",return_value=lease), patch.object(guard,"set_wifi") as set_wifi, patch.object(guard,"restore_lease") as restore, patch.object(guard.subprocess,"run",return_value=child):
            rc=guard.with_wifi_off("test",["echo","ok"])
        self.assertEqual(rc,0)
        set_wifi.assert_called_once_with(False)
        restore.assert_called_once()
        self.assertFalse(lease.exists())

    def test_active_wifi_lease_does_not_hide_unmanaged_proxy(self):
        guard.LEASES.mkdir(parents=True,exist_ok=True)
        lease=guard.LEASES/"wifi-active.json"
        lease.write_text(json.dumps({"type":"wifi_off","created_at":9999999999,"owner_pid":1,"purpose":"test","settings":blank(),"wifi_enabled":True}))
        state=blank(); state["http_proxy"]={"exists":True,"value":"127.0.0.1:8888"}
        with patch.object(guard,"lease_alive",return_value=True), patch.object(guard,"settings_state",return_value=state), patch.object(guard,"restore_lease") as restore:
            rc=guard.check_and_reconcile(False)
        self.assertEqual(rc,2); restore.assert_not_called()
        self.assertEqual(json.loads(guard.RECEIPT.read_text())["reason"],"unmanaged_global_proxy_detected")

    def test_stale_wifi_lease_is_restored_exactly(self):
        guard.LEASES.mkdir(parents=True,exist_ok=True)
        lease=guard.LEASES/"wifi-stale.json"
        lease.write_text(json.dumps({"type":"wifi_off","created_at":1,"owner_pid":999999,"purpose":"test","settings":blank(),"wifi_enabled":False}))
        with patch.object(guard,"lease_alive",return_value=False), patch.object(guard,"restore_lease") as restore, patch.object(guard,"settings_state",return_value=blank()):
            rc=guard.check_and_reconcile(False)
        self.assertEqual(rc,0); restore.assert_called_once()
        self.assertFalse(lease.exists())

class FakeAdb:
    """Protocol fixture only. No subprocess, real ADB, proxy or UI is used."""
    def __init__(self, testcase):
        self.testcase = testcase
        self.rows = []
        self.calls = []
        self.create_behavior = None
        self.remove_behavior = None
        self.fail_lists = False
        self.fail_after_create = False

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs.get("serial")))
        if args == ("forward", "--list"):
            if self.fail_lists:
                raise RuntimeError("fixture_observation_unavailable")
            return subprocess.CompletedProcess(args, 0, "\n".join(" ".join(r[k] for k in ("serial", "local", "remote")) for r in self.rows), "")
        if args[:2] == ("forward", "--no-rebind"):
            local, remote = args[2:]
            leases = [json.loads(p.read_text()) for p in guard.LEASES.glob("*.json")]
            row = next(r for r in leases if r.get("resource", {}).get("local") == local)
            self.testcase.assertEqual(row["state"], "CREATE_REQUESTED")
            self.testcase.assertEqual(row["before"], [])
            self.testcase.assertEqual(row["events"][0]["state"], "PREPARED")
            self.testcase.assertTrue(row["mutation_dispatched"])
            self.testcase.assertFalse(row["ownership_proven"])
            self.testcase.assert_lock_held()
            if any(r["local"] == local for r in self.rows):
                return subprocess.CompletedProcess(args, 1, "", "fixture: cannot rebind")
            self.rows.append({"serial": kwargs["serial"], "local": local, "remote": remote})
            if self.create_behavior == "timeout":
                raise subprocess.TimeoutExpired("fixture-adb", 1)
            if self.create_behavior == "crash":
                raise KeyboardInterrupt("fixture crash after effect before acknowledgment")
            if self.fail_after_create:
                self.fail_lists = True
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[:2] == ("forward", "--remove"):
            local = args[2]
            row = next(json.loads(p.read_text()) for p in guard.LEASES.glob("*.json")
                       if json.loads(p.read_text()).get("resource", {}).get("local") == local)
            self.testcase.assertEqual(row["state"], "REMOVE_REQUESTED")
            self.testcase.assertTrue(row["remove_dispatched"])
            self.testcase.assert_lock_held()
            if self.remove_behavior == "timeout_keep":
                raise subprocess.TimeoutExpired("fixture-adb", 1)
            # Real ADB removal is local-only: the guard must check every identity.
            self.rows = [r for r in self.rows if r["local"] != local]
            if self.remove_behavior == "timeout_removed":
                raise subprocess.TimeoutExpired("fixture-adb", 1)
            return subprocess.CompletedProcess(args, 0, "", "")
        raise AssertionError("unexpected fixture ADB command")

    def mutations(self):
        return [args for args, _ in self.calls if args[:2] in (("forward", "--no-rebind"), ("forward", "--remove"))]

class ForwardLeaseTests(unittest.TestCase):
    SERIAL = "fixture-device"
    OWNER = 4242
    LEASE = "a" * 32
    REMOTE = "localabstract:fixture_chrome_devtools_remote"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "network-mutation"
        self.clock = 10000.0
        self.identities = {self.OWNER: {"start_ticks": "fixture-birth-1", "boot_id": "fixture-boot"}}
        self.unreadable = set()
        self.server = {"binary": "/fixture/adb", "ADB_SERVER_SOCKET": None}
        self.fake = FakeAdb(self)
        patches = {
            "ROOT": self.root, "LEASES": self.root / "leases", "RECEIPT": self.root / "health.json",
            "MAX_LEASE_AGE": 900, "adb": self.fake,
        }
        for name, value in patches.items():
            p = patch.object(guard, name, value); p.start(); self.addCleanup(p.stop)
        for name, function in (("process_identity", self.identity), ("forward_server_identity", lambda: dict(self.server)),
                               ("settings_state", blank)):
            p = patch.object(guard, name, side_effect=function); p.start(); self.addCleanup(p.stop)
        p = patch.object(guard.time, "time", side_effect=lambda: self.clock); p.start(); self.addCleanup(p.stop)
        p = patch.object(guard.os, "kill", side_effect=self.kill); p.start(); self.addCleanup(p.stop)

    def identity(self, pid):
        return None if pid in self.unreadable else self.identities.get(pid)

    def kill(self, pid, sig):
        if pid not in self.identities:
            raise ProcessLookupError("fixture owner absent")

    def assert_lock_held(self):
        fd = os.open(self.root / "guard.lock", os.O_RDWR)
        try:
            with self.assertRaises(BlockingIOError):
                guard.fcntl.flock(fd, guard.fcntl.LOCK_EX | guard.fcntl.LOCK_NB)
        finally:
            os.close(fd)

    def acquire(self, **overrides):
        args = {"serial": self.SERIAL, "local": "tcp:49152", "remote": self.REMOTE,
                "purpose": "UNIT FIXTURE ONLY", "owner_pid": self.OWNER, "lease_id": self.LEASE}
        args.update(overrides)
        return guard.acquire_adb_forward(**args)

    def lease(self):
        return json.loads((guard.LEASES / (self.LEASE + ".json")).read_text())

    def end_owner(self):
        self.identities.pop(self.OWNER, None)

    def test_create_is_durable_once_and_cleanup_only_its_mapping(self):
        unrelated = {"serial": "other-device", "local": "tcp:49153", "remote": "tcp:8080"}
        self.fake.rows.append(unrelated)
        acquired = self.acquire()
        self.assertEqual(acquired["state"], "ACTIVE")
        self.assertTrue(acquired["ready"] and acquired["verified"])
        self.assertEqual(acquired["endpoint"], "http://127.0.0.1:49152")
        self.assertEqual((guard.LEASES / (self.LEASE + ".json")).stat().st_mode & 0o777, 0o600)
        self.assertTrue(self.acquire()["ready"])
        self.assertEqual(len(self.fake.mutations()), 1)
        closed = guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertTrue(closed["cleanup_verified"])
        self.assertTrue(closed["restored_exact"])
        self.assertFalse(closed["ready"])
        self.assertEqual(self.fake.rows, [unrelated])
        guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(len(self.fake.mutations()), 2)
        self.assertEqual(self.lease()["state"], "CLOSED")

    def test_preexisting_exact_forward_is_reused_and_never_removed(self):
        existing = {"serial": self.SERIAL, "local": "tcp:49152", "remote": self.REMOTE}
        self.fake.rows = [existing]
        result = self.acquire(local="tcp:0")
        self.assertEqual(result["state"], "REUSED")
        self.assertTrue(result["ready"])
        self.assertFalse(result["created"] or result["mutation_dispatched"])
        self.assertTrue(guard.release_adb_forward(self.LEASE, self.OWNER)["cleanup_verified"])
        self.assertEqual(self.fake.rows, [existing])
        self.assertEqual(self.fake.mutations(), [])

    def test_preexisting_foreign_local_is_blocked_without_cleanup_debt(self):
        existing = {"serial": "other-device", "local": "tcp:49152", "remote": "tcp:8080"}
        self.fake.rows = [existing]
        result = self.acquire()
        self.assertEqual(result["state"], "BLOCKED")
        self.assertFalse(result["ready"] or result["mutation_dispatched"])
        self.assertTrue(result["cleanup_verified"])
        guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(self.fake.rows, [existing])
        self.assertEqual(self.fake.mutations(), [])

    def test_multiple_matching_preexisting_forwards_are_not_guessed(self):
        self.fake.rows = [{"serial": self.SERIAL, "local": f"tcp:{port}", "remote": self.REMOTE} for port in (49152, 49153)]
        result = self.acquire(local="tcp:0")
        self.assertEqual(result["state"], "BLOCKED")
        self.assertEqual(result["reason"], "multiple_preexisting_forwards")
        self.assertEqual(self.fake.mutations(), [])

    def test_dynamic_port_is_concrete_in_lease_before_dispatch(self):
        class Reservation:
            def bind(self, address): self.address = address
            def getsockname(self): return ("127.0.0.1", 49157)
            def close(self): pass
        with patch.object(guard.socket, "socket", return_value=Reservation()):
            result = self.acquire(local="tcp:0")
        self.assertTrue(result["ready"])
        self.assertEqual(result["local"], "tcp:49157")
        self.assertEqual(self.lease()["request"]["local"], "tcp:0")
        self.assertEqual(self.fake.mutations()[0][2], "tcp:49157")

    def test_unknown_create_with_matching_mapping_is_never_owned_or_replayed(self):
        self.fake.create_behavior = "timeout"
        result = self.acquire()
        self.assertEqual(result["state"], "VERIFY_REQUIRED")
        self.assertFalse(result["ready"] or result["created"])
        self.assertTrue(result["observed_matches"])
        self.acquire()
        guard.release_adb_forward(self.LEASE, self.OWNER)
        self.end_owner()
        self.assertEqual(guard.check_and_reconcile(False), 2)
        self.assertEqual(len(self.fake.mutations()), 1)
        self.assertEqual(len(self.fake.rows), 1)

    def test_crash_after_effect_before_ack_preserves_unproven_forward(self):
        self.fake.create_behavior = "crash"
        with self.assertRaises(KeyboardInterrupt):
            self.acquire()
        self.assertEqual(self.lease()["state"], "CREATE_REQUESTED")
        self.assertFalse(self.lease()["ownership_proven"])
        self.end_owner()
        self.assertEqual(guard.check_and_reconcile(False), 2)
        self.assertEqual(len(self.fake.mutations()), 1)
        self.assertEqual(len(self.fake.rows), 1)

    def test_dead_owner_acknowledged_forward_is_reconciled(self):
        self.acquire()
        self.end_owner()
        self.assertEqual(guard.check_and_reconcile(False), 0)
        self.assertEqual(self.fake.rows, [])
        self.assertTrue(self.lease()["cleanup_verified"])
        self.assertTrue((guard.LEASES / (self.LEASE + ".json")).exists())

    def test_acknowledged_create_with_lost_observation_can_be_cleaned_when_observed(self):
        self.fake.fail_after_create = True
        result = self.acquire()
        self.assertFalse(result["ready"])
        self.assertTrue(result["created"])
        self.fake.fail_lists = False
        self.end_owner()
        self.assertEqual(guard.check_and_reconcile(False), 0)
        self.assertEqual(self.fake.rows, [])

    def test_repointed_mapping_is_preserved_even_if_old_tuple_later_returns(self):
        self.acquire()
        old = self.fake.rows[0]
        foreign = {**old, "serial": "other-device", "remote": "tcp:8080"}
        self.fake.rows = [foreign]
        result = guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(result["state"], "PRESERVED")
        self.assertFalse(result["cleanup_verified"])
        self.fake.rows = [old]
        guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(self.fake.rows, [old])
        self.assertEqual(len(self.fake.mutations()), 1)

    def test_observed_absence_revokes_ownership_before_same_tuple_reappears(self):
        self.acquire()
        old = self.fake.rows[0]
        self.fake.rows = []
        self.assertFalse(guard.inspect_adb_forward(self.LEASE)["ready"])
        self.assertTrue(self.lease()["ownership_lost"])
        self.fake.rows = [old]
        guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(self.fake.rows, [old])
        self.assertEqual(len(self.fake.mutations()), 1)

    def test_renewal_preserves_active_campaign_beyond_original_ttl(self):
        self.acquire()
        self.clock += 899
        result = guard.renew_adb_forward(self.LEASE, self.OWNER)
        self.assertTrue(result["ready"])
        self.clock += 200
        self.assertEqual(guard.check_and_reconcile(False), 0)
        self.assertEqual(len(self.fake.rows), 1)
        self.assertEqual(len(self.fake.mutations()), 1)
        self.assertEqual(self.lease()["renewals"], 1)
        self.clock += 701
        self.assertFalse(guard.renew_adb_forward(self.LEASE, self.OWNER)["ready"])
        self.assertEqual(guard.check_and_reconcile(False), 0)
        self.assertEqual(self.fake.rows, [])

    def test_observed_absence_after_lost_creation_observation_revokes_ownership(self):
        self.fake.fail_after_create = True
        result = self.acquire()
        self.assertEqual(result["state"], "VERIFY_REQUIRED")
        self.assertTrue(result["created"])
        old = self.fake.rows[0]
        self.fake.fail_lists = False
        self.fake.rows = []
        self.assertFalse(guard.inspect_adb_forward(self.LEASE)["ready"])
        self.assertTrue(self.lease()["ownership_lost"])
        self.fake.rows = [old]
        result = guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(result["state"], "PRESERVED")
        self.assertFalse(result["cleanup_verified"])
        self.assertEqual(self.fake.rows, [old])
        self.assertEqual(len(self.fake.mutations()), 1)

    def test_pid_reuse_is_not_the_original_owner(self):
        self.acquire()
        self.identities[self.OWNER] = {"start_ticks": "fixture-birth-2", "boot_id": "fixture-boot"}
        with self.assertRaises(ValueError):
            guard.renew_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(guard.check_and_reconcile(False), 0)
        self.assertEqual(self.fake.rows, [])

    def test_unreadable_live_owner_is_not_assumed_dead(self):
        self.acquire()
        self.unreadable.add(self.OWNER)
        self.assertEqual(guard.check_and_reconcile(False), 2)
        result = guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(result["owner_state"], "UNKNOWN")
        self.assertFalse(result["cleanup_verified"])
        self.assertEqual(len(self.fake.mutations()), 1)

    def test_unknown_remove_is_not_replayed(self):
        self.acquire()
        self.fake.remove_behavior = "timeout_keep"
        self.assertFalse(guard.release_adb_forward(self.LEASE, self.OWNER)["cleanup_verified"])
        guard.release_adb_forward(self.LEASE, self.OWNER)
        self.end_owner()
        self.assertEqual(guard.check_and_reconcile(False), 2)
        self.assertEqual(len(self.fake.mutations()), 2)
        self.assertEqual(len(self.fake.rows), 1)

    def test_remove_lost_reply_with_observed_absence_is_verified(self):
        self.acquire()
        self.fake.remove_behavior = "timeout_removed"
        result = guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertTrue(result["cleanup_verified"])
        self.assertEqual(result["state"], "CLOSED")

    def test_changed_adb_server_or_unavailable_list_cannot_authorize_removal(self):
        self.acquire()
        self.fake.fail_lists = True
        self.assertFalse(guard.release_adb_forward(self.LEASE, self.OWNER)["cleanup_verified"])
        self.fake.fail_lists = False
        self.server["ADB_SERVER_SOCKET"] = "tcp:fixture-other-host:5037"
        self.assertFalse(guard.release_adb_forward(self.LEASE, self.OWNER)["cleanup_verified"])
        self.assertEqual(len(self.fake.mutations()), 1)

    def test_forward_does_not_legitimize_an_unmanaged_global_proxy(self):
        self.acquire()
        state = blank(); state["http_proxy"] = {"exists": True, "value": "127.0.0.1:8888"}
        with patch.object(guard, "settings_state", return_value=state), patch.object(guard, "restore_state") as restore:
            self.assertEqual(guard.check_and_reconcile(False), 2)
        restore.assert_not_called()
        self.assertEqual(json.loads(guard.RECEIPT.read_text())["reason"], "unmanaged_global_proxy_detected")
        self.assertEqual(len(self.fake.mutations()), 1)

    def test_unknown_lease_type_never_falls_through_to_proxy_restore(self):
        guard.LEASES.mkdir(parents=True)
        (guard.LEASES / "unknown.json").write_text(json.dumps({"type": "future_unknown", "settings": blank()}))
        with patch.object(guard, "restore_state") as restore:
            self.assertEqual(guard.check_and_reconcile(False), 2)
        restore.assert_not_called()
        self.assertEqual(self.fake.mutations(), [])

    def test_invalid_identity_and_noncanonical_ports_have_no_effect(self):
        for override in ({"lease_id": "../escape"}, {"local": "tcp:00080"}, {"remote": "tcp:0"}, {"owner_pid": True}):
            with self.subTest(override=override), self.assertRaises(ValueError):
                self.acquire(**override)
        self.assertEqual(self.fake.calls, [])

    def test_cli_requires_stable_owner_and_id_and_returns_verified_result(self):
        args = [str(MODULE), "forward-acquire", "--serial", self.SERIAL, "--local", "tcp:49152",
                "--remote", self.REMOTE, "--owner-pid", str(self.OWNER), "--lease-id", self.LEASE]
        with patch.object(guard.sys, "argv", args), patch.object(guard.sys, "stdout", new_callable=io.StringIO) as output:
            self.assertEqual(guard.main(), 0)
        self.assertTrue(json.loads(output.getvalue())["ready"])
        args = [str(MODULE), "forward-release", self.LEASE, "--owner-pid", str(self.OWNER)]
        with patch.object(guard.sys, "argv", args), patch.object(guard.sys, "stdout", new_callable=io.StringIO) as output:
            self.assertEqual(guard.main(), 0)
        self.assertTrue(json.loads(output.getvalue())["cleanup_verified"])

if __name__ == "__main__":
    unittest.main(verbosity=2)
