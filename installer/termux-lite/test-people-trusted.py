#!/data/data/com.termux/files/usr/bin/python3
import importlib.util, json, tempfile, unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

MODULE=Path(__file__).with_name("people-trusted.py")
spec=importlib.util.spec_from_file_location("people_trusted",MODULE)
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

CONTACTS=[
 {"_id":"1","display_name":"Amine Sadfi"},
 {"_id":"2","display_name":"Mehdi Test"},
]
PHONES=[
 {"contact_id":"1","display_name":"Amine Sadfi","data1":"+216 53 792 744","data2":"2"},
 {"contact_id":"2","display_name":"Mehdi Test","data1":"+216 20 000 001","data2":"2"},
 {"contact_id":"2","display_name":"Mehdi Test","data1":"+216 20 000 002","data2":"2"},
]
EMAILS=[{"contact_id":"1","display_name":"Amine Sadfi","data1":"amine@example.com","data2":None}]
NAMES=[
 {"contact_id":"1","display_name":"Amine Sadfi","data2":"Amine","data3":"Sadfi"},
 {"contact_id":"2","display_name":"Mehdi Test","data2":"Mehdi","data3":"Test"},
]
class PeopleTrustedTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); root=Path(self.tmp.name)
  self.old=(m.ROOT,m.DB,m.WORKSPACE,m.CONTACTS)
  m.ROOT=root/"people"; m.DB=m.ROOT/"directory.db"
  m.WORKSPACE=root/"workspace"; m.CONTACTS=m.WORKSPACE/"memory"/"whatsapp"/"contacts"
  m.CONTACTS.mkdir(parents=True)
  with patch.object(m,"source_snapshot",return_value=(CONTACTS,PHONES,EMAILS,NAMES)), patch.object(m,"refresh_interactions",return_value=0):
   m.sync_directory()

 def tearDown(self):
  m.ROOT,m.DB,m.WORKSPACE,m.CONTACTS=self.old
  self.tmp.cleanup()

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
  with patch.object(m,"source_snapshot",return_value=(CONTACTS,PHONES,EMAILS,NAMES)), patch.object(m,"refresh_interactions",return_value=0):
   a=m.sync_directory(); b=m.sync_directory()
  c=m.connect()
  self.assertEqual(c.execute("select count(*) from people where active=1").fetchone()[0],2)
  self.assertEqual(c.execute("select count(*) from phones").fetchone()[0],3)
  self.assertEqual(a["people"],b["people"]); c.close()

 def test_multiple_numbers_fail_closed_without_recent_signal(self):
  with self.assertRaisesRegex(RuntimeError,"phone_ambiguous"):
   m.resolve(query="Mehdi Test")

 def test_recent_whatsapp_resolves_multi_number(self):
  c=m.connect(); c.execute("insert into interactions values(?,?)",("+21620000002",999)); c.commit()
  p,target=m.resolve(query="Mehdi Test")
  self.assertEqual(target,"+21620000002")

 def test_unknown_person_fails_closed(self):
  with self.assertRaisesRegex(RuntimeError,"person_not_found"):
   m.resolve(query="Nobody Exists")
 def args(self,**kw):
  base=dict(query="Amine Sadfi",person_id=None,e164=None,scope="standard",scope_text=None,
            silent=True,after_message=None,dry_run=False)
  base.update(kw); return Namespace(**base)

 def test_trusted_add_preserves_existing_allowlist(self):
  state={"channels.whatsapp.allowFrom":["+21611111111"],"channels.whatsapp.direct":{"*":{"systemPrompt":"base"}}}
  def get(path): return json.loads(json.dumps(state[path]))
  def setv(path,new,old): self.assertEqual(state[path],old); state[path]=json.loads(json.dumps(new))
  with patch.object(m,"cfg_get",side_effect=get), patch.object(m,"cfg_set",side_effect=setv):
   out=m.trusted_add(self.args())
  self.assertEqual(out["state"],"verified")
  self.assertEqual(state["channels.whatsapp.allowFrom"],["+21611111111","+21653792744"])
  self.assertEqual(state["channels.whatsapp.direct"],{"*":{"systemPrompt":"base"}})

 def test_custom_scope_does_not_delegate_owner(self):
  state={"channels.whatsapp.allowFrom":[],"channels.whatsapp.direct":{"*":{"systemPrompt":"base"}}}
  def get(path): return json.loads(json.dumps(state[path]))
  def setv(path,new,old): state[path]=json.loads(json.dumps(new))
  with patch.object(m,"cfg_get",side_effect=get), patch.object(m,"cfg_set",side_effect=setv):
   m.trusted_add(self.args(scope="custom",scope_text="Projet Alpha uniquement"))
  prompt=state["channels.whatsapp.direct"]["+21653792744"]["systemPrompt"]
  self.assertIn("Projet Alpha uniquement",prompt); self.assertIn("Owner privileges are not delegated",prompt)
 def test_business_message_only_after_welcome(self):
  state={"channels.whatsapp.allowFrom":[],"channels.whatsapp.direct":{"*":{"systemPrompt":"base"}}}; sent=[]
  def get(path): return json.loads(json.dumps(state[path]))
  def setv(path,new,old): state[path]=json.loads(json.dumps(new))
  def send(target,msg,key): sent.append((target,msg,key)); return "MID"+str(len(sent))
  with patch.object(m,"cfg_get",side_effect=get), patch.object(m,"cfg_set",side_effect=setv), patch.object(m,"whatsapp_send",side_effect=send):
   out=m.trusted_add(self.args(silent=False,after_message="Récap Zain"))
  self.assertEqual(len(sent),2); self.assertIn("autoriser",sent[0][1]); self.assertEqual(sent[1][1],"Récap Zain")
  self.assertEqual(out["welcome"],"MID1"); self.assertEqual(out["after"],"MID2")

 def test_config_failure_rolls_back_allowlist(self):
  state={"channels.whatsapp.allowFrom":[],"channels.whatsapp.direct":{"*":{"systemPrompt":"base"}}}; calls=[]
  def get(path): return json.loads(json.dumps(state[path]))
  def setv(path,new,old):
   calls.append(path)
   if path.endswith("direct"): raise RuntimeError("boom")
   state[path]=json.loads(json.dumps(new))
  with patch.object(m,"cfg_get",side_effect=get), patch.object(m,"cfg_set",side_effect=setv):
   with self.assertRaisesRegex(RuntimeError,"boom"):
    m.trusted_add(self.args(scope="claw"))
  self.assertEqual(state["channels.whatsapp.allowFrom"],[])

if __name__=="__main__": unittest.main(verbosity=2)
