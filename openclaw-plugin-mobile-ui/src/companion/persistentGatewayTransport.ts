/** Bounded transport around OpenClaw's official handshake/reconnect owner. */
export type GatewayCallOptions = {expectFinal?: boolean; timeoutMs?: number; hardTimeoutMs?: number; strictOutput?: {stdoutMaxBytes:number;stderrMaxBytes:number;killGraceMs:number}};
export type GatewayClientOwner = {
  connected: boolean;
  start(): void;
  stop(): void;
  request(method: string, params: any, options: {
    expectFinal?: boolean; timeoutMs: number; signal?: AbortSignal;
  }): Promise<any>;
};
export type GatewayCallbacks = {
  onHelloOk(): void;
  onClose(code?: number): void;
  onConnectError(error: any): void;
};
export type GatewayClientFactory = (callbacks: GatewayCallbacks) => GatewayClientOwner;
type Job = {method: string; params: any; options: GatewayCallOptions; deadline: number;
  resolve(v: any): void; reject(e: any): void; timer: ReturnType<typeof setTimeout>; started: boolean};
const failure = (code: string, sent = false) => Object.assign(new Error(code), {code, requestSent: sent});
const socketDown = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOENT']);
const casMessages = new Set([
  'config base hash unavailable; re-run config.get and retry',
  'config base hash required; re-run config.get and retry',
  'config changed since last load; re-run config.get and retry',
]);
/** No arbitrary SDK message, details or credential may cross this boundary. */
function requestFailure(method: string, cause: any) {
  if (cause?.name === 'GatewayClientRequestError' && cause?.gatewayCode === 'FORBIDDEN' && cause?.details?.code === 'MISSING_SCOPE') {
    return Object.assign(failure('gateway_scope_refused', true), {gatewayCode: 'FORBIDDEN', effectNotStarted: true});
  }
  if (method === 'cron.runs' && cause?.name === 'GatewayClientRequestError' && cause?.gatewayCode === 'INVALID_REQUEST' && cause?.details?.code === 'CRON_JOB_NOT_FOUND') {
    return Object.assign(failure('CRON_JOB_NOT_FOUND', true), {gatewayCode: 'INVALID_REQUEST', effectNotStarted: true});
  }
  if (cause?.name === 'GatewayClientRequestError' && cause?.gatewayCode === 'INVALID_REQUEST') {
    if (method === 'config.patch' && casMessages.has(cause.message)) {
      return Object.assign(failure('gateway_config_revision_conflict', true), {
        message: 'config baseHash conflict', gatewayCode: 'INVALID_REQUEST', effectNotStarted: true,
      });
    }
    return Object.assign(failure('gateway_request_invalid', true), {
      gatewayCode: 'INVALID_REQUEST',
    });
  }
  return failure('gateway_dispatch_indeterminate', true);
}
export class PersistentGatewayTransport {
  private client: GatewayClientOwner;
  private closed = false;
  private helloReady = false;
  private queue: Job[] = [];
  private running = new Set<Job>();
  private waiters = new Set<(available: boolean) => void>();
  private unavailable = false;
  private authenticationRejected = false;
  constructor(factory: GatewayClientFactory,
    private cli: (method: string, params: any, options: GatewayCallOptions) => Promise<any>) {
    this.client = factory({
      onHelloOk: () => {
        this.helloReady = true; this.unavailable = false;
        this.authenticationRejected = false; this.wake(true);
      },
      onClose: code => {
        const previouslyAdmitted = this.helloReady;
        this.helloReady = false;
        if (code === 1008) this.authenticationRejected = true;
        else if (previouslyAdmitted) this.unavailable = true;
        // A pre-hello close is not evidence that bypassing admission via CLI is safe.
        if (this.unavailable || this.authenticationRejected) this.wake(false);
      },
      onConnectError: cause => {
        this.helloReady = false;
        if (socketDown.has(cause?.code)) this.unavailable = true;
        else this.authenticationRejected = true;
        this.wake(false);
      },
    });
    // The SDK owns challenge, authentication, device identity and reconnect/backoff.
    this.client.start();
  }
  call(method: string, params: any = {}, options: GatewayCallOptions = {}): Promise<any> {
    if (this.closed) return Promise.reject(failure('gateway_transport_closed'));
    if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,159}$/.test(method) ||
      !params || typeof params !== 'object' || Array.isArray(params)) return Promise.reject(failure('gateway_call_invalid'));
    let captured: any;
    try {
      const encoded = JSON.stringify(params);
      if (Buffer.byteLength(encoded) > 256 * 1024) return Promise.reject(failure('gateway_call_too_large'));
      captured = JSON.parse(encoded);
    } catch { return Promise.reject(failure('gateway_call_invalid')); }
    const timeout = options.timeoutMs ?? 10000, hard = options.hardTimeoutMs ?? timeout;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 300000 ||
      !Number.isFinite(hard) || hard < 1 || hard > 300000) return Promise.reject(failure('gateway_call_invalid'));
    if (options.strictOutput) {
      const bounds = options.strictOutput;
      if (hard > 30000 || !Number.isSafeInteger(bounds.stdoutMaxBytes) || bounds.stdoutMaxBytes < 256 || bounds.stdoutMaxBytes > 9 * 1024 * 1024 ||
        !Number.isSafeInteger(bounds.stderrMaxBytes) || bounds.stderrMaxBytes < 256 || bounds.stderrMaxBytes > 128 * 1024 ||
        !Number.isSafeInteger(bounds.killGraceMs) || bounds.killGraceMs < 1 || bounds.killGraceMs > 1000) {
        return Promise.reject(failure('gateway_read_limits_invalid'));
      }
    }
    if (this.queue.length >= 32) return Promise.reject(failure('gateway_queue_full'));
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + Math.min(timeout, hard);
      const job: Job = {method, params: captured, options: {...options}, deadline,
        resolve, reject, started: false, timer: undefined as any};
      job.timer = setTimeout(() => {
        if (job.started) return;
        this.queue = this.queue.filter(x => x !== job); reject(failure('gateway_queue_timeout'));
      }, Math.max(1, deadline - Date.now()));
      this.queue.push(job); this.drain();
    });
  }
  private wake(available: boolean) { for (const waiter of [...this.waiters]) waiter(available); }
  private waitForSocket(deadline: number): Promise<boolean> {
    // connected alone is transport state, not successful admission.
    if (this.helloReady && this.client.connected) return Promise.resolve(true);
    if (this.unavailable || this.authenticationRejected) return Promise.resolve(false);
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const done = (available: boolean) => {
        clearTimeout(timer); this.waiters.delete(done); resolve(available);
      };
      this.waiters.add(done); timer = setTimeout(() => done(false), Math.max(1, deadline - Date.now()));
    });
  }
  private drain() {
    while (!this.closed && this.running.size < 4 && this.queue.length) {
      const job = this.queue.shift()!; clearTimeout(job.timer);
      if (Date.now() >= job.deadline) { job.reject(failure('gateway_queue_timeout')); continue; }
      job.started = true; this.running.add(job);
      this.execute(job).then(job.resolve, job.reject).finally(() => {
        this.running.delete(job); this.drain();
      });
    }
  }
  private async execute(job: Job) {
    const ready = await this.waitForSocket(job.deadline);
    if (this.closed) throw failure('gateway_transport_closed');
    const remaining = Math.max(0, job.deadline - Date.now());
    if (!remaining) throw failure('gateway_connect_timeout');
    if (!ready) {
      if (this.authenticationRejected) throw failure('gateway_connect_refused');
      if (!this.unavailable) throw failure('gateway_connect_timeout');
      try {
        return await this.cli(job.method, job.params,
          {...job.options, timeoutMs: remaining, hardTimeoutMs: remaining});
      } catch (cause: any) {
        if (['ENOENT', 'ECONNREFUSED'].includes(cause?.code)) throw failure(cause.code);
        // CLI structured refusal is already normalized by its owner below.
        if (cause?.code === 'gateway_config_revision_conflict') throw cause;
        if (job.options.strictOutput && cause?.message === 'gateway_read_failed') throw failure('gateway_read_failed', true);
        if (job.options.strictOutput && cause?.message === 'gateway_read_limits_invalid') throw failure('gateway_read_limits_invalid');
        throw failure('gateway_cli_failed', true);
      }
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), remaining);
    // Crossing request() is the dispatch boundary. No SDK rejection causes replay.
    try {
      const result = await this.client.request(job.method, job.params,
        {expectFinal: job.options.expectFinal, timeoutMs: remaining, signal: abort.signal});
      if (job.options.strictOutput) {
        // SDK supplies parsed JSON, not stdout/stderr. Preserve the response byte ceiling
        // from the existing file owner; SDK loggers are neutralized and CLI limits unchanged.
        let bytes: number;
        try { bytes = Buffer.byteLength(JSON.stringify(result)); }
        catch { throw failure('gateway_read_failed', true); }
        if (bytes > job.options.strictOutput.stdoutMaxBytes) throw failure('gateway_read_failed', true);
      }
      return result;
    } catch (cause: any) {
      if (cause?.code === "gateway_read_failed") throw cause;
      throw requestFailure(job.method, cause);
    }
    finally { clearTimeout(timer); }
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.helloReady = false; this.client.stop(); this.wake(false);
    for (const job of this.queue) { clearTimeout(job.timer); job.reject(failure('gateway_transport_closed')); }
    this.queue = [];
  }
}
