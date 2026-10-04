#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import argparse,json,os,shutil,subprocess
from pathlib import Path
H=Path.home(); SRC=Path(__file__).resolve().parent; T=H/'.openclaw/tier0'; BIN=T/'bin'; BOOT=H/'.termux/boot/start-samantha'; TERMUX_PROPERTIES=H/'.termux/termux.properties'
NAMES=('tier0-control.py','tier0-watchdog.py','tier0-bootstrap.sh','native-recovery-entrypoint.py')
def ensure_termux_external_apps(path:Path=TERMUX_PROPERTIES):
    path.parent.mkdir(parents=True,exist_ok=True)
    old=path.read_text() if path.exists() else ''
    lines=old.splitlines(); out=[]; seen=False
    for line in lines:
        stripped=line.strip()
        if stripped.startswith('allow-external-apps=') and not stripped.startswith('#'):
            if not seen: out.append('allow-external-apps=true');seen=True
        else: out.append(line)
    if not seen: out.append('allow-external-apps=true')
    new='\n'.join(out).rstrip()+"\n"
    if new==old:return False
    backup=T/'backups/termux.properties.pre-native-recovery'
    if path.exists() and not backup.exists():
        backup.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,backup)
    tmp=path.with_suffix('.tmp');tmp.write_text(new);os.chmod(tmp,0o600);os.replace(tmp,path)
    return True

def write_boot():
    BOOT.parent.mkdir(parents=True,exist_ok=True)
    if BOOT.exists() and 'tier0-bootstrap.sh' not in BOOT.read_text():
        shutil.copy2(BOOT,BOOT.with_name('start-samantha.pre-tier0'))
    text='#!/data/data/com.termux/files/usr/bin/bash\ntermux-wake-lock 2>/dev/null || true\nexec "$HOME/.openclaw/tier0/bin/tier0-bootstrap.sh"\n'
    tmp=BOOT.with_suffix('.tmp');tmp.write_text(text);os.chmod(tmp,0o700);os.replace(tmp,BOOT)
def main():
    p=argparse.ArgumentParser();p.add_argument('--apply',action='store_true');p.add_argument('--source-root',default=str(SRC));p.add_argument('--soak-seconds',type=int,default=300);p.add_argument('--startup-grace-seconds',type=int,default=30);p.add_argument('--critical-capability',action='append');p.add_argument('--product-manifest');a=p.parse_args()
    if not a.apply: raise SystemExit('use --apply')
    BIN.mkdir(parents=True,exist_ok=True);os.chmod(T,0o700);os.chmod(BIN,0o700)
    for n in NAMES:
        src=Path(a.source_root)/n
        tmp=BIN/(n+'.next')
        try:tmp.unlink()
        except FileNotFoundError:pass
        shutil.copy2(src,tmp);os.chmod(tmp,0o500);os.replace(tmp,BIN/n)
    write_boot()
    changed=ensure_termux_external_apps()
    if changed:
        subprocess.run(['termux-reload-settings'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5,check=False)
    source=Path(a.source_root)
    commit=subprocess.run(['git','-C',str(source),'rev-parse','HEAD'],capture_output=True,text=True).stdout.strip() or 'unknown'
    critical=a.critical_capability
    if critical is None:
        try:
            state=json.loads((T/'state.json').read_text())
            critical=[str(x) for x in state.get('critical_capabilities',[]) if str(x)]
        except (OSError,ValueError,TypeError):
            critical=[]
    cmd=[str(BIN/'tier0-control.py'),'package','--source',str(source),'--source-commit',commit,'--soak-seconds',str(a.soak_seconds),'--startup-grace-seconds',str(a.startup_grace_seconds)]
    for cap in critical: cmd += ['--critical-capability',cap]
    if a.product_manifest: cmd += ['--product-manifest',a.product_manifest]
    rid=subprocess.run(cmd,capture_output=True,text=True,check=True).stdout.strip()
    subprocess.run([str(BIN/'tier0-control.py'),'promote',rid],check=True)
    print('TIER0_INSTALLED',rid)
if __name__=='__main__':main()
