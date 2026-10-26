# L3 — voix relay au cerveau principal

## Voix relay encore atteignable : suppression du pré-interprète sous brain-only

Au head3661, `cloud/voice-relay/src/index.mjs` autorise encore `/voice` par son `OWNER_TOKEN` puis son WS appareil authentifié. `voiceRelay.handleRequest` aboutissait à `voiceDialogue.turn`, aux corrections lexicales et à `capabilityBridge` avant le cerveau, même sous `SAMANTHA_BRAIN_ONLY`. L'entrée native app/P1 était déjà déléguée ; cette autre entrée ne l'était pas.

Le même propriétaire relay délègue désormais le message entier à `runAgentTurn`/Gateway `agent`, explicitement `main`, avant tout interprète/Graph/correction. Le `requestId` reste l'idempotencyKey ; l'identité de session initiale est stable et le même propriétaire `conversations` garde les suivis, y compris après réponse. Stop et confirmations restent des messages au cerveau. Les anciennes clarifications gardent leur contexte explicitement marqué sans rejouer leur branche déterministe. Le transport n'invente aucun ticket P1 ni `ownerAdmitted` depuis son bearer : refus Gateway/toolguard conservés, aucune permission élargie.

Le budget commun est30s. Le renderer `gatewayTerminalResult` existant lit le vrai terminal SDK (capture S24 du25/10), jamais `summary=completed` comme une réponse. Retard, reçu vide, panne ou effet incertain renvoient `unknown`, sans texte de réussite ni relance ; un refus d'autorité identifié garde son code. Un canal abandonné ne reprend pas une conversation effacée. La recette live et la qualification canonique du head final restent à faire ; le test CI enregistré vérifie ces garanties hors réseau sur le contrat SDK capturé.

Retour arrière : désactiver brain-only ou restaurer le head précédent avec le propriétaire Companion existant. Aucun déploiement ni nouvelle route HTTP, capability, store, ordonnanceur ou secret.

Le Worker existant laisse35s au seul transport voix : les30s de travail utile du cerveau restent inchangées et5s ne servent qu'au reçu terminal ou différé du Companion. MCP conserve28s. Un test en temps virtuel prouve qu'une réponse à29s et un reçu unknown/différé à30s sont reçus, sans faux device_timeout ni second dispatch sur la même identité. Ce changement exige aussi l'activation du Worker par son propriétaire existant ; le déploiement Companion seul ne l'applique pas. Le registre pending du Worker est son accusé technique existant, aucun nouveau canal d'avancement ou timer de retry n'est ajouté.
