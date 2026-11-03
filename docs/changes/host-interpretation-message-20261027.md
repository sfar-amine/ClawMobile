# Plain message when a reply cannot be taken into account — 27 October 2026

On 27/10 at 17:38, Sadok received in the Pulse WhatsApp room: « L’interprétation reçue n’est pas conforme à la demande admise. Rien n’a été exécuté. » Amine noted that this is not a message for the user.

The phrase for `host_interpretation_failed` now reads « Je n’ai pas réussi à prendre ta demande en compte. Rien n’a été fait : tu peux la reformuler. » (English: « I couldn’t take your request into account. Nothing was done; you can rephrase it. »). The reason code stays the same in the receipt.

The cause of the 17:38 refusal (an answer filling several asked fields was refused) is fixed in samantha-ui-playbooks.

Test: `test-typed-failure-presentation.cjs` checks that the phrase contains no pipeline vocabulary. Rollback: revert this commit.
