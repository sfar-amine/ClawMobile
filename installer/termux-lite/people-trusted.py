#!/data/data/com.termux/files/usr/bin/python3
import argparse, hashlib, json, os, re, sqlite3, subprocess, sys, time, unicodedata
from pathlib import Path
from contextlib import closing

HOME=Path.home()
ROOT=Path(os.environ.get("SAMANTHA_PEOPLE_ROOT", HOME/".openclaw"/"people"))
DB=ROOT/"directory.db"
WORKSPACE=Path(os.environ.get("SAMANTHA_WORKSPACE", HOME/".openclaw"/"workspace"))
CONTACTS=WORKSPACE/"memory"/"whatsapp"/"contacts"
CONFIG=Path(os.environ.get("OPENCLAW_CONFIG_PATH", HOME/".openclaw"/"openclaw.json"))
SESSION_DB=HOME/".openclaw"/"agents"/"main"/"agent"/"openclaw-agent.sqlite"
ADB_SERIAL=os.environ.get("SAMANTHA_ADB_SERIAL","127.0.0.1:5556")
NAME_MIME="vnd.android.cursor.item/name"
PHONE_MIME="vnd.android.cursor.item/phone_v2"
EMAIL_MIME="vnd.android.cursor.item/email_v2"

def run(args, timeout=20, check=True):
    p=subprocess.run(args,text=True,capture_output=True,timeout=timeout)
    if check and p.returncode:
        raise RuntimeError(f"{' '.join(args[:4])}: {p.stderr.strip() or p.stdout.strip()}")
    return p
def connect():
    ROOT.mkdir(parents=True,exist_ok=True)
    c=sqlite3.connect(DB,timeout=30)
    c.row_factory=sqlite3.Row
    c.executescript("""CREATE TABLE IF NOT EXISTS people(
      person_id TEXT PRIMARY KEY,source_contact_id TEXT UNIQUE,display_name TEXT,
      first_name TEXT,last_name TEXT,active INTEGER NOT NULL,last_sync INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS phones(person_id TEXT,raw TEXT,normalized TEXT,e164 TEXT,
      UNIQUE(person_id,normalized));
    CREATE TABLE IF NOT EXISTS emails(person_id TEXT,email TEXT COLLATE NOCASE,
      UNIQUE(person_id,email));
    CREATE TABLE IF NOT EXISTS interactions(e164 TEXT PRIMARY KEY,last_interaction_ms INTEGER);
    CREATE TABLE IF NOT EXISTS send_receipts(
      idempotency_key TEXT PRIMARY KEY,target TEXT NOT NULL,message_sha256 TEXT NOT NULL,
      state TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);""")
    return c

def meta_get(c,key,default=None):
    row=c.execute("SELECT value FROM meta WHERE key=?",(key,)).fetchone()
    return row[0] if row else default

def meta_set(c,key,value):
    c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)",(key,str(value)))
def fold(v):
    s=unicodedata.normalize("NFKD",v or "")
    return "".join(ch for ch in s if not unicodedata.combining(ch)).casefold().strip()

def phone_norm(raw):
    raw=(raw or "").strip()
    digits=re.sub(r"\D","",raw)
    normalized=("+"+digits) if raw.startswith("+") else digits
    e164=normalized if normalized.startswith("+") and 8 <= len(digits) <= 15 else None
    return normalized,e164

def parse_rows(text):
    out=[]
    for line in text.splitlines():
        if not line.startswith("Row: "): continue
        body=re.sub(r"^Row: \d+\s+","",line)
        row={}
        for part in re.split(r", (?=[A-Za-z0-9_]+=)",body):
            if "=" in part:
                k,v=part.split("=",1); row[k]=None if v=="NULL" else v
        out.append(row)
    return out

def adb_rows(uri,projection,where=None):
    args=["adb","-s",ADB_SERIAL,"shell","content","query","--uri",uri,"--projection",projection]
    if where: args += ["--where",f"'{where}'"]
    return parse_rows(run(args,timeout=30).stdout)
def contact_catalog():
    return adb_rows("content://com.android.contacts/contacts",
                    "_id:display_name:contact_last_updated_timestamp")

def all_contact_data(where=None):
    return adb_rows("content://com.android.contacts/data",
                    "contact_id:display_name:data1:data2:data3:mimetype",where)

def build_people(contacts,data_rows):
    by={}
    def item(cid):
        return by.setdefault(str(cid),{"display_name":None,"first_name":None,"last_name":None,
                                      "phones":[],"emails":[]})
    for r in contacts:
        cid=r.get("_id")
        if cid is not None: item(cid)["display_name"]=r.get("display_name")
    for r in data_rows:
        cid=r.get("contact_id")
        if cid is None: continue
        x=item(cid); x["display_name"]=r.get("display_name") or x["display_name"]
        mime=r.get("mimetype")
        if mime==NAME_MIME:
            x["first_name"]=r.get("data2") or x["first_name"]
            x["last_name"]=r.get("data3") or x["last_name"]
        elif mime==PHONE_MIME and r.get("data1"): x["phones"].append(r["data1"])
        elif mime==EMAIL_MIME and r.get("data1"): x["emails"].append(r["data1"].strip())
    return by
def upsert_person(c,cid,x,now):
    pid="person_"+hashlib.sha256(("android:"+str(cid)).encode()).hexdigest()[:16]
    c.execute("""INSERT INTO people VALUES(?,?,?,?,?,1,?)
      ON CONFLICT(source_contact_id) DO UPDATE SET display_name=excluded.display_name,
      first_name=excluded.first_name,last_name=excluded.last_name,active=1,last_sync=excluded.last_sync""",
      (pid,str(cid),x["display_name"] or "",x["first_name"],x["last_name"],now))
    c.execute("DELETE FROM phones WHERE person_id=?",(pid,))
    c.execute("DELETE FROM emails WHERE person_id=?",(pid,))
    for raw in dict.fromkeys(x["phones"]):
        norm,e164=phone_norm(raw)
        if norm: c.execute("INSERT OR IGNORE INTO phones VALUES(?,?,?,?)",(pid,raw,norm,e164))
    for email in dict.fromkeys(x["emails"]):
        if email: c.execute("INSERT OR IGNORE INTO emails VALUES(?,?)",(pid,email))
    return pid

def refresh_interactions(c):
    if not SESSION_DB.exists(): return 0
    src=sqlite3.connect(f"file:{SESSION_DB}?mode=ro",uri=True)
    rows=src.execute("""SELECT peer_id,MAX(updated_at) FROM conversations
      WHERE channel='whatsapp' AND kind='direct' AND peer_id LIKE '+%' GROUP BY peer_id""").fetchall()
    src.close()
    for e164,ts in rows:
        if re.fullmatch(r"\+\d{7,15}",e164 or ""):
            c.execute("""INSERT INTO interactions(e164,last_interaction_ms) VALUES(?,?)
              ON CONFLICT(e164) DO UPDATE SET last_interaction_ms=max(last_interaction_ms,excluded.last_interaction_ms)""",
              (e164,int(ts or 0)))
    return len(rows)
def sync_directory():
    contacts=contact_catalog(); data=all_contact_data(); by=build_people(contacts,data)
    now=int(time.time()); c=connect(); c.execute("BEGIN"); c.execute("UPDATE people SET active=0")
    for cid,x in by.items(): upsert_person(c,cid,x,now)
    interactions=refresh_interactions(c)
    stamps=[int(r.get("contact_last_updated_timestamp") or 0) for r in contacts]
    meta_set(c,"last_sync",now); meta_set(c,"last_full_sync",now); meta_set(c,"last_check",now)
    meta_set(c,"last_contact_ts",max(stamps or [0]))
    c.commit(); c.close()
    phone_rows=sum(1 for r in data if r.get("mimetype")==PHONE_MIME and r.get("data1"))
    email_rows=sum(1 for r in data if r.get("mimetype")==EMAIL_MIME and r.get("data1"))
    name_rows=sum(1 for r in data if r.get("mimetype")==NAME_MIME)
    return {"mode":"full","people":len(by),"contact_rows":len(contacts),"phone_rows":phone_rows,
            "email_rows":email_rows,"name_rows":name_rows,
            "whatsapp_interactions":interactions,"last_sync":now}

