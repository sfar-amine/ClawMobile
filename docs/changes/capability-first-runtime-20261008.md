# Capability-First runtime — 2026-10-08

## Change

The existing ClawMobile inbound_claim fast path is generalized from read-only static Skill routes into a Capability-First owner ingress backed by the canonical Capability Graph.

Before a model is called, owner operational requests are resolved by the Graph. A ready, authorized, deterministic, model-free selection is executed directly. Requests classified as assist or miss continue to model reasoning.

Known deterministic execution failures do not fall through to a model-generated refusal.

## Human boundaries

A confirmation-required Known route can bypass the model only when its execution contract declares a pre_model_handoff with effect_before_boundary=none. The helper invokes only that declared domain handoff and leaves the actual authorization/effect to the existing human/capability boundary.

## Owner continuity

The native Samantha Companion path has a bounded owner fallback for canonical agent:main:companion-chat-* sessions. This repairs turns where the gateway drops senderIsOwner while retaining the canonical local Companion session identity. WhatsApp, group sessions, non-main agents and other remote sessions do not inherit this fallback.

## Components reused

- existing inbound_claim hook
- existing Capability Graph
- existing claw-capability runtime adapter
- existing provider fallback and Model Governor
- existing capability executors and human boundaries

No new router, registry, store, scheduler, retry engine or execution owner is introduced.
