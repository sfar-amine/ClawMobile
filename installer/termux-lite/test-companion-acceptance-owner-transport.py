"""P1 : la recette signale (alerte, sans retour arrière) un tour admis owner parti sur le CLI write."""
import contextlib, importlib.util, io, json, pathlib, unittest


class OwnerTransportAlertTests(unittest.TestCase):
    def run_acceptance(self, runs):
        path = pathlib.Path(__file__).with_name('companion-acceptance.py')
        spec = importlib.util.spec_from_file_location('p1_acceptance', path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        def call(method, path, timeout, headers=None):
            if method != 'GET':
                return 403, b'{}', 0.01
            if path == mod.VOICE_TERMINAL_ROUTE:
                return 200, json.dumps({'runs': runs}).encode(), 0.01
            if path == '/runs?contract=2&view=conversations&limit=20':
                return 200, b'{"items": []}', 0.01
            if path == '/skills/candidates?limit=50':
                return 200, b'{"items": []}', 0.01
            return 200, b'{}', 0.01
        mod.call = call
        with contextlib.redirect_stdout(io.StringIO()) as output:
            code = mod.main()
        return code, json.loads(output.getvalue())

    def test_degraded_owner_transport_is_an_alert_not_a_rollback(self):
        code, result = self.run_acceptance([
            {'runId': 'a', 'ownerAdmitted': True, 'ownerTransport': 'write_cli_owner_unavailable'},
            {'runId': 'b', 'ownerAdmitted': True, 'ownerTransport': 'admin_admitted'},
            {'runId': 'c', 'ownerTransport': 'write_cli'},
        ])
        self.assertEqual(code, 0)
        self.assertIn({'route': '/runs?limit=50', 'warning': 'owner_transport_unavailable', 'runs': 1}, result['warnings'])

    def test_no_alert_when_admin_transport_used(self):
        code, result = self.run_acceptance([{'runId': 'b', 'ownerTransport': 'admin_admitted'}])
        self.assertEqual(code, 0)
        self.assertFalse([w for w in result['warnings'] if w.get('warning') == 'owner_transport_unavailable'])

    def test_owner_admission_routes_are_guarded(self):
        path = pathlib.Path(__file__).with_name('companion-acceptance.py')
        text = path.read_text()
        self.assertIn('("DELETE", "/owner-admission/enrollment")', text)
        self.assertIn('("POST", "/owner-admission/enrollment")', text)
        self.assertIn('("/owner-admission", 0.5)', text)
        self.assertIn('("POST", "/extensions/claw-live/capability")', text)


if __name__ == '__main__':
    unittest.main()
