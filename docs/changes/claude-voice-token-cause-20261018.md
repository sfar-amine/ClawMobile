# Voix : l'échec du jeton Gemini Live dit sa cause

## Constat (S24, 18/10, lecture seule)
`companion.stderr.log` : à 14:03:37, 14:03:38 et 14:03:41, puis à 15:15:21 et 15:15:23, `gemini_live_token_helper_failed exit=75 … stderr=empty`. Les trois tentatives du préchauffage échouent, `/claw-live/prewarm` répond 502 et l'ouverture de la voix est lente. Rejeu à 17:40 : 5 jetons sur 5 en 1,2 à 2,0 s. L'échec est intermittent et sa cause n'a pas été journalisée.

## Cause du diagnostic manquant
`gemini-live-client.mjs --mint-token` écrit sa cause sur stdout (`{"status":"error","reason":…}`) et sort en 75. `tokenHelperFailure` ne lisait que stderr.

## Correctif
`tokenHelperFailure` reprend la `reason` de la dernière ligne JSON de stdout : bornée à 120 caractères, ASCII, avec les suites de 24 caractères ou plus masquées (clés). Le jeton n'est jamais présent dans un échec.

## Suite
Au prochain échec sur le S24, la cause (code HTTP amont, clé indisponible, réseau) permettra de corriger sans deviner.
