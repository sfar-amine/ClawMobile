# QA privée — contrat CLI vers affichage

Le test Core exige explicitement un checkout Playbooks. Son producteur versionné `tests/qa_contact_renderer_fixture.py` exécute les vrais propriétaires métier et `cli.main`, avec l’entrée FIFO privée réelle et une autorité externe synthétique. Le consommateur importe le `model-fast-path.py` voisin sans copier ni mocker son renderer. Chaque réponse passe par `_display_text` avec `card=True` (chemin QA réel) puis `False`.

Les cinq contrats vérifient les choix Q1 numérotés ; Q12 en mode smoke, une version avec build long et une version protégée ; le dossier Q2 avec validation distincte du démarrage ; la file WAITING ; l’acceptation du rapport par le transport sans prétendre à sa lecture et le refus de capacité avec sa cause. L’affichage doit conserver le texte humain et ne jamais revenir au dump du DTO, aux identifiants, paquet, hash, chemins ou références de données. Les assertions métier appartiennent au consommateur Core.

Commande : `python3 installer/termux-lite/test-qa-contact-renderer.py EXPLICIT_PLAYBOOKS_ROOT`. Aucun skip ni repli vers une fixture embarquée. Le job CI Core existant récupère le pin Playbooks exact et ses dépendances ; l’intégration ajoute cette commande après le test média inter-dépôts, dans le même job. La CI Playbooks ne dépend pas d’un checkout Core.

Premier rejeu ciblé : 5/5 en 2,885 s avec le producteur Playbooks en préparation. Ce reçu ne remplace pas la CI canonique du head final intégré de la PR 350. Aucune recette physique, notification réelle ou livraison WhatsApp. Retour arrière : retirer le test et son invocation CI, sans modifier les propriétaires métier.

La copie playbooks utilisée par ces tests vit dans un dossier temporaire externe
au checkout core, supprimé à la sortie de l'étape même en cas d'échec. Le runner
local place RUNNER_TEMP dans le checkout : y laisser un second dépôt faussait
l'inventaire ultérieur des propriétaires de maintenance. L'inventaire et ses
attentes restent inchangés.
