# C12 — admission privée du contexte partagé MCP

C12 raccorde le lecteur C9 au port MCP C8 existant. Le profil propriétaire est admis par `authenticateMcpClient` côté Worker, depuis la configuration serveur du client authentifié ; `handleMcpTool` envoie ce profil et son identifiant au relais appareil authentifié. Seule la branche `mcp_request && authenticated` du Companion marque l'objet reçu dans la WeakMap `authenticatedMcpAccess` existante. Les arguments publics, copies JSON, chaînes `caller`, profils déclarés et portées techniques de `claw_context` ne produisent pas cette provenance.

Le getter expose uniquement les identités et la fenêtre de fraîcheur du message `chat-owner`, jamais son callback d'exécution ni un droit supplémentaire. Le profil shadow et tout autre profil restent sans preuve de lecture GLOBAL. Le protocole d'entrée public `client_context` reste fermé et `client_reported` ; il ne transporte ni autorisation, ni racine de fichier, ni état actif de dialogue.

Le host reconstruit les deux champs publics `request`/`client_context` : un sibling ajouté à un JSON d'options n'est jamais relayé. Seule l'admission WeakMap ajoute un sibling privé `host_context` (`mcp-host-context.v1`) dans le même paquet privé borné à 32 Kio. Ses dix champs lient le client, la requête canonique, le fil namespace `external_mcp:<client>:<fil>`, les références de provenance, une fenêtre technique de 30 secondes et l'empreinte canonique de l'entrée. L'empreinte lie le contenu ; elle ne donne aucun droit. Aucun champ `verified`, signature ou ACL parallèle n'est créé.

Le helper vérifie d'abord le vrai canal stdin existant (FIFO de même UID ou flux AF_UNIX avec UID du pair vérifié), puis le schéma exact, le profil propriétaire, les identités natives `request-id`/`origin-id`/événement, la fraîcheur et l'empreinte. Il appelle ensuite la fabrique privée C9 et lui donne les racines hôte `Path.home()` et le répertoire canonique du helper contenant `context_memory.py`. Aucun chemin d'entrée client n'est admis. La preuve typée reste hors modèle et hors reçu ; C9 vérifie son sceau, sa durée et sa requête avant tout import du propriétaire mémoire ou lecture GLOBAL. Un paquet sans sibling est refusé dans `main` avant même la construction du backend ou de sa base ModelGovernor, sans conférer de droit depuis `caller=owner`.

Les reçus existants conservent les empreintes et références de sources v2 (référence, SHA256, révision, octets), avec projection bornée et sans corps privés. Le claim RemoteBridge précède toujours l'interprétation ; un doublon retourne le même reçu sans relire les sources. Aucun nouvel outil, store, ACL, exécuteur ou état de dialogue n'est ajouté. `NO_CAPABILITY` : adaptation technique interne des outils MCP existants ; aucune nouvelle action app. La voix en direct, le paiement et les anciens clients hors migration ne changent pas. Le seul changement dans `voiceRelay.ts` marque la branche MCP authentifiée.

## Rejeu borné, sans fournisseur

Compiler le plugin par ses commandes existantes et préparer un checkout de playbooks de la PR playbooks [#263](https://github.com/sfar-amine/samantha-ui-playbooks/pull/263) au SHA C9 immuable `38ef1ad5053517e7796238854ed3daecfbf585ce`, puis :

```sh
node openclaw-plugin-mobile-ui/scripts/test-mcp-context-paired.cjs <checkout-playbooks> 38ef1ad5053517e7796238854ed3daecfbf585ce <result.json>
```

Le step CI prépare et supprime ce checkout temporaire avec l'accès Git existant, sans jeton en argument. La paire importe les vrais propriétaires C9, `request_context.snapshot`, `context_memory`, B et Graph. Seuls le runner Recorded et l'exécuteur métier sont des fixtures MOCK. Les formats de documents proviennent des fixtures nettoyées existantes de playbooks ; la base mémoire et le compte de relais sont synthétiques. La recette n'ouvre aucun contexte utilisateur réel, ne modifie pas HOME et ne contacte aucun fournisseur ou téléphone.

La preuve distingue deux lectures propriétaire MOCK et une préparation `claw_resolve` sans exécution, les refus JSON propriétaire non admis/shadow avant toute lecture privée, l'absence de corps dans le reçu, les fils distincts, le texte exact, la provenance client, le doublon sans nouveau helper et le refus DATA inconnu avant génération. Une proposition d'écriture ne touche aucun exécuteur ; le contre-témoin Graph `read_only_policy` conserve son label indépendant `SYNTHETIC_BOUNDARY_ONLY`. Ces preuves n'attestent ni modèle LIVE, ni configuration DATA réelle, ni déploiement S24. La CI canonique sur le head exact et la recette de Claude restent requises.

Retour arrière : revert C12, sans migration ni suppression de reçu. Le lecteur C9 redevient fermé faute de preuve privée ; aucune activation n'est réalisée par ce lot.

Le step historique de paire C8 conserve ses quatre cas et toutes leurs assertions. Sur la seule branche C12, il utilise désormais PB263/C9 et le helper de contexte réel : sa précédente dépendance PB259 sans ce lecteur ne pouvait qualifier la nouvelle admission. La paire C12 ajoute les refus sans marker/shadow avant toute construction du backend et le preview sans effet. Les références publiées C8 restent inchangées.
