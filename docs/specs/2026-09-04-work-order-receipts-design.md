# Design: work orders and receipts between two organizations' agents, paid with x402 on Hedera

Date: 2026-09-04 (ETHOnline 2026, day 1). Status: approved direction; spike passed 12:47 EDT (see `spike/README.md`); schemas aligned with the source protocol 12:5x EDT.

## Problem
Two companies each run AI agents. Company A's agent wants Company B's agent to do a unit of work (a backlog story), pay for it without a human, a card or an API key, and later prove to anyone — including an auditor who trusts neither company's servers — what was ordered, what was paid and what was delivered. Today's x402 demos pay for a single HTTP response; a unit of work lives for days and settles in stages. Existing marketplaces keep the truth in their own database.

## What we build
1. **Work-order protocol.** Documents follow the canonical schemas in `docs/schemas/` (source: RetailBox A2A Bridge spec 2026-09-04): `mandate.v1` (customer → contractor: story ref, title, acceptance criteria, frame, due), `receipt.v1` with `kind: accepted` on intake and `kind: delivered` on completion (mandate envelope hash, anchor, taken/declined, result links). This repository adds the `payment.v1` profile — a `payment` object with the x402 legs — via `allOf`, because the base schemas carry no money fields by design. Canonical JSON (RFC 8785) + Ed25519 signatures for envelopes; x402 payments signed with ECDSA (Hedera requirement).
2. **Contractor agent (Company B).** HTTP service with two x402-gated routes settled through the Blocky402 facilitator on Hedera testnet:
   - `POST /mandates` — accept a mandate; the 402 price is the intake fee. Returns a signed `receipt.v1` with `kind: accepted`.
   - `GET /mandates/{id}/receipt` — the 402 price is the balance; returns the signed `receipt.v1` with `kind: delivered` (+ `payment`) once the deliverable exists.
   Between the two calls the contractor does the work (in the demo: the deliverable is a PR link + staging URL produced by the contractor's pipeline; for the hackathon this may be simulated deterministically).
3. **Customer agent (Company A).** Signs the order, pays both 402s with `@x402/fetch`, stores the receipt.
4. **Public audit log on HCS.** Every step (order hash, intake payment tx, acceptance hash, delivery hash, balance payment tx, receipt hash) is anchored as a message on a Hedera Consensus Service topic (HIP-991 custom fee optional). Only hashes and public ids — never the content.
5. **Verifier.** A CLI that takes a topic id and a receipt, reads the mirror node REST API, and reconstructs `ordered → paid → delivered` for that order: every hash matches, every payment tx exists with the right payer/payee/amount, timestamps are consistent. Exits non-zero on any mismatch. Works without access to either company's server.
6. **Agent identity (extra).** Each agent publishes an HCS-14 style identifier and signs with the corresponding key; the verifier resolves it.
7. **Recurring retainer (extra, if time).** A Scheduled Transaction that pays a monthly retainer from A to B, referenced from the audit topic.

## Data flow
```
Customer agent                 Contractor service                Hedera
  sign mandate.v1 ──POST /mandates─▶ 402 (intake fee) ─┐
  pay via x402    ──POST /mandates + PAYMENT-SIGNATURE▶ verify+settle via Blocky402 ──▶ TransferTransaction
                  ◀── receipt.v1 accepted ──          anchor(order#, tx, acceptance#) ─▶ HCS topic message
                                                       ... work happens ...
                                                       anchor(delivery#) ────────────▶ HCS topic message
  GET /receipt    ──────────────────────────▶ 402 (balance)
  pay via x402    ──GET /receipt + PAYMENT-SIGNATURE─▶ settle via Blocky402 ────────▶ TransferTransaction
                  ◀── receipt.v1 delivered+payment              anchor(receipt#, tx) ─────────▶ HCS topic message
Anyone: verifier --topic 0.0.X --receipt receipt.json  → reads mirror node → PASS / FAIL with reasons

What the chain proves and does not prove is stated in `docs/schemas/README.md` and printed by the verifier on every run.
```

## Components and boundaries
| Unit | Does | Depends on | Tested by |
|---|---|---|---|
| `protocol/` | types, canonical JSON, sign/verify envelopes | none | unit tests with fixed vectors |
| `contractor/` | Express + `@x402/express` + `@x402/hedera`, order state, anchoring | protocol, hedera client | integration test against testnet |
| `customer/` | `@x402/fetch` client, signs orders | protocol | e2e run |
| `anchor/` | HCS topic create/submit, message schema | `@hiero-ledger/sdk` | unit + mirror read-back |
| `verifier/` | CLI, mirror node REST only | protocol (verify), HTTP | golden run + tamper tests |

## Error handling
- Facilitator `verify` fails → 402 again with reason; no state change; anchor nothing.
- Settle succeeds but anchoring fails → retry anchor with backoff; receipt is not issued until the anchor for the payment exists (the receipt must be provable).
- Mirror node lag (~1–2 s) → verifier retries reads for up to 30 s before declaring a missing message.
- Tampered receipt / wrong payer / amount mismatch → verifier prints the exact failing check and exits 1.

## Testing
- Unit: canonicalization, signatures, verifier checks against golden fixtures and tampered variants.
- Integration (testnet): one full order end to end; verifier PASS; then three tamper cases (edited receipt, replaced tx id, missing anchor) → FAIL.
- Demo: the same run recorded for the video, with HashScan links in `README.md`.

## Out of scope
Escrow, disputes with arbitration, mainnet, USDC, a UI beyond a minimal status page.

## Prizes targeted
Hedera "AI & Agentic Payments" (qualification + extras: A2A, identity, HCS audit trail, Scheduled Transactions); Hedera "Improve the Harness" via a separate PR if time remains; Bazantic "x402 gateway + MCP for an API" if the contractor service is also exposed through MCP.