def incremental_refresh(max_check_age=300,full_reconcile_age=86400):
    now=int(time.time()); c=connect()
    last_check=int(meta_get(c,"last_check","0")); last_full=int(meta_get(c,"last_full_sync","0"))
    last_ts=int(meta_get(c,"last_contact_ts","0"))
    active_ids={r[0] for r in c.execute("SELECT source_contact_id FROM people WHERE active=1")}
    if not last_full:
        c.close(); return sync_directory()
    if now-last_check < max_check_age:
        n=refresh_interactions(c); c.commit(); c.close()
        return {"mode":"cached","changed":0,"whatsapp_interactions":n,"last_check":last_check}
    c.close()
    contacts=contact_catalog()
    current_ids={str(r.get("_id")) for r in contacts if r.get("_id") is not None}
    stamps=[int(r.get("contact_last_updated_timestamp") or 0) for r in contacts]
    max_ts=max(stamps or [0])
    if now-last_full >= full_reconcile_age or active_ids-current_ids or max_ts < last_ts:
        return sync_directory()
    changed=[r for r in contacts if int(r.get("contact_last_updated_timestamp") or 0)>last_ts]
    if len(changed)>25: return sync_directory()
    c=connect(); c.execute("BEGIN")
    for r in changed:
        cid=str(r["_id"])
        data=all_contact_data(f"contact_id={cid}")
        x=build_people([r],data).get(cid,{"display_name":r.get("display_name"),"first_name":None,
                                         "last_name":None,"phones":[],"emails":[]})
        upsert_person(c,cid,x,now)
    n=refresh_interactions(c)
    meta_set(c,"last_check",now); meta_set(c,"last_sync",now); meta_set(c,"last_contact_ts",max_ts)
    c.commit(); c.close()
    return {"mode":"incremental","changed":len(changed),"whatsapp_interactions":n,
            "last_contact_ts":max_ts,"last_check":now}

def ensure_fresh(max_check_age=300):
    return incremental_refresh(max_check_age=max_check_age)

def person_dict(c,row):
    pid=row["person_id"]
    phones=[dict(r) for r in c.execute("SELECT raw,normalized,e164 FROM phones WHERE person_id=? ORDER BY e164 DESC,normalized",(pid,))]
    emails=[r[0] for r in c.execute("SELECT email FROM emails WHERE person_id=? ORDER BY email",(pid,))]
    recent=[]
    for p in phones:
        if p["e164"]:
            q=c.execute("SELECT last_interaction_ms FROM interactions WHERE e164=?",(p["e164"],)).fetchone()
            if q: recent.append({"e164":p["e164"],"lastInteractionAt":q[0]})
    return {"personId":pid,"sourceContactId":row["source_contact_id"],"displayName":row["display_name"],
            "firstName":row["first_name"],"lastName":row["last_name"],"phones":phones,
            "emails":emails,"recentWhatsApp":sorted(recent,key=lambda x:x["lastInteractionAt"],reverse=True),
            "lastSync":row["last_sync"]}

def search_people(query,limit=10):
    q=fold(query); c=connect(); results=[]
    for row in c.execute("SELECT * FROM people WHERE active=1"):
        p=person_dict(c,row); fields=[p["displayName"],p["firstName"],p["lastName"],*p["emails"]]
        fields += [x["raw"] for x in p["phones"]]+[x["normalized"] for x in p["phones"]]
        score=0
        for v in fields:
            f=fold(v)
            if not f: continue
            if f==q: score=max(score,100)
            elif f.startswith(q): score=max(score,85)
            elif q in f: score=max(score,70)
        if score: p["score"]=score; results.append(p)
    results.sort(key=lambda x:(-x["score"],-max([i["lastInteractionAt"] for i in x["recentWhatsApp"]] or [0]),x["displayName"]))
    out=results[:limit]; c.close(); return out

def get_person(person_id):
    c=connect(); r=c.execute("SELECT * FROM people WHERE person_id=? AND active=1",(person_id,)).fetchone()
    out=person_dict(c,r) if r else None; c.close(); return out
def resolve(query=None,person_id=None,e164=None):
    if person_id:
        p=get_person(person_id)
        if not p: raise RuntimeError("person_not_found")
    else:
        hits=search_people(query or "")
        if not hits: raise RuntimeError("person_not_found")
        top=hits[0]["score"]; peers=[h for h in hits if h["score"]==top]
        if len(peers)!=1: raise RuntimeError("identity_ambiguous")
        p=peers[0]
    candidates=[x["e164"] for x in p["phones"] if x["e164"]]
    if e164:
        if e164 not in candidates: raise RuntimeError("requested_e164_not_on_person")
        target=e164
    elif len(candidates)==1: target=candidates[0]
    else:
        recent=list(dict.fromkeys(x["e164"] for x in p["recentWhatsApp"] if x["e164"] in candidates))
        if len(recent)==1: target=recent[0]
        else: raise RuntimeError("phone_ambiguous_or_not_e164")
    return p,target

def local_config():
    try: return json.loads(CONFIG.read_text())
    except Exception as e: raise RuntimeError(f"local_config_invalid:{e}")

def whatsapp_state(cfg=None):
    cfg=cfg or local_config()
    wa=cfg.get("channels",{}).get("whatsapp",{})
    return list(wa.get("allowFrom",[])),dict(wa.get("direct",{}))
def gateway_call(method,params=None,timeout_ms=7000):
    args=["openclaw","gateway","call",method,"--json","--timeout",str(timeout_ms)]
    if params is not None:
        args += ["--params",json.dumps(params,ensure_ascii=False,separators=(",",":"))]
    p=run(args,timeout=(timeout_ms/1000)+5)
    try: return json.loads(p.stdout)
    except Exception as e: raise RuntimeError(f"invalid_gateway_response:{method}:{e}")

def desired_whatsapp(allow,direct,target,prompt):
    new_allow=list(allow)
    if target not in new_allow: new_allow.append(target)
    new_direct=dict(direct)
    if prompt: new_direct[target]={"systemPrompt":prompt}
    return new_allow,new_direct

def gateway_mutate_whatsapp(target,prompt):
    snap=gateway_call("config.get",{})
    allow,direct=whatsapp_state(snap.get("config") or {})
    new_allow,new_direct=desired_whatsapp(allow,direct,target,prompt)
    changed_allow=new_allow!=allow; changed_direct=new_direct!=direct
    if not changed_allow and not changed_direct:
        return {"changed":False,"allow":allow,"direct":direct}
    patch={"channels":{"whatsapp":{}}}; replace=[]
    if changed_allow:
        patch["channels"]["whatsapp"]["allowFrom"]=new_allow
        replace.append("channels.whatsapp.allowFrom")
    if changed_direct:
        patch["channels"]["whatsapp"]["direct"]={target:new_direct[target]}
    params={"raw":json.dumps(patch,ensure_ascii=False,separators=(",",":")),
            "baseHash":snap["hash"],"note":"people-trusted onboarding"}
    if replace: params["replacePaths"]=replace
    out=gateway_call("config.patch",params)
    cfg=out.get("config") or {}
    got_allow,got_direct=whatsapp_state(cfg)
    if target not in got_allow: raise RuntimeError("allowlist_verify_failed")
    if prompt and got_direct.get(target,{}).get("systemPrompt")!=prompt:
        raise RuntimeError("direct_verify_failed")
    return {"changed":True,"source":"gateway","changedAllow":changed_allow,"changedDirect":changed_direct,
            "beforeAllow":allow,"beforeDirectTarget":direct.get(target),
            "allow":got_allow,"direct":got_direct,"changedPaths":out.get("changedPaths",[])}

def legacy_cfg_get(path):
    return json.loads(run(["openclaw","config","get",path],timeout=15).stdout)

def legacy_cfg_set(path,new,old,timeout=25):
    run(["openclaw","config","set",path,json.dumps(new,ensure_ascii=False,separators=(",",":")),
         "--strict-json","--expect-current-json",json.dumps(old,ensure_ascii=False,separators=(",",":"))],timeout=timeout)

def legacy_mutate_whatsapp(target,prompt):
    allow=legacy_cfg_get("channels.whatsapp.allowFrom")
    direct=legacy_cfg_get("channels.whatsapp.direct")
    new_allow,new_direct=desired_whatsapp(allow,direct,target,prompt)
    changed_allow=new_allow!=allow; changed_direct=new_direct!=direct
    if changed_allow: legacy_cfg_set("channels.whatsapp.allowFrom",new_allow,allow)
    try:
        if changed_direct: legacy_cfg_set("channels.whatsapp.direct",new_direct,direct)
    except Exception:
        if changed_allow:
            try: legacy_cfg_set("channels.whatsapp.allowFrom",allow,new_allow)
            except Exception: pass
        raise
    got_allow=legacy_cfg_get("channels.whatsapp.allowFrom")
    got_direct=legacy_cfg_get("channels.whatsapp.direct")
    if target not in got_allow: raise RuntimeError("legacy_allowlist_verify_failed")
    if prompt and got_direct.get(target,{}).get("systemPrompt")!=prompt:
        raise RuntimeError("legacy_direct_verify_failed")
    return {"changed":changed_allow or changed_direct,"source":"legacy",
            "changedAllow":changed_allow,"changedDirect":changed_direct,
            "beforeAllow":allow,"beforeDirectTarget":direct.get(target),
            "allow":got_allow,"direct":got_direct}

