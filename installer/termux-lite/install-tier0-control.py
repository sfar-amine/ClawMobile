#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import argparse,json,os,shutil,subprocess,signal,time
from pathlib import Path
H=Path.home(); SRC=Path(__file__).resolve().parent; T=H/'.openclaw/tier0'; BIN=T/'bin'; BOOT=H/'.termux/boot/start-samantha'; TERMUX_PROPERTIES=H/'.termux/termux.properties'
NAMES=('bounded-log.py','tier0-control.py','runtime_mode.py','tier0-watchdog.py','immune_action.py','tier0-bootstrap.sh','native-recovery-entrypoint.py','android-game-day-run.sh')
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

def watchdog_identity(pid):
    """Exact canonical argv plus kernel start ticks; a recycled PID never authorizes termination."""
    try:
        root=Path('/proc')/str(pid)
        args=[a.decode(errors='replace') for a in (root/'cmdline').read_bytes().split(b'\0') if a]
        if str(BIN/'tier0-watchdog.py') not in args:return None
        fields=(root/'stat').read_text().rsplit(')',1)[1].split()
        return fields[19]
    except (OSError,ValueError,IndexError):return None

def watchdogs_before_update():
    result={}
    for p in Path('/proc').iterdir():
        if p.name.isdigit():
            identity=watchdog_identity(int(p.name))
            if identity is not None:result[int(p.name)]=identity
    return result

def watchdog_has_children(captured,proc=Path('/proc')):
    # Do not turn an in-flight decision/effect into an uncertain replay by killing its owner.
    # A zombie (state Z) has already exited and only awaits reaping: no effect is in flight. The S24 resident
    # watchdog Popen()s bootstrap without waiting, so its exited children stay defunct until it is replaced.
    for p in proc.iterdir():
        if not p.name.isdigit():continue
        try:
            fields=(p/'stat').read_text().rsplit(')',1)[1].split();state,parent=fields[0],int(fields[1])
            if state=='Z':continue
            if parent in captured and watchdog_identity(parent)==captured[parent]:return True
        except (OSError,ValueError,IndexError):continue
    return False

def reload_watchdog(captured):
    # This is the existing deployment owner's explicit reload, after the complete AI bridge was copied. Merely
    # replacing Python files does not reload a resident interpreter (S24 PID started 18/10, code replaced 24/10).
    if watchdog_has_children(captured):raise RuntimeError('watchdog_busy_no_reload')
    for sig in (signal.SIGTERM,signal.SIGKILL):
        live=[pid for pid,start in captured.items() if watchdog_identity(pid)==start]
        if not live:return
        for pid in live:
            try:os.kill(pid,sig)
            except ProcessLookupError:pass
        deadline=time.monotonic()+1
        while time.monotonic()<deadline and any(watchdog_identity(pid)==captured[pid] for pid in live):time.sleep(.05)
    if any(watchdog_identity(pid)==start for pid,start in captured.items()):raise RuntimeError('watchdog_reload_not_stopped')

def main():
    p=argparse.ArgumentParser();p.add_argument('--apply',action='store_true');p.add_argument('--source-root',default=str(SRC));p.add_argument('--soak-seconds',type=int,default=300);p.add_argument('--startup-grace-seconds',type=int,default=30);p.add_argument('--critical-capability',action='append');p.add_argument('--product-manifest');a=p.parse_args()
    if not a.apply: raise SystemExit('use --apply')
    BIN.mkdir(parents=True,exist_ok=True);os.chmod(T,0o700);os.chmod(BIN,0o700)
    resident=watchdogs_before_update()
    if watchdog_has_children(resident):raise RuntimeError('watchdog_busy_no_reload')
    # Validate the full versioned dependency set before the first replacement.
    for n in NAMES:
        if not (Path(a.source_root)/n).is_file():raise RuntimeError('tier0_dependency_missing:'+n)
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
    # Existing guardian/bootstrap will start the new singleton from this complete, versioned bin directory.
    reload_watchdog(resident)
    inherited=os.environ.get('SAMANTHA_DEPLOY_LOCK_FD','')
    pass_fds=(int(inherited),) if inherited.isdigit() else ()
    subprocess.run([str(BIN/'tier0-control.py'),'promote',rid],check=True,pass_fds=pass_fds)
    print('TIER0_INSTALLED',rid)
if __name__=='__main__':main()
