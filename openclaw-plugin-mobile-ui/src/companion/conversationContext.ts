/** Nullable projection of the public sessions.list row, not a token estimate.
 * Installed S24 capture fixtures/s24-2026-10-10/gateway/sessions.list.json
 * confirms these fields; public package OpenClaw2026.9.6 also establishes their shape.
 */
export type ConversationContext={usedTokens:number;windowTokens:number;percent:number;source:"gateway";measuredAt:number};
export function conversationContext(row:any):ConversationContext|null{
 if(!row||typeof row!=='object'||row.totalTokensFresh!==true||!Number.isSafeInteger(row.totalTokens)||row.totalTokens<0||!Number.isSafeInteger(row.contextTokens)||row.contextTokens<=0||!Number.isSafeInteger(row.snapshotAt)||row.snapshotAt<=0)return null;
 return {usedTokens:row.totalTokens,windowTokens:row.contextTokens,percent:Math.max(0,Math.min(100,Math.round(100*row.totalTokens/row.contextTokens))),source:"gateway",measuredAt:row.snapshotAt};
}
