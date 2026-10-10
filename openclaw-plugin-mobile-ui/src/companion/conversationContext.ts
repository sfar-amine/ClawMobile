/** Nullable projection of the public sessions.list row, not a token estimate.
 * Public package OpenClaw2026.9.6 session-row-prepared-read establishes these
 * fields. This draft HTTP projection still requires installed S24 captures.
 */
export type ConversationContext={usedTokens:number;windowTokens:number;percent:number;source:"gateway";measuredAt:number};
export function conversationContext(row:any):ConversationContext|null{
 if(!row||typeof row!=='object'||row.totalTokensFresh!==true||!Number.isSafeInteger(row.totalTokens)||row.totalTokens<0||!Number.isSafeInteger(row.contextTokens)||row.contextTokens<=0||!Number.isSafeInteger(row.snapshotAt)||row.snapshotAt<=0)return null;
 return {usedTokens:row.totalTokens,windowTokens:row.contextTokens,percent:Math.max(0,Math.min(100,Math.round(100*row.totalTokens/row.contextTokens))),source:"gateway",measuredAt:row.snapshotAt};
}
