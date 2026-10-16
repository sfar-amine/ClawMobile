# M4 — Oubli WhatsApp à la fin d'accès

Décision d'Amine : les fiches contact restent dans le dépôt privé et sont supprimées 30 jours après la fin d'accès (expiration ou retrait).

- **Propriétaire** : `installer/termux-lite/people-trusted.py`, action `allowlist sweep` déjà lancée chaque minute par `samantha-health-manager.sh`. Aucun nouveau scheduler, démon ni store.
- **Fin d'accès** : dernier reçu R17 terminal du contact (`send_receipts`, états `added`/`reactivated`/`removed`) égal à `removed` (retrait ou expiration), daté de 30 jours ou plus. Un nouvel ajout annule l'oubli.
- **Matériel effacé** (chemins confirmés sur le S24, fixture `openclaw-plugin-mobile-ui/fixtures/s24-2026-10-12/m4/private-layout.json`) :
  - la fiche `memory/whatsapp/contacts/wa_<numéro>.md` (lien vers `samantha-context-private/whatsapp/contacts/`) ;
  - les entrées de `memory/amine-inbox.md` (lien vers `samantha-context-private/whatsapp/inbox/amine-inbox.md`) dont l'expéditeur est ce numéro.
  - `memory/cross-surface/` n'existe pas sur le S24 ; `contacts-index.md` ne contient aucune ligne par contact.
- **Protections** : propriétaire (`commands.ownerAllowFrom`), numéro encore dans `allowFrom` ou `direct`, fiche portant encore un bloc R17 : jamais effacés. Une lecture `config.get` par passe, seulement si du matériel est dû.
- **Bornes** : 20 contacts par passe, dans le reste du budget de 20 s du sweep ; le reliquat passe au cycle suivant. Une panne (Gateway, disque) ne fait jamais échouer le sweep d'expiration (`forget.state=unavailable`).
- **Reçu** : ligne R17 `forget:<contactId>:<fin d'accès>` (`state=forgotten`, `purged.contactFile`, `purged.inboxEntries`, `retentionDays`). Intention écrite avant toute suppression : une passe interrompue est terminée par la suivante, sans doublon. Aucun numéro, nom ni contenu dans le reçu, la sortie ou le journal (`event=forget forgotten=N remaining=M`).
- **Limite** : l'historique Git du dépôt privé garde les anciennes versions ; la suppression est commitée par la synchronisation existante (`save.sh`, `git add -A`).
- **Retour arrière** : revenir au commit précédent ; les reçus `forgotten` restent inertes.
