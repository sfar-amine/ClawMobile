# Outils typés : un tour écrit de l'app n'est plus traité comme une voix en direct

**Constat (S24, 07/11 16:07).** « mon solde orange » partagé depuis l'app, à la maison sur Wi-Fi. Le garde Orange a refusé (`orange_cellular_required_wifi_kept`, Wi-Fi jamais coupé). La cause : `typedCapabilityTools` passait au graphe la surface `claw_live` (type `voice`) pour tout appel hors WhatsApp. Le graphe posait donc `SAMANTHA_LIVE_VOICE=1`, et le garde refusait le passage temporaire en 4G, pourtant prévu pour les demandes écrites.

**Correctif.**
- Le Companion enregistre les tours confiés par Samantha Voix (`voiceDelegation`) et indique l'origine dans le statut du run (`turnOrigin` : `voice` ou `app`).
- L'outil typé lit ce statut en local avant d'appeler le graphe. Seul un tour écrit prouvé reçoit la surface `samantha_android` (type `app`).
- Samantha Voix, un run inconnu ou un Companion injoignable gardent `claw_live` : la restriction voix reste la valeur par défaut. C'est une restriction, jamais une admission.

**Preuve.** `scripts/test-typed-app-surface.cjs` sur `fixtures/s24-2026-11-07-orange-app-surface`, qui contient le statut réel du run en échec et le refus enregistré par le garde.

**Hors champ.** L'échec de 15:17 (`network_snapshot_unavailable`, incident en attente de récupération déterministe) est un transitoire séparé de la lecture réseau du garde.
