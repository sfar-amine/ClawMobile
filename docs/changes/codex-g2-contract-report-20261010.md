# G2 : rapport des contrats en lecture, couverture restante explicite

Le précédent rapport pouvait traiter l'inventaire `/v1` comme exhaustif et ignorer des routes récentes. Cette livraison impose un manifeste versionné de 120 cas, maintient les lots non fusionnés et les recettes de mutation dans la couverture obligatoire, et borne le transport à des GET loopback sans redirection ni rejeu.

Validation : 11 tests locaux du runner, sans S24. Aucun résultat de qualification physique ou de mutation n'est revendiqué. Le manifeste actuel produit volontairement une couverture incomplète. Toutes les étapes CI sont conservées.
