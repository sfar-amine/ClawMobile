# J1 — contexte numérique et signatures publiques

Suite de core #161 sur le scanner existant. Le budget, les limites, le job nocturne et les exclusions de répertoires privés ne changent pas.

Le détecteur de cartes exige Luhn, puis écarte les identifiants temporels de 13, 16 ou 19 chiffres dont le préfixe est compris entre 16 et 18 et la forme calendrier AAAAMMJJ-HHMMSS. La frontière rejette une lettre, un point, un tiret ou un caractère de mot adjacent : aucun fragment numérique d'UUID n'est admis. Une carte isolée ou séparée en groupes reste détectée. Les noms de fichiers restent masqués conservativement, même lorsqu'un contexte numérique est écarté du détecteur de contenu.

Le manifeste statique du scanner `workspace-secret-scan-fixtures.json` contient uniquement `{path,type,hash,raison}`. `public_fixture` atteste le SHA256 intégral d'une source publique versionnée ; il ne soustrait jamais le fichier au scan. Une signature `card` ne s'applique qu'à un finding exact dans cette source attestée, ancrée au checkout réel du scanner avec le label core. L'unique dérogation de basename privé est le fichier de test public existant précisément désigné dans le code. Un root externe, un fichier modifié ou un chemin runtime inconnu ne bénéficie pas de cette dérogation. Aucune dérogation de répertoire privé, credentials, contacts, contextes ou paiement.

Les signatures admises restent visibles dans `accepted` (chemin, ligne, type, hash, raison de la politique versionnée) et dans le reçu nocturne existant ; elles n'entrent pas dans les findings actifs ou les alertes. Le total findings + warnings + accepted partage la limite existante. Un finding supplémentaire dans le même fichier reste actif. Le hook refuse une acceptation inconnue et ne copie pas la raison libre d'un sous-processus. Aucun nouveau store ou service ; les preuves statiques sont dans le dépôt.

Tests : valeurs numériques générées uniquement en mémoire et dans des répertoires temporaires, horodatages avec checksum valide, adjacency, UUID, calendrier, cartes isolées/groupées, attestation modifiée/root externe, finding supplémentaire et plafond combiné, trace nocturne et absence d'alerte pour signature publique exacte. Le nouveau test est dans la suite J1 existante de ci.yml. La CI complète de la tête finale reste à rejouer localement avant readiness.

Les racines réelles sont attestées par la capture #131 `s24-2026-10-11b/j1/secret-roots.paths.json`. L'objectif de réduction de 332 sur 346 alertes nécessite une capture S24 avant/après par Claude : uniquement chemin nettoyé, type, hash et contexte structurel catégorisé, provenance et SHA du scanner ; jamais de valeur ou extrait. Aucun résultat réel ni pourcentage d'amélioration revendiqué sans cette capture. Déploiement, recette et décision de budget restent à Claude et Amine.

Retour arrière : revert de ce lot ; scanner et receipt nocturne existants conservés, aucune migration.
