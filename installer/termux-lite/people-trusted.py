#!/data/data/com.termux/files/usr/bin/python3
import argparse, hashlib, json, os, re, sqlite3, subprocess, sys, time, unicodedata
from pathlib import Path

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

def legacy_cfg_set(path,new,old):
    run(["openclaw","config","set",path,json.dumps(new,ensure_ascii=False,separators=(",",":")),
         "--strict-json","--expect-current-json",json.dumps(old,ensure_ascii=False,separators=(",",":"))],timeout=25)

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

def whatsapp_send(target,message,key):
    allow,_=whatsapp_state()
    if target not in allow: raise RuntimeError("target_not_allowlisted")
    params={"to":target,"message":message,"channel":"whatsapp","accountId":"default","idempotencyKey":key}
    out=gateway_call("send",params,timeout_ms=10000)
    mid=out.get("messageId")
    if out.get("channel")!="whatsapp" or not mid: raise RuntimeError("invalid_send_response")
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
def main():
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
