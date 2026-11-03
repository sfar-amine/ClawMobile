#!/data/data/com.termux/files/usr/bin/python3
"""S24 26/10, 28/10, 29/10 : Wi-Fi coupé vers 23:35 sans raison enregistrée, 8 à 10 h, SMTP en panne,
621 des 625 envois WhatsApp propriétaire en échec.

Cause (fixture s24-2026-11-02-wifi-night-offline, lecture seule) : Wi-Fi ET données mobiles coupés à moins d'une
seconde d'intervalle par com.android.systemui (reason=USER, écran allumé), rallumés ensemble le matin. Aucune
bascule shell (uid 2000), donc aucun `svc wifi` de Samantha ; Samantha ne touche jamais aux données mobiles.

Correctif : le garde (`check`, déjà lancé par le cycle santé) suit l'épisode, ajoute au reçu la durée et l'état
données mobiles / mode avion, signale `device_offline_wifi_and_mobile_data_off` et, après 15 min hors ligne, met
UNE notification dans la file existante (incident-notify.sh). Jamais de réactivation automatique.
"""
import importlib.util
import json
import re
import subprocess
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("guard_wifi_night", HERE / "android-network-mutation-guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
CAPTURE = json.loads((HERE.parents[1] / "openclaw-plugin-mobile-ui" / "fixtures" / "s24-2026-11-02-wifi-night-offline"
                      / "capture.json").read_text())

def night_settings():
    """Réglages réels du S24, avec mobile_data tel que la téléphonie l'a enregistré la nuit (USER, enable=false)."""
    return CAPTURE["settings_global_now"].replace("mobile_data=1", "mobile_data=0")

class FakeS24:
    """`settings list global` et `cmd wifi status` aux formats réels capturés ; aucun ADB réel."""
    def __init__(self, settings: str, wifi: bool):
        self.settings, self.wifi, self.calls = settings, wifi, []
    def adb(self, *args, **_kwargs):
        self.calls.append(args)
        class P: returncode = 0; stdout = ""; stderr = ""
        out = P()
        if args[:4] == ("shell", "settings", "list", "global"):
            out.stdout = self.settings
        elif args[:4] == ("shell", "cmd", "wifi", "status"):
            out.stdout = (CAPTURE["cmd_wifi_status_now"] if self.wifi
                          else CAPTURE["cmd_wifi_status_now"].replace("Wifi is enabled", "Wifi is disabled"))
        else:
            raise AssertionError(f"unexpected adb call {args}")
        return out
    def mutations(self):
        return [c for c in self.calls if c[:2] in (("shell", "svc"),) or c[:3] in (("shell", "settings", "put"),
                                                                                 ("shell", "settings", "delete"))]

class IncidentEvidenceTest(unittest.TestCase):
    def test_night_cuts_are_paired_wifi_and_mobile_data_from_systemui(self):
        year = "2026-"
        wifi_ui = [datetime.strptime(year + t["at"], "%Y-%m-%d %H:%M:%S.%f") for t in CAPTURE["wifi_controller_toggles"]
                   if t["worksource"].endswith("com.android.systemui")]
        data = [(datetime.fromisoformat(r["at"]), r["enabled"]) for r in CAPTURE["mobile_data_changes"]]
        for at, enabled in data:
            self.assertEqual(at.tzinfo, None)
            nearest = min(wifi_ui, key=lambda w: abs((w - at).total_seconds()))
            self.assertLess(abs((nearest - at).total_seconds()), 1.0, f"{at} mobile data {enabled} has a paired Wi-Fi toggle")
        offs = [at for at, enabled in data if not enabled]
        self.assertEqual([a.strftime("%d/%m %H:%M") for a in offs], ["28/10 23:08", "29/10 23:39"])
        for r in CAPTURE["mobile_data_changes"]:
            self.assertEqual((r["reason"], r["callingPackage"]), ("USER", "com.android.systemui"))

    def test_no_samantha_toggle_in_the_android_record(self):
        sources = {t["worksource"] for t in CAPTURE["wifi_controller_toggles"]}
        self.assertEqual(sources, {"1000 android", "10049 com.android.systemui"})
        self.assertFalse(any("2000" in s or "shell" in s for s in sources), "adb svc wifi would be uid 2000 com.android.shell")
        for script in ("android-network-mutation-guard.py", "adb-recovery-watchdog.sh", "samantha-health-manager.sh"):
            text = (HERE / script).read_text()
            self.assertNotRegex(text, r"svc\W+data|mobile_data\W+0|set-?mobile-?data", script)

    def test_health_log_shows_the_three_nights_without_reason(self):
        lines = CAPTURE["health_log_network_safety"]
        starts = [l[:16] for l in lines if "state=warning reason=wifi_disabled_without_lease" in l]
        self.assertEqual(starts, ["2026-10-26T23:34", "2026-10-28T23:08", "2026-10-29T23:39"])
        self.assertTrue(all("action=none" in l for l in lines if "state=warning reason" in l))

class OfflineEpisodeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old = (guard.ROOT, guard.LEASES, guard.RECEIPT)
        guard.ROOT = root / "network-mutation"
        guard.LEASES = guard.ROOT / "leases"
        guard.RECEIPT = root / "health" / "network-mutation-safety.json"
        self.patches = [patch.object(guard, "log_line"), patch.object(guard, "notify_offline", return_value=True)]
        self.log, self.notify = (p.start() for p in self.patches)
        self.t0 = datetime(2026, 10, 29, 23, 39, 39).timestamp()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        guard.ROOT, guard.LEASES, guard.RECEIPT = self.old
        self.tmp.cleanup()

    def sweep(self, fake, at):
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "time", return_value=at):
            self.assertEqual(guard.check_and_reconcile(False), 0)
        return json.loads(guard.RECEIPT.read_text())

    def test_night_offline_notifies_once_after_15_minutes_and_never_reenables(self):
        fake = FakeS24(night_settings(), wifi=False)
        first = self.sweep(fake, self.t0)
        self.assertEqual(first["state"], "healthy")
        self.assertEqual(first["warnings"], [guard.WIFI_UNMANAGED_WARNING, guard.DEVICE_OFFLINE_WARNING])
        self.assertEqual({k: first["wifi_unmanaged"][k] for k in ("mobile_data", "airplane_mode", "offline", "notified")},
                         {"mobile_data": "off", "airplane_mode": "off", "offline": True, "notified": False})
        self.sweep(fake, self.t0 + 14 * 60)
        self.notify.assert_not_called()
        late = self.sweep(fake, self.t0 + 15 * 60)
        self.notify.assert_called_once_with(self.t0)
        self.assertEqual((late["wifi_unmanaged"]["duration_s"], late["wifi_unmanaged"]["notified"]), (900, True))
        line = self.log.call_args[0][0]
        self.assertIn("reason=device_offline_wifi_and_mobile_data_off", line); self.assertIn("action=notify_queued", line)
        self.assertIn("wifi_reenable=never", line)
        for hours in range(1, 10):  # toute la nuit : une seule notification, une seule ligne
            self.sweep(fake, self.t0 + hours * 3600)
        self.assertEqual(self.notify.call_count, 1)
        self.assertEqual(self.log.call_count, 1)
        self.assertEqual(fake.mutations(), [], "Samantha never toggles Wi-Fi nor any setting")
        # Matin : Wi-Fi rallumé par Amine -> épisode clos ; la nuit suivante notifie à nouveau.
        fake.wifi = True
        morning = self.sweep(fake, self.t0 + 9.5 * 3600)
        self.assertEqual((morning["warnings"], morning["wifi_unmanaged"]), ([], None))
        self.assertFalse(guard.wifi_episode_path().exists())
        fake.wifi = False
        next_night = self.t0 + 24 * 3600
        self.sweep(fake, next_night); self.sweep(fake, next_night + 900)
        self.assertEqual(self.notify.call_args_list[-1].args, (next_night,))

    def test_daytime_wifi_off_with_4g_is_receipt_only(self):
        fake = FakeS24(CAPTURE["settings_global_now"], wifi=False)  # Wi-Fi automatique Samsung, données mobiles actives
        for minutes in (0, 30, 600):
            receipt = self.sweep(fake, self.t0 + minutes * 60)
        self.assertEqual(receipt["warnings"], [guard.WIFI_UNMANAGED_WARNING])
        self.assertEqual((receipt["wifi_unmanaged"]["offline"], receipt["wifi_unmanaged"]["mobile_data"],
                          receipt["wifi_unmanaged"]["duration_s"]), (False, "on", 36000))
        self.notify.assert_not_called(); self.log.assert_not_called()
        self.assertEqual(fake.mutations(), [])

    def test_mobile_data_back_on_resets_the_offline_clock(self):
        fake = FakeS24(night_settings(), wifi=False)
        self.sweep(fake, self.t0)
        fake.settings = CAPTURE["settings_global_now"]
        self.sweep(fake, self.t0 + 10 * 60)
        fake.settings = night_settings()
        self.sweep(fake, self.t0 + 20 * 60)
        self.sweep(fake, self.t0 + 34 * 60)
        self.notify.assert_not_called()
        receipt = self.sweep(fake, self.t0 + 35 * 60)
        self.notify.assert_called_once_with(self.t0 + 20 * 60)
        self.assertEqual(receipt["wifi_unmanaged"]["duration_s"], 35 * 60, "Wi-Fi episode itself keeps its start")

    def test_failed_queue_retries_without_log_spam(self):
        self.notify.return_value = False
        fake = FakeS24(night_settings(), wifi=False)
        self.sweep(fake, self.t0)
        for minutes in (15, 16, 17):
            receipt = self.sweep(fake, self.t0 + minutes * 60)
        self.assertEqual(self.notify.call_count, 3)
        self.assertEqual(self.log.call_count, 1)
        self.assertIn("action=notify_failed", self.log.call_args[0][0])
        self.assertFalse(receipt["wifi_unmanaged"]["notified"])

    def test_unreadable_settings_keep_the_existing_warning(self):
        fake = FakeS24(night_settings(), wifi=False)
        real = fake.adb
        def flaky(*args, **kwargs):
            if args[:4] == ("shell", "settings", "list", "global") and len([c for c in fake.calls if c[:4] == args[:4]]) >= 1:
                fake.calls.append(args)
                raise RuntimeError("adb_command_failed")
            return real(*args, **kwargs)
        with patch.object(guard, "adb", side_effect=flaky), patch.object(guard.time, "time", return_value=self.t0):
            self.assertEqual(guard.check_and_reconcile(False), 0)
        receipt = json.loads(guard.RECEIPT.read_text())
        self.assertEqual((receipt["warnings"], receipt["wifi_unmanaged"]), ([guard.WIFI_UNMANAGED_WARNING], None))

