import importlib.util
import unittest
import json
import subprocess
import sys
import tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('route', Path(__file__).with_name('voice-route-requalify.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RouteTests(unittest.TestCase):
    def evidence(self):
        return dict(schema='samantha.voice.route-evidence.v1', deviceFingerprint='S24-DZI1', routeKey='DZI1|speaker', samples=[])

    def test_no_acoustics_never_qualifies(self):
        value = module.report(self.evidence())
        self.assertEqual(value['state'], 'awaiting_acoustic_qualification')
        self.assertIsNone(value['proposal'])
        self.assertFalse(value['applied'])

    def test_complete_only_proposes(self):
        e = self.evidence()
        common = dict(fingerprint=e['deviceFingerprint'], routeKey=e['routeKey'], externalAligned=True)
        e['samples'] = [dict(common, kind='interruption', detected=True, stopped=True, cutMs=80)] * 100
        e['samples'].append(dict(common, kind='negative', interrupted=False))
        r = module.report(e)
        self.assertEqual(r['state'], 'review_required')
        self.assertTrue(r['proposal']['requiresOwnerValidation'])
        self.assertFalse(r['applied'])

    def test_missed_or_false_interruptions_never_propose_qualification(self):
        e=self.evidence();common=dict(fingerprint=e['deviceFingerprint'],routeKey=e['routeKey'],externalAligned=True)
        e['samples']=[dict(common,kind='interruption',detected=True,stopped=True,cutMs=80)]*100
        e['samples'].append(dict(common,kind='negative',interrupted=True))
        self.assertIsNone(module.report(e)['proposal'])
        e['samples'][-1]['interrupted']=False
        e['samples'][0]=dict(common,kind='interruption',detected=False,stopped=False)
        self.assertIsNone(module.report(e)['proposal'])

    def test_other_build_is_rejected(self):
        e = self.evidence()
        e['samples'] = [dict(fingerprint='DZH2', routeKey=e['routeKey'])]
        with self.assertRaises(ValueError): module.report(e)

    def test_missing_negative_cannot_qualify(self):
        e = self.evidence()
        e['samples'] = [dict(fingerprint=e['deviceFingerprint'], routeKey=e['routeKey'], externalAligned=True,
                             kind='interruption', detected=True, stopped=True, cutMs=80)] * 100
        self.assertIsNone(module.report(e)['proposal'])


    def test_incomplete_or_nonfinite_reference_never_proposes(self):
        e=self.evidence();common=dict(fingerprint=e['deviceFingerprint'],routeKey=e['routeKey'],externalAligned=True)
        e['samples']=[dict(common,kind='interruption',detected=True,stopped=True,cutMs=80)]*100
        e['samples'].append(dict(common,kind='negative',interrupted=False))
        for latency in [float('nan'),float('inf'),-1,True]:
            e['samples'][0]=dict(common,kind='interruption',detected=True,stopped=True,cutMs=latency)
            self.assertIsNone(module.report(e)['proposal'])
        e['samples'][0]=dict(common,kind='interruption',detected=True,stopped=True,cutMs=80,externalAligned=False)
        self.assertIsNone(module.report(e)['proposal'])
    def test_other_route_is_rejected(self):
        e=self.evidence();e['samples']=[dict(fingerprint=e['deviceFingerprint'],routeKey='DZI1|bluetooth')]
        with self.assertRaisesRegex(ValueError,'mixed_route_or_build'):module.report(e)
    def test_cli_preserves_evidence_and_existing_profile(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'evidence.json';profile=root/'openclaw.json';destination=root/'report.json'
            source.write_text(json.dumps(self.evidence()));profile.write_text('{"qualifiedRoutes":["DZH2|speaker"]}')
            before={source:source.read_bytes(),profile:profile.read_bytes()}
            command=[sys.executable,str(Path(__file__).with_name('voice-route-requalify.py')),str(source),'--out']
            r=subprocess.run(command+[str(destination)],capture_output=True,text=True)
            self.assertEqual(r.returncode,0,r.stderr);self.assertFalse(json.loads(destination.read_text())['applied'])
            for forbidden in [source,profile,destination]:
                rejected=subprocess.run(command+[str(forbidden)],capture_output=True,text=True)
                self.assertNotEqual(rejected.returncode,0)
            for file,data in before.items():self.assertEqual(file.read_bytes(),data)
    def test_cli_bounds_and_rejects_nonfinite_json(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'evidence.json';destination=root/'report.json'
            command=[sys.executable,str(Path(__file__).with_name('voice-route-requalify.py')),str(source),'--out',str(destination)]
            for data in [b' '*(8*1024*1024+1),b'{"samples": [NaN]}']:
                source.write_bytes(data);r=subprocess.run(command,capture_output=True,text=True)
                self.assertNotEqual(r.returncode,0);self.assertFalse(destination.exists())

if __name__ == '__main__': unittest.main()
