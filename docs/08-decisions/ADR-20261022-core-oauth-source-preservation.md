# ADR — préserver la source OAuth active dans la livraison Chantier 1

Amine confirme : « Incorpore les et Synchronise le tout je lai fait avec gpt chat ». Le checkout S24 actif avait quatorze commits OAuth absents du runtime Git utilisé pour préparer C12. Remplacer cette source par un ancien checkout perdrait l’authentification déjà utilisée par le plugin Samantha.

La livraison conserve les quatorze commits et leurs parentés par une fusion Git normale, avec C12, G1 et le mandat borné du Chantier 1. Une branche privée de sauvegarde garde le SHA exact `98e9b8f859682cd6866cf174dcb229e6a73f6217`. Le bundle source et son empreinte attestent le transfert ; ce digest n’accorde aucune autorité d’accès.

Le Worker OAuth, son KV, la liaison de service et l’inscription interactive des secrets existaient déjà en production. Cette intégration n’en provisionne aucun et ne change aucun secret. Google vérifie signature, audience, nonce et identité propriétaire ; le validateur OAuth garde audience, expiration et portée. Le client OAuth reste `chatgpt` / `chat-owner-shadow`, sans `claw_exec` ni `claw_remember`. Claude et Codex gardent leurs identités Bearer et le chemin authentifié prioritaire. C12 garde sa preuve serveur privée séparée du JSON client et refuse shadow avant toute lecture privée.

Le seul conflit de source concernait le workflow : union des étapes C8, C12 et OAuth. La fixture RPC OAuth reprend la date de compatibilité du vrai relay, au lieu d’une date future non supportée par le Workerd verrouillé ; le service d’autorisation simulé reste explicitement une fixture RPC, sans qualification Google réelle. Les trois tests de politique historiques sont inscrits dans cette même étape CI.

Le reçu historique OAuth est conservé comme preuve importée dans une note v2 ; il n’est pas un nouveau test live de cette composition. La CI locale complète sur le head publié, la synchronisation runtime par les propriétaires existants et la vérification de la version activée restent indispensables avant toute annonce de livraison. Une qualification de fixture ne vaut ni effet réel, ni autorisation de paiement, ni extension à la voix directe.

Retour arrière : employer les propriétaires de release et leurs reçus pour revenir à la version qualifiée précédente tout en gardant la source OAuth sauvegardée ; ne jamais reconstruire le relay depuis un checkout qui omet les quatorze commits.
