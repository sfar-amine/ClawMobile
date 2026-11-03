# Entrée IA de l’app et résultat partiel factures — 24 octobre 2026

Le processus Companion S24 avait SAMANTHA_INTENT_INTERPRETER=1, mais la demande de factures de 15 h 48 n’avait aucun interpretationReceipt. Sa conversation était app et sa décision technique claw_live. L’adaptateur app transmet cette surface technique au helper ; ce dernier exclut les sessions de développement claw_live de l’interprète. La confusion empêchait donc l’interprétation IA de l’app malgré l’interrupteur activé.

Le helper distingue désormais la surface de l’événement hôte et celle de l’exécuteur. La première pilote l’admission de l’interprète et son contexte app, la seconde garde le routage existant. Les sessions réellement claw_live et la QA privée conservent leur propriétaire ; l’interrupteur hôte reste obligatoire. Les espaces du texte utilisateur sont préservés sur cette entrée IA. Aucun champ de texte naturel n’active l’interprète.

Le rendu sémantique conserve aussi la carte du propriétaire pour une lecture billing partielle déjà acceptée, sans transformer son execution_state=partial en completed. Le lecteur Python de transport admet cette famille de lignes de facturation, avec cardinalité, libellés fermés, montants bornés et protections contre les données privées. La projection TypeScript existante la supporte déjà. Les autres familles ne gagnent aucun champ libre. Les parcours de paiement ne changent pas.

La PR playbooks309 conserve les réponses STEG/SONEDE, distingue la maintenance Topnet et corrige le règlement de la consultation partielle dans le dialogue et Continuum. Les fixtures Core reprennent le constat exact S24 et la projection du propriétaire sur le reçu original nettoyé ; cette dernière est explicitement régénérée hors ligne et ne constitue pas une recette après déploiement.

Les régressions sont dans les suites déjà inscrites au workflow canonique. Aucun nouvel endpoint, store, scheduler, modèle, droit ni appel par ligne. Les budgets du helper et du modèle restent inchangés. La CI complète hors téléphone et la recette réelle avec interpretationReceipt restent nécessaires avant clôture.

Activation : propriétaires existants activate-ui-playbooks.sh puis companion-deploy.sh sous le verrou canonique, avec preuves de versions. Retour arrière : version Companion8b531a781dc8327b55858529372440c88f884249 et précédent pin playbooks vérifié. Préserver les reçus et checkpoints originaux ; aucun paiement de recette.
