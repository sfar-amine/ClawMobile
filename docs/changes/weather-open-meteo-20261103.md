# Météo par Open-Meteo (3 novembre 2026)

## Problème

Recette des formulations sur le S24 (03/11), cas A15 : « quel temps fait-il » échoue
après 40 s. Le skill `weather` fourni par OpenClaw s'appuie sur wttr.in, injoignable
depuis le S24 (connexion refusée). L'agent est alors passé par `exec curl`, puis par
`web_search`, qui n'a pas de fournisseur configuré (bascule automatique refusée, puis
quota). Open-Meteo, lui, répond en 0,4 s depuis le S24.

## Changement

- `installer/workspace-seed-lite/skills/weather/SKILL.md` : skill `weather` du
  workspace. Il porte le nom du skill fourni, donc il est prioritaire. Il géocode le lieu
  puis lit les prévisions sur Open-Meteo par `web_fetch` (sans clé), avec les codes WMO
  et une consigne de réponse courte dans la langue de la demande. Pas de wttr.in, de
  `curl` ni de `web_search`.
- Installé par le seed existant (`clawmobile_sync_workspace_seed`) au prochain
  déploiement.
- Test sur la capture S24 réelle (`fixtures/s24-2026-11-03-weather-sources`), inscrit
  dans la CI.

## Retour arrière

Revert de la PR, puis suppression de `~/.openclaw/workspace/skills/weather` sur le S24 :
le skill fourni reprend la main.

## Limites

- `web_search` reste sans fournisseur : choix et clé à décider par Amine.
- Recette météo en direct après déploiement.
