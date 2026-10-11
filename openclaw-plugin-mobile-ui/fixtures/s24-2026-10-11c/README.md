# Captures S24, vague 5c (11/10/2026) — HS3

| Fichier | Source | Contenu |
|---|---|---|
| `hs3-payment-terminal-records.json` | S24, `~/.openclaw/clawmobile-companion/runs.json`, champ `paymentRequests` (lu par `readPaymentRequests()`), runtime `507851b5`, 11/10 02:11 | `PaymentRecord` terminaux réels (confirmé, annulé, échec, bloqué, effet inconnu, démo expirée ou annulée) réduits aux champs publics de `paymentView()` : état, raison, `financialSubmissionAttempted`, étapes de la trace. Retirés : id, nonce, clé, devis, montants, références, échanges http, navigation, reçu, continuation. SHA-256 identique sur le S24 : `cc4a07c89b41f99986a7ab6efde48196877a1db089c1593de2b73df0cee3504a`. |
| `hs5-runs-shapes.json` | S24, `~/.openclaw/clawmobile-companion/runs.json` (`runs`), runtime `507851b5`, 11/10 02:18 | Une forme réelle par (source, état, type de décision, modalité, clarification) : 7 runs. runId pseudonymisés (HMAC, sel non conservé), texte, résultat et erreurs libres retirés. SHA-256 identique sur le S24 : `efcba24fa8227e270d0919531ca3bcd4584378f987fb7a0a94938f81784af7fe`. |
| `hs3-presentations-from-captures.json` | Généré par `samantha-ui-playbooks` `skill_intelligence/receipt_presentation.py` (PR #72, `983b81b8`) | Présentations calculées sur les captures réelles `s24-2026-10-11/` (core #129) et sur le fichier ci-dessus ; aucune valeur inventée. |

Capture faite par Claude via le connecteur Claw, en lecture seule : aucun paiement, aucune consultation opérateur, aucun appel de modèle ; écriture seulement dans `~/tmp/hs35/`.
