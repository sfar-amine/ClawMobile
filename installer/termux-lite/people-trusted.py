#!/data/data/com.termux/files/usr/bin/python3
import argparse, hashlib, json, os, re, sqlite3, subprocess, sys, time, unicodedata
from pathlib import Path

HOME=Path.home()
ROOT=Path(os.environ.get("SAMANTHA_PEOPLE_ROOT", HOME/".openclaw"/"people"))
DB=ROOT/"directory.db"
WORKSPACE=Path(os.environ.get("SAMANTHA_WORKSPACE", HOME/".openclaw"/"workspace"))
CONTACTS=WORKSPACE/"memory"/"whatsapp"/"contacts"
ADB_SERIAL=os.environ.get("SAMANTHA_ADB_SERIAL","127.0.0.1:5556")

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
def adb_rows(uri, projection, where=None):
    args=["adb","-s",ADB_SERIAL,"shell","content","query","--uri",uri,"--projection",projection]
    if where: args += ["--where",where]
    return parse_rows(run(args,timeout=30).stdout)

def source_snapshot():
    contacts=adb_rows("content://com.android.contacts/contacts","_id:display_name")
    phones=adb_rows("content://com.android.contacts/data/phones","contact_id:display_name:data1:data2")
    emails=adb_rows("content://com.android.contacts/data/emails","contact_id:display_name:data1:data2")
    all_data=adb_rows("content://com.android.contacts/data","contact_id:display_name:data2:data3:mimetype")
    names=[r for r in all_data if r.get("mimetype")=="vnd.android.cursor.item/name"]
    return contacts,phones,emails,names

def refresh_interactions(c):
    try:
        p=run(["openclaw","sessions","--json","--active","43200","--limit","all"],timeout=20)
        data=json.loads(p.stdout)
    except Exception:
        return 0
    n=0
    for s in data.get("sessions",[]):
        key=s.get("key","")
        prefix="agent:main:whatsapp:direct:"
        if not key.startswith(prefix): continue
        e164=key[len(prefix):]
        if not re.fullmatch(r"\+\d{7,15}",e164): continue
        ts=int(s.get("lastInteractionAt") or s.get("updatedAt") or 0)
        c.execute("""INSERT INTO interactions(e164,last_interaction_ms) VALUES(?,?)
          ON CONFLICT(e164) DO UPDATE SET last_interaction_ms=max(last_interaction_ms,excluded.last_interaction_ms)""",(e164,ts))
        n+=1
    return n

def sync_directory():
    contacts,phones,emails,names=source_snapshot()
    by={}
    def item(cid):
        return by.setdefault(str(cid),{"display_name":None,"first_name":None,"last_name":None,
                                      "phones":[],"emails":[]})
    for r in contacts:
        x=item(r.get("_id")); x["display_name"]=r.get("display_name") or x["display_name"]
    for r in names:
        x=item(r.get("contact_id")); x["display_name"]=r.get("display_name") or x["display_name"]
        x["first_name"]=r.get("data2") or x["first_name"]; x["last_name"]=r.get("data3") or x["last_name"]
    for r in phones:
        x=item(r.get("contact_id")); x["display_name"]=r.get("display_name") or x["display_name"]
        if r.get("data1"): x["phones"].append(r["data1"])
    for r in emails:
        x=item(r.get("contact_id")); x["display_name"]=r.get("display_name") or x["display_name"]
        if r.get("data1"): x["emails"].append(r["data1"].strip())
    now=int(time.time()); c=connect(); c.execute("BEGIN"); c.execute("UPDATE people SET active=0")
    for cid,x in by.items():
        pid="person_"+hashlib.sha256(("android:"+cid).encode()).hexdigest()[:16]
        c.execute("""INSERT INTO people VALUES(?,?,?,?,?,1,?)
          ON CONFLICT(source_contact_id) DO UPDATE SET display_name=excluded.display_name,
          first_name=excluded.first_name,last_name=excluded.last_name,active=1,last_sync=excluded.last_sync""",
          (pid,cid,x["display_name"] or "",x["first_name"],x["last_name"],now))
        c.execute("DELETE FROM phones WHERE person_id=?",(pid,)); c.execute("DELETE FROM emails WHERE person_id=?",(pid,))
        for raw in dict.fromkeys(x["phones"]):
            norm,e164=phone_norm(raw)
            if norm: c.execute("INSERT OR IGNORE INTO phones VALUES(?,?,?,?)",(pid,raw,norm,e164))
        for email in dict.fromkeys(x["emails"]):
            if email: c.execute("INSERT OR IGNORE INTO emails VALUES(?,?)",(pid,email))
    interactions=refresh_interactions(c)
    c.execute("INSERT OR REPLACE INTO meta VALUES('last_sync',?)",(str(now),))
    c.commit(); c.close()
    return {"people":len(by),"contact_rows":len(contacts),"phone_rows":len(phones),"email_rows":len(emails),
            "name_rows":len(names),"whatsapp_interactions":interactions,"last_sync":now}
