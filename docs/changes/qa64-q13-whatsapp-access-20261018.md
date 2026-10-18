# Q13 — accès WhatsApp aux tests Android, par application

Travail en cours, non activé. La commande privée `people-trusted.py qa-scope-read`
relit l'autorité du contact avant chaque usage asynchrone. Les grants restent
dans l'en-tête privé existant du contact ; aucune nouvelle base d'autorisation.
Une session ou un DTO ne constitue jamais, seul, une autorisation.

Le propriétaire des pièces conserve `qaApps` (12 au plus), dans la pièce `qa`.
Chaque app porte un nom public, un paquet interne, un environnement et le droit
d'écriture, faux par défaut. L'ajout d'une app ou le changement de son périmètre
exige la confirmation biométrique existante, même si la pièce est déjà ouverte.
Le hash de confirmation est identique en Python et TypeScript. La révision de
l'autorité est vérifiée entre la préparation et l'effet. Retrait, suspension,
expiration et binding concret manquant refusent la lecture privée.

L'entrée QA transporte le texte du contact sur stdin privé, jamais dans argv,
l'événement de dialogue ni la politique. Le propriétaire QA traite les données
du compte avant le Graph ; une version de playbooks sans cette frontière est
refusée. Seul un texte structuré généré par QA atteint ensuite le Graph, avec
un second pipe privé indépendant du stdin de sa décision. Les autres capabilities
conservent leur admission. Aucun changement au paiement, à la voix directe ou
à l'environnement D. Budget de l'entrée : 15 s, dont lecture locale d'autorité
3 s au plus et helper borné ; aucune boucle de réessai d'effet.

Sources : signatures des cinq propriétaires installés relevées en lecture seule
par Claw sur le S24, checkout `145339bbae88ffd66fb7475fcbf275b379d9cb6a`, fixture
`openclaw-plugin-mobile-ui/fixtures/qa/q13-existing-owner-source-20261018.json`.
L'ancien GET allowlist nettoyé du S24 du 10/10 est aussi testé : il ne crée aucun
grant QA. Les nouvelles autorisations sont des fixtures synthétiques explicites.

Les tests de lecture courante, absence/révocation/expiry, autre app/contact,
fausse autorité, biométrie dans une pièce existante, révision périmée, parité
du hash et séparation des deux pipes sont inscrits dans la CI existante.

Restent avant livraison : admission/fences complètes dans playbooks, pièces
jointes entrantes qualifiées, restitution au demandeur et schéma document du
Gateway confirmé par Claude. Ne pas déclarer cette préparation prête à fusionner.
La recette physique reste réservée à Claude après revue, fusion et épinglage.
Retour arrière : revenir au commit précédent du lot dans les deux propriétaires ;
les anciens lecteurs refusent les métadonnées QA inconnues, sans élargir l'accès.
