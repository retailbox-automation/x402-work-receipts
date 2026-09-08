# Tampered fixtures

Four copies of the golden run, each with one thing changed, and each expected to fail the check it
was built to fail. The assertions live in `tests/verifier/cli.test.ts`.

Three of the four edit the receipt, and any edit to a receipt necessarily breaks two more checks: the
signature no longer covers the document (check 1), and the document no longer hashes to what the
topic anchored (check 5). That collateral is asserted explicitly rather than tolerated, so a change
in what a fixture catches shows up as a failing test instead of passing quietly.

| Fixture | What was changed | Intended check | Also fails |
|---|---|---|---|
| `edited-receipt-hash.json` | last character of `data.mandate_envelope_hash` | 2 — mandate hash linkage | 1, 5 |
| `swapped-tx-id.json` | `payment.intake.transaction_id` and `payment.balance.transaction_id` exchanged | 4 — payments on ledger | 1, 5 |
| `wrong-payee.json` | `payment.payee` set to `0.0.9999999`, an account that was never credited | 4 — payments on ledger | 1, 5 |
| `missing-anchor/topic-messages.json` | the `delivered` anchor removed from the recorded topic page | 3 — anchor sequence | nothing |

The fourth is the clean one: it tampers with the public record rather than with the receipt, so the
receipt still verifies against itself and only the step that vanished is reported. It is also the
case worth watching in a demo — the contractor cannot quietly drop a step from a log it does not own.

Swapping the two transaction ids is caught twice over: the amounts no longer match the transfers on
the ledger, and neither `payment_*` anchor hash covers the payment the receipt now states.
