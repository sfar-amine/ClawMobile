#!/usr/bin/env python3
"""Recette 03/11 A15: the workspace weather skill uses a source reachable from the S24."""

import json
from pathlib import Path
import re
import unittest
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "installer/workspace-seed-lite/skills/weather/SKILL.md"
CAPTURE = ROOT / "openclaw-plugin-mobile-ui/fixtures/s24-2026-11-03-weather-sources/capture.json"


class WeatherSeedSkillTests(unittest.TestCase):
    def setUp(self):
        self.text = SKILL.read_text()
        self.capture = json.loads(CAPTURE.read_text())

    def test_same_name_as_bundled_skill_so_the_workspace_copy_wins(self):
        match = re.match(r"^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n", self.text)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), self.capture["bundled_skill"]["name"])
        self.assertNotIn("weather", self.capture["workspace_skills_before"])

    def test_every_source_is_reachable_from_the_s24_and_wttr_is_not_used(self):
        reachable = {urlparse(p["url"]).hostname for p in self.capture["probes"] if p["reachable"]}
        unreachable = {urlparse(p["url"]).hostname for p in self.capture["probes"] if not p["reachable"]}
        used = {urlparse(u).hostname for u in re.findall(r'https://[^\s"\'`)]+', self.text)}
        self.assertTrue(used)
        self.assertLessEqual(used, reachable)
        self.assertFalse(used & unreachable)
        self.assertEqual(unreachable, {"wttr.in"})

    def test_forecast_example_requests_the_fields_the_capture_returned(self):
        current = self.capture["probes"][-1]["current"]
        for field in ("temperature_2m", "apparent_temperature", "precipitation", "weather_code", "wind_speed_10m"):
            self.assertIn(field, current)
            self.assertIn(field, self.text)

    def test_no_shell_or_search_detour(self):
        self.assertIn("web_fetch", self.text)
        self.assertNotIn("curl ", self.text.replace("`curl`", ""))
        self.assertIn("Pas de `exec`/`curl` ni de\n`web_search`", self.text)


if __name__ == "__main__":
    unittest.main()
