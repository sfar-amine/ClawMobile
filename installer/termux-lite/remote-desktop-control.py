#!/data/data/com.termux/files/usr/bin/python3
"""RDC watchdog primitives shared with managed repair and canonical health."""
import argparse, contextlib, datetime, fcntl, json, os, signal, sqlite3
import subprocess, time
import urllib.error, urllib.request
from pathlib import Path

SCRIPT = '/data/data/com.termux/files/usr/lib/node_modules/@wonderwhy-er/desktop-commander/dist/index.js'
ROOT = Path(__file__).resolve().parent
REMOTE_ENDPOINT = 'https://mcp.desktopcommander.app'

def remote_dependency_reachable(url=REMOTE_ENDPOINT, timeout=5):
    try:
        req = urllib.request.Request(url, method='HEAD', headers={'User-Agent':'Claw-RDC-Health/1'})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return 200 <= int(getattr(response, 'status', 0)) < 500
    except (OSError, ValueError, urllib.error.URLError):
        return False


def identity(pid, proc=Path('/proc')):
    try:
        p = proc / str(pid)
        fields = (p/'stat').read_text().rsplit(')', 1)[1].split()
        if fields[0] == 'Z': return None
        return {'pid': int(pid), 'start_ticks': fields[19], 'ppid': int(fields[1]),
                'args': (p/'cmdline').read_bytes().decode(errors='replace').split('\0')}
    except (OSError, ValueError, IndexError): return None

def processes(proc=Path('/proc')):
    rows = []
    for p in proc.iterdir():
        if p.name.isdigit():
            r = identity(p.name, proc)
            if r and SCRIPT in r['args'] and 'remote' in r['args']: rows.append(r)
    return rows

def health(home=None, proc=Path('/proc'), now=None):
    home = Path(home or Path.home()); now = time.time() if now is None else now
    rows = processes(proc)
    result = {'state': 'down', 'reason': 'process_missing', 'instance_count': len(rows),
              'pids': [r['pid'] for r in rows], 'checked_at': now, 'e2e': 'external_probe_required'}
    if len(rows) != 1:
        if rows: result.update(state='degraded', reason='duplicate_instances')
        return result
    r = rows[0]
    expected_shell = str(ROOT/'remote-desktop-bash')
    if (ROOT/'remote-desktop-bash').exists():
        try:
            env = {}
            for item in (proc/str(r['pid'])/'environ').read_bytes().split(b'\0'):
                if b'=' in item:
                    key, value = item.split(b'=', 1)
                    if key == b'SHELL': env['SHELL'] = value.decode(errors='replace')
            if env.get('SHELL') != expected_shell:
                result.update(state='degraded', reason='runtime_environment_stale')
                return result
        except OSError:
            result.update(state='unverified', reason='runtime_environment_unreadable')
            return result
    p = home/'.openclaw/watchdogs'/f"remote-desktop-{r['pid']}.json"
    try:
        d = json.loads(p.read_text()); age = now-float(d['checked_at'])
        boot = (proc/'sys/kernel/random/boot_id').read_text().strip()
        match = d['pid'] == r['pid'] and str(d['start_ticks']) == r['start_ticks'] and d['boot_id'] == boot
        result['freshness_s'] = round(age, 3)
        if not match: reason = 'receipt_identity_mismatch'
        elif not 0 <= age <= 35: reason = 'functional_receipt_stale'
        elif d.get('session_lost'): reason = 'remote_session_lost'
        elif d.get('local_mcp') is not True: reason = 'local_mcp_unresponsive'
        elif d.get('remote_channel') is not True: reason = 'remote_channel_unhealthy'
        elif d.get('healthy') is not True: reason = 'functional_probe_failed'
        else: result.update(state='healthy', reason='local_mcp_ping_and_remote_heartbeat'); return result
        result.update(state='degraded', reason=reason)
    except (OSError, ValueError, KeyError, TypeError):
        result.update(state='unverified', reason='functional_receipt_missing_or_invalid')
    return result

