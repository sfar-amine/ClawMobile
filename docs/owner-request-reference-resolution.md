# Owner request reference resolution

`AMINE-REQ-<revision>` is a human-facing reference backed directly by the durable context event revision.

`context-retrieve.sh` recognizes one or more `AMINE-REQ-*` tokens before normal lexical retrieval. For each reference it:

1. resolves the exact opening event by durable `revision`;
2. follows the `supersedes` chain by event ID;
3. returns `opening`, `current`, and the ordered `chain`;
4. reports `state=open` or `state=resolved` without reading or searching the daily mail.

This keeps the mail as a cockpit, not a source of truth. A reply such as `AMINE-REQ-175 ok` can be grounded from Memory Core directly. Multiple references in one user turn are resolved independently and in citation order.

The resolver does not infer the business meaning of `OK`, `NON`, or `FAIT`; callers still apply the request's explicit expected-response contract and normal human-decision rules.

Validation: `test-context-integration.py` covers direct resolution, supersession, and multiple references in one turn.
