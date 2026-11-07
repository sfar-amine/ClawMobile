# Outils typés : le cerveau peut rattraper une réponse prête incohérente (07/11/2026)

Sur le S24 à 21:46, « mon solde orange » depuis l'app : l'outil typé Orange a rendu des faits vérifiés (huit compteurs Max it), mais sa réponse prête était la phrase générique « Le résultat de la demande reste à vérifier. ». La description de l'outil disait « Reproduis la réponse prête du reçu sans inventer de fait », donc le cerveau a répété cette phrase.

Amine : « Je veux toujours donner au modèle une certaine liberté justement pour rattraper si incohérence ou autres. »

La description dit maintenant : « Pars de la réponse prête du reçu sans inventer de fait ; si elle est générique, incomplète ou contredit les faits vérifiés du reçu (facts), réponds à partir de ces faits et dis ce qui ne colle pas ». Ce qui ne change pas :
- une question du reçu se pose toujours telle quelle ;
- aucune confirmation ni écriture ne change ;
- aucun fait n'est inventé.

La cause côté playbooks (lecture opérateur vérifiée sans réponse prête) est corrigée séparément (samantha-ui-playbooks#417).

Preuve réelle : `openclaw-plugin-mobile-ui/fixtures/s24-2026-11-07-typed-generic-answer/`.
