#!/usr/bin/env python3
"""L1 authored recipe plan: canonical bindings and fail-closed static validation, no live claims."""
import copy, importlib.util, json, os, pathlib, sys, tempfile, unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
CORE = HERE.parents[1]
if os.environ.get('CLAW_QA_PYTHON_LIB'):
    sys.path.insert(0, os.environ['CLAW_QA_PYTHON_LIB'])
import jsonschema
spec = importlib.util.spec_from_file_location('acceptance_journey', HERE/'companion-acceptance.py')
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
PLAN = CORE/'openclaw-plugin-mobile-ui/fixtures/refonte-parcours-unique/L1-scenarios.json'
PEER = pathlib.Path(sys.argv.pop(1)).resolve() if len(sys.argv)>1 else None

class JourneyPlan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.path = pathlib.Path(self.tmp.name)/'plan.json'
        self.plan = json.loads(PLAN.read_text())
    def validate(self, plan):
        self.path.write_text(json.dumps(plan))
        with patch.object(a, 'call', side_effect=AssertionError('Static plan validation must not send a request')):
            return a.journey_scenarios_validate(self.path, PEER)
    def test_all_twelve_scenarios_have_canonical_bindings_but_no_runtime_success_claim(self):
        self.assertIsNotNone(PEER, 'explicit pinned peer required')
        result = self.validate(self.plan)
        self.assertEqual(12, result['scenarios']); self.assertEqual(32, result['surfaceCases'])
        self.assertFalse(result['runtimeExecuted'])
        self.assertEqual({'voice-greeting','voice-interruption'}, {r['id'] for r in self.plan['scenarios'] if r['surfaces']==['voice']})
    def test_mutations_payment_fields_and_client_authority_cannot_be_added_to_the_plan(self):
        for mutation in ('write', 'confirmation', 'extra'):
            candidate = copy.deepcopy(self.plan)
            row = candidate['scenarios'][2]
            if mutation=='write': row['safety']['allowWrite']=True
            elif mutation=='confirmation': row['safety']['stopAtConfirmation']=False
            else: row['safety']['owner']=True
            with self.assertRaises(jsonschema.ValidationError): self.validate(candidate)
    def test_unknown_or_duplicate_scenarios_and_non_surface_inputs_are_refused(self):
        for change in ('duplicate', 'missing', 'surface', 'claim'):
            candidate = copy.deepcopy(self.plan)
            if change=='duplicate': candidate['scenarios'][1]['id']=candidate['scenarios'][0]['id']
            elif change=='missing': candidate['scenarios'].pop()
            elif change=='surface': candidate['scenarios'][0]['surfaces']=['direct_graph']
            else: candidate['provenance']['runtimeCapture']=True
            with self.assertRaises((ValueError,jsonschema.ValidationError)): self.validate(candidate)
    def test_correct_shape_does_not_admit_wrong_capability_intent_parameter_or_revision(self):
        for change in ('capability', 'intent', 'params', 'type', 'revision'):
            candidate = copy.deepcopy(self.plan)
            if change=='capability': candidate['scenarios'][0]['expected']['capability']='agenda.google_whatsapp'
            elif change=='intent': candidate['scenarios'][0]['expected']['intent']='imaginary.intent'
            elif change=='params': candidate['scenarios'][0]['expected']['params']={'raw_card':'forbidden'}
            elif change=='type': candidate['scenarios'][2]['expected']['params']['start_time']=False
            else: candidate['provenance']['contractSource']['commit']='0'*40
            with self.assertRaises(ValueError): self.validate(candidate)
    def test_default_deployment_owner_remains_read_and_refusal_only(self):
        self.assertTrue(a.OWNER_GUARDS)
        self.assertIn(('POST','/learning/not-this'), a.OWNER_GUARDS)
        self.assertNotIn('/v1/runs', [row[0] for row in a.READS])

if __name__=='__main__': unittest.main()
