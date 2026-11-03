# Native execution: retain the existing auth SecretRef owner

The real Gemini primary smoke returned `executor_unavailable` before a model was
confirmed. Earlier isolated native diagnostics failed while resolving a Copilot
secret reference, although native metadata remained readable. Public installed
OpenClaw source shows that `agent exec` scopes persisted authentication to its
original state directory, while `prepareSecretsRuntimeSnapshot` used the temporary
execution state's environment for SecretRefs. No credential file was inspected.

The existing reversible compatibility owner now supports a second, closed patch
set. For the exact captured 2026.9.6 module it passes the native scoped auth
environment to secret snapshot preparation, preserving explicit environment
precedence. Execution state/workspace remain isolated. Missing credentials still
fail; no credential is copied, no Gateway lock is bypassed, no profile is removed,
and no API, fallback, DATA02 admission or business permission is enabled.

The public S24 module and its hash are captured under
`openclaw-plugin-mobile-ui/fixtures/s24-2026-10-23-native-auth-scope/`.
Tests execute its actual producer with synthetic secret stores: the original fails,
the patch succeeds, explicit overrides and ordinary execution remain valid,
missing entries still fail and concurrent scopes stay separate. Transaction tests
check source/version drift, symlink refusal, idempotence and byte-exact rollback.
Both test entrypoints are in canonical CI. Native IO and a new real provider
qualification remain distinct from these tests.

`runtime-sync.sh` checks/applies this set through the existing patch owner.
Gateway startup follows the deployed checkout's ownership independently of the
older WhatsApp patch. Companion rollback restores this set before returning to a
revision without its manifest. Explicit operator invocation is
`whatsapp-network-recovery.py --patch-set agent-exec-auth-scope --apply` under the
existing deployment guard; `--rollback` restores the pinned original bytes.
No new service, store, scheduler or retry engine is added.