class Controller:
    def __init__(self, home=None, root=ROOT, readiness=60, attempts=2, half_open_probe_s=60, dependency_probe=None):
        self.home = Path(home or Path.home()); self.root = Path(root)
        self.state = self.home/'.openclaw/watchdogs'; self.state.mkdir(parents=True, exist_ok=True)
        self.readiness = readiness; self.attempts = attempts
        self.half_open_probe_s = max(15, int(half_open_probe_s))
        self.dependency_probe = dependency_probe or remote_dependency_reachable
    def log(self, text):
        with (self.state/'remote-desktop.log').open('a') as f:
            f.write(datetime.datetime.now().astimezone().isoformat(timespec='seconds')+' '+text+'\n')
    def beat(self):
        p = self.home/'.openclaw/health/remote-watchdog.heartbeat'
        p.parent.mkdir(parents=True, exist_ok=True); p.write_text(str(int(time.time())))
    @contextlib.contextmanager
    def lock(self, name):
        with (self.state/name).open('a') as f:
            try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: yield False; return
            try: yield True
            finally: fcntl.flock(f, fcntl.LOCK_UN)
    def probe(self): return health(self.home)
    def stop(self):
        parents = processes(); victims = list(parents)
        parent_ids = {r['pid'] for r in parents}
        for p in Path('/proc').iterdir():
            if not p.name.isdigit(): continue
            r = identity(p.name)
            # Only RDC's direct MCP child, never its user's running shell/build.
            if r and r['ppid'] in parent_ids and SCRIPT in r['args'] and 'remote' not in r['args']: victims.append(r)
        def remains(r):
            actual = identity(r['pid'])
            return actual and actual['start_ticks'] == r['start_ticks']
        for sig, duration in [(signal.SIGTERM, 7), (signal.SIGKILL, 2)]:
            for r in victims:
                if remains(r):
                    try: os.kill(r['pid'], sig)
                    except ProcessLookupError: pass
            deadline = time.monotonic()+duration
            while any(remains(r) for r in victims) and time.monotonic() < deadline:
                self.beat(); time.sleep(.25)
        return not any(remains(r) for r in victims) and not processes()
    def launch(self):
        log = self.state/'remote-desktop-process.log'
        if log.exists() and log.stat().st_size > 4194304:
            with log.open('rb') as f: f.seek(-1048576, 2); tail = f.read()
            log.write_bytes(tail)
        tmp = self.home/'.cache/tmp'
        tmp.mkdir(parents=True, exist_ok=True, mode=0o700)
        env = os.environ.copy()
        env.update(TMPDIR=str(tmp), TMP=str(tmp), TEMP=str(tmp),
                   SHELL=str(self.root/'remote-desktop-bash'))
        with log.open('ab') as out:
            subprocess.Popen([str(self.home/'.openclaw-android/bin/node'),
                '--import='+str(self.root/'remote-desktop-health.mjs'), SCRIPT, 'remote'], cwd=self.home,
                stdin=subprocess.DEVNULL, stdout=out, stderr=out, close_fds=True, start_new_session=True, env=env)
    def wait_ready(self):
        deadline = time.monotonic()+self.readiness; passed = 0
        while time.monotonic() < deadline:
            self.beat(); d = self.probe()
            passed = passed+1 if d['state'] == 'healthy' else 0
            if passed >= 2: return True
            if d['reason'] in ('duplicate_instances', 'remote_session_lost'): return False
            time.sleep(1)
        return False
    def repair(self):
        with self.lock('remote-desktop-repair.lock') as acquired:
            if not acquired: return {'state': 'busy', 'reason': 'repair_already_owned'}
            if self.probe()['state'] == 'healthy':
                return {'state':'recovered','evidence':self.probe(),'mutation':'none_already_healthy'}
            for attempt in range(1, self.attempts+1):
                # Every retry cleans and verifies the previous attempt first.
                if not self.stop(): return {'state':'failed','reason':'previous_instance_survived'}
                self.log(f'restart attempt {attempt}/{self.attempts} readiness_deadline_s={self.readiness}')
                self.launch()
                if self.wait_ready(): return {'state':'recovered','evidence':self.probe()}
                if not self.stop(): return {'state':'failed','reason':'attempt_cleanup_failed'}
            return {'state':'failed','reason':'bounded_functional_readiness_exhausted'}
    def half_open(self):
        if not self.dependency_probe():
            return {'state':'deferred','reason':'remote_dependency_unreachable'}
        self.log('HALF-OPEN dependency_reachable=true action=repair')
        return self.repair()
    def incident(self, action, reason):
        cmd = [str(self.root/'incident-orchestrator.py'), action, 'remote_desktop', 'runtime',
               '--source', 'remote-desktop-watchdog', '--summary' if action=='open' else '--reason', reason]
        try: return subprocess.run(cmd, capture_output=True, text=True, timeout=20).returncode == 0
        except subprocess.TimeoutExpired: return False
    def notify(self, mode):
        # Retain existing notification entrypoints; delivery stays owned by them.
        if mode == 'recovered':
            cmd=[str(self.root/'incident-close.sh'),'Remote Desktop Commander','Samantha — RDC est de nouveau operationnel; connexion et MCP verifies.']
        else:
            message='Samantha — RDC retabli automatiquement; connexion et MCP verifies.' if mode=='repaired' else 'Samantha — RDC indisponible apres reprises bornees; incident transmis au diagnostic gere.'
            cmd=[str(self.root/'incident-notify.sh'),'remote_desktop',message]
        subprocess.Popen(cmd,cwd=self.home,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True,start_new_session=True)
    def supervise(self):
        with self.lock('remote-desktop.lock') as acquired:
            if not acquired: return
            p = self.state/'remote-desktop.state'
            previous = p.read_text().strip() if p.exists() else 'unknown'
            failures = 0; next_half_open = None
            self.log(f'watchdog started; previous={previous} functional_probe=v4_mcp_remote_receipt')
            while True:
                self.beat(); current = self.probe()
                if current['state'] == 'healthy':
                    if previous == 'down':
                        self.log('RECOVERED functional=true circuit=closed')
                        self.incident('recover', 'Singleton RDC: local MCP ping and current remote heartbeat verified')
                        self.notify('recovered')
                    p.write_text('up'); previous = 'up'; failures = 0; next_half_open = None
                elif previous != 'down':
                    failures += 1
                    if current['reason'] not in ('duplicate_instances','process_missing','functional_receipt_missing_or_invalid') and failures < 3:
                        for _ in range(15): self.beat(); time.sleep(1)
                        continue
                    self.log('DOWN confirmed: '+current['reason'])
                    result = self.repair()
                    if result['state'] == 'recovered':
                        self.log('SELF-HEAL SUCCESS functional=true'); p.write_text('up'); previous='up'
                        self.notify('repaired')
                    elif result['state'] != 'busy':
                        self.log('SELF-HEAL FAILED circuit=open reason='+result['reason'])
                        # Persist open circuit only after canonical ingress acknowledgement.
                        if self.incident('open', 'Remote Desktop functional recovery exhausted: '+result['reason']):
                            p.write_text('down'); previous='down'; next_half_open=time.monotonic()+self.half_open_probe_s
                            self.notify('failed')
                        else:
                            self.log('INCIDENT_INGRESS_FAILED no_restart_replay=true')
                            p.write_text('down'); previous='down'; next_half_open=time.monotonic()+self.half_open_probe_s
                else:
                    # Reconcile lost ingress without repeating the failed recovery mutation.
                    db=self.home/'.openclaw/incidents/orchestrator.db'
                    try:
                        with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as c:
                            row=c.execute("select state from incidents where component='remote_desktop' and scope='runtime' order by created desc limit 1").fetchone()
                        if row is None or row[0]=='recovered': self.incident('open', 'RDC remains unhealthy with circuit open')
                    except sqlite3.Error: pass
                    now = time.monotonic()
                    if next_half_open is None:
                        next_half_open = now + self.half_open_probe_s
                    if now >= next_half_open:
                        next_half_open = now + self.half_open_probe_s
                        result = self.half_open()
                        if result['state'] == 'recovered':
                            self.log('RECOVERED functional=true circuit=closed source=half_open')
                            self.incident('recover', 'Half-open RDC: remote dependency reachable, local MCP ping and remote heartbeat verified')
                            self.notify('recovered')
                            p.write_text('up'); previous='up'; failures=0; next_half_open=None
                        elif result['state'] not in ('busy','deferred'):
                            self.log('HALF-OPEN FAILED circuit=open reason='+result['reason'])
                for _ in range(15): self.beat(); time.sleep(1)

def diagnostics(home=None):
    home=Path(home or Path.home()); d={'functional_probe':health(home),'watchdog_events':[]}
    p=home/'.openclaw/watchdogs/remote-desktop.log'
    if p.exists():
        with p.open('rb') as f:
            f.seek(max(0,p.stat().st_size-8192)); lines=f.read().decode(errors='replace').splitlines()
        d['watchdog_events']=lines[-12:]
    d['managed_action_contract']={'action':'runtime.managed_repair','scope':'RDC only',
        'behavior':'serialized stop, verify exit, restart, bounded local MCP and remote heartbeat check',
        'code_editing':False,'max_attempts':2}
    return d

def main():
    p=argparse.ArgumentParser(); p.add_argument('command', choices=['health','repair','diagnostics','supervise'])
    p.add_argument('--watchdog-tag'); a=p.parse_args()
    if a.command=='supervise': Controller().supervise(); return 0
    d=diagnostics() if a.command=='diagnostics' else Controller().repair() if a.command=='repair' else health()
    print(json.dumps(d)); return 0 if a.command=='diagnostics' or d['state'] in ('healthy','recovered') else 1
if __name__=='__main__': raise SystemExit(main())
