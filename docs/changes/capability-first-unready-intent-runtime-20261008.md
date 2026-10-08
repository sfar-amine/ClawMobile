# Capability-First unready high-consequence intent runtime — 2026-10-08

## Runtime rule

The existing `model-fast-path.py` ingress now distinguishes a normal assisted/unknown request from a high-confidence, confirmation-required, high-consequence intent whose canonical route has not yet been promoted.

When the Capability Graph returns `tool_policy=required` and the skill plan is `transfer` or `degraded` with risk `transaction`, `destructive`, `sensitive` or `external_send`, the ingress returns terminal `known_error / required_capability_not_ready`. It does not release the request to a model.

For payment intents, the response names the target provider and states that its adapter is not yet validated and that no payment was launched. This is used by future STEG/SONEDE payment intents until their provider adapters and live contracts are promoted. Validated Maxit and Topnet intents remain normal deterministic/handoff paths.

## Effect boundary

The rule performs no mutation, provider call, payment handoff or financial dispatch. It prevents a model from inventing a permission/refusal or substituting a lower-risk route when Claw already recognizes a consequential intent but cannot yet execute it.
