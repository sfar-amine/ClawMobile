# Erratum V1 — timing anchors of historical QA413 observations

Date:25October2026. Applies to derived Cloud observations `qa413-question-v1-observation.json` and `qa413-question-v2-observation.json`, associated with public science runs `run_1792934450703_597aff20` and `run_1792935319413_895d9c81`.

The historical941/567ms values follow a local anchor labelled pcm_end/vad_end. They do not prove first audible sign within1second of the actual end of speech. The Bonjour trace separately shows VoiceInject.phrase_end4152.304 followed by t24 at4155.128, a2.824second EOS interval. A future recipe must correlate SamanthaVoiceInject.phrase_end with the actual audible sign. O2 remains unverified on the historical observations; no success is inferred from the earlier local timing classification.

The underlying native receipts/logs and recorded times were never changed. During clarification, the source agent briefly changed a derived v1 criterion to unknown and added a qualification field to both Cloud documents, without preserving a prior local backup. The historical values were restored from the preceding documented observation; this is not claimed as a bit-exact original backup. The transient derived qualification copies and `qa413-anchor-erratum-v1.json` retain that correction history. This erratum is the versioned correction; historical source records remain historical.

No transcript or private answer is included. The post-receipt SDK/audio delay measurements remain independent of the disputed input-end anchor. This document does not close any recipe or authorize an unmeasured EOS change.
