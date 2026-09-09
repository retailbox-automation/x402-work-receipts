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

Against the order anchored on shared topic `0.0.10426298` on 2026-09-09:

```
order   01a0868a-954e-772c-9995-d9c5696f2ee0
receipt 01a0868a-c20c-70ce-a983-861a808ad380 (delivered, issued by agency-x-agent)
topic   0.0.10426298
source  https://testnet.mirrornode.hedera.com/api/v1 (public mirror node only)

      check                 detail
PASS  receipt signature     signed by 99573eae7ac7… over the receipt as issued
PASS  agent identity        uaid:did:z6MkpmqamYik… is the key that signed this receipt (99573eae7ac7…), addressed to uaid:did:z6MkpKkccyxe…
PASS  mandate hash linkage  6c545cc123a2a0e98f57f8f47be3510bf0e3053592e153e03747a1fe450f8587 — receipt, anchor #115 and the mandate file agree
PASS  anchor sequence       mandate_in #115 → payment_intake #116 → accepted #117 → delivered #118 → payment_balance #119 → receipt #120
PASS  payments on ledger    intake 1000000 tinybars 0.0.10365982 → 0.0.10365984 (0.0.7162784-1788963619-765994096); balance 4000000 tinybars 0.0.10365982 → 0.0.10365984 (0.0.7162784-1788963626-820218273)
PASS  receipt anchor        c2d75097959eef53a4eb85b2c2d36d33e9c40613388cd5b77a28ef68beb68538 anchored at #120 (1788963636.004054104)

────────────────────────────────────────────────────────────────────────────────────────
VERIFIED — all 6 applicable checks passed against the public record.
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
N/A   agent identity        the receipt comes from "agency-x-agent", a handle rather than an HCS-14 identifier — it makes no identity claim to check
PASS  mandate hash linkage  79225ab80d552f8eef6fbc57bc8ba23add91724eced2185953607546a511809a anchored at #1; no mandate file given, so the fingerprint was not recomputed
PASS  anchor sequence       mandate_in #1 → payment_intake #2 → accepted #3 → delivered #4 → payment_balance #5 → receipt #6
FAIL  payments on ledger    the intake payee 0.0.9999999 was not credited exactly 1000000 tinybars; the payment_intake anchor does not cover the intake payment the receipt states (anchored f9d41c01c01a…, receipt implies a65c94a16822…); the balance payee 0.0.9999999 was not credited exactly 4000000 tinybars; the payment_balance anchor does not cover the balance payment the receipt states (anchored 13f722391958…, receipt implies 68e3946523d1…)
FAIL  receipt anchor        this receipt hashes to 8dce26c78858…, the topic anchored 8c7c94dd3029… at #6

NOT VERIFIED — 3 of 5 checks failed: receipt signature, payments on ledger, receipt anchor. 1 had nothing to check: agent identity.
```

## The seven checks

| # | Check | What has to hold |
|---|---|---|
| 1 | `receipt signature` | the Ed25519 signature covers the receipt as issued — the document was not edited after signing |
| 2 | `agent identity` | the HCS-14 identifier in the envelope's `from` decodes to the key in `sig.pub`, the `to` is well formed, and — when the work order is supplied — it came from the agent the receipt answers |
| 3 | `mandate hash linkage` | the receipt's `mandate_envelope_hash` equals the `mandate_in` anchor's hash, and — when the work order is supplied — equals `envelopeHash(mandate)` recomputed from it |
| 4 | `anchor sequence` | all six steps of this order are on the topic, none twice, and they reached consensus in the order `mandate_in → payment_intake → accepted → delivered → payment_balance → receipt` |
| 5 | `payments on ledger` | both transactions exist with `result: SUCCESS`, the payer is debited and the payee credited exactly `tinybars`, the network fee is paid by somebody other than the payer, and each `payment_*` anchor's hash equals `paymentAnchorHash` of the leg the receipt publishes |
| 6 | `receipt anchor` | the `receipt` anchor's hash equals `envelopeHash(receipt)` — the receipt on the topic is this receipt |
| 7 | `retainer on ledger` | when the order anchored a retainer: the schedule and the transfer it executed are on the mirror node, the receipt's payer authorised the schedule, the transfer moves the anchored amount between the two accounts the receipt names, both anchored hashes recompute from the ledger, and the release reached consensus after the `delivered` anchor |

Check 5's fee-payer condition is what stops a "payment" from being a self-transfer dressed up: under
the x402 `upfront` flow the facilitator pays the fee, so the fee payer is never the payer.

Checks 2 and 7 are the ones that can have nothing to decide, and then they print `N/A` rather than
`PASS`. Check 7 has nothing to decide whenever the order anchored no retainer, which is the ordinary
case; see [`docs/extras/retainer.md`](../docs/extras/retainer.md).
Two cases: an envelope that carries a plain handle, which is what every receipt issued before
identifiers existed carries; and an identifier that would have to be resolved — a `uaid:aid:`, or a
DID of a method other than `did:key`. This command reads the public mirror node and nothing else, so
it cannot resolve either, and a report that counted an unmade lookup as a pass would be lying about
the one thing it exists to establish. See [`docs/extras/identity.md`](../docs/extras/identity.md).

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
| `checks.ts` | the checks — each a pure function over `(receipt, anchors, transactions)` |
| `mirror.ts` | REST reads of the public mirror node, with pagination and retries |
| `retainer.ts` | the optional retainer check, over a schedule and the transfer it executed |
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
