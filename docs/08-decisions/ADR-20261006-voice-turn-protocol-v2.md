# ADR — protocole vocal local v2, candidat du 6 octobre 2026

Statut : candidat implémenté, **non activé et non promouvable** tant que la frontière provider n’est pas qualifiée.

La détection locale de parole et la purge audio appartiennent à Android. La corrélation de protocole, l’unique propriétaire de la connexion et la réception provider appartiennent à `ClawLiveWarmCore`, déjà existant. Les autorisations et effets métier restent dans Capability Harness et ses exécuteurs. Les générations et tampons sont éphémères ; les révisions de lecture enrichissent seulement le registre existant.

Le socket local v2 négocie la version et l’epoch. Les nouvelles enveloppes ne sont pas des champs Google. Le protocole refuse les discontinuités audio, les doublons contradictoires, le deuxième client d’écriture, les sorties de génération obsolète et les demandes sans transcription attribuée. Les clients v1 conservent leur parcours ; aucune activation globale ne découle de ce code.

Décision de qualification : ne pas assimiler un champ optionnel du SDK à une garantie du modèle. Le modèle conversationnel testé ne renvoie pas `inputTranscription.finished`. Les résultats négatifs invalident l’hypothèse d’activation immédiate, pas le travail audio local. Garder le flag inactif et le blocage de promotion jusqu’à adaptation validée du contrat. Ne pas introduire un second ASR, un provider payant, une reconnexion systématique ou une règle de délai sans expliciter l’impact.

Alternatives : reprendre une API de transcription avec une frontière explicite ou établir une corrélation supportée par le modèle actuel. Les coûts, dépendances et impacts de latence doivent être qualifiés avant choix. L’assimilation de `turnComplete` à une preuve ASR complète est rejetée sans garantie documentée, car les flux sont indépendants.

Cette évolution modifie un contrat local, pas l’architecture de vérité de Claw. Les anciens correctifs Warm/fallback et les frontières humaines restent conservés. Voir le change record pour les preuves et réserves de recette.
