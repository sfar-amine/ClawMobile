#!/data/data/com.termux/files/usr/bin/python3
import json,os,re
def sent(name):
 v=os.environ.get(name,'')
 return bool(v), bool(re.fullmatch(r'oc-sent-v2\..+\.end',v))
print(json.dumps({
 "steg_username":sent("STEG_USERNAME"),
 "steg_password":sent("STEG_PASSWORD"),
 "https_proxy":bool(os.environ.get("HTTPS_PROXY")),
 "curl_ca_bundle":bool(os.environ.get("CURL_CA_BUNDLE")),
 "requests_ca_bundle":bool(os.environ.get("REQUESTS_CA_BUNDLE"))
},separators=(",",":")))
