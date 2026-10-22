# Chantier 1 G1 — canonical CI private evidence API

Adds an explicit in-process proof API to the existing canonical CI owner, preserving its CLI/workflow behavior. Proof issuance requires the actual canonical run's terminal exit 0, exact SHA40/PR/base, runner/workflow identities, a committed JSON subject, and GitHub metadata rechecked after execution. Verification rechecks producer instance and source/artifact identities; logs, files and JSON cannot reconstruct a PASS after restart.

Import-time source identity prevents disk/HEAD changes from relabeling loaded Python. The same CLI is invoked in a PID namespace to stop even detached descendants before proof issuance; unavailable namespaces remain closed, without an uncontained fallback. Regular-file descriptor checks reject FIFOs/symlinks before reading. Existing CLI behavior is unchanged.

Tests use tiny temporary repositories, short workflows and fake GitHub metadata only. No full CI replay, model inference, S24 access, signing key or persistent proof store is added by this lot. G4/G5, LIVE, latency budgets, multi-repository final integration and production remain unqualified. Rollback: revert the API/tests/docs; preserve existing canonical CI and do not recreate private proofs from saved receipts.
