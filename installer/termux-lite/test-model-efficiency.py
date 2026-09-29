#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod


fast = load("model_fast_path", "model-fast-path.py")
cfg = load("model_efficiency_config", "model-efficiency-config.py")


def plan(**overrides):
    value = {
        "mode": "known",
        "confidence": 1.0,
        "risk": "read",
        "confirmation_required": False,
        "fallback": None,
        "target": "maxit-tunisie",
        "intent": {"id": "telecom.balance"},
        "route": {"id": "orange.silent_first.balance", "health": "healthy"},
    }
    value.update(overrides)
    return value


def route(**overrides):
    value = {
        "id": "orange.silent_first.balance",
        "status": "validated",
        "layer": "script",
        "entrypoint": "python -m telecom.service read orange balance",
    }
    value.update(overrides)
    return value


class FastPathTests(unittest.TestCase):
    def test_safe_read_route_is_eligible(self):
        self.assertEqual(fast.eligible(plan(), route()), (True, "eligible"))

    def test_write_route_is_refused(self):
        self.assertEqual(
            fast.eligible(plan(risk="external_send"), route())[1],
            "not_read_only",
        )

    def test_low_confidence_is_refused(self):
        self.assertEqual(
            fast.eligible(plan(confidence=0.7), route())[1],
            "low_confidence",
        )
    def test_fallback_is_refused(self):
        self.assertEqual(
            fast.eligible(plan(fallback={"id": "x"}), route())[1],
            "fallback_selected",
        )

    def test_browser_route_is_refused(self):
        self.assertEqual(
            fast.eligible(plan(), route(layer="browser"))[1],
            "not_script_route",
        )

    def test_shell_composition_is_refused(self):
        self.assertEqual(
            fast.eligible(plan(), route(entrypoint="python -m x read; rm -rf /"))[1],
            "entrypoint_not_static",
        )

    def test_needs_counter_is_human_readable(self):
        self.assertEqual(
            fast._display_text(
                {"state": "needs_counter", "choices": ["recharge", "balances"]}
            ),
            "Précise : recharge / balances",
        )

    def test_selected_route_executes_once(self):
        with mock.patch.object(fast, "resolve_plan", return_value=plan()),              mock.patch.object(fast, "_route_from_manifest", return_value=route()),              mock.patch.object(
                 fast,
                 "_execute_route",
                 return_value=(0, '{"ok":true,"message":"done"}', ""),
             ) as execute:
            out = fast.try_fast_path("mon solde maxit")
        self.assertEqual(out["status"], "hit")
        self.assertEqual(out["text"], "done")
        execute.assert_called_once()

    def test_needs_counter_nonzero_is_bounded_hit(self):
        payload = json.dumps({
            "ok": False,
            "state": "needs_counter",
            "choices": ["recharge", "balances"],
            "sent": False,
        })
        with mock.patch.object(fast, "resolve_plan", return_value=plan()),              mock.patch.object(fast, "_route_from_manifest", return_value=route()),              mock.patch.object(
                 fast,
                 "_execute_route",
                 return_value=(4, payload, ""),
             ):
            out = fast.try_fast_path("mon solde maxit")
        self.assertEqual(out["status"], "hit")
        self.assertEqual(out["text"], "Précise : recharge / balances")

    def test_other_nonzero_remains_error(self):
        with mock.patch.object(fast, "resolve_plan", return_value=plan()),              mock.patch.object(fast, "_route_from_manifest", return_value=route()),              mock.patch.object(
                 fast,
                 "_execute_route",
                 return_value=(3, '{"ok":false,"state":"failed","sent":false}', "boom"),
             ):
            out = fast.try_fast_path("mon solde maxit")
        self.assertEqual(out["status"], "error")
        self.assertEqual(out["reason"], "route_failed")


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.old_main = cfg.MAIN_WORKSPACE
        self.old_gemini = cfg.GEMINI_WORKSPACE
        cfg.MAIN_WORKSPACE = self.root / "main"
        cfg.GEMINI_WORKSPACE = self.root / "gemini"
        self.config = self.root / "openclaw.json"
        self.original = {
            "auth": {
                "profiles": {
                    "google:claw-gemini-free": {
                        "provider": "google",
                        "mode": "api_key",
                    }
                }
            },
            "unrelated": {"keep": "yes"},
            "agents": {
                "entries": {
                    "main": {
                        "workspace": "/original/main",
                        "model": {
                            "primary": "openai/gpt-5.6-sol@p",
                            "fallbacks": ["openai/gpt-5.6-luna"],
                        },
                        "modelPolicy": {
                            "allow": [
                                "openai/gpt-5.6-sol",
                                "openai/gpt-5.6-luna",
                            ]
                        },
                        "tools": {"deny": ["dangerous-test"]},
                    },
                    "engineering-lite": {
                        "workspace": "/engineering",
                        "marker": "unchanged",
                    },
                    "gemini": {
                        "workspace": "/old",
                        "model": {
                            "primary": (
                                "google/gemini-3.5-flash-lite"
                                "@google:claw-gemini-free"
                            ),
                            "fallbacks": [],
                        },
                        "modelPolicy": {
                            "allow": ["google/gemini-3.5-flash-lite"]
                        },
                    },
                }
            },
        }
        self.config.write_text(json.dumps(self.original))

    def tearDown(self):
        cfg.MAIN_WORKSPACE = self.old_main
        cfg.GEMINI_WORKSPACE = self.old_gemini
        self.tmp.cleanup()

    def test_dry_run_does_not_write(self):
        out = cfg.apply_efficiency(config_path=self.config, apply=False)
        self.assertTrue(out["config_changed"])
        self.assertEqual(json.loads(self.config.read_text()), self.original)
        self.assertFalse(cfg.GEMINI_WORKSPACE.exists())

    def test_apply_preserves_unrelated_and_models(self):
        cfg.apply_efficiency(config_path=self.config, apply=True)
        value = json.loads(self.config.read_text())
        self.assertEqual(value["unrelated"], {"keep": "yes"})
        self.assertEqual(
            value["agents"]["entries"]["engineering-lite"],
            {"workspace": "/engineering", "marker": "unchanged"},
        )
        self.assertEqual(
            value["agents"]["entries"]["main"]["model"],
            self.original["agents"]["entries"]["main"]["model"],
        )
        self.assertEqual(
            value["agents"]["entries"]["main"]["tools"],
            {"deny": ["dangerous-test"]},
        )
        self.assertEqual(
            value["agents"]["entries"]["gemini"]["model"]["fallbacks"],
            [],
        )
        self.assertEqual(
            value["agents"]["entries"]["gemini"]["tools"],
            {"allow": []},
        )

    def test_apply_is_idempotent(self):
        cfg.apply_efficiency(config_path=self.config, apply=True)
        out = cfg.apply_efficiency(config_path=self.config, apply=False)
        self.assertFalse(out["config_changed"])
        self.assertEqual(out["file_paths"], [])

    def test_retry_settings_are_separate(self):
        cfg.apply_efficiency(config_path=self.config, apply=True)
        main = json.loads(
            (cfg.MAIN_WORKSPACE / ".openclaw/settings.json").read_text()
        )
        gemini = json.loads(
            (cfg.GEMINI_WORKSPACE / ".openclaw/settings.json").read_text()
        )
        self.assertEqual(main["retry"]["provider"]["maxRetries"], 1)
        self.assertEqual(gemini["retry"]["provider"]["maxRetries"], 0)


if __name__ == "__main__":
    unittest.main()
