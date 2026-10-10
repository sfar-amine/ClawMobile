import contextlib, importlib.util, io, json, pathlib, unittest

class R8AcceptanceTests(unittest.TestCase):
    def load(self):
        path = pathlib.Path(__file__).with_name('companion-acceptance.py')
        spec = importlib.util.spec_from_file_location('r8_acceptance', path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def execute(self, detail_seconds=1.9, empty=False):
        mod = self.load()
        seen = []
        def call(method, path, timeout, headers=None):
            seen.append((method, path))
            if method == 'POST': return 403, b'{}', 0.01
            if path == '/skills/candidates?limit=50':
                return 200, json.dumps({'items': [] if empty else [{'traceId': 'trace-fixture'}]}).encode(), 1.9
            return 200, b'{}', detail_seconds if path == '/skills/candidates/trace-fixture' else 0.01
        mod.call = call
        with contextlib.redirect_stdout(io.StringIO()) as output:
            code = mod.main()
        return code, json.loads(output.getvalue()), seen

    def test_existing_candidate_detail_and_owner_guard(self):
        code, result, seen = self.execute()
        self.assertEqual(code, 0)
        self.assertIn(('GET', '/skills/candidates/trace-fixture'), seen)
        self.assertIn(('POST', '/skills/learn'), seen)
        detail = next(row for row in result['checks'] if row['route'] == '/skills/candidates/{traceId}')
        self.assertEqual(detail['budget'], 2.0)

    def test_real_artifact_required_and_over_budget_refuses(self):
        code, _, seen = self.execute(empty=True)
        self.assertEqual(code, 0)
        self.assertNotIn(('GET', '/skills/candidates/trace-fixture'), seen)
        self.assertEqual(self.execute(detail_seconds=2.01)[0], 1)

if __name__ == '__main__':
    unittest.main()
