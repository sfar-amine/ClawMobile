"""J1 false-positive boundaries; numeric samples exist only in temporary memory/files."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('scan',Path(__file__).with_name('workspace-secret-scan.py'))
scan=importlib.util.module_from_spec(spec);spec.loader.exec_module(scan)

def valid_number(prefix,length):
    stem=prefix+'1'*(length-len(prefix)-1)
    for check in range(10):
        value=stem+str(check)
        if scan.luhn(value):
            return value
    raise AssertionError('could not construct checksum sample')

class CardDetectorTests(unittest.TestCase):
    def scan_text(self,text):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'sample.txt').write_text(text)
            result=scan.scan_roots([('public',root)])
        self.assertNotIn(text,json.dumps(result))
        return result
    def test_timestamp_lengths_and_all_required_prefixes(self):
        for prefix in range(16,19):
            for length in (13,16,19):
                value=valid_number(str(prefix),length)
                self.assertTrue(scan.luhn(value))
                self.assertFalse(scan.card_candidate(value))
                self.assertEqual(len(self.scan_text(value)['findings']),0)
    def test_isolated_and_space_separated_cards_remain_detected(self):
        value=valid_number('4',16)
        for sample in (value,' '.join(value[i:i+4] for i in range(0,len(value),4)), '-'.join(value[i:i+4] for i in range(0,len(value),4))):
            self.assertEqual([row['type'] for row in self.scan_text(sample)['findings']],['card'])
    def test_adjacent_letters_dot_hyphen_and_uuid_are_not_cards(self):
        import uuid
        value=valid_number('4',16)
        for edge in ('a','é','.','-','_'):
            for sample in (edge+value,value+edge):
                self.assertEqual(len(self.scan_text(sample)['findings']),0)
        sample=str(uuid.UUID(int=int(value)))
        self.assertEqual(len(self.scan_text(sample)['findings']),0)
    def test_calendar_identifier_is_rejected_even_with_valid_checksum(self):
        from datetime import datetime,timedelta
        start=datetime.now().replace(microsecond=0)
        sample=None
        for seconds in range(100):
            candidate=(start+timedelta(seconds=seconds)).strftime('%Y%m%d-%H%M%S')
            if scan.luhn(candidate):
                sample=candidate;break
        self.assertIsNotNone(sample)
        self.assertFalse(scan.card_candidate(sample))
        self.assertEqual(len(self.scan_text(sample)['findings']),0)
    def test_exact_attested_public_signature_is_traced_but_extra_card_is_active(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'installer/termux-lite/test-context-memory.py';source.parent.mkdir(parents=True)
            accepted=valid_number('4',16);extra=valid_number('5',16);source.write_text(accepted+'\n'+extra)
            relative='core/installer/termux-lite/test-context-memory.py'
            rows=({'path':relative,'type':'public_fixture','hash':hashlib.sha256(source.read_bytes()).hexdigest(),'raison':'public test'}, {'path':relative,'type':'card','hash':hashlib.sha256(accepted.encode()).hexdigest()[:16],'raison':'synthetic checksum sample'})
            rows=tuple(rows)+tuple(dict(row,path=row['path'].replace('core/installer/','core_installer/',1)) for row in rows)
            with patch.object(scan,'__file__',str(root/'installer/termux-lite/workspace-secret-scan.py')),patch.object(scan,'accepted_signature_rows',lambda:rows):
                result=scan.scan_roots([('core',root)])
                self.assertEqual(len(result['accepted']),1)
                self.assertEqual(len(result['findings']),1)
                self.assertEqual(result['stats']['files'],1)
                installer=scan.scan_roots([('core_installer',root/'installer')])
                self.assertEqual((len(installer['accepted']),len(installer['findings'])),(1,1))
                self.assertNotIn(accepted,json.dumps(result));self.assertNotIn(extra,json.dumps(result))
                limited=scan.scan_roots([('core',root)],max_findings=1)
                self.assertEqual(len(limited['accepted'])+len(limited['findings']),1)
                self.assertEqual(limited['state'],'partial')
                # A changed source loses attestation; a matching label in another root cannot enable it.
                source.write_text(extra)
                changed=scan.scan_roots([('core',root)])
                self.assertEqual((len(changed['accepted']),len(changed['findings'])),(0,1))
            with patch.object(scan,'accepted_signature_rows',lambda:rows):
                changed=scan.scan_roots([('core',root)])
                self.assertEqual((len(changed['accepted']),len(changed['findings'])),(0,1))
    def test_nightly_receipt_preserves_accepted_metadata_without_alerting(self):
        spec=importlib.util.spec_from_file_location('hook',Path(__file__).with_name('nightly-secret-scan.py'))
        hook=importlib.util.module_from_spec(spec);spec.loader.exec_module(hook)
        known=next(row for row in scan.accepted_signature_rows() if row['type']=='card')
        accepted={'path':known['path'],'type':'card','hash':known['hash'],'line':1,'raison':'untrusted raw reason'}
        raw={'schemaVersion':1,'state':'ok','findings':[],'warnings':[],'accepted':[accepted],'stats':{'files':1,'bytes':10,'entries':1,'skipped':0}}
        out,attention=hook.execute_scan(Path(__file__).parent,[('core','/synthetic/not-read')],[],lambda *_:(0,raw))
        self.assertFalse(attention)
        self.assertEqual(out['newFindingCount'],0)
        self.assertEqual(out['accepted'][0]['raison'],known['raison'])
        self.assertNotIn('untrusted raw reason',json.dumps(out))
        raw['accepted']*=hook.MAX_ROWS+1
        with self.assertRaises(ValueError):hook.closed_scan(raw,scan)
        raw['accepted']=[dict(accepted,hash='f'*16)]
        with self.assertRaises(ValueError):hook.closed_scan(raw,scan)

    def test_manifest_cannot_authorize_private_directories_or_unknown_runtime_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'credentials').mkdir();(root/'credentials/data.txt').write_text(valid_number('4',16))
            (root/'auth.json').write_text(valid_number('5',16))
            private=root/'auth.json'
            rows=({'path':'core/auth.json','type':'public_fixture','hash':hashlib.sha256(private.read_bytes()).hexdigest(),'raison':'must not authorize private file'},)
            # Even a supplied source attestation cannot bypass the existing name exclusion.
            with patch.object(scan,'__file__',str(root/'installer/termux-lite/workspace-secret-scan.py')),patch.object(scan,'accepted_signature_rows',lambda:rows):
                changed=scan.scan_roots([('core',root)])
                self.assertEqual(changed['stats']['files'],0)
                self.assertEqual((len(changed['accepted']),len(changed['findings'])),(0,0))

if __name__=='__main__':unittest.main()
