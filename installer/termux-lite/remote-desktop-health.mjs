// Observation only. Loaded into RDC's existing process; no server or credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

export function assess(device, now, localPing) {
  const c = device?.remoteChannel;
  const age = c?.lastHeartbeatOkAt == null ? null : now - c.lastHeartbeatOkAt;
  const remote = c?.channel?.state === 'joined' && c.presenceTracked === true &&
    !c.sessionLost && !c.shuttingDown && age !== null && age >= 0 && age <= 75000;
  return { local_mcp: localPing === true, remote_channel: remote,
    remote_heartbeat_age_ms: age, session_lost: c?.sessionLost === true,
    healthy: localPing === true && remote && !device.isShuttingDown };
}

export async function install(MCPDevice, receiptDir) {
  const original = MCPDevice.prototype.start;
  const stat = await fs.readFile('/proc/self/stat', 'utf8');
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  await fs.mkdir(receiptDir, { recursive: true, mode: 0o700 });
  MCPDevice.prototype.start = async function (...args) {
    let busy = false;
    const sample = async () => {
      if (busy) return;
      busy = true;
      try {
        let local = false;
        if (this.desktop?.ready && this.desktop?.mcpClient) {
          try {
            await this.desktop.mcpClient.ping({ timeout: 3000 });
            local = true;
          } catch { /* bounded failed MCP ping is evidence, never an auto-replay */ }
        }
        const result = { version: 1, pid: process.pid, start_ticks: startTicks,
          boot_id: bootId, checked_at: Date.now() / 1000,
          ...assess(this, performance.now(), local) };
        const file = path.join(receiptDir, `remote-desktop-${process.pid}.json`);
        await fs.writeFile(file + '.tmp', JSON.stringify(result) + '\n', { mode: 0o600 });
        await fs.rename(file + '.tmp', file);
      } catch { /* missing receipt fails closed in the external watchdog */ }
      finally { busy = false; }
    };
    const timer = setInterval(() => void sample(), 10000);
    timer.unref();
    void sample();
    return original.apply(this, args);
  };
}

if (process.argv.includes('remote')) {
  const dist = '/data/data/com.termux/files/usr/lib/node_modules/@wonderwhy-er/desktop-commander/dist';
  const { MCPDevice } = await import(pathToFileURL(path.join(dist, 'remote-device/device.js')));
  await install(MCPDevice, path.join(os.homedir(), '.openclaw/watchdogs'));
}
