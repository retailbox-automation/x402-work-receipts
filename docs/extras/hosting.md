# The hosted contractor

The contractor agent runs as one container on a Zeabur dedicated server, so the flow can be tried
without starting anything locally:

**https://x402-work-receipts.zeabur.app**

```bash
curl -s https://x402-work-receipts.zeabur.app/.well-known/agent.json          # who it is
curl -si -X POST https://x402-work-receipts.zeabur.app/mandates -d '{}' \
  -H 'content-type: application/json' | head -1                               # 402, with the quote
```

The second call answers `402 Payment Required` with a `payment-required` header — base64 of the x402
quote: scheme `exact`, network `hedera:testnet`, 1 000 000 tinybars, `payTo 0.0.10365984`, and the
facilitator's own `feePayer`. That header is the whole handshake; the customer agent reads it, pays,
and retries.

**Testnet only, and deliberately bounded.** The account that receives payments holds a few test HBAR
and is used for nothing else; the operator account that pays for the HCS anchors is a testnet account
too. There is no mainnet key on that machine. The [verifier](../../verifier) is unaffected either way —
it holds no keys and reads only the public mirror node, so a stranger checks the same receipt without
trusting this host at all.

**Two things the container does that a laptop does not need.** Zeabur terminates TLS and forwards
plain http, so the service trusts one proxy hop (`app.set("trust proxy", 1)`) — without it the quote in
the `402` advertised `http://x402-work-receipts.zeabur.app/...` for a host that answers only over
https, and a customer agent that took the advertised url at its word would have been sent to the wrong
scheme. And `POST /mandates/{id}/deliver`, the one route guarded by a static token rather than by a
payment, is rate-limited per address — 20 calls per 10 minutes, counted before the token is checked, so
guessing it is not free. Everything else costs HBAR before the handler runs, which is its own limit.
The service also stops naming Express in its response headers.

## A real run against it

Order `01a086c8-8c74-773e-b95a-75574aa4128e`, 2026-09-09, placed from a laptop against the url above,
verified `VERIFIED — all 6 applicable checks passed`.

| What | Where |
|---|---|
| Audit topic | [`0.0.10426298`](https://hashscan.io/testnet/topic/0.0.10426298) |
| Intake payment, 1 000 000 tinybars | [`0.0.7162784@1788967679.615119899`](https://hashscan.io/testnet/transaction/0.0.7162784@1788967679.615119899) |
| Balance payment, 4 000 000 tinybars | [`0.0.7162784@1788967689.416097643`](https://hashscan.io/testnet/transaction/0.0.7162784@1788967689.416097643) |
| Anchors | `mandate_in` #142 → `payment_intake` #143 → `accepted` #144 → `delivered` #145 → `payment_balance` #146 → `receipt` #147 |

The commands, exactly as they were run:

```bash
BASE=https://x402-work-receipts.zeabur.app

npm run customer -- order --story demo/fixtures/story-history-grouping.json --to $BASE --out out/hosted

curl -sS -X POST "$BASE/mandates/<mandate_id>/deliver" \
  -H 'content-type: application/json' \
  -H "x-contractor-token: $CONTRACTOR_DELIVER_TOKEN" -d '{}'

npm run customer -- collect <mandate_id> --to $BASE --out out/hosted

npm run verify -- --topic 0.0.10426298 \
  --receipt out/hosted/<mandate_id>/receipt.json \
  --mandate out/hosted/<mandate_id>/mandate.json
```

Only the delivery call needs a secret, and only because that route is the contractor's own: it is how
the agency's side says the work is done. Ordering, paying and verifying need nothing but the url.

**Verify a minute after collecting, not the same second.** The anchors and the transfers are final on
the network before the mirror node has indexed them, and the verifier reads only the mirror node — run
immediately, it reported the receipt anchor missing; run a minute later, the same files verified. That
is the verifier being honest about what it can see, not a flake.

## How it is deployed

| | |
|---|---|
| Zeabur project | `x402-work-receipts` — `6aa1732c6c3d9581b71572f6` |
| Environment | `production` — `6aa1732cda9bc245fbad3e24` |
| Service | `contractor` — `6aa1734c6c3d9581b7157302` |
| Server | AI-Experts, Frankfurt (dedicated, `6863068a5eaf76cff951ff39`) |
| Source | this repository, branch `main` — a push redeploys |
| Container | `Dockerfile`, `node:22-slim`, limited to 0.5 CPU / 512 MB |
| Port | Zeabur injects `PORT=8080`; the service prefers `CONTRACTOR_PORT`, then `PORT`, then `4021` |

The image runs the service straight from TypeScript with `tsx`, which is why `tsx` is a dependency and
not a dev dependency. The job store is a file inside the container and does not survive a redeploy —
an order taken before one cannot be collected after it. That is fine for a demo host and would not be
for anything else; the store is one small interface away from being external.

Redeploy, and stop:

```bash
zeabur service redeploy --id 6aa1734c6c3d9581b7157302 --env-id 6aa1732cda9bc245fbad3e24 -y -i=false
zeabur service suspend  --id 6aa1734c6c3d9581b7157302 --env-id 6aa1732cda9bc245fbad3e24 -y -i=false
```

A suspended service is brought back with `redeploy`, not `restart`.

The variables the service reads, by name — values live in the platform, never in this repository:
`HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, `HEDERA_OPERATOR_KEY_TYPE`, `HEDERA_NETWORK`,
`ANCHOR_TOPIC_ID`, `CONTRACTOR_SIGNING_KEY`, `CONTRACTOR_DELIVER_TOKEN`, `RECEIVER_ACCOUNT_ID`,
`X402_FACILITATOR_URL`, `X402_NETWORK`. Every one of them is described in the README's Setup table.
