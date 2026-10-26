# Restore the candidate model-profile consumer before checkout rollback

The existing runtime-sync applies model-flow-selection before promoting the candidate Tier0 release. If synchronization fails in that interval, the previous release may lack its manifest. Its startup then cannot undo the candidate SDK consumer.

companion-deploy.sh now uses the same existing compatibility owner to undo the exact candidate set before git reset whenever the previous commit has no manifest or a different manifest. Unknown SDK state stops rollback before checkout replacement. An unchanged set remains applied; no model config, account, permission, public route, retry or diagnostic patch is changed. The prior runtime subsequently reapplies only the sets it owns.

The existing CI-registered test-model-flow-selection.py executes the real shell guard against actual Git blobs: absent/changed/unchanged previous manifest, absent candidate and rollback failure. Targeted source65ca180a with Python3.12.14/Node26.11.1 passed5model-profile and7native-provenance tests, exit0; source hashes and HEAD unchanged. Log model-flow-rollback-65ca-focused-20261026.log SHA256c5ad3ed2925757759f9a4469716348d006ae45354debd609d85221099f33804b. Final combined-head canonical CI and native recipe remain required.

Rollback of this repair is a source revert before deployment; doing so restores the known missing SDK rollback protection. Existing companion-deploy.sh remains the sole deploy/rollback owner. No native effect was performed by this work.
