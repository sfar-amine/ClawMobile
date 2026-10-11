export type RuntimeCommandState = "not_started" | "running" | "failed" | "stopping";

export type GatewayStatus = {
  host: string;
  port: number;
  reachable: boolean;
  message: string;
};

export type ModelKeyStatus = {
  configured: boolean;
  provider?: string;
  message: string;
};

export type CompanionHealth = {
  status: "connected" | "disconnected" | "unknown";
  message: string;
  version: string;
  stage?: string;
  checks?: Array<{
    id: string;
    label: string;
    state: "online" | "degraded" | "offline" | "unknown";
    detail?: string;
  }>;
  gateway: GatewayStatus;
  runtime: any;
  model?: ModelKeyStatus;
};

export type RunCreateRequest = {
  clientRunId?: string;
  instruction?: string;
  displayText?: string;
  text?: string;
  userText?: string;
  sessionId?: string;
  attachments?: IntentAttachment[];
  /** Édition d'un message envoyé : rejoue depuis ce run dans une nouvelle conversation (voir runs.ts prepareReplay). */
  replayOf?: { sessionId?: string; runId?: string };
  source?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type IntentAttachment = {
  id: string;
  clientId?: string;
  type: "image" | string;
  mimeType?: string;
  displayName?: string;
  sizeBytes?: number;
  path?: string;
  serverId?: string;
  serverPath?: string;
  downloadUrl?: string;
  expiresAt?: string | number | null;
  createdAt?: number;
};

export type TerminalCommandRequest = {
  command: string;
};

export type TerminalCommandResponse = {
  success: boolean;
  command: string;
  cwd: string;
  output: string;
  message: string;
  exitCode?: number;
  durationMs?: number;
};

export type TerminalSessionRequest = {
  text: string;
};

export type TerminalSessionResponse = {
  success: boolean;
  message: string;
  output: string;
  cwd: string;
  running: boolean;
  pid?: number;
  updatedAt: number;
};

export type IntentSubmitResponse = {
  decision?: import("./receiptPresentation").PublicDecision;
  presentation?: import("./receiptPresentation").ReceiptPresentation;
  understood?: import("./receiptPresentation").ReceiptPresentation["understood"];
  alternatives?: import("./receiptPresentation").ReceiptPresentation["alternatives"];
  failure?: import("./receiptPresentation").ReceiptPresentation["failure"];
  success: boolean;
  accepted?: boolean;
  submissionState?: "accepted" | "not_submitted";
  retrySafe?: boolean;
  duplicate?: boolean;
  runId: string;
  clientRunId?: string;
  sessionId?: string;
  state?: CompanionRunStatus["state"];
  result: string;
  message: string;
  userText?: string;
  canvas: CanvasSchema;
  attachments?: IntentAttachment[];
  /** Édition-relecture acceptée : ancienne conversation, tours remplacés (marqués, non supprimés) et effets connus. */
  replay?: { sourceSessionId: string; runId: string; seededTurns: number; supersededRuns: number; effects: { executed: number; unknown: number } };
  gatewayRun?: unknown;
};

export type CompanionRunStatus = {
  /** Closed projection of the stored decision (receiptPresentation.publicDecision). */
  decision?: import("./receiptPresentation").PublicDecision;
  presentation?: import("./receiptPresentation").ReceiptPresentation;
  understood?: import("./receiptPresentation").ReceiptPresentation["understood"];
  alternatives?: import("./receiptPresentation").ReceiptPresentation["alternatives"];
  failure?: import("./receiptPresentation").ReceiptPresentation["failure"];
  provenance?: import("./capabilityProvenance").CapabilityProvenance;
  inactivityCorrectionReceipt?: import("./runInactivity").InactivityReceipt;
  modality?: "voice";
  clientRunId?: string;
  transcriptState?: "partial" | "completed" | "interrupted";
  playback?: import("./voicePlaybackMetadata").VoicePlaybackMetadata;
  /** Édition-relecture : ce run rejoue un message modifié de `replayOf` ; `supersededBy` marque l'ancienne branche (audit, jamais supprimée). */
  replayOf?: ReplayLink;
  supersededBy?: ReplayLink;
  /** Ce que l'on sait de l'effet de ce tour : `none` (lecture ou question), `executed` (action exécutée), `unknown` (agent ou échec). */
  replayEffect?: "none" | "executed" | "unknown";
  success: boolean;
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  state: "running" | "done" | "failed" | "unknown";
  status?: string;
  memoTranscription?: {phase: "transcribing" | "transcription_pending" | "ready" | "dispatched"; attempts: number; nextAttemptAt?: number};
  message: string;
  result?: string;
  /** F4: structured projection of `result` (summary list only); `result` stays the raw fallback. */
  notification?: import("./notificationText").StructuredNotification | null;
  pendingApprovals?: unknown[];
  progress?: CompanionRunProgress;
  prompt?: string;
  userText?: string;
  attachments?: IntentAttachment[];
  submittedAt?: number;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  tokenUsage?: CompanionRunTokenUsage;
  canvas?: CanvasSchema;
  raw?: unknown;
};

export type ReplayLink = { version: 1; sessionId: string; runId: string; at: number };

export type CompanionRunTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  estimatedCost?: string;
  estimatedCostUsd?: number;
};

export type CompanionRunProgress = {
  text: string;
  detail?: string;
  updatedAt?: number;
  events: CompanionRunProgressEvent[];
  /** HS5: real steps derived on read (runProgress.ts); absent for voice runs. */
  steps?: import("./runProgress").RunStep[];
  failedStep?: string;
  cause?: string;
  effect?: {debited: "unknown"; source: "receipt"};
};

export type CompanionRunProgressEvent = {
  type: string;
  label: string;
  detail?: string;
  at?: number;
  seq?: number;
};

export type RuntimeCommandResponse = {
  success: boolean;
  state: RuntimeCommandState;
  message: string;
  gateway: GatewayStatus;
};

export type RuntimeLogResponse = {
  success: boolean;
  message: string;
  path: string;
  text: string;
  exists: boolean;
  size: number;
  truncated: boolean;
  updatedAt?: number;
};

export type CanvasSchema = {
  title: string;
  summary?: string;
  fields: CanvasField[];
  actions: CanvasAction[];
};

export type CanvasField = {
  id: string;
  label: string;
  type: "Text" | "Checkbox";
  textValue?: string;
  checked?: boolean;
};

export type CanvasAction = {
  id: string;
  label: string;
};
