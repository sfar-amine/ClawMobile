# Private Samantha Companion history compatibility

This source branch belongs to private samantha-core, not the public ClawMobile fork. Public upstream remains e7f5576e04ace735b1ff1701b59ee6c4f3f3f215. The exact private patch and checksum-gated installation/rollback are maintained on Samantha Core main under deployment/companion-sqlite-20261003.

The SQLite migration fallback already installed on S24 uses Gateway sessions.list/chat.history only when the legacy session file is absent. Corrupt legacy files remain errors; list calls do not produce per-session history calls. No database migration, new store or provider/Bixby change.

Reconciliation on 2026-10-03 commits the existing source unchanged, keeping the running compiled module hash bae7e1439fde28b07717e96f6783c359fbd52b6b1083a284980bf5f9aa1a34ab. It does not rebuild/restart the live Companion.

Verification in the isolated candidate: TypeScript compilation, existing companion-runs suite and seven SQLite compatibility assertions pass. The Companion source/tests are unchanged between public 1dc41e9 and e7f5576. Use the installed Android-compatible Node wrapper and Termux TMPDIR.

The runtime checkout stays on runtime/samantha-companion-private, with its upstream and push remote set to the existing private samantha-core repository. Never push this branch to origin/upstream (public ClawMobile), reset it to public main, or replace its source with the upstream version while preparing a release. Integrate later public changes into this private branch in isolation and revalidate the patch.

Rollback uses the private checksum-gated installer and verified backups; Git integration alone never implies restarting or replacing a running service.
