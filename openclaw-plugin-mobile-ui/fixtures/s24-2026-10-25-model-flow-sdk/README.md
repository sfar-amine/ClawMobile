# Sources publiques du SDK installé sur le S24

Lecture seule le25octobre2026 d’OpenClaw2026.9.6. `PROVENANCE.json` donne les tailles et empreintes natives. Aucun auth/config privé, message ou transcript n’est capturé. Les fichiers `.d.ts.gz` sont compressés sans perte avec mtime nul ; leur SHA est celui des octets décompressés. Les tests décompressent seulement dans leur répertoire temporaire.

Ces sources immuables servent aux remplacements exacts du propriétaire existant de compatibilité ; les fichiers modifiés sont produits dans des répertoires temporaires, jamais dans ces fixtures. Les scénarios et comptes de tests sont rédigés explicitement. La présence d’une source ou une transformation réussie ne prouve aucun appel de modèle, changement SDK ou recette sur le téléphone.

Licence OpenClaw : voir `LICENSE.openclaw`. Provenance upstream publique : https://github.com/openclaw/openclaw ; empreintes du paquet réellement installé, sans présumer un commit upstream non vérifié.

Supplément26/10 : `native-session-cas-snippets.json` contient uniquement des fonctions publiques extraites des modules S24, avec SHA256 complets de modules et extraits. Le test utilise ces fonctions sur une base minimale locale rédigée et des ports I/O explicites ; aucune base privée ou recette native n’est simulée comme réelle.
