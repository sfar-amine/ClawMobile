# Recette texte, voix et WhatsApp — 20 phrases

Plan de recette rédigé pour Claude, **pas une capture ni une qualification passée**. Les phrases derja/arabizi sont proposées et restent à valider avec Amine. Chaque phrase est rejouée dans la même conversation sur texte, voix legacy, voix v2 et WhatsApp admis selon leur propriétaire canonique. Aucun paiement exécuté par cette recette.

| ID | Phrase proposée | Point comparé |
| --- | --- | --- |
| V01 | Allume le Wi-Fi | Parcours appareil déterministe |
| V02 | Éteins le Wi-Fi | Parcours appareil déterministe |
| V03 | Allume le Bluetooth | Parcours appareil déterministe |
| V04 | Monte le volume | Parcours appareil déterministe |
| V05 | Allume la lampe torche | Refus/effet réellement attesté, aucun succès inventé |
| V06 | Mets une alarme à 7h | Slots et exécuteur canonique |
| V07 | Quel est mon solde Orange ? | Consultation par wrapper canonique |
| V08 | Quel est mon solde ? | CLARIFY et réponse liée à l'origine |
| V09 | Orange | Suite de V08, aucune requête reconstruite par Gemini |
| V10 | Ce n'est pas ça | Réalignement canonique après un reçu |
| V11 | La première | Suite de la clarification de réalignement |
| V12 | Que t'ai-je dit hier ? | Mémoire via main, pas seulement VOICE_CONTEXT |
| V13 | Souviens-toi de ce que nous avons décidé sur la voix | Mémoire et continuité |
| V14 | Continue ta réponse précédente | Même discussion et session |
| V15 | Résume ce fichier puis rédige un message court | Délégation main/skills, sans envoi à un tiers |
| V16 | Rédige un texte de présentation de Samantha | Rédaction hors catalogue |
| V17 | Explique-moi cette idée en trois étapes | Conversation ou délégation hors catalogue |
| V18 | 9addech batterie ? | Arabizi, intention et formulation à qualifier |
| V19 | Chnowa 9olna 3al voix ? | Mémoire en arabizi, proposé pour Amine |
| V20 | Raconte-moi quelque chose en derja | Langue réellement parlée, proposé pour Amine |

Pour chaque surface conserver uniquement les champs publics nettoyés : SHA core/app/playbooks actifs, phrase ou pseudo stable, session et origine pseudonymisées, `decision.type/capability/route`, exécuteur, `selected.deterministic/model_required`, statut vérifié, présentation HS3, résultat public, admission native (owner ou non-owner), latences décision/exécution/voix. Les identifiants, secrets, numéros, scopes privés et texte personnel sont exclus. Pour V12/V13, employer une mémoire de recette existante autorisée par Amine, sans nouvelle écriture implicite.

Acceptation : même décision, même exécuteur, même résultat vérifié ; seule la formulation peut varier. Tout état non pris en charge reste un refus ou une clarification identique, pas un repli modèle prétendant avoir effectué l'action. V05 peut légitimement être non pris en charge. Mesurer l'attente `ask_samantha` (30 s au plus pour le retour vocal), le résultat tardif dans le même fil, l'accueil v2 et une interruption après admission sans second effet.

Source des phrases appareil : branche playbooks `codex/r2-device-registry-20261011`, `tests/fixtures/routing/device-system.jsonl` (préparation H7, à intégrer par Claude). Capture demandée : https://github.com/sfar-amine/samantha-core/pull/182#issuecomment-6110135476. Aucun numéro de PR ou SHA de capture future n'est inventé.
