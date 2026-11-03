# Outil `samantha_qa` : capture du catalogue compilé sur le S24, 3 novembre 2026

Suivi de core #530. La fixture `s24-2026-11-02-qa-typed-tool/qa-tool.json` était une projection produite depuis le code source des playbooks. Elle est maintenant confirmée par le catalogue réellement compilé sur le S24.

## Capture

Faite en lecture seule par `claw_exec` (clés `qa530-cap-a`, `qa530-cap-b`, `qa530-cap-c`), après l'activation des playbooks 8863a801 et le déploiement de core bfa6521a :

- le fichier lu est `~/.openclaw/capability-views/agent-tools.json` (sha256 `64262186…`, révision `23ba6f3528cc4c3a`) ;
- il contient 14 outils typés, dont `samantha_qa` ;
- l'empreinte canonique (clés triées) des entrées `samantha_qa` et `qa.test_campaign` est égale à celle de la projection.

Le fichier `s24-2026-11-03-compiled-after-activation.json` ne contient que des noms d'outils et des empreintes : aucun paramètre, aucun compte, aucun message.

## Test

`test-typed-qa-tool.cjs`, déjà inscrit dans la CI, vérifie maintenant trois points :

- le catalogue compilé compte un outil de plus que la capture du 02/11 ;
- il contient `samantha_qa` ;
- les deux empreintes sont égales à celles de la projection.

## Retour arrière

Revert de ce commit. Aucun effet sur le runtime.
