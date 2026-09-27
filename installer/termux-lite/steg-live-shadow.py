#!/data/data/com.termux/files/usr/bin/python3
import http.cookiejar,json,os,re,sys,urllib.parse,urllib.request
from html import unescape

BASE="https://espace.steg.com.tn/fr/espace/"
HOST="espace.steg.com.tn"
def clean_text(html):
 t=re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>"," ",html,flags=re.I)
 t=re.sub(r"<[^>]+>"," ",t); return re.sub(r"\s+"," ",unescape(t)).strip()
def login_page(html):
 return bool(re.search(r'name=["\']utilisateur["\']',html,re.I) and re.search(r'name=["\']pwd["\']',html,re.I))
def parse_due(html):
 text=clean_text(html); label=re.search(r"(?:Reste\s*d[ûu]|Solde\s+restant\s+d[ûu])",text,re.I)
 if not label:return None
 tail=text[label.end():label.end()+160]
 m=re.search(r"([0-9]+(?:[.,][0-9]+)?)\s*(?:TND|DT)?",tail,re.I)
 return float(m.group(1).replace(",",".")) if m else 0.0
def read(opener,url,data=None):
 req=urllib.request.Request(url,data=data,headers={"User-Agent":"Mozilla/5.0"})
 with opener.open(req,timeout=20) as r:
  return r.status,r.geturl(),r.read(2_000_000).decode("utf-8","replace")
user=os.environ.get("STEG_USERNAME");pwd=os.environ.get("STEG_PASSWORD")
if not user or not pwd:
 print(json.dumps({"status":"auth_source_missing"}));raise SystemExit(3)
jar=http.cookiejar.CookieJar()
opener=urllib.request.build_opener(urllib.request.ProxyHandler(),urllib.request.HTTPCookieProcessor(jar))
try:
 body=urllib.parse.urlencode({"utilisateur":user,"pwd":pwd,"submit":"Entrer"}).encode()
 st,final,html=read(opener,urllib.parse.urljoin(BASE,"login.php"),body)
 st2,home_url,home=read(opener,urllib.parse.urljoin(BASE,"accueil.php"))
 if login_page(home):
  print(json.dumps({"status":"auth_required","auth_ok":False},separators=(",",":")));raise SystemExit(5)
 auth_ok=(st<500 and st2<500 and urllib.parse.urlparse(home_url).hostname==HOST)
 hrefs=[]
 for q in re.findall(r'href\s*=\s*["\']([^"\']*consulter\.php[^"\']*)',home,re.I):
  u=urllib.parse.urljoin(home_url,q)
  if urllib.parse.urlparse(u).hostname==HOST and u not in hrefs:hrefs.append(u)
 due=[]
 for u in hrefs[:20]:
  _,_,page=read(opener,u)
  if login_page(page):
   print(json.dumps({"status":"session_lost","auth_ok":True,"references_seen":len(hrefs)},separators=(",",":")));raise SystemExit(6)
  due.append(parse_due(page))
 contract_valid=bool(due) and all(v is not None for v in due)
 pending=[v for v in due if isinstance(v,(int,float)) and v>0]
 out={"status":"ok" if contract_valid else "contract_drift","auth_ok":bool(auth_ok),"references_seen":len(hrefs),"details_checked":len(due),"contract_valid":contract_valid}
 if contract_valid:out.update({"has_pending":bool(pending),"pending_count":len(pending)})
 print(json.dumps(out,separators=(",",":")))
except Exception as e:
 # Never print request bodies, URLs, cookies, environment, or exception reprs.
 print(json.dumps({"status":"transport_error","error_type":type(e).__name__},separators=(",",":")));raise SystemExit(7)
finally:
 jar.clear()