def ensure_fresh(max_age=300):
    c=connect(); row=c.execute("SELECT value FROM meta WHERE key='last_sync'").fetchone(); c.close()
    if not row or int(time.time())-int(row[0])>max_age:
        return sync_directory()
    return {"state":"fresh","last_sync":int(row[0])}

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
    out=person_dict(c,r) if r else None
    c.close(); return out

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
        recent=[x["e164"] for x in p["recentWhatsApp"] if x["e164"] in candidates]
        recent=list(dict.fromkeys(recent))
        if len(recent)==1: target=recent[0]
        else: raise RuntimeError("phone_ambiguous_or_not_e164")
    return p,target
def cfg_get(path):
    return json.loads(run(["openclaw","config","get",path],timeout=15).stdout)

def cfg_set(path,new,old):
    args=["openclaw","config","set",path,json.dumps(new,ensure_ascii=False,separators=(",",":")),
          "--strict-json","--expect-current-json",json.dumps(old,ensure_ascii=False,separators=(",",":"))]
    run(args,timeout=20)

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
    allow=cfg_get("channels.whatsapp.allowFrom")
    if target not in allow: raise RuntimeError("target_not_allowlisted")
    params={"to":target,"message":message,"channel":"whatsapp","accountId":"default","idempotencyKey":key}
    p=run(["openclaw","gateway","call","send","--timeout","10000","--json",
           "--params",json.dumps(params,ensure_ascii=False,separators=(",",":"))],timeout=15)
    out=json.loads(p.stdout); mid=out.get("messageId")
    if out.get("channel")!="whatsapp" or not mid: raise RuntimeError("invalid_send_response")
    return mid

def trusted_add(args):
    person,target=resolve(args.query,args.person_id,args.e164)
    allow_old=cfg_get("channels.whatsapp.allowFrom"); direct_old=cfg_get("channels.whatsapp.direct")
    allow_new=list(allow_old)
    if target not in allow_new: allow_new.append(target)
    direct_new=dict(direct_old); prompt=scope_prompt(person["displayName"],args.scope,args.scope_text)
    if prompt: direct_new[target]={"systemPrompt":prompt}
    effective_scope=args.scope if prompt or target not in direct_old else "existing_direct_preserved"
    plan={"personId":person["personId"],"displayName":person["displayName"],"e164":target,
          "scope":args.scope,"effectiveScope":effective_scope,"allowChange":allow_new!=allow_old,"directChange":direct_new!=direct_old,
          "silent":args.silent,"afterMessage":bool(args.after_message)}
    if args.dry_run: return {"state":"dry_run","plan":plan}
    path=oldctx=None; changed_allow=changed_direct=False
    try:
        if allow_new!=allow_old: cfg_set("channels.whatsapp.allowFrom",allow_new,allow_old); changed_allow=True
        if direct_new!=direct_old: cfg_set("channels.whatsapp.direct",direct_new,direct_old); changed_direct=True
        path,oldctx=update_context(person,target,effective_scope,args.scope_text)
        if target not in cfg_get("channels.whatsapp.allowFrom"): raise RuntimeError("allowlist_verify_failed")
        if prompt and cfg_get("channels.whatsapp.direct").get(target,{}).get("systemPrompt")!=prompt:
            raise RuntimeError("direct_verify_failed")
    except Exception:
        if path: restore_context(path,oldctx)
        try:
            if changed_direct: cfg_set("channels.whatsapp.direct",direct_old,direct_new)
            if changed_allow: cfg_set("channels.whatsapp.allowFrom",allow_old,allow_new)
        except Exception: pass
        raise
    result={"state":"verified","plan":plan,"context":str(path),"welcome":"not_requested","after":"not_requested"}
    if not args.silent:
        welcome=(f"Salut {person['displayName'].split()[0] if person['displayName'] else ''}, Amine vient de t'autoriser "
                 "à échanger directement avec Samantha sur WhatsApp.")
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
        elif args.cmd=="search": ensure_fresh(); out=search_people(args.query,args.limit)
        elif args.cmd=="get": ensure_fresh(); out=get_person(args.person_id)
        elif args.cmd=="trusted-add": ensure_fresh(); out=trusted_add(args)
        else: out={"messageId":whatsapp_send(args.e164,args.message,args.key)}
        print(json.dumps(out,ensure_ascii=False,indent=2))
    except Exception as e:
        print(json.dumps({"state":"error","error":str(e)},ensure_ascii=False),file=sys.stderr); raise SystemExit(2)

if __name__=="__main__": main()