def gateway_rollback_whatsapp(target,mutation):
    if not mutation.get("changed"): return
    snap=gateway_call("config.get",{})
    patch={"channels":{"whatsapp":{}}}; replace=[]
    if mutation.get("changedAllow"):
        patch["channels"]["whatsapp"]["allowFrom"]=mutation["beforeAllow"]
        replace.append("channels.whatsapp.allowFrom")
    if mutation.get("changedDirect"):
        patch["channels"]["whatsapp"]["direct"]={target:mutation.get("beforeDirectTarget")}
    params={"raw":json.dumps(patch,ensure_ascii=False,separators=(",",":")),
            "baseHash":snap["hash"],"note":"people-trusted rollback"}
    if replace: params["replacePaths"]=replace
    gateway_call("config.patch",params)

def rollback_whatsapp(target,mutation):
    if not mutation.get("changed"): return
    if mutation.get("source")!="legacy":
        return gateway_rollback_whatsapp(target,mutation)
    allow=legacy_cfg_get("channels.whatsapp.allowFrom")
    direct=legacy_cfg_get("channels.whatsapp.direct")
    if mutation.get("changedDirect"):
        restored=dict(direct)
        if mutation.get("beforeDirectTarget") is None: restored.pop(target,None)
        else: restored[target]=mutation["beforeDirectTarget"]
        legacy_cfg_set("channels.whatsapp.direct",restored,direct)
    if mutation.get("changedAllow"):
        current=legacy_cfg_get("channels.whatsapp.allowFrom")
        legacy_cfg_set("channels.whatsapp.allowFrom",mutation["beforeAllow"],current)

def scope_prompt(name,scope,custom=None):
    if scope=="standard": return None
    if scope=="claw":
        return (f"You are speaking with {name}. Amine explicitly authorizes this contact to ask about the Claw project "
                "and its non-secret technical documentation without case-by-case authorization. Do not disclose unrelated "
                "private information, credentials, secrets, tokens, cookies, OTP/2FA, personal data about other contacts, "
                "or sensitive payloads. Owner privileges are not delegated.")
    if scope=="custom" and custom:
        return (f"You are speaking with {name}. Amine authorizes this contact for the following scope only: {custom}. "
                "Do not extend that scope. Never disclose unrelated private information, credentials, secrets, tokens, "
                "cookies, OTP/2FA, or other contacts' personal data. Owner privileges are not delegated.")
    raise RuntimeError("invalid_scope")

def update_context(person,target,scope,custom):
    CONTACTS.mkdir(parents=True,exist_ok=True)
    path=CONTACTS/("wa_"+re.sub(r"\D","",target)+".md")
    old=path.read_text() if path.exists() else None
    marker_start="<!-- TRUSTED_CONTACT_START -->"; marker_end="<!-- TRUSTED_CONTACT_END -->"
    block=(f"{marker_start}\n## Trusted contact authorization\n- Verified identity: {person['displayName']}\n"
           f"- E164: {target}\n- Authorized by Amine for direct WhatsApp conversation.\n"
           f"- Delegated scope: {scope if scope!='custom' else custom}\n"
           "- Owner privileges: not delegated.\n"
           "- Secrets, credentials, OTP/2FA and unrelated private data remain excluded.\n"
           f"{marker_end}")
    base=old or (f"# WhatsApp Contact Context\n\n- WhatsApp ID: {target}\n- Verified name: {person['displayName']}\n"
                 "- Relationship/context: Authorized contact of Amine.\n- Preferred language/style: learn from conversation\n"
                 "- Last compacted: not yet\n\n## Stable context\n\n## Open threads\n\n## Commitments / follow-ups\n"
                 "\n## Communication preferences\n\n## Recent compact summaries\n")
    if marker_start in base and marker_end in base:
        base=re.sub(re.escape(marker_start)+r".*?"+re.escape(marker_end),block,base,flags=re.S)
    else: base=base.rstrip()+"\n\n"+block+"\n"
    tmp=path.with_suffix(".tmp"); tmp.write_text(base); os.replace(tmp,path)
    return path,old

def restore_context(path,old):
    if old is None:
        try: path.unlink()
        except FileNotFoundError: pass
    else: path.write_text(old)

def send_digest(target,message):
    return hashlib.sha256((target+"\0"+message).encode()).hexdigest()

def reserve_send(key,target,digest):
    if not key or len(key)>256: raise RuntimeError("invalid_idempotency_key")
    c=connect(); now=int(time.time()); c.execute("BEGIN IMMEDIATE")
    row=c.execute("""SELECT target,message_sha256,state,message_id FROM send_receipts
                     WHERE idempotency_key=?""",(key,)).fetchone()
    if row:
        c.commit(); c.close()
        if row["target"]!=target or row["message_sha256"]!=digest:
            raise RuntimeError("idempotency_key_conflict")
        if row["state"]=="accepted" and row["message_id"]:
            return {"state":"accepted","messageId":row["message_id"],"replay":True}
        raise RuntimeError("send_state_uncertain_no_retry")
    c.execute("""INSERT INTO send_receipts(idempotency_key,target,message_sha256,state,message_id,created_at,updated_at)
                 VALUES(?,?,?,'pending',NULL,?,?)""",(key,target,digest,now,now))
    c.commit(); c.close(); return {"state":"reserved","replay":False}

def finish_send(key,state,message_id=None):
    c=connect(); now=int(time.time())
    c.execute("UPDATE send_receipts SET state=?,message_id=?,updated_at=? WHERE idempotency_key=?",
              (state,message_id,now,key))
    c.commit(); c.close()

def whatsapp_send(target,message,key):
    allow,_=whatsapp_state()
    if target not in allow: raise RuntimeError("target_not_allowlisted")
    digest=send_digest(target,message)
    reservation=reserve_send(key,target,digest)
    if reservation["state"]=="accepted": return reservation["messageId"]
    params={"to":target,"message":message,"channel":"whatsapp","accountId":"default","idempotencyKey":key}
    try:
        out=gateway_call("send",params,timeout_ms=10000)
        mid=out.get("messageId")
        if out.get("channel")!="whatsapp" or not mid: raise RuntimeError("invalid_send_response")
    except Exception:
        finish_send(key,"uncertain")
        raise
    finish_send(key,"accepted",mid)
    return mid

def local_plan(person,target,args):
    allow,direct=whatsapp_state(); prompt=scope_prompt(person["displayName"],args.scope,args.scope_text)
    new_allow,new_direct=desired_whatsapp(allow,direct,target,prompt)
    effective=args.scope if prompt or target not in direct else "existing_direct_preserved"
    return prompt,effective,{"personId":person["personId"],"displayName":person["displayName"],"e164":target,
      "scope":args.scope,"effectiveScope":effective,"allowChange":new_allow!=allow,
      "directChange":new_direct!=direct,"silent":args.silent,"afterMessage":bool(args.after_message)}
def trusted_add(args):
    person,target=resolve(args.query,args.person_id,args.e164)
    prompt,effective_scope,plan=local_plan(person,target,args)
    if args.dry_run: return {"state":"dry_run","plan":plan}
    mutation={"changed":False}; path=oldctx=None
    try:
        if plan["allowChange"] or plan["directChange"]:
            try:
                mutation=gateway_mutate_whatsapp(target,prompt)
                plan["configFallback"]="none"
            except Exception as fast_error:
                mutation=legacy_mutate_whatsapp(target,prompt)
                plan["configFallback"]="legacy"
                plan["fastPathError"]=str(fast_error)[:160]
            plan["allowChange"]=bool(mutation.get("changedAllow"))
            plan["directChange"]=bool(mutation.get("changedDirect"))
        path,oldctx=update_context(person,target,effective_scope,args.scope_text)
    except Exception:
        if path: restore_context(path,oldctx)
        try: rollback_whatsapp(target,mutation)
        except Exception: pass
        raise
    source=mutation.get("source") if mutation.get("changed") else "local-noop"
    result={"state":"verified","plan":plan,"configPath":source,
            "context":str(path),"welcome":"not_requested","after":"not_requested"}
    if not args.silent:
        first=person["displayName"].split()[0] if person["displayName"] else ""
        welcome=f"Salut {first}, Amine vient de t'autoriser à échanger directement avec Samantha sur WhatsApp."
        key="trusted:welcome:"+re.sub(r"\D","",target)+":"+hashlib.sha256(prompt.encode() if prompt else b"standard").hexdigest()[:12]
        result["welcome"]=whatsapp_send(target,welcome,key)
    if args.after_message:
        key="trusted:after:"+re.sub(r"\D","",target)+":"+hashlib.sha256(args.after_message.encode()).hexdigest()[:12]
        result["after"]=whatsapp_send(target,args.after_message,key)
    return result
