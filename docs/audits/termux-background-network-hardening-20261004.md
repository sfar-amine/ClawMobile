# Termux background-network hardening — 2026-10-04

## Incident and root cause
RDC, Slack Bridge, SMTP and WhatsApp lost outbound connectivity together while Termux remained alive and Android connectivity for foreground ChatGPT remained available. No new Termux LOW_MEMORY exit occurred. Standard Android/Samsung background restrictions were therefore the common dependency. Live inspection found Termux already Doze-whitelisted and background AppOps allowed after owner wake-up, but shared UID `10554` was absent from the Data Saver whitelist. Samsung adaptive background management is enabled on the device, so the effective Android policy must be treated as driftable state.

## Correction
The existing `device.network_safety` owner is extended; no daemon, scheduler, store or recovery engine is added. `android-network-mutation-guard.py` now discovers the installed Termux family and shared UID, verifies Doze whitelist, RUN_ANY_IN_BACKGROUND, RUN_IN_BACKGROUND, Data Saver whitelist, inactive/standby state and app hibernation where supported, repairs only missing required protections, then re-reads and verifies the final state.

Health Manager now reconciles canonical ADB before network safety so an ADB reconnect does not create a false policy incident. Tier0 performs a best-effort background-policy reconciliation at boot when canonical ADB is already ready; Health Manager remains the continuous owner after boot.

## Controlled live proof before activation
On the S24, Data Saver itself was disabled. UID 10554 was deliberately removed from the restrict-background whitelist under an EXIT restoration trap. The candidate detected the drift, re-added UID 10554, re-read all three installed packages (`com.termux`, `com.termux.api`, `com.termux.boot`) and returned `state=healthy`, `mutation=repaired`. RDC remained connected.

## Safety and limitations
The guard never disables Android/Samsung power management globally and does not overwrite unrelated app policy. It only maintains explicit protections for the Termux family used by Claw. Unsupported hibernation APIs are treated as unavailable rather than as failure. Low-level carrier/radio causation for the earlier outbound outage remains unproven; this change addresses the verified common-mode background-policy dependency and observed Data Saver drift.

## Rollback
Promote the previous immutable Tier0 LKG and revert this scoped runtime commit. The guard's policy mutations are additive exemptions for the Termux UID/packages; rollback of code does not silently remove owner-approved exemptions.

## Tier0 activation correction
The first candidate activation exposed a pre-existing installer gap: `install-tier0-control.py` packaged with the tier0-control default critical list and therefore reduced the active soak set from five capabilities to three, dropping `device.adb` and `remote_desktop`. The candidate was not accepted in that state. The installer now accepts repeated `--critical-capability` arguments and otherwise preserves the current Tier0 list. Final activation explicitly restores the five previously validated critical capabilities.

## Release attribution correction
The second activation verified the five-capability soak set but exposed `source_commit=unknown` in the immutable release manifest. The installer derived the repository root with `source.parents[2]`, which is wrong for a nested `installer/termux-lite` worktree path. It now asks Git directly from the nested source directory (`git -C <source> rev-parse HEAD`), which walks to the owning worktree and records the exact commit. The final activation must show the published runtime commit in its manifest.
