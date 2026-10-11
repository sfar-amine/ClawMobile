  /** Trusted platform-native conversation id for the active inbound turn. */
  nativeChannelId?: string;
  /** Trusted sender id from inbound context (runtime-provided, not tool args). */
  requesterSenderId?: string;
  /** Trusted owner bit from inbound context (runtime-provided, not tool args). */
  senderIsOwner?: boolean;
  /** Live host-bound authority. Recheck inside the final synchronous effect/write guard. */
  assertInvocationCurrent?: () => void;

/** Version 1 is the source-compatible direct-turn context; version 2 requires final-effect authority. */
type OpenClawPluginToolContext<Version extends 1 | 2 = 1> = Version extends 2 ? OpenClawPluginToolContextBase & {
  assertInvocationCurrent: () => void;
} : OpenClawPluginToolContextBase;
/** A version 2 descriptor explicitly opts into owner-authorized continuations. */
type OpenClawPluginToolFactory$1<Version extends 1 | 2 = 1> = Version extends 2 ? {
  contextVersion: 2;
  create: (ctx: OpenClawPluginToolContext<2>) => ReturnType<OpenClawPluginToolFactory$1>;
} : (ctx: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null | undefined;