class NotificationContractTest(unittest.TestCase):
    def test_queue_is_the_existing_incident_notify_and_message_is_honest(self):
        at = datetime(2026, 10, 29, 23, 39, 17).timestamp()
        with patch.object(guard.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertTrue(guard.notify_offline(at))
        argv = run.call_args.args[0]
        self.assertEqual((Path(argv[0]).name, argv[1]), ("incident-notify.sh", "info"))
        self.assertEqual(run.call_args.kwargs["timeout"], 5)
        message = argv[2]
        self.assertIn("29/10 23:39", message)
        self.assertIn("Wi-Fi et données mobiles", message)
        self.assertIn("ne les réactive jamais", message)
        self.assertNotRegex(message, r"[0-9a-f]{2}(:[0-9a-f]{2}){5}|@|token|password")
        with patch.object(guard.subprocess, "run", side_effect=subprocess.TimeoutExpired("x", 5)):
            self.assertFalse(guard.notify_offline(at))

    def test_health_consumers_still_read_the_receipt(self):
        manager = (HERE / "samantha-health-manager.sh").read_text()
        self.assertIn("'wifi_disabled_without_lease' in", manager)
        self.assertNotIn("svc wifi", manager)
        hv_spec = importlib.util.spec_from_file_location("hv_wifi_night", HERE / "health-verdict.py")
        hv = importlib.util.module_from_spec(hv_spec); hv_spec.loader.exec_module(hv)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "receipt.json"
            path.write_text(json.dumps({"checked_at": hv.NOW, "state": "healthy", "reason": "network_settings_clean",
                                        "warnings": [guard.WIFI_UNMANAGED_WARNING, guard.DEVICE_OFFLINE_WARNING],
                                        "wifi_unmanaged": {"offline": True}}))
            items = hv.network_safety_items(path)
        self.assertEqual(items["device.network_safety"]["state"], "healthy")
        self.assertEqual((items["device.network_safety.wifi_unmanaged"]["state"],
                          items["device.network_safety.wifi_unmanaged"]["critical"]), ("degraded", False))

if __name__ == "__main__":
    unittest.main(verbosity=2)
