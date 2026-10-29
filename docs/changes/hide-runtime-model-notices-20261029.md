# Avis techniques de modèle masqués dans les conversations (29/10/2026)

Le 29/10 à 17:57, après une coupure WhatsApp, Amine a reçu « ↪️ Model Fallback: openai/gpt-5.6-terra (selected openai/gpt-5.6-sol; unknown) ». Ce message interne du SDK n'a rien à faire dans une conversation.

Le plugin enregistre le crochet SDK existant `message_sending` : un message qui n'est qu'un avis de modèle (« Model Fallback », « Model Fallback cleared », « Retried on ») n'est pas envoyé ; une ligne d'avis placée avant une vraie réponse est retirée. Tous les autres messages passent tels quels. Le basculement reste visible dans les journaux.
