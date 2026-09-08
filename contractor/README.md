# Contractor service — paid intake, delivery, paid receipt release

The contractor agent (Agency X in the demo) accepts a signed work order, does the work, and releases a
signed receipt. Both ends of that exchange are paid with x402 on Hedera testnet through the Blocky402
facilitator, and every step is anchored on a public HCS topic.

| Route | Payment | Answers |
|---|---|---|
| `POST /mandates` | `INTAKE_TINYBARS` (default 1 000 000 = 0.01 ℏ) | `201 { receipt }` — signed `receipt.v1`, `kind: accepted` |
| `POST /mandates/{id}/deliver` | none — contractor-local, `X-Contractor-Token` | `200 { result, anchor }` |
| `GET /mandates/{id}/receipt` | `BALANCE_TINYBARS` (default 4 000 000 = 0.04 ℏ) | `200 { receipt }` — signed `receipt.v1+payment.v1`, `kind: delivered` |
| `GET /health` | none | configuration and prices |

Six anchors go on the topic for one order, in this order:
`mandate_in → payment_intake → accepted → delivered → payment_balance → receipt`.

## Why the `upfront` payment flow

Under x402's default `authorization` flow the facilitator settles **after** the resource handler has run and
its response has been buffered. A receipt that has to name the transaction that just paid for it could then
never carry that transaction id — it would always be one payment behind.

The Hedera exact scheme also supports the `upfront` flow (`settleBeforeHandler`), which both routes request
through `extra: { paymentFlow: "upfront" }`. The money settles before the handler, so the handler can anchor
the payment and put its transaction id inside the receipt it signs and returns.

Nothing about the facilitator is hardcoded: `extra.feePayer` arrives from its `/supported` response through
`@x402/express`, exactly as in `spike/`.

Two consequences worth stating plainly:

- **`GET /mandates/{id}/receipt` refuses before it charges.** A guard runs ahead of the payment gate and
  answers `409` when the deliverable does not exist yet, `404` for an unknown order, and the stored receipt
  when one was already issued. The customer never sees a `402` for something it cannot receive, and a repeat
  collection costs nothing and writes no new anchors.
- **A refused intake keeps the settled payment.** `POST /mandates` is paid before its body can be checked, so
  a body that is not a valid signed `mandate.v1` gets `422` with a signed `receipt.v1`, `kind: rejected` —
  naming the expected schema, its url, and a hint, without quoting the refused message. Nothing is anchored
  for a refusal; the transfer itself is on the ledger, and the response carries its transaction id.

## What the payment anchors contain

An anchor never carries content, only a hash — but a hash nobody can recompute proves nothing. The two
payment anchors carry `sha256(canonicalize({v:"wr-payment.v1", network, asset, payer, payee, tinybars,
transaction_id}))`, over exactly the fields the receipt's `payment` profile publishes, plus the transaction
id in mirror-node form in `ref`. A verifier holding only the receipt and the public topic can therefore
recompute the hash and look the transfer up independently. The helper is `paymentAnchorHash` in
`receipts.ts`.

## Configuration

`.env` is gitignored and stays that way. Required:

| Variable | Meaning |
|---|---|
| `ANCHOR_TOPIC_ID` | Audit topic; create one with `npm run anchor:create-topic` |
| `CONTRACTOR_SIGNING_KEY` | Ed25519 secret key, 32 bytes hex — signs every receipt |
| `CONTRACTOR_DELIVER_TOKEN` | Shared secret for the contractor-local delivery route |
| `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, `HEDERA_OPERATOR_KEY_TYPE` | Pays for the HCS messages |
| `CONTRACTOR_ACCOUNT_ID` | Hedera account that receives payments; falls back to `RECEIVER_ACCOUNT_ID` from the spike. Must be a real `0.0.x` account — the facilitator rejects aliases |

Optional: `CONTRACTOR_HANDLE` (default `agency-x-agent`), `CONTRACTOR_PORT` (4021), `CONTRACTOR_STORE`
(`out/contractor/jobs.json`), `INTAKE_TINYBARS`, `BALANCE_TINYBARS`, `X402_FACILITATOR_URL`
(`https://api.testnet.blocky402.com`), `X402_NETWORK` (`hedera:testnet`), `X402_ASSET` (`0.0.0` = HBAR).

A signing key, if you need one:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Running

```bash
npm run contractor:start
# then, from the paying side (Task 4), or by hand:
curl -s localhost:4021/health
```

## Files

| File | Role |
|---|---|
| `server.ts` | Routes, the x402 gate, the settlement ledger, anchoring, configuration |
| `store.ts` | The job store: one JSON file, atomic writes, survives a restart between the two paid calls |
| `work.ts` | The simulated deliverable — deterministic links derived from the mandate id |
| `receipts.ts` | Builds and signs `accepted`, `delivered` and `rejected` receipts; payment anchor hash; uuid7 |

The job store keeps the mandate envelope byte-identical to what arrived, because its hash is what the
receipt and the topic both point at.

## Tests

`tests/contractor/*.test.ts`. The unit suite replaces the two things that cost money — settling and writing
to HCS — with injected stubs, so it exercises the real route code and can assert the order and content of
every anchor and every refusal path. `contractor.integration.test.ts` runs the whole flow on testnet with
real payments and a real topic; it skips itself when `.env` has no operator.
