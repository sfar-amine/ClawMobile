#!/data/data/com.termux/files/usr/bin/python3
import importlib.util, json, tempfile, unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

MODULE=Path(__file__).with_name("people-trusted.py")
spec=importlib.util.spec_from_file_location("people_trusted",MODULE)
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

CONTACT_ROWS=[
 {"_id":"1","display_name":"Amine Sadfi","contact_last_updated_timestamp":"100"},
 {"_id":"2","display_name":"Mehdi Test","contact_last_updated_timestamp":"101"},
]
DATA_ROWS=[
 {"contact_id":"1","display_name":"Amine Sadfi","data1":"Amine Sadfi","data2":"Amine","data3":"Sadfi","mimetype":m.NAME_MIME},
 {"contact_id":"1","display_name":"Amine Sadfi","data1":"+216 53 792 744","data2":"2","data3":None,"mimetype":m.PHONE_MIME},
 {"contact_id":"1","display_name":"Amine Sadfi","data1":"amine@example.com","data2":None,"data3":None,"mimetype":m.EMAIL_MIME},
 {"contact_id":"2","display_name":"Mehdi Test","data1":"Mehdi Test","data2":"Mehdi","data3":"Test","mimetype":m.NAME_MIME},
 {"contact_id":"2","display_name":"Mehdi Test","data1":"+216 20 000 001","data2":"2","data3":None,"mimetype":m.PHONE_MIME},
 {"contact_id":"2","display_name":"Mehdi Test","data1":"+216 20 000 002","data2":"2","data3":None,"mimetype":m.PHONE_MIME},
]
class PeopleTrustedTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); root=Path(self.tmp.name)
  self.old=(m.ROOT,m.DB,m.WORKSPACE,m.CONTACTS,m.CONFIG,m.SESSION_DB)
  m.ROOT=root/"people"; m.DB=m.ROOT/"directory.db"
  m.WORKSPACE=root/"workspace"; m.CONTACTS=m.WORKSPACE/"memory"/"whatsapp"/"contacts"
  m.CONFIG=root/"openclaw.json"; m.SESSION_DB=root/"missing.sqlite"
  m.CONTACTS.mkdir(parents=True)
  m.CONFIG.write_text(json.dumps({"channels":{"whatsapp":{"allowFrom":[],"direct":{"*":{"systemPrompt":"base"}}}}}))
  with patch.object(m,"contact_catalog",return_value=CONTACT_ROWS), patch.object(m,"all_contact_data",return_value=DATA_ROWS), patch.object(m,"refresh_interactions",return_value=0):
   m.sync_directory()

 def tearDown(self):
  m.ROOT,m.DB,m.WORKSPACE,m.CONTACTS,m.CONFIG,m.SESSION_DB=self.old
  self.tmp.cleanup()

 def args(self,**kw):
  base=dict(query="Amine Sadfi",person_id=None,e164=None,scope="standard",scope_text=None,
            silent=True,after_message=None,dry_run=False)
  base.update(kw); return Namespace(**base)

 def set_config(self,allow=None,direct=None):
  cfg={"channels":{"whatsapp":{"allowFrom":allow or [],"direct":direct or {"*":{"systemPrompt":"base"}}}}}
  m.CONFIG.write_text(json.dumps(cfg))
 def test_phone_normalization(self):
  self.assertEqual(m.phone_norm("+216 (53) 792-744"),("+21653792744","+21653792744"))
  self.assertEqual(m.phone_norm("53 792 744"),("53792744",None))

 def test_search_exact_name(self):
  hits=m.search_people("Amine Sadfi")
  self.assertEqual(len(hits),1); self.assertEqual(hits[0]["score"],100)
  self.assertEqual(hits[0]["phones"][0]["e164"],"+21653792744")

 def test_search_case_and_accent_fold(self):
  self.assertEqual(m.fold("Élodie"),"elodie")

 def test_full_sync_is_idempotent(self):
  with patch.object(m,"contact_catalog",return_value=CONTACT_ROWS), patch.object(m,"all_contact_data",return_value=DATA_ROWS), patch.object(m,"refresh_interactions",return_value=0):
   a=m.sync_directory(); b=m.sync_directory()
  c=m.connect()
  self.assertEqual(c.execute("select count(*) from people where active=1").fetchone()[0],2)
  self.assertEqual(c.execute("select count(*) from phones").fetchone()[0],3)
  self.assertEqual(a["people"],b["people"]); c.close()
 def test_cached_refresh_does_not_call_adb(self):
  with patch.object(m,"contact_catalog") as catalog:
   out=m.incremental_refresh(max_check_age=999999)
  catalog.assert_not_called(); self.assertEqual(out["mode"],"cached")

 def test_stale_refresh_without_changes_avoids_data_scan(self):
  c=m.connect(); m.meta_set(c,"last_check",0); c.commit(); c.close()
  with patch.object(m,"contact_catalog",return_value=CONTACT_ROWS), patch.object(m,"all_contact_data") as data, patch.object(m,"refresh_interactions",return_value=0):
   out=m.incremental_refresh(max_check_age=0,full_reconcile_age=999999)
  data.assert_not_called(); self.assertEqual(out["changed"],0)

 def test_incremental_refresh_updates_one_contact(self):
  c=m.connect(); m.meta_set(c,"last_check",0); m.meta_set(c,"last_contact_ts",101); c.commit(); c.close()
  changed=[CONTACT_ROWS[0],{"_id":"2","display_name":"Mehdi New","contact_last_updated_timestamp":"200"}]
  data=[r.copy() for r in DATA_ROWS if r["contact_id"]=="2"]
  for r in data: r["display_name"]="Mehdi New"
  with patch.object(m,"contact_catalog",return_value=changed), patch.object(m,"all_contact_data",return_value=data), patch.object(m,"refresh_interactions",return_value=0):
   out=m.incremental_refresh(max_check_age=0,full_reconcile_age=999999)
  self.assertEqual(out["changed"],1); self.assertEqual(m.search_people("Mehdi New")[0]["displayName"],"Mehdi New")
 def test_multiple_numbers_fail_closed_without_recent_signal(self):
  with self.assertRaisesRegex(RuntimeError,"phone_ambiguous"):
   m.resolve(query="Mehdi Test")

 def test_recent_whatsapp_resolves_multi_number(self):
  c=m.connect(); c.execute("insert into interactions values(?,?)",("+21620000002",999)); c.commit(); c.close()
  _,target=m.resolve(query="Mehdi Test")
  self.assertEqual(target,"+21620000002")

 def test_unknown_person_fails_closed(self):
  with self.assertRaisesRegex(RuntimeError,"person_not_found"):
   m.resolve(query="Nobody Exists")

 def test_local_plan_preserves_existing_direct_scope(self):
  existing={"*":{"systemPrompt":"base"},"+21653792744":{"systemPrompt":"old scope"}}
  self.set_config(["+21653792744"],existing)
  person,target=m.resolve(query="Amine Sadfi")
  prompt,effective,plan=m.local_plan(person,target,self.args())
  self.assertIsNone(prompt); self.assertEqual(effective,"existing_direct_preserved")
  self.assertFalse(plan["allowChange"]); self.assertFalse(plan["directChange"])
 def test_noop_trusted_add_never_calls_gateway(self):
  existing={"*":{"systemPrompt":"base"},"+21653792744":{"systemPrompt":"old scope"}}
  self.set_config(["+21653792744"],existing)
  with patch.object(m,"gateway_mutate_whatsapp") as mutate:
   out=m.trusted_add(self.args())
  mutate.assert_not_called(); self.assertEqual(out["configPath"],"local-noop")

 def test_gateway_mutation_combines_allow_and_scope_in_one_patch(self):
  prompt=m.scope_prompt("Amine Sadfi","claw")
  snap={"hash":"H1","config":{"channels":{"whatsapp":{"allowFrom":["+21611111111"],"direct":{"*":{"systemPrompt":"base"}}}}}}
  final={"channels":{"whatsapp":{"allowFrom":["+21611111111","+21653792744"],"direct":{"*":{"systemPrompt":"base"},"+21653792744":{"systemPrompt":prompt}}}}}
  calls=[]
  def gw(method,params=None,timeout_ms=7000):
   calls.append((method,params))
   return snap if method=="config.get" else {"config":final,"changedPaths":["channels.whatsapp.allowFrom","channels.whatsapp.direct.+21653792744"]}
  with patch.object(m,"gateway_call",side_effect=gw):
   out=m.gateway_mutate_whatsapp("+21653792744",prompt)
  self.assertTrue(out["changed"]); self.assertEqual([x[0] for x in calls],["config.get","config.patch"])
  patch_raw=json.loads(calls[1][1]["raw"])
  self.assertIn("+21653792744",patch_raw["channels"]["whatsapp"]["allowFrom"])
  self.assertEqual(calls[1][1]["baseHash"],"H1")
  self.assertEqual(calls[1][1]["replacePaths"],["channels.whatsapp.allowFrom"])
 def test_custom_scope_does_not_delegate_owner(self):
  person,target=m.resolve(query="Amine Sadfi")
  prompt,effective,plan=m.local_plan(person,target,self.args(scope="custom",scope_text="Projet Alpha uniquement"))
  self.assertIn("Projet Alpha uniquement",prompt); self.assertIn("Owner privileges are not delegated",prompt)
  self.assertTrue(plan["allowChange"]); self.assertTrue(plan["directChange"])

 def test_business_message_only_after_welcome(self):
  sent=[]
  def mutate(target,prompt):
   self.set_config([target],{"*":{"systemPrompt":"base"}})
   return {"changed":True,"changedAllow":True,"changedDirect":False}
  def send(target,msg,key): sent.append((target,msg,key)); return "MID"+str(len(sent))
  with patch.object(m,"gateway_mutate_whatsapp",side_effect=mutate), patch.object(m,"whatsapp_send",side_effect=send):
   out=m.trusted_add(self.args(silent=False,after_message="Récap Zain"))
  self.assertEqual(len(sent),2); self.assertIn("autoriser",sent[0][1]); self.assertEqual(sent[1][1],"Récap Zain")
  self.assertEqual(out["welcome"],"MID1"); self.assertEqual(out["after"],"MID2")

 def test_context_failure_rolls_back_gateway_mutation(self):
  mutation={"changed":True,"source":"gateway","changedAllow":True,"changedDirect":False,"beforeAllow":[]}
  with patch.object(m,"gateway_mutate_whatsapp",return_value=mutation), patch.object(m,"update_context",side_effect=RuntimeError("disk")), patch.object(m,"rollback_whatsapp") as rollback:
   with self.assertRaisesRegex(RuntimeError,"disk"): m.trusted_add(self.args())
  rollback.assert_called_once_with("+21653792744",mutation)

 def test_fast_mutation_failure_uses_legacy_fallback(self):
  legacy={"changed":True,"source":"legacy","changedAllow":True,"changedDirect":False}
  with patch.object(m,"gateway_mutate_whatsapp",side_effect=RuntimeError("rpc down")), patch.object(m,"legacy_mutate_whatsapp",return_value=legacy) as fallback:
   out=m.trusted_add(self.args())
  fallback.assert_called_once()
  self.assertEqual(out["configPath"],"legacy")
  self.assertEqual(out["plan"]["configFallback"],"legacy")
  self.assertIn("rpc down",out["plan"]["fastPathError"])
 def test_durable_send_replay_survives_old_receipt(self):
  self.set_config(["+21653792744"])
  with patch.object(m,"gateway_call",return_value={"channel":"whatsapp","messageId":"MID-DURABLE"}) as gw:
   first=m.whatsapp_send("+21653792744","hello","durable-key")
   c=m.connect(); c.execute("update send_receipts set updated_at=1 where idempotency_key='durable-key'"); c.commit(); c.close()
   second=m.whatsapp_send("+21653792744","hello","durable-key")
  self.assertEqual(first,"MID-DURABLE"); self.assertEqual(second,"MID-DURABLE")
  self.assertEqual(gw.call_count,1)

 def test_idempotency_key_conflict_rejected(self):
  self.set_config(["+21653792744"])
  with patch.object(m,"gateway_call",return_value={"channel":"whatsapp","messageId":"MID1"}) as gw:
   m.whatsapp_send("+21653792744","hello","same-key")
   with self.assertRaisesRegex(RuntimeError,"idempotency_key_conflict"):
    m.whatsapp_send("+21653792744","different","same-key")
  self.assertEqual(gw.call_count,1)

 def test_uncertain_send_is_never_replayed_automatically(self):
  self.set_config(["+21653792744"])
  with patch.object(m,"gateway_call",side_effect=RuntimeError("timeout")) as gw:
   with self.assertRaisesRegex(RuntimeError,"timeout"):
    m.whatsapp_send("+21653792744","hello","uncertain-key")
   with self.assertRaisesRegex(RuntimeError,"send_state_uncertain_no_retry"):
    m.whatsapp_send("+21653792744","hello","uncertain-key")
  self.assertEqual(gw.call_count,1)

 def test_send_rejects_target_outside_local_allowlist(self):
  with self.assertRaisesRegex(RuntimeError,"target_not_allowlisted"):
   m.whatsapp_send("+21699999999","hello","k")

if __name__=="__main__": unittest.main(verbosity=2)
