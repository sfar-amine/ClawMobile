#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding='utf-8')


def require(text: str, needle: str, label: str) -> None:
    assert needle in text, f'{label}: missing {needle!r}'


capsule = read('capsule.bxb')
require(capsule, 'id (samantha.clawvoice)', 'capsule id')
require(capsule, 'runtime-version (9)', 'runtime')
require(capsule, 'js-runtime-version (2)', 'js runtime')
require(capsule, 'target (bixby-mobile-fr-FR)', 'target')

request_model = read('models/concepts/Request.model.bxb')
require(request_model, 'name (Request)', 'request concept')
assert 'text (Request)' not in request_model, 'Request must stay NL-visible'

answer_model = read('models/concepts/ClarificationAnswer.model.bxb')
require(answer_model, 'name (ClarificationAnswer)', 'clarification answer concept')
require(answer_model, 'transient', 'clarification answer must not leak into later turns')

for action_name in ('AskClaw', 'ContinueClaw'):
    model = read(f'models/actions/{action_name}.model.bxb')
    require(model, 'error (NeedsClarification)', f'{action_name} checked error')
    require(model, 'route: ContinueClaw', f'{action_name} continuation route')
    require(model, 'goal: Response', f'{action_name} result goal')

continue_model = read('models/actions/ContinueClaw.model.bxb')
require(continue_model, 'prompt-behavior (AlwaysElicitation)', 'clarification input prompt')
require(continue_model, 'type (ConversationId)', 'conversation id input')
require(continue_model, 'type (ClarificationAnswer)', 'clarification answer input')

endpoints = read('resources/base/endpoints.bxb')
require(endpoints, 'action-endpoint (AskClaw)', 'AskClaw endpoint')
require(endpoints, 'action-endpoint (ContinueClaw)', 'ContinueClaw endpoint')

for js_name in ('AskClaw.js', 'ContinueClaw.js'):
    js = read(f'code/{js_name}')
    require(js, "secret.get('relay.token')", f'{js_name} secret source')
    require(js, "url + '/voice'", f'{js_name} relay endpoint')
    assert 'timeoutMs' not in js, f'{js_name}: avoid unsupported Bixby http timeout option'

properties = read('resources/base/capsule.properties')
assert 'relay.token' not in properties, 'relay token must never be stored in capsule.properties'

info = read('resources/fr/capsule-info.bxb')
require(info, 'display-name (Samantha)', 'display identity')
require(info, 'dispatch-name (Claw)', 'validated named dispatch')

hints = read('resources/fr-FR/samantha.hints.bxb')
assert hints.count('hint (') >= 3, 'Marketplace warning guard: at least three hints required'

print('bixby capsule static tests: PASS')
