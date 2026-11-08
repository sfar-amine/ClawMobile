# Outil `samantha_messaging` : SMS et e-mail à la voix (09/11/2026)

Amine, le 08/11, après la recette voix : « la voix doit pouvoir faire cela et tout ce qui ressemble à ça ». Ce soir-là,
Samantha refusait l'envoi d'un SMS ou d'un e-mail à soi-même : aucun outil n'existait.

Les règles de Samantha (samantha-ui-playbooks) projettent un nouvel outil `samantha_messaging`, avec deux actions,
`messaging.sms.send` et `messaging.email.send`, toutes deux soumises à récapitulatif puis confirmation.

Ce changement côté serveur de l'app :
- déclare `samantha_messaging` dans `openclaw.plugin.json` (contracts.tools) ;
- le montre directement à la voix et à l'app (`DIRECT_TYPED_TOOLS`), sans passer par tool_search ; la surface directe
  passe à 38 259 caractères (plafond du nouveau test : 38 500) ;
- masque seul un outil du catalogue non déclaré, au lieu de laisser OpenClaw refuser tout le lot (S24 31/10 15:20 :
  un outil non déclaré avait fait perdre tous les outils typés).

À déployer **avant** l'activation des règles qui projettent `samantha_messaging`.

Test : `openclaw-plugin-mobile-ui/scripts/test-typed-messaging-direct.cjs`.
