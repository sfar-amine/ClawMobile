# F2 — Conserver la cause jusque dans le reçu

Le rendu des erreurs du transport et du web utilise une table française et une table anglaise, dans le propriétaire existant `receiptPresentation.ts`. Les codes émis par les producteurs TypeScript sont relevés par un test de couverture, inscrit dans la CI. Un code futur explicite est conservé et affiché comme tel ; il ne devient pas une cause absente. Les présentations déjà qualifiées par leur propriétaire sont préservées.

La clôture d'un run conserve toutes les causes établies, pas uniquement `web_deadline_exceeded`. Une cause nommée devient aussi le message visible lorsque le propriétaire n'a fourni aucune présentation. L'absence de code incrémente un scalaire saturant, sans contenu personnel ni identifiant. Ce compteur décrit la vie du processus Companion ; il ne prétend pas mesurer des journées comprenant un redémarrage.

Le diagnostic existant expose `presentationCounters.missingFailureCauseRenders` et `scope: companion_process` dans ses pages de journaux, son enveloppe d'export et sa section de contrôle. L'affichage Android est une contrepartie distincte : ce changement serveur seul ne le qualifie pas.

Aucune nouvelle route, capability, source runtime, base, journal ni service. Aucun appel Gateway. Les budgets des routes existantes ne changent pas (diagnostic Python 5 s, snapshot 6,5 s) : ajout constant en mémoire après leur lecture. Les fixtures de reçus proviennent des captures S24 `s24-2026-10-11c/hs3-presentations-from-captures.json` déjà versionnées ; la panne du transport est injectée hors téléphone et identifiée comme telle.

Tests ciblés : construction TypeScript ; couverture des codes, langues, sécurité, compteur et persistance du run ; régression N1 ; diagnostic ; recherche web ; transport des reçus. Le rejeu CI complet avec PR et SHA exact reste obligatoire avant revue de fusion.

Retour arrière : revenir au commit précédent sur la ligne runtime ; aucun format persistant ni migration n'est ajouté. Ne pas confondre ce lot avec les phrases de la voix en direct, réservées à Claude, ni avec les cartes métier playbooks, livrées séparément.

Le lecteur de reçus accepte aussi jusqu’à huit lignes en paires `[libellé, valeur]`, format déjà lu par l’app, avec les mêmes gardes de contenu. Cela prépare les cartes métier rendues par leur propriétaire playbooks ; objets libres, lignes malformées et secrets restent refusés.