# R17: extend these existing owners, never a parallel registry.
"""R17 extension of People Directory/receipts, config and private contact context.

JSON stdin, closed JSON stdout. No networking during imports, no new persistence.
"""
import argparse
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time
from datetime import datetime, timezone

MARKER = '<!-- samantha-allowlist v1 -->'
END = '<!-- /samantha-allowlist -->'
NOTE = '<!-- samantha-private-note -->'
NOTE_END = '<!-- /samantha-private-note -->'
OP = re.compile(r'[A-Za-z0-9_.:-]{1,128}\Z')
CID = re.compile(r'wa-[a-f0-9]{16}\Z')
E164 = re.compile(r'\+[1-9][0-9]{7,14}\Z')
FIELDS = {'state', 'scope', 'scopeText', 'expiresAt', 'addedAt', 'suspendedScope', 'personId'}
EVENTS = {'add':'added', 'remove':'removed', 'scope':'scope_changed', 'suspend':'suspended',
          'reactivate':'reactivated', 'expiry':'extended', 'note':'note_updated', 'sweep':'expired'}

class Refused(Exception):
    def __init__(self, code, status=400): self.code, self.status = code, status

def fail(code, status=400): raise Refused(code, status)
def digest(value): return hashlib.sha256(value.encode('utf-8')).hexdigest()
def canonical(value): return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
def contact_id(number): return 'wa-' + digest(number)[:16]
def utc(timestamp): return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
def stamp(value):
    try: return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (TypeError, ValueError, AttributeError): fail('contact_state_invalid', 503)
def safe_text(value, limit, empty=True):
    if not isinstance(value, str) or len(value) > limit or (not empty and not value) or any(ord(c)<32 or ord(c)==127 for c in value): fail('invalid_request')
    return value

def request_hash(action, body):
    return digest(canonical({'action':action, **{k:v for k,v in body.items() if k not in ('requestHash','expectedAuthority')}}))

class _ExistingPeopleOwner:
    def __getattr__(self, name): return globals()[name]

