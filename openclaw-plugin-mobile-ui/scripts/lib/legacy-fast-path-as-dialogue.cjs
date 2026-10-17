// SAM-MIG V2.2 test seam: adapts a legacy fast-path fake (check, then prepared execution) to the dialogue
// coordinator protocol used by the Companion (`--dialogue turn|handoff|abort`). It stands for the Python
// coordinator (tested in samantha-ui-playbooks) and keeps the committed decision per goal, as its store would.
'use strict';
module.exports = function asDialogue(legacy) {
  const goals = new Map();
  let seq = 0;
  return async (text, opts = {}) => {
    const d = opts.dialogue;
    if (!d) return legacy(text, opts);
    if (d.mode === 'abort') { goals.delete(d.goalRef); return { outcome: 'DENIED', reasonCode: 'admission_revoked', handled: true }; }
    if (d.mode === 'handoff') {
      const decision = goals.get(d.goalRef);
      goals.delete(d.goalRef);
      const r = await legacy(text, { ...opts, dialogue: undefined, checkOnly: false, preparedDecision: decision });
      if (r.status === 'hit') return { outcome: 'COMPLETED', text: r.text, handled: true, decision, metadata: r.presentation ? { presentation: r.presentation } : undefined };
      return { outcome: 'FAILED', text: r.text || 'failed', handled: true, decision };
    }
    const r = await legacy(text, { ...opts, dialogue: undefined, checkOnly: true });
    if (r.status === 'eligible') {
      const goalRef = 'goal-' + String(++seq).padStart(20, '0');
      goals.set(goalRef, r.decision);
      return { outcome: 'READY', handled: true, goalRef, pendingHandoff: { goalRef, klass: 'FAST' }, decision: r.decision };
    }
    if (r.status === 'clarification') return { outcome: 'NEEDS_INPUT', text: r.text, handled: true, decision: r.decision, question: { version: 1, kind: 'input', text: r.text } };
    if (r.status === 'known_error') return { outcome: 'FAILED', text: r.text, handled: true, decision: r.decision };
    return { outcome: 'UNRESOLVED', reasonCode: r.reason || 'miss', modelAllowed: true, handled: false };
  };
};
