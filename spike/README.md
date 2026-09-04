# Day-1 spike — a real HBAR payment for an HTTP resource, settled through Blocky402

This spike proves one thing end to end: **an agent can pay HBAR for an HTTP resource over the x402
protocol on Hedera testnet, with settlement performed by the Blocky402 facilitator.** No mocks, no
stubs — a real `CRYPTOTRANSFER` reached consensus and is visible on HashScan.

Everything below is the actual output of the run on 2026-09-04, not a description of what should
happen.

## The payment

**HashScan:** https://hashscan.io/testnet/transaction/0.0.7162784@1788539653.433840739

| | |
|---|---|
| Transaction id | `0.0.7162784@1788539653.433840739` |
| Consensus timestamp | `1788539659.779738844` — 2026-09-04 16:34:19 UTC (12:34:19 EDT) |
| Result | `SUCCESS` |
| Payer (our agent) | `0.0.10365982` — **−1 000 000 tinybars** |
| Receiver (our route's `payTo`) | `0.0.10365984` — **+1 000 000 tinybars** |
| Fee payer (Blocky402) | `0.0.7162784` — **−261 078 tinybars** network fee |
| Network | `hedera:testnet` |
| Asset | `0.0.0` (native HBAR) |

The transfer list straight from the public mirror node
(`https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788539653-433840739`):

```json
"transfers": [
  { "account": "0.0.802",      "amount":    261078 },
  { "account": "0.0.7162784",  "amount":   -261078 },
  { "account": "0.0.10365982", "amount":  -1000000 },
  { "account": "0.0.10365984", "amount":   1000000 }
]
```

The payer pays only the resource price; the facilitator carries the Hedera network fee. That is the
whole point of the fee-payer model — the paying agent never needs to reason about gas.

It settled three times, not once, so this is reproducible rather than lucky:

| # | Transaction | Consensus (UTC) | Note |
|---|---|---|---|
| 1 | `0.0.7162784@1788539597.122303478` | 16:33:22 | Settled fine; our *verification* code had gotcha 2 and wrongly reported "not found" |
| 2 | `0.0.7162784@1788539653.433840739` | 16:34:19 | **The link above** — first run with verification fixed |
| 3 | `0.0.7162784@1788540153.262607741` | 16:42:39 | Clean server restart from the committed tree, to confirm reproducibility |

Every one is `SUCCESS` with the identical transfer shape. Account balances agree with exactly three
payments of 0.01 ℏ: payer `3 000 000 000 → 2 997 000 000` tinybars, receiver `100 000 000 →
103 000 000`.

## What is in here

| File | Role |
|---|---|
| `create-accounts.ts` | Creates the two ECDSA testnet accounts (PAYER, RECEIVER) and appends their credentials to the gitignored `.env`. Re-running is a no-op for accounts that already exist. |
| `server.ts` | Express service with one x402-gated route, `GET /quote`, priced at 1 000 000 tinybars. |
| `client.ts` | The paying agent. Pays via `@x402/fetch`, prints the settlement + HashScan link, then independently confirms the transfer on the mirror node. |

## How to run

`.env` needs a funded Hedera **testnet** operator (`HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`,
`HEDERA_OPERATOR_KEY_TYPE`). It is gitignored and must stay that way.

```bash
npm install
npm run spike:accounts   # once — creates + funds PAYER (30 ℏ) and RECEIVER (1 ℏ), writes them to .env
npm run spike:server     # terminal 1
npm run spike:client     # terminal 2
```

Successful client output:

```
payer:     0.0.10365982
receiver:  0.0.10365984
resource:  http://localhost:4021/quote

paying…

HTTP 200, payment status: settled
resource body: {"quote":{"task":"translate-one-page","currency":"HBAR","amount":"12.50","validForSeconds":900},"servedAt":"2026-09-04T16:34:19.050Z"}

settled by:  0.0.10365982
transaction: 0.0.7162784@1788539653.433840739
hashscan:    https://hashscan.io/testnet/transaction/0.0.7162784@1788539653.433840739

confirming on the mirror node…

mirror node result:        SUCCESS
consensus timestamp:       1788539659.779738844
charged fee (tinybars):    261078
hbar transfers:
  0.0.802        +261078
  0.0.7162784    -261078
  0.0.10365982   -1000000
  0.0.10365984   +1000000

checks:
  payer 0.0.10365982 debited 1000000 tinybars: true
  receiver 0.0.10365984 credited 1000000 tinybars: true
  facilitator 0.0.7162784 paid the network fee: true
```

## How the flow actually works

1. The agent calls `GET /quote` with no payment. The middleware answers **402** with a
   `PAYMENT-REQUIRED` header — base64 JSON, decoded here verbatim:

   ```json
   {
     "x402Version": 2,
     "error": "Payment required",
     "resource": {
       "url": "http://localhost:4021/quote",
       "description": "A priced quote for one unit of work",
       "mimeType": "application/json"
     },
     "accepts": [
       {
         "scheme": "exact",
         "network": "hedera:testnet",
         "amount": "1000000",
         "asset": "0.0.0",
         "payTo": "0.0.10365984",
         "maxTimeoutSeconds": 120,
         "extra": { "feePayer": "0.0.7162784" }
       }
     ]
   }
   ```

   Note `extra.feePayer` — **we never configure it.** `@x402/express` syncs the facilitator's
   `GET /supported` on startup and `ExactHederaScheme.enhancePaymentRequirements` copies
   `extra.feePayer` from the facilitator's `hedera:testnet` kind into the requirements. Hardcoding it
   would be wrong; it is the facilitator's own account.

2. The client builds a `TransferTransaction` (payer −amount, `payTo` +amount), sets
   `transactionId.accountId` to the **facilitator's** account so the facilitator pays the fee,
   freezes, signs with the payer key only, and sends it base64 in the `PAYMENT-SIGNATURE` header.

3. The server sends the payload to the facilitator's `POST /verify`, serves the resource, then calls
   `POST /settle`. The facilitator adds its fee-payer signature, submits to Hedera, waits for the
   receipt, and returns the transaction id. It comes back to the client in the `PAYMENT-RESPONSE`
   header.

4. `client.ts` does not trust that header alone — it re-reads the transaction from the public mirror
   node and asserts the three balances moved the way they should.

## Gotchas hit (verbatim)

### 1. Native HBAR is rejected by the client's own spend controls before anything is signed

`x402Client` ships spend controls that, by default, allow **only assets the scheme recognises as
"default assets"**. For Hedera that table contains exactly one entry — testnet USDC `0.0.429274`
(`@x402/hedera/dist/esm/chunk-X5J2I56W.mjs`). Native HBAR `0.0.0` is *not* in it, so an
HBAR-priced route is refused client-side. Reproduced deliberately with a client that omits the
opt-in:

```
ERROR: Failed to create payment payload: All payment requirements were rejected by spendControls:
only default assets or entries in spendControls.allowedAssets are allowed. Add an allowedAssets
entry for non-default tokens, set allowedAssets: true, or set spendControls: false.
```

Fix used in `client.ts` — opt HBAR in explicitly, with a real cap rather than disabling the
controls:

```ts
client.setSpendControls({
  allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0", maxAmountPerPayment: "5000000" }],
});
```

This is the single most likely thing to stop a first HBAR integration, and the error names spend
controls rather than HBAR, so it is easy to misread as a server problem.

### 2. The mirror node returns transaction ids hyphenated, so a naive equality check silently fails

The facilitator returns `0.0.7162784@1788539597.122303478`. The mirror node addresses *and* reports
the same transaction as `0.0.7162784-1788539597-122303478`. Our first client converted the id for the
URL but then compared the response's `transaction_id` against the original `@` form, so it looped
through every retry and printed:

```
confirming on the mirror node…
transaction not found on the mirror node yet — check the HashScan link manually
```

**The payment had settled perfectly.** Only our verification was wrong — a false negative that would
have read as "the facilitator didn't settle". Fixed by comparing against the hyphenated id.

Worth stating plainly: a failing confirmation step is not evidence of a failed payment. Check the
chain before believing your own checker.

### 3. HashScan deep links answer HTTP 404 to `curl` while rendering fine in a browser

```
404  https://hashscan.io/testnet/transaction/0.0.7162784@1788539653.433840739
404  https://hashscan.io/testnet/account/0.0.10365982
404  https://hashscan.io/testnet/dashboard
200  https://hashscan.io/
```

Even HashScan's own dashboard route 404s, and the 404 body is the full "Hedera Mirror Node Explorer"
SPA shell — it is client-side routing, not a bad link. Verified by rendering the transaction URL in a
headless browser (see below). Do not use a `curl` status code to judge an explorer link.

### 4. Facilitator has no documentation; probe it directly

`https://github.com/blocky402` and the docs link 404. What actually works:

```
GET  /supported  → 200
{"kinds":[…,{"x402Version":2,"scheme":"exact","network":"hedera:testnet",
             "extra":{"feePayer":"0.0.7162784"}}],
 "signers":{"hedera:*":["0.0.7162784"]}}

POST /verify  {}  → 400 {"message":"Payment requirements are required","error":"Bad Request","statusCode":400}
POST /settle  {}  → 400 {"message":"Payment requirements are required","error":"Bad Request","statusCode":400}
GET  /            → 404
```

`GET /supported` is the useful one — it tells you the fee payer account and confirms the network is
live before you write any code.

### 5. `AccountCreateTransaction.setKey` is deprecated in `@hiero-ledger/sdk` 2.85

From the shipped typings:

```
/** @deprecated Use `setKeyWithoutAlias` instead. */
```

`setKeyWithoutAlias(publicKey)` creates the plain `0.0.x` account this spike needs. The alias
variants (`setKeyWithAlias`, `setECDSAKeyWithAlias`) create an EVM alias, and the facilitator rejects
an alias as `payTo`.

### 6. SDK pin — pinned up front, so not hit

`@x402/hedera` depends on `@hiero-ledger/sdk` 2.85.0. Installing the SDK standalone pulls 2.87.0,
producing two on-disk copies and a runtime `t.startsWith is not a function` from the SDK's internal
brand checks. We pinned `"@hiero-ledger/sdk": "2.85.0"` in `package.json` before installing and
verified a single copy resolves:

```
$ find node_modules -path "*@hiero-ledger/sdk/package.json"
node_modules/@hiero-ledger/sdk/package.json: 2.85.0
```

We did not hit the error; we avoided it. Recording it because it is the failure everyone else hits.

### 7. The payer key must be ECDSA

The x402 exact-Hedera flow assumes ECDSA payer keys. Our operator happened to already be ECDSA, so
`create-accounts.ts` reads `HEDERA_OPERATOR_KEY_TYPE` and handles either kind for the *operator*,
while the two accounts it creates are always ECDSA (`PrivateKey.generateECDSA()`). Both confirmed on
the mirror node as `ECDSA_SECP256K1`.

## Browser confirmation of the HashScan link

Because of gotcha 3, the link was checked the way a person checks it — rendered in a real browser
(Chrome for Testing 151, headless, `--dump-dom`) rather than trusted from a status code. Text
extracted from the rendered page:

```
Hedera Transaction 1788539659.779738844
Transaction 0.0.7162784@1788539653.433840739
Summary  Transaction SUCCESS
ID 0.0.7162784@1788539653.433840739
Type CRYPTO TRANSFER
Consensus at 12:34:19.7797 PM Sep 4, 2026, EDT
Block 40106085   Node Submitted To 0.0.6
Payer Account 0.0.7162784   Charged Fee 0.00261078 ℏ

Hbar Transfers
  0.0.7162784    -0.00261078 ℏ
  0.0.10365984    0.01000000 ℏ   Transfer
  0.0.10365982   -0.01000000 ℏ
  0.0.802         0.00261078 ℏ   Fee Collection Account
```

The explorer shows exactly what the mirror node reported: our payer down 0.01 ℏ, our receiver up
0.01 ℏ, the facilitator carrying the fee.

## What this spike does NOT prove

- **HTTPS / deployed service.** Everything ran against `http://localhost:4021`. The facilitator never
  needs to reach our server (the client carries the signed payload), so this is not a blocker for the
  hackathon build, but it is untested.
- **USDC / HTS tokens.** HBAR only, deliberately. HTS adds token association, which is a separate
  failure surface (`TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`).
- **Failure paths.** We did not test replay of a used payload, an expired `maxTimeoutSeconds`, an
  underfunded payer, or a `payTo` alias. The facilitator's behaviour there is claimed by the spec but
  unverified by us.
- **Mainnet.** Testnet only.
- **HCS receipts.** The public work-order/receipt log is the next lane, not this one.
