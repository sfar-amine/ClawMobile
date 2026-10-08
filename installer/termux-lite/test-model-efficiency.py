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
    def resolution(self, **overrides):
        value = {
            "harness": {"tool_policy": "required", "reason": "known_route"},
            "selected": {
                "state": "ready", "authorized": True, "deterministic": True,
                "model_required": False, "risk": "read", "capability": "x",
                "target": "t", "intent": "i", "route": "r",
                "execution_contract": {},
            },
            "confirmation_required": False,
            "skill_plan": {"mode": "known", "target": "t", "intent": "i", "risk": "read", "confirmation_required": False},
        }
        for key, item in overrides.items():
            if key == "selected":
                value["selected"].update(item)
            elif key == "harness":
                value["harness"].update(item)
            else:
                value[key] = item
        return value

    def test_required_deterministic_authorized_capability_is_eligible(self):
        self.assertEqual(fast.capability_first_eligibility(self.resolution()), ("eligible", "capability_first"))

    def test_optional_conversation_is_model_miss(self):
        value=self.resolution(harness={"tool_policy":"optional","reason":"conversation_or_unknown"})
        self.assertEqual(fast.capability_first_eligibility(value), ("miss", "conversation_or_unknown"))

    def test_intent_clarification_is_terminal_before_model(self):
        value=self.resolution(
            selected={},
            harness={"tool_policy":"required","reason":"intent_clarification_required"},
            skill_plan={"mode":"needs_clarification","target":"maxit-tunisie","intent":None},
            clarification={"question":"Tu veux consulter ton offre ou recharger ton numéro ?","choices":[]},
        )
        self.assertEqual(fast.capability_first_eligibility(value), ("clarification", "intent_clarification_required"))
        with mock.patch.object(fast,"resolve_capability",return_value=value), mock.patch.object(fast,"execute_capability") as execute:
            out=fast.try_fast_path("maxit mon numéro")
        self.assertEqual(out["status"],"clarification")
        self.assertTrue(out["model_bypassed"])
        self.assertIn("recharger",out["text"])
        execute.assert_not_called()

    def test_model_required_capability_is_assisted(self):
        value=self.resolution(selected={"model_required":True})
        self.assertEqual(fast.capability_first_eligibility(value), ("assist", "selected_requires_model"))

    def test_unready_high_consequence_intent_is_terminal_without_model(self):
        value=self.resolution(
            harness={"reason":"known_intent_not_ready"},
            selected={"deterministic":False,"risk":"read"},
            skill_plan={"mode":"transfer","target":"steg","intent":"billing.pay",
                        "risk":"transaction","confirmation_required":True},
        )
        self.assertEqual(
            fast.capability_first_eligibility(value),
            ("known_error", "required_capability_not_ready"),
        )
        with mock.patch.object(fast,"resolve_capability",return_value=value), \
             mock.patch.object(fast,"execute_capability") as execute:
            out=fast.try_fast_path("paie ma facture steg")
        self.assertEqual(out["status"],"known_error")
        self.assertTrue(out["model_bypassed"])
        self.assertIn("STEG",out["text"]); self.assertIn("Aucun paiement",out["text"])
        execute.assert_not_called()

    def test_unauthorized_known_capability_is_terminal_without_model(self):
        value=self.resolution(selected={"authorized":False})
        self.assertEqual(fast.capability_first_eligibility(value), ("known_error", "selected_not_authorized"))

    def test_completed_known_execution_bypasses_model(self):
        resolved=self.resolution()
        executed={**resolved,"execution":{"state":"completed","result":{"message":"done"}}}
        with mock.patch.object(fast,"resolve_capability",return_value=resolved), \
             mock.patch.object(fast,"execute_capability",return_value=executed) as execute:
            out=fast.try_fast_path("known read")
        self.assertEqual(out["status"],"hit")
        self.assertEqual(out["text"],"done")
        self.assertTrue(out["model_bypassed"])
        execute.assert_called_once()

    def test_assisted_execution_returns_to_model_without_fake_result(self):
        resolved=self.resolution()
        executed={**resolved,"execution":{"state":"delegation_required"}}
        with mock.patch.object(fast,"resolve_capability",return_value=resolved), \
             mock.patch.object(fast,"execute_capability",return_value=executed):
            out=fast.try_fast_path("assisted")
        self.assertEqual(out["status"],"assist")
        self.assertEqual(out["reason"],"delegation_required")

    def test_known_failed_execution_does_not_fall_through_to_model_refusal(self):
        resolved=self.resolution()
        executed={**resolved,"execution":{"state":"failed"}}
        with mock.patch.object(fast,"resolve_capability",return_value=resolved), \
             mock.patch.object(fast,"execute_capability",return_value=executed):
            out=fast.try_fast_path("known failure")
        self.assertEqual(out["status"],"known_error")
        self.assertIn("Claw",out["text"])

    def test_confirmation_without_declared_inert_handoff_is_assisted(self):
        resolved=self.resolution(confirmation_required=True)
        with mock.patch.object(fast,"resolve_capability",return_value=resolved):
            out=fast.try_fast_path("needs confirmation")
        self.assertEqual(out["status"],"assist")
        self.assertEqual(out["reason"],"confirmation_requires_assisted_handoff")

    def test_declared_inert_handoff_is_model_bypass(self):
        resolved=self.resolution(
            confirmation_required=True,
            selected={"execution_contract":{
                "pre_model_handoff":{
                    "entrypoint":"python3 -m payments.request_handoff",
                    "input_mode":"request_arg",
                    "effect_before_boundary":"none",
                    "boundary":"owner_biometric",
                }
            }},
        )
        with mock.patch.object(fast,"resolve_capability",return_value=resolved), \
             mock.patch.object(fast,"_execute_declared_handoff",return_value={"status":"hit","text":"confirm","model_bypassed":True}) as handoff:
            out=fast.try_fast_path("top up maxit 5 tnd",origin_id="run-1")
        self.assertEqual(out["status"],"hit")
        self.assertTrue(out["model_bypassed"])
        handoff.assert_called_once()



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
            {"allow": ["clawmobile_capability"]},
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