class Contacts:
    def __init__(self, people, clock=time.time, state_dir=None):
        self.people, self.clock = people, clock
        self.state_dir = Path(state_dir or os.environ.get('OPENCLAW_STATE_DIR', Path.home()/'.openclaw'))
    def local_config(self):
        try: value=self.people.local_config()
        except Exception: fail('contacts_unavailable', 503)
        if not isinstance(value, dict): fail('contacts_unavailable', 503)
        return value
    def owners(self, config):
        values=config.get('commands', {}).get('ownerAllowFrom', [])
        owners={v[9:] for v in values if isinstance(v,str) and v.startswith('whatsapp:') and E164.fullmatch(v[9:])}
        if not owners: fail('owner_contact_unknown', 503)
        return owners
    def directory(self):
        people={};activity={}
        try:
            if self.people.DB.exists():
                connection=sqlite3.connect(f'file:{self.people.DB}?mode=ro', uri=True,timeout=1)
                connection.row_factory=sqlite3.Row
                for row in connection.execute('SELECT phones.e164, people.person_id, people.display_name FROM phones JOIN people USING(person_id) WHERE people.active=1'):
                    if row['e164'] and E164.fullmatch(row['e164']): people.setdefault(row['e164'], {'personId':row['person_id'],'name':row['display_name']})
                connection.close()
            # PR48 S24 schema: WhatsApp provider timestamp, never conversation
            # updated_at or Gateway persistence time. One read for the page.
            if self.people.SESSION_DB.exists():
                with closing(sqlite3.connect(f'file:{self.people.SESSION_DB}?mode=ro',uri=True,timeout=1)) as sessions:
                    sessions.execute('PRAGMA query_only=ON')
                    deadline=time.monotonic()+2
                    sessions.set_progress_handler(lambda: int(time.monotonic()>deadline),1000)
                    records=sessions.execute("""
                      SELECT sw.session_key,
                        MAX(CASE WHEN json_valid(te.event_json)
                          AND json_extract(te.event_json,'$.type')='message'
                          AND json_extract(te.event_json,'$.message.role')='user'
                          AND json_extract(te.event_json,'$.message.__openclaw.transport.channel')='whatsapp'
                          AND json_type(te.event_json,'$.message.timestamp') IN ('integer','real')
                          THEN json_extract(te.event_json,'$.message.timestamp') END) AS inbound_ms,
                        (SELECT newest.created_at FROM transcript_events newest WHERE newest.session_id=sw.session_id ORDER BY newest.seq DESC LIMIT 1) AS latest_at,
                        (SELECT newest.event_json IS NULL AND newest.event_zstd IS NOT NULL FROM transcript_events newest WHERE newest.session_id=sw.session_id ORDER BY newest.seq DESC LIMIT 1) AS archived
                      FROM session_windows sw JOIN transcript_events te USING(session_id)
                      WHERE sw.channel='whatsapp' AND sw.chat_type='direct'
                        AND sw.session_key LIKE 'agent:main:whatsapp:direct:%'
                      GROUP BY sw.session_id,sw.session_key
                    """)
                    for key,inbound,latest,archived in records:
                        number=key.removeprefix('agent:main:whatsapp:direct:')
                        if not E164.fullmatch(number): continue
                        current=activity.setdefault(number,{'timestamp':None,'latest':-1,'reason':None})
                        if isinstance(inbound,(int,float)) and inbound>0:
                            current['timestamp']=max(current['timestamp'] or 0,inbound)
                        if isinstance(latest,(int,float)) and latest>=current['latest']:
                            current['latest']=latest;current['reason']='archived_history' if archived else None
            return people, activity
        except sqlite3.Error: fail('contacts_unavailable', 503)
    def path(self, number): return self.people.CONTACTS/('wa_'+number[1:]+'.md')
    def metadata(self, number):
        path=self.path(number)
        try:
            if path.is_symlink(): fail('contact_state_invalid', 503)
            with path.open('rb') as file: prefix=file.read(2048)
        except FileNotFoundError: return None
        except OSError: fail('contact_state_invalid', 503)
        if not prefix.startswith((MARKER+'\n').encode()): return None
        try:
            line=prefix.split(b'\n',2)[1]; value=json.loads(line)
            if not prefix.split(b'\n',2)[2].startswith(END.encode()): raise ValueError()
            if set(value)!=FIELDS or value['state'] not in ('active','suspended') or value['scope'] not in ('standard','claw','custom'): raise ValueError()
            if value['expiresAt'] is not None: stamp(value['expiresAt'])
            if value['addedAt'] is not None: stamp(value['addedAt'])
            if value['scopeText'] is not None: safe_text(value['scopeText'],500,False)
            if value['personId'] is not None and (not isinstance(value['personId'],str) or not re.fullmatch(r'person_[a-f0-9]{16}',value['personId'])): raise ValueError()
            return value
        except (ValueError,KeyError,IndexError,UnicodeDecodeError): fail('contact_state_invalid',503)
    def context(self, number):
        path=self.path(number)
        try:
            if path.is_symlink() or path.stat().st_size>1024*1024: fail('contact_state_invalid',503)
            return path.read_text(encoding='utf-8')
        except FileNotFoundError: return ''
        except (OSError,UnicodeDecodeError): fail('contact_state_invalid',503)
    def note(self, number):
        text=self.context(number)
        if text.startswith(MARKER+'\n'):
            end=text.find('\n'+END+'\n')
            if end<0: fail('contact_state_invalid',503)
            text=text[end+len('\n'+END+'\n'):]
        return text
    def write_context(self, number, metadata, note=None, archive=False, removed=False, display_name=None):
        old=self.context(number)
        if old.startswith(MARKER+'\n'):
            end=old.find('\n'+END+'\n')
            if end<0: fail('contact_state_invalid',503)
            old=old[end+len('\n'+END+'\n'):]
        if archive and old:
            old='## Private note archive '+utc(self.clock())+'\n'+old
        elif note is not None:
            old=note
        if display_name is not None:
            old=re.sub(r'^- Suggested display name: .*\n?', '', old, flags=re.M)
            old+='\n- Suggested display name: '+json.dumps(display_name,ensure_ascii=False)+'\n'
        head='' if removed else MARKER+'\n'+canonical(metadata)+'\n'+END+'\n'
        if len(head.encode())>2048 or len((head+old).encode())>1024*1024: fail('contact_state_invalid',503)
        path=self.path(number); path.parent.mkdir(parents=True,exist_ok=True)
        if path.parent.is_symlink(): fail('contact_state_invalid',503)
        temporary=path.with_suffix('.r17.tmp')
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            with os.fdopen(fd,'w',encoding='utf-8') as file: file.write(head+old);file.flush();os.fsync(file.fileno())
            os.replace(temporary,path)
        finally:
            try: temporary.unlink()
            except FileNotFoundError: pass
    def policy(self, rule):
        prompt=rule.get('systemPrompt')
        if not prompt: return 'standard',None
        if not isinstance(prompt,str): fail('contact_state_invalid',503)
        names=['Authorized contact']
        prefix='You are speaking with '
        for separator in ('. Amine explicitly authorizes this contact', '. Amine authorizes this contact for the following scope only: '):
            if prompt.startswith(prefix) and separator in prompt:
                name=prompt[len(prefix):].split(separator,1)[0]
                if name and len(name)<=80 and not any(ord(c)<32 or ord(c)==127 for c in name): names.append(name)
        for name in names:
            if prompt==self.people.scope_prompt(name,'claw'): return 'claw',None
            separator='. Amine authorizes this contact for the following scope only: '
            ending='. Do not extend that scope.'
            if prompt.startswith(prefix+name+separator) and ending in prompt:
                text=prompt[len(prefix+name+separator):].split(ending,1)[0]
                if text and len(text)<=500 and not any(ord(c)<32 or ord(c)==127 for c in text) and prompt==self.people.scope_prompt(name,'custom',text): return 'custom',text
        return 'custom',None
    def rows(self, config=None, target=None):
        if config is None:
            try: config=self.people.gateway_call('config.get',{},timeout_ms=5000).get('config')
            except Exception: fail('contacts_unavailable',503)
            if not isinstance(config,dict): fail('contacts_unavailable',503)
        owners=self.owners(config)
        allow,direct=self.people.whatsapp_state(config); directory, activity=self.directory()
        numbers=[n for n in allow if isinstance(n,str) and E164.fullmatch(n) and (target is None or contact_id(n)==target)]
        # Suspended contacts remain visible through their existing private block.
        if self.people.CONTACTS.exists():
            paths=sorted(self.people.CONTACTS.glob('wa_*.md'))
            selected=paths[:200] if target is None else [p for p in paths if contact_id('+'+p.stem[3:])==target]
            for path in selected:
                number='+'+path.stem[3:]
                if E164.fullmatch(number) and self.metadata(number) and number not in numbers: numbers.append(number)
        out=[]
        for number in numbers:
            metadata=self.metadata(number); rule=direct.get(number, {})
            if metadata is None:
                scope='standard' if not rule.get('systemPrompt') else 'custom'
                metadata={'state':'active','scope':scope,'scopeText':None,'expiresAt':None,'addedAt':None,'suspendedScope':None,'personId':directory.get(number,{}).get('personId')}
            scope,text=self.policy(rule);metadata={**metadata,'scope':scope,'scopeText':text}
            state='active' if number in allow else 'suspended'
            if state=='active' and metadata['expiresAt'] and stamp(metadata['expiresAt'])<self.clock(): state='expired_pending'
            out.append({'contactId':contact_id(number),'e164':number,'name':directory.get(number,{}).get('name') or None,'owner':number in owners,
                        'scope':metadata['scope'],'scopeText':metadata['scopeText'],'state':state,
                        'expiresAt':metadata['expiresAt'],'addedAt':metadata['addedAt'],'personId':metadata['personId'],
                        'lastActivityAt':utc(activity[number]['timestamp']/1000) if activity.get(number,{}).get('timestamp') and not activity[number]['reason'] else None,
                        **({'reason':'archived_history'} if activity.get(number,{}).get('reason')=='archived_history' else {})})
        return out
    def find(self, identity):
        if not isinstance(identity,str) or not CID.fullmatch(identity): fail('invalid_contact_id')
        values=[r for r in self.rows(target=identity) if r['contactId']==identity]
        if len(values)!=1: fail('unknown_contact',404)
        return values[0]
    def retired(self, identity):
        if not CID.fullmatch(identity or ''): fail('invalid_contact_id')
        paths=sorted(self.people.CONTACTS.glob('wa_*.md')) if self.people.CONTACTS.exists() else []
        for file in paths:
            number='+'+file.stem[3:]
            if E164.fullmatch(number) and contact_id(number)==identity: return {'contactId':identity,'e164':number,'scope':'standard','scopeText':None,'personId':None}
        fail('unknown_contact',404)
    def read_operation(self, operation, wanted=None):
        if not isinstance(operation,str) or not OP.fullmatch(operation): fail('invalid_operation_id')
        if not self.people.DB.exists(): return None
        try:
            c=sqlite3.connect(f'file:{self.people.DB}?mode=ro',uri=True)
            row=c.execute('SELECT message_sha256,state,message_id FROM send_receipts WHERE idempotency_key=?',('r17:'+digest(operation),)).fetchone(); c.close()
        except sqlite3.Error: fail('receipt_unavailable',503)
        if not row: return None
        if wanted is not None and wanted!=row[0]: fail('operation_conflict',409)
        value=json.loads(row[2]) if row[2] else {'success':False,'state':'indeterminate','receipt':None}
        value={k:v for k,v in value.items() if not k.startswith('_')}
        if row[1]=='failed_before_effect': value['retryable']=True
        return value
    def reserve(self, operation, target, wanted, confirmation_id=None, event=None):
        c=self.people.connect(); c.execute('BEGIN IMMEDIATE')
        row=c.execute('SELECT message_sha256,state,message_id FROM send_receipts WHERE idempotency_key=?',('r17:'+digest(operation),)).fetchone()
        if row:
            c.rollback(); c.close()
            if row[0]!=wanted: fail('operation_conflict',409)
            if row[1]=='failed_before_effect':
                value=json.loads(row[2]);value['state']='indeterminate';value['success']=False;value['receipt']['state']='indeterminate'
                c=self.people.connect();c.execute('BEGIN IMMEDIATE');current=c.execute('SELECT state FROM send_receipts WHERE idempotency_key=?',('r17:'+digest(operation),)).fetchone()
                if current[0]!='failed_before_effect':c.rollback();c.close();return False
                c.execute("UPDATE send_receipts SET state='pending',message_id=? WHERE idempotency_key=?",(canonical(value),'r17:'+digest(operation)));c.commit();c.close();return True
            return False
        if confirmation_id:
            claim=c.execute("SELECT idempotency_key FROM send_receipts WHERE idempotency_key LIKE 'r17:%' AND json_valid(message_id) AND json_extract(message_id,'$._confirmationId')=?",(confirmation_id,)).fetchone()
            if claim:c.rollback();c.close();fail('confirmation_mismatch',403)
        now=int(self.clock());pending={'success':False,'state':'indeterminate','receipt':{'version':1,'operationId':operation,'action':event or 'added','contactId':target,'state':'indeterminate','at':utc(self.clock())}}
        if confirmation_id:pending['_confirmationId']=confirmation_id
        c.execute("INSERT INTO send_receipts VALUES(?,?,?,'pending',?,?,?)",('r17:'+digest(operation),target,wanted,canonical(pending),now,now));c.commit();c.close();return True
    def finish(self, operation, value):
        c=self.people.connect();previous=c.execute('SELECT message_id FROM send_receipts WHERE idempotency_key=?',('r17:'+digest(operation),)).fetchone()
        stored=dict(value)
        if previous and previous[0]:stored.update({k:v for k,v in json.loads(previous[0]).items() if k.startswith('_')})
        c.execute('UPDATE send_receipts SET state=?,message_id=?,updated_at=? WHERE idempotency_key=?',(value['state'],canonical(stored),int(self.clock()),'r17:'+digest(operation)));c.commit();c.close();return value
    def history(self, identity=None, limit=50):
        if identity is not None and not CID.fullmatch(identity or ''): fail('invalid_contact_id')
        if not isinstance(limit,int) or isinstance(limit,bool) or not 1<=limit<=100: fail('invalid_request')
        if not self.people.DB.exists(): return []
        c=sqlite3.connect(f'file:{self.people.DB}?mode=ro',uri=True)
        rows=c.execute("SELECT message_id FROM send_receipts WHERE (? IS NULL OR target=?) AND idempotency_key LIKE 'r17:%' AND message_id IS NOT NULL ORDER BY updated_at DESC LIMIT ?",(identity,identity,limit)).fetchall();c.close()
        return [dict(at=r['at'],action=r['action'],contactId=r['contactId'],name=None,scope=r.get('scope'),durationDays=r.get('durationDays')) for row in rows if (r:=json.loads(row[0]).get('receipt')) and r['state'] in ('added','removed','updated','suspended','reactivated')]
    def history_page(self, body):
        limit=body.get('limit',50)
        if not isinstance(limit,int) or isinstance(limit,bool) or not 1<=limit<=50: fail('invalid_request')
        cursor=body.get('before');when=9223372036854775807;key='z'
        if cursor is not None:
            try:
                raw=base64.urlsafe_b64decode(cursor+'='*((-len(cursor))%4)).decode('ascii')
                if not re.fullmatch(r'[0-9]{1,19}:r17:[a-f0-9]{64}',raw): raise ValueError()
                when,tail=raw.split(':',1);when=int(when);key=tail
            except (ValueError,UnicodeDecodeError,TypeError): fail('invalid_request')
        if not self.people.DB.exists(): return {'success':True,'state':'ok','receipt':None,'items':[],'nextBefore':None}
        c=sqlite3.connect(f'file:{self.people.DB}?mode=ro',uri=True)
        rows=c.execute("SELECT message_id,updated_at,idempotency_key FROM send_receipts WHERE idempotency_key LIKE 'r17:%' AND message_id IS NOT NULL AND state IN ('added','removed','updated','suspended','reactivated') AND (updated_at<? OR (updated_at=? AND idempotency_key<?)) ORDER BY updated_at DESC,idempotency_key DESC LIMIT ?",(when,when,key,limit+1)).fetchall();c.close()
        items=[]
        for content,when,key in rows[:limit]:
            receipt=json.loads(content).get('receipt')
            if receipt: items.append({k:receipt[k] for k in ('at','action','contactId')}|{'name':None,'scope':receipt.get('scope'),'durationDays':receipt.get('durationDays')})
        next_before=None
        if len(rows)>limit:
            content,when,key=rows[limit-1];next_before=base64.urlsafe_b64encode(f'{when}:{key}'.encode()).decode().rstrip('=')
        return {'success':True,'state':'ok','receipt':None,'items':items,'nextBefore':next_before}
    def history_count(self,identity):
        if not self.people.DB.exists(): return 0
        c=sqlite3.connect(f'file:{self.people.DB}?mode=ro',uri=True)
        count=c.execute("SELECT COUNT(*) FROM send_receipts WHERE target=? AND idempotency_key LIKE 'r17:%' AND state IN ('added','removed','updated','suspended','reactivated')",(identity,)).fetchone()[0];c.close();return count
    def duration_days(self, identity):
        if not self.people.DB.exists(): return None
        c=sqlite3.connect(f'file:{self.people.DB}?mode=ro',uri=True)
        row=c.execute("SELECT message_id FROM send_receipts WHERE target=? AND idempotency_key LIKE 'r17:%' AND state IN ('added','updated') AND json_valid(message_id) AND json_extract(message_id,'$.receipt.action') IN ('added','extended','shortened') ORDER BY updated_at DESC,rowid DESC LIMIT 1",(identity,)).fetchone();c.close()
        value=json.loads(row[0]).get('receipt',{}).get('durationDays') if row else None
        return value if value in (1,3,5) and not isinstance(value,bool) else None
    def noop(self, operation, identity, wanted, state):
        if not self.reserve(operation,identity,wanted): return self.read_operation(operation,wanted)
        return self.finish(operation,{'success':True,'state':state,'receipt':{'version':1,'operationId':operation,'action':'added' if state=='already_present' else 'removed','contactId':identity,'state':state,'at':utc(self.clock())}})
    def release_failed(self, operation):
        c=self.people.connect();row=c.execute('SELECT message_id FROM send_receipts WHERE idempotency_key=?',('r17:'+digest(operation),)).fetchone()
        value=json.loads(row[0]);value['state']='failed';value['success']=False;value['receipt']['state']='failed'
        c.execute("UPDATE send_receipts SET state='failed_before_effect',message_id=? WHERE idempotency_key=?",(canonical(value),'r17:'+digest(operation)));c.commit();c.close()
        return {k:v for k,v in value.items() if not k.startswith('_')}|{'statusCode':503}
    def confirmation(self, body, action, identity, wanted, retry=False):
        if self.phase=='preflight': return
        cid=body.get('confirmationId')
        if not isinstance(cid,str) or not re.fullmatch(r'[0-9a-f-]{36}',cid): fail('confirmation_required',403)
        file=self.state_dir/'clawmobile-companion'/'runs.json'
        try:
            if file.is_symlink() or file.stat().st_size>8*1024*1024: raise ValueError()
            registry=json.loads(file.read_text());rows=registry.get('ownerConfirmations',[])
            record=next(r for r in rows if r.get('id')==cid)
            intent=record['intent']['action']
            if record['expiresAt']<=self.clock()*1000: fail('confirmation_expired',403)
            expected={'type':'whatsapp.allowlist_'+action,'reference':identity,'payloadHash':wanted}
            if intent!=expected: raise ValueError()
            if self.phase=='prepare':
                if record['state'] not in ('approved','consumed'): raise ValueError()
            elif record['state']!='consumed' or record['consumedAt']>=record['expiresAt']: raise ValueError()
            self.confirmation_claim={'operationId':body['operationId'],'requestHash':body['requestHash'],'confirmationId':cid,'type':expected['type'],'reference':identity,'payloadHash':wanted}
            if self.phase=='prepare' and record['state']=='consumed' and not self.claim_matches(self.confirmation_claim): raise ValueError()
            if self.phase=='effect' and not self.claim_matches(self.confirmation_claim): raise ValueError()
        except (OSError,ValueError,KeyError,StopIteration,TypeError): fail('confirmation_mismatch',403)
    def claim_matches(self, claim):
        if not self.people.DB.exists(): return False
        c=sqlite3.connect(f'file:{self.people.DB}?mode=ro',uri=True)
        row=c.execute('SELECT value FROM meta WHERE key=?',('r17-confirmation:'+digest(claim['confirmationId']),)).fetchone();c.close()
        return row is not None and row[0]==canonical(claim)
    def prepare_claim(self, claim):
        if not claim: return
        c=self.people.connect();c.execute('BEGIN IMMEDIATE');key='r17-confirmation:'+digest(claim['confirmationId'])
        row=c.execute('SELECT value FROM meta WHERE key=?',(key,)).fetchone()
        if row and row[0]!=canonical(claim):c.rollback();c.close();fail('confirmation_mismatch',403)
        if not row:c.execute('INSERT INTO meta VALUES(?,?)',(key,canonical(claim)))
        c.commit();c.close()
    def patch(self, before, after):
        # Fallback allowed only when config.get itself failed: patch never dispatched.
        try: snap=self.people.gateway_call('config.get',{},timeout_ms=5000)
        except Exception:
            return self.legacy_patch(before,after)
        current=snap.get('config')
        if not isinstance(current,dict) or self.people.whatsapp_state(current)!=self.people.whatsapp_state(before) or self.owners(current)!=self.owners(before): fail('config_changed',409)
        a,d=self.people.whatsapp_state(after); olda,oldd=self.people.whatsapp_state(before)
        patch={'channels':{'whatsapp':{}}}; replacements=[]
        if a!=olda: patch['channels']['whatsapp']['allowFrom']=a;replacements.append('channels.whatsapp.allowFrom')
        if d!=oldd:
            # Replace exact direct map under CAS: JSON merge cannot remove a property safely.
            patch['channels']['whatsapp']['direct']=d;replacements.append('channels.whatsapp.direct')
        params={'raw':canonical(patch),'baseHash':snap.get('hash'),'replacePaths':replacements,'note':'whatsapp allowlist owner operation'}
        try: self.people.gateway_call('config.patch',params,timeout_ms=5000)
        except Exception: pass
        # One verification after success or uncertainty, never redispatch.
        try: verified=self.people.gateway_call('config.get',{},timeout_ms=5000).get('config')
        except Exception: return False
        return isinstance(verified,dict) and self.people.whatsapp_state(verified)==self.people.whatsapp_state(after) and self.owners(verified)==self.owners(after)
    def legacy_patch(self,before,after):
        olda,oldd=self.people.whatsapp_state(before);a,d=self.people.whatsapp_state(after)
        try:
            # Before fallback, local full owner snapshot must still match.
            if self.local_config()!=before: fail('config_changed',409)
            adding=any(number not in olda for number in a)
            if adding and d!=oldd: self.people.legacy_cfg_set('channels.whatsapp.direct',d,oldd,timeout=5)
            if a!=olda: self.people.legacy_cfg_set('channels.whatsapp.allowFrom',a,olda,timeout=5)
            if not adding and d!=oldd: self.people.legacy_cfg_set('channels.whatsapp.direct',d,oldd,timeout=5)
        except Exception: return False
        try: return self.local_config()==after
        except Exception: return False
    def mutate(self, action, body, sweep_target=None, phase="effect", sweep_config=None):
        self.phase=phase;self.confirmation_claim=None
        operation=body.get('operationId'); wanted=request_hash(action,body)
        if body.get('requestHash')!=wanted: fail('invalid_request_hash')
        old=self.read_operation(operation,wanted)
        retry=bool(old and old.get('retryable'))
        if old and not retry and phase!='preflight': return old
        before=sweep_config if sweep_config is not None else self.local_config(); owners=self.owners(before); allow,direct=self.people.whatsapp_state(before)
        row=None
        if action=='add':
            number=body.get('e164')
            if not isinstance(number,str) or not number.startswith('+'): fail('country_code_required')
            if not E164.fullmatch(number): fail('invalid_e164')
            if 'displayName' in body: safe_text(body['displayName'],80)
            if not isinstance(body.get('notify'),bool): fail('invalid_request')
            identity=contact_id(number)
            if body.get('contactId') is not None and body['contactId']!=identity: fail('operation_conflict',409)
            row=next((r for r in self.rows(before) if r['contactId']==identity),None)
        elif action=='sweep' and sweep_target is not None:
            number,known_metadata=sweep_target
            identity=contact_id(number)
            scope,text=self.policy(direct.get(number,{}))
            row={'contactId':identity,'e164':number,'scope':scope,'scopeText':text,'personId':known_metadata['personId'],'state':'active' if number in allow else 'suspended','expiresAt':known_metadata['expiresAt']}
        else:
            try: row=self.find(body.get('contactId'))
            except Refused as error:
                if action!='remove' or error.code!='unknown_contact': raise
                row=self.retired(body.get('contactId'))
            number=row['e164'];identity=row['contactId']
        if number in owners and (action in ('remove','suspend','sweep') or (action=='expiry' and body.get('durationDays') is not None)): fail('owner_contact_protected',409)
        metadata=self.metadata(number) or {'state':'active','scope':row['scope'] if row else 'standard','scopeText':row['scopeText'] if row else None,'expiresAt':None,'addedAt':None,'suspendedScope':None,'personId':row['personId'] if row else None}
        if row: metadata={**metadata,'scope':row['scope'],'scopeText':row['scopeText']}
        if action=='remove' and number not in allow and number not in direct and self.metadata(number) is None:
            if phase=='preflight': return {'success':True,'state':'already_absent','receipt':None}
            return self.noop(operation,identity,wanted,'already_absent')
        expected=body.get('expectedAuthority')
        if expected is not None:
            current={'present':number in allow,'owner':number in owners,'scope':row['scope'] if row else None,'scopeText':row['scopeText'] if row else None,'state':row['state'] if row and 'state' in row else None,'expiresAt':row['expiresAt'] if row and 'expiresAt' in row else None}
            if expected!=current: fail('operation_conflict',409)
        if action=='add' and metadata['personId'] is None: metadata['personId']=self.directory()[0].get(number,{}).get('personId')
        original=copy.deepcopy(metadata);after=copy.deepcopy(before);wa=after.setdefault('channels',{}).setdefault('whatsapp',{})
        wa.setdefault('allowFrom',[]);wa.setdefault('direct',{})
        note=None;archive=False;event=EVENTS[action];state='completed';duration=body.get('durationDays')
        if action=='scope' and 'scope' not in body: body={**body,'scope':metadata['scope']}
        if action in ('add','scope'):
            scope=body.get('scope','standard');text=body.get('scopeText')
            if scope not in ('standard','claw','custom'): fail('invalid_scope')
            if scope=='custom': safe_text(text,500,False)
            elif text is not None: fail('invalid_scope')
            if action=='add' and number in owners and duration is not None: fail('owner_contact_protected',409)
            if action=='add' and number in allow:
                if phase=='preflight': return {'success':True,'state':'already_present','receipt':None}
                return self.noop(operation,identity,wanted,'already_present')
            if action=='add':
                if duration not in (None,1,3,5) or isinstance(duration,bool): fail('invalid_duration')
                if number in owners and duration is not None: fail('owner_contact_protected',409)
                self.confirmation(body,'add',identity,digest('|'.join([number,scope,text or '',str(duration) if duration else 'permanent'])),retry=retry)
                wa['allowFrom'].append(number);metadata['addedAt']=utc(self.clock());metadata['expiresAt']=utc(self.clock()+duration*86400) if duration else None
            elif (metadata['scope']=='custom' and metadata['scopeText'] is None and scope!='standard') or (metadata['scope']=='standard' and scope!='standard') or (metadata['scope']=='claw' and scope=='custom') or (scope=='custom' and metadata['scopeText']!=text): self.confirmation(body,'raise',identity,digest('|'.join([number,scope,text or ''])),retry=retry)
            rule=copy.deepcopy(wa['direct'].get(number,{}));rule.pop('systemPrompt',None)
            if scope!='standard': rule['systemPrompt']=self.people.scope_prompt('Authorized contact',scope,text)
            if rule: wa['direct'][number]=rule
            else: wa['direct'].pop(number,None)
            metadata.update(scope=scope,scopeText=text,state='active')
        elif action in ('remove','suspend','sweep'):
            if action=='remove': self.confirmation(body,'remove',identity,digest(number),retry=retry)
            if action=='sweep' and (not metadata['expiresAt'] or stamp(metadata['expiresAt'])>=self.clock()): return {'success':True,'state':'not_due','receipt':None}
            wa['allowFrom']=[x for x in allow if x!=number]
            metadata['state']='suspended';metadata['suspendedScope']=metadata['scope'];archive=action in ('remove','sweep')
            if action in ('remove','sweep'):
                wa['direct'].pop(number,None)
                metadata['expiresAt']=None
        elif action=='reactivate':
            if metadata['scope']=='custom' and metadata['scopeText'] is None: fail('invalid_scope')
            self.confirmation(body,'reactivate',identity,digest('|'.join([number,metadata['scope'],metadata['scopeText'] or ''])),retry=retry)
            if number not in wa['allowFrom']: wa['allowFrom'].append(number)
            metadata['state']='active';metadata['suspendedScope']=None
        elif action=='expiry':
            if duration not in (None,1,3,5) or isinstance(duration,bool): fail('invalid_duration')
            expires=utc(self.clock()+duration*86400) if duration else None
            if original['expiresAt'] is not None and (expires is None or stamp(expires)>stamp(original['expiresAt'])): self.confirmation(body,'extend',identity,digest('|'.join([number,str(duration) if duration else 'permanent'])),retry=retry)
            if original['expiresAt'] is None and expires is None: event='extended'
            elif expires is not None and (original['expiresAt'] is None or stamp(expires)<stamp(original['expiresAt'])): event='shortened'
            metadata['expiresAt']=expires
        elif action=='note':
            if isinstance(body.get('text'),str) and len(body['text'])>2000: fail('note_too_long')
            note=safe_text(body.get('text'),2000)
        if len((MARKER+'\n'+canonical(metadata)+'\n'+END+'\n').encode())>2048: fail('invalid_scope')
        if phase=='preflight': return {'success':True,'state':'validated','receipt':None}
        if phase=='prepare':
            self.prepare_claim(self.confirmation_claim)
            if not self.reserve(operation,identity,wanted,body.get('confirmationId'),event): return self.read_operation(operation,wanted)
            self.release_failed(operation)
            return {'success':True,'state':'prepared','receipt':None,'confirmationClaim':self.confirmation_claim,'allowConsumedRetry':retry}
        if not self.reserve(operation,identity,wanted,body.get('confirmationId'),event): return self.read_operation(operation,wanted)
        receipt={'version':1,'operationId':operation,'contactId':identity,'action':event,'at':utc(self.clock()),'state':state,'scope':metadata['scope'],'durationDays':duration if action in ('add','expiry') else self.duration_days(identity)}
        effect_possible=False;staged_content=None;previous_context=None
        try:
            # Persist expiry BEFORE access becomes effective: a kill after CAS
            # must never turn a temporary grant into a permanent one.
            if action=='add':
                previous_context=self.context(number) if self.path(number).exists() else None
                self.write_context(number,metadata,display_name=body.get('displayName'))
                staged_content=self.context(number)
            if after!=before:
                effect_possible=True
                if not self.patch(before,after): state='indeterminate'
            if state=='completed' and staged_content is None: self.write_context(number,metadata,note,archive,removed=action in ('remove','sweep'))
            if state=='completed' and action=='add' and body.get('notify') is True:
                self.people.whatsapp_send(number,'Amine autorise ce contact à échanger avec Samantha.','trusted:r17-welcome:'+digest(operation))
        except Refused as error:
            if error.code=='config_changed':
                if staged_content is not None and self.context(number)==staged_content: self.people.restore_context(self.path(number),previous_context)
                return self.release_failed(operation)
            state='indeterminate'
        except Exception:
            if not effect_possible:
                return self.release_failed(operation)
            state='indeterminate'
        success=state=='completed'
        if success: state={'add':'added','remove':'removed','suspend':'suspended','reactivate':'reactivated'}.get(action,'updated')
        receipt['state']=state
        return self.finish(operation,{'success':success,'state':state,'receipt':receipt})
    def sweep(self):
        paths=sorted(self.people.CONTACTS.glob('wa_*.md')) if self.people.CONTACTS.exists() else []
        due=[]
        pages=max(1,(len(paths)+199)//200);page=(int(self.clock())//60)%pages
        for path in paths[page*200:(page+1)*200]:
            number='+'+path.stem[3:]
            if not E164.fullmatch(number): continue
            meta=self.metadata(number)
            if meta and meta['expiresAt'] and stamp(meta['expiresAt'])<self.clock(): due.append((number,meta))
        results=[];deadline=time.monotonic()+20
        for number,metadata in due:
            if time.monotonic()>=deadline: break
            # Every attempt starts with a fresh authoritative read. An old
            # uncertain RPC is never replayed; still-present access is a new intent.
            snapshot=self.people.gateway_call('config.get',{},timeout_ms=5000).get('config')
            if not isinstance(snapshot,dict): fail('contacts_unavailable',503)
            prefix='expire:'+digest(number+'\0'+metadata['expiresAt'])[:40]+':'
            attempt=0
            if self.people.DB.exists():
                c=sqlite3.connect(f'file:{self.people.DB}?mode=ro',uri=True)
                attempt=c.execute("SELECT COUNT(*) FROM send_receipts WHERE target=? AND idempotency_key LIKE 'r17:%' AND json_valid(message_id) AND json_extract(message_id,'$.receipt.action')='expired'",(contact_id(number),)).fetchone()[0];c.close()
            body={'contactId':contact_id(number),'operationId':prefix+str(attempt)};body['requestHash']=request_hash('sweep',body)
            results.append(self.mutate('sweep',body,sweep_target=(number,metadata),sweep_config=snapshot))
        success=len(results)==len(due) and all(row['success'] for row in results)
        return {'success':success,'state':('partial' if pages>1 else 'completed') if success else 'expired_pending','receipt':None,'processed':len(results),'remaining':len(due)-sum(row['success'] for row in results),'scanComplete':pages==1,'scanPage':page,'scanPages':pages}
    def call(self,action,body):
        if not isinstance(body,dict): fail('invalid_request')
        common={'operationId','requestHash','confirmationId','expectedAuthority','contactId'}
        allowed={'list':set(),'get':{'contactId'},'operation':{'operationId','requestHash'},'history':{'limit','before'},'note-get':{'contactId'},'sweep':set(),'preflight':{'action','body'},'prepare':{'action','body'},'add':common|{'e164','displayName','scope','scopeText','durationDays','notify'},'remove':common,'scope':common|{'scope','scopeText'},'suspend':common|{'state'},'reactivate':common|{'state'},'expiry':common|{'durationDays'},'note':common|{'text'}}
        if action not in allowed or set(body)-allowed[action]: fail('invalid_request')
        if action=='list': return {'success':True,'state':'partial' if self.people.CONTACTS.exists() and sum(1 for _ in self.people.CONTACTS.glob('wa_*.md'))>200 else 'ok','receipt':None,'items':self.rows(),'issues':['contact_scan_partial'] if self.people.CONTACTS.exists() and sum(1 for _ in self.people.CONTACTS.glob('wa_*.md'))>200 else []}
        if action=='get': return {'success':True,'state':'ok','receipt':None,'contact':self.find(body.get('contactId')),'historyCount':self.history_count(body.get('contactId'))}
        if action=='operation':
            value=self.read_operation(body.get('operationId'),body.get('requestHash'))
            return value or {'success':False,'state':'not_found','receipt':None}
        if action=='history': return self.history_page(body)
        if action=='note-get':
            row=self.find(body.get('contactId'));history=self.history(row['contactId'])
            changed=next((r['at'] for r in history if r['action']=='note_updated'),None)
            value=self.note(row['e164'])
            return {'success':True,'state':'partial' if len(value)>2000 else 'ok','receipt':None,'text':value[:2000],'truncated':len(value)>2000,'updatedAt':changed}
        if action in ('preflight','prepare'):
            target=body.get('action');request=body.get('body')
            if target not in EVENTS or target=='sweep' or not isinstance(request,dict): fail('invalid_request')
            return self.mutate(target,request,phase=action)
        if action=='sweep': return self.sweep()
        if action not in EVENTS: fail('invalid_action')
        return self.mutate(action,body)


def main():
    if len(sys.argv)>1 and sys.argv[1]=='allowlist':
        try:
            if len(sys.argv)!=3: fail('invalid_request')
            data=sys.stdin.buffer.read(16385)
            if len(data)>16384: fail('invalid_request')
            result=Contacts(_ExistingPeopleOwner()).call(sys.argv[2],json.loads(data or b'{}'))
        except Refused as error:
            result={'success':False,'state':'refused','receipt':None,'reason':error.code,'statusCode':error.status}
        except Exception:
            result={'success':False,'state':'failed','receipt':None,'statusCode':503}
        print(canonical(result));return
    ap=argparse.ArgumentParser()
    sub=ap.add_subparsers(dest="cmd",required=True)
    sub.add_parser("sync")
    r=sub.add_parser("refresh"); r.add_argument("--max-age",type=int,default=300)
    s=sub.add_parser("search"); s.add_argument("query"); s.add_argument("--limit",type=int,default=10)
    g=sub.add_parser("get"); g.add_argument("person_id")
    a=sub.add_parser("trusted-add")
    z=a.add_mutually_exclusive_group(required=True); z.add_argument("--query"); z.add_argument("--person-id")
    a.add_argument("--e164"); a.add_argument("--scope",choices=["standard","claw","custom"],default="standard")
    a.add_argument("--scope-text"); a.add_argument("--silent",action="store_true")
    a.add_argument("--after-message"); a.add_argument("--dry-run",action="store_true")
    w=sub.add_parser("send"); w.add_argument("e164"); w.add_argument("message"); w.add_argument("--key",required=True)
    args=ap.parse_args()
    try:
        if args.cmd=="sync": out=sync_directory()
        elif args.cmd=="refresh": out=incremental_refresh(args.max_age)
        elif args.cmd=="search": ensure_fresh(); out=search_people(args.query,args.limit)
        elif args.cmd=="get": ensure_fresh(); out=get_person(args.person_id)
        elif args.cmd=="trusted-add": ensure_fresh(); out=trusted_add(args)
        else: out={"messageId":whatsapp_send(args.e164,args.message,args.key)}
        print(json.dumps(out,ensure_ascii=False,indent=2))
    except Exception as e:
        print(json.dumps({"state":"error","error":str(e)},ensure_ascii=False),file=sys.stderr)
        raise SystemExit(2)

if __name__=="__main__": main()
