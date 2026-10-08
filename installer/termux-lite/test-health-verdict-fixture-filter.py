#!/usr/bin/env python3
import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).with_name("health-verdict.py")
spec = importlib.util.spec_from_file_location("health_verdict_fixture_filter", SOURCE)
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)

class FixtureFilterTests(unittest.TestCase):
    def test_marked_test_fixture_is_not_operational_incident(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            incident_dir = root / "incidents"
            incident_dir.mkdir()
            con = sqlite3.connect(incident_dir / "orchestrator.db")
            con.execute("create table incidents(id text primary key,component text,scope text,state text,created real,updated real,human_boundary integer,human_reason text,summary text,next_retry real)")
            con.execute("create table events(seq integer primary key autoincrement,incident_id text,ts real,source text,kind text,payload text)")
            con.execute("insert into incidents values(?,?,?,?,?,?,?,?,?,?)", ("fixture-id","route.test","runtime","failed",990,995,0,None,"synthetic",0))
            con.execute("insert into incidents values(?,?,?,?,?,?,?,?,?,?)", ("real-id","route.real","runtime","failed",990,995,0,None,"real failure",0))
            con.execute("insert into events(incident_id,ts,source,kind,payload) values(?,?,?,?,?)", ("fixture-id",996,"test","test_fixture",'{"synthetic":true}'))
            con.commit()
            con.close()
            with patch.object(health, "OC", root), patch.object(health, "NOW", 1000):
                active, failed, human = health.incidents({})
            self.assertEqual(active, [])
            self.assertEqual(human, [])
            self.assertEqual([row["id"] for row in failed], ["real-id"])

if __name__ == "__main__":
    unittest.main()
