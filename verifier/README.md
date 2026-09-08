# Verifier — public, trustless reconstruction

A stranger with this repository, a topic id and a receipt file can reach the same verdict as either
company. The command reads one source, the public Hedera mirror node, and never calls the contractor
or the customer.

```bash
npm run verify -- --topic 0.0.10426298 \
  --receipt out/<mandate_id>/receipt.json \
  --mandate  out/<mandate_id>/mandate.json   # optional
```

## A real run

Against the order anchored on shared topic `0.0.10426298` on 2026-09-08:

```
order   01a0826c-11d6-7b61-b75d-3ae618a2776a
receipt 01a0826c-6529-7354-b656-3eb0f535486b (delivered, issued by agency-x-agent)
topic   0.0.10426298
source  https://testnet.mirrornode.hedera.com/api/v1 (public mirror node only)

      check                 detail
PASS  receipt signature     signed by 99573eae7ac7… over the receipt as issued
PASS  mandate hash linkage  79225ab80d552f8eef6fbc57bc8ba23add91724eced2185953607546a511809a — receipt, anchor #1 and the mandate file agree
PASS  anchor sequence       mandate_in #1 → payment_intake #2 → accepted #3 → delivered #4 → payment_balance #5 → receipt #6
PASS  payments on ledger    intake 1000000 tinybars 0.0.10365982 → 0.0.10365984 (0.0.7162784-1788894509-185405540); balance 4000000 tinybars 0.0.10365982 → 0.0.10365984 (0.0.7162784-1788894527-494125454)
PASS  receipt anchor        8c7c94dd3029b8df236a7f8acf9aa8dabd46ec746ccf31e297dc12b742160c04 anchored at #6 (1788894537.313272104)

────────────────────────────────────────────────────────────────────────────────────────
VERIFIED — all 5 checks passed against the public record.
────────────────────────────────────────────────────────────────────────────────────────
What the chain proves (wording taken from the source spec §4.2): a sealed mandate with
envelope hash eh existed at the sender no later than consensus time T1 and was accepted
by the contractor, whose receipt with hash eh2 is fixed no later than T2; the
counterparty's signature verifies independently. It does not prove the mandate's content
(only its fingerprint), the quality or the fact of the work, or that a key belongs to a
person. The payment profile adds: the intake and balance transfers exist on the ledger
with the stated payer, payee and amounts.
```

The same receipt with its `payee` edited to an account that was never credited:

```
      check                 detail
FAIL  receipt signature     the signature does not cover this document — it was edited after signing, or the key does not match
PASS  mandate hash linkage  79225ab80d552f8eef6fbc57bc8ba23add91724eced2185953607546a511809a anchored at #1; no mandate file given, so the fingerprint was not recomputed
PASS  anchor sequence       mandate_in #1 → payment_intake #2 → accepted #3 → delivered #4 → payment_balance #5 → receipt #6
FAIL  payments on ledger    the intake payee 0.0.9999999 was not credited exactly 1000000 tinybars; the payment_intake anchor does not cover the intake payment the receipt states (anchored f9d41c01c01a…, receipt implies a65c94a16822…); …
FAIL  receipt anchor        this receipt hashes to 8dce26c78858…, the topic anchored 8c7c94dd3029… at #6

NOT VERIFIED — 3 of 5 checks failed: receipt signature, payments on ledger, receipt anchor.
```

## The five checks

| # | Check | What has to hold |
|---|---|---|
| 1 | `receipt signature` | the Ed25519 signature covers the receipt as issued — the document was not edited after signing |
| 2 | `mandate hash linkage` | the receipt's `mandate_envelope_hash` equals the `mandate_in` anchor's hash, and — when the work order is supplied — equals `envelopeHash(mandate)` recomputed from it |
| 3 | `anchor sequence` | all six steps of this order are on the topic, none twice, and they reached consensus in the order `mandate_in → payment_intake → accepted → delivered → payment_balance → receipt` |
| 4 | `payments on ledger` | both transactions exist with `result: SUCCESS`, the payer is debited and the payee credited exactly `tinybars`, the network fee is paid by somebody other than the payer, and each `payment_*` anchor's hash equals `paymentAnchorHash` of the leg the receipt publishes |
| 5 | `receipt anchor` | the `receipt` anchor's hash equals `envelopeHash(receipt)` — the receipt on the topic is this receipt |

Check 4's fee-payer condition is what stops a "payment" from being a self-transfer dressed up: under
the x402 `upfront` flow the facilitator pays the fee, so the fee payer is never the payer.

## Three exit codes, not two

| Code | Meaning |
|---|---|
| `0` | every check passed |
| `1` | at least one check failed — the public record contradicts the receipt |
| `2` | the check could not be completed: unreadable input, or the mirror node |

"This receipt does not check out" and "I could not look" must never arrive as the same answer. One
consequence: `/topics/{id}/messages` answers `200` with an empty list for a topic that does not
exist, so an unknown topic id would otherwise read as "this order was never anchored" — a false
statement about the order. When no anchors come back, the reader confirms the topic on
`/topics/{id}`, which does answer `404`, and an unknown id exits `2`.

## Design notes

- **The mirror-node url is a constant, not an environment variable.** A verifier that can be pointed
  at a private endpoint proves nothing to a stranger, so "trust only the public mirror node" is a
  property of the code rather than of how it was launched. This is also why `verifier/` does not use
  `anchor/client.ts`, which is configurable and pulls in the Hedera SDK: verification needs no keys,
  no operator account and no ability to write.
- **Nothing is re-implemented.** `parseAnchor` and `toMirrorTxId` come from `anchor/records.ts`,
  `envelopeHash` and `verifyEnvelope` from `protocol/envelope.ts`, and `paymentAnchorHash` from
  `contractor/receipts.ts` — the hash a verifier recomputes is the function the contractor anchored
  with, not a second copy of it.
- **The topic is shared.** Several orders live on `0.0.10426298`, and anyone can write to a topic
  with no submit key. Every check filters by `mandate_id` first, so a neighbouring order cannot stand
  in for a missing step of this one, and messages that are not `wr-anchor.v1` are skipped rather than
  treated as errors.
- **Order comes from consensus time, not from the anchor's own `at` field.** The network decides when
  something happened; the writer only claims it.
- **The closing statement is not written here.** It is read at run time from `docs/schemas/README.md`,
  which took the wording from the source spec. A copy in the code would drift, and a claim about
  evidence that drifts is worse than no claim.

## Files

| File | Role |
|---|---|
| `cli.ts` | argument handling, loading the documents, the report, the exit codes |
| `checks.ts` | the five checks — each a pure function over `(receipt, anchors, transactions)` |
| `mirror.ts` | REST reads of the public mirror node, with pagination and retries |
| `statement.ts` | the proves / does-not-prove wording, read from `docs/schemas/README.md` |

## Tests

`tests/verifier/`. The unit suite runs entirely offline against `golden/` — the three envelopes of a
real testnet run plus a recorded snapshot of the mirror-node answers it produced. The snapshot is the
whole page the mirror node returned, not an extract, so it holds a second order and a verifier that
forgot to filter by `mandate_id` would be caught by it.

`tampered/` holds four edited copies; each must fail the check it was built to fail. See
`tests/verifier/tampered/README.md` for what was changed in each and which other checks move with it.

`verifier.integration.test.ts` runs the command against the live mirror node and skips itself when
`.env` is absent.
