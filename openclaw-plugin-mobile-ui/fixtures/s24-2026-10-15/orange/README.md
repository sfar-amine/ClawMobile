# Orange network owner source captures, 15 October 2026

Root captured these sanitized observations on the S24 through the existing Claw owner. Source: artifacts/orange-fastpath-20261015 (preflight, identity, network-shape, read-offer). No candidate activation. The first three captures performed no network mutation and no provider call. The offer capture called the existing canonical read once, without financial effect; it is not candidate qualification.

The offer returned success under the old enabled-bit contract, but its immediate post-observation had cellular as default and no connected Wi-Fi. `wifi_initial_equals_final:true` therefore does not certify effective restoration. Asynchronous reconnection remains a separate root observation; this fixture does not claim permanent restoration failure.

No account values, phone numbers, credentials, SSID, IP, ICCID or raw dumps are retained. Network/subscription IDs are the captured ephemeral OS handles needed to test exact network selection. Test strings assembled from these fragments are explicitly derived protocol fixtures, not raw Android captures. The existing 11/10 cellular-default text fixture independently preserves the actual dumpsys grammar.
