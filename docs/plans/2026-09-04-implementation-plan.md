# x402-work-receipts — Implementation Plan

> **For agentic workers:** one task = one isolated lane (fresh `claude -p` run in its own git worktree, branch `lane-<task>`), reviewed and merged by the orchestrator. Steps use checkbox (`- [ ]`) syntax. Every task ends with tests passing and a commit on its lane branch. Implementation code is written by the lane; this plan fixes files, interfaces, tests and acceptance so lanes can run without the author's context.

**Goal:** Two organizations' agents exchange a signed work order (`mandate.v1`) and signed receipts (`receipt.v1`), pay intake and balance with x402 on Hedera testnet through the Blocky402 facilitator, anchor every step on an HCS topic, and let anyone verify `ordered → paid → delivered` from the public mirror node alone.

**Architecture:** TypeScript monorepo-lite in one npm package. `protocol/` (schemas, canonical JSON, Ed25519 envelopes) is the only shared dependency. `contractor/` is an Express service with two x402-gated routes; `customer/` is a CLI agent that signs, pays and stores; `anchor/` talks to HCS and the mirror node; `verifier/` is a stand-alone CLI that reads only public mirror-node data. Spec: `docs/specs/2026-09-04-work-order-receipts-design.md`. Schemas: `docs/schemas/`. Proven payment path: `spike/`.

**Tech Stack:** Node ≥ 22, TypeScript 5.9 via `tsx`, `vitest`; `@x402/core|hedera|express|fetch` 2.24.0; `@hiero-ledger/sdk` **2.85.0 (pinned)**; `ajv` 8 + `ajv-formats` (draft 2020-12); `@noble/ed25519` + `@noble/hashes`; `json-canonicalize` (RFC 8785); `express` 5; `commander` for CLIs.

## Global Constraints
- Every commit inside the hacking window (from 2026-09-04 12:00 EDT); author `RetailBox <admin@retailbox-automation.com>`; commit messages in plain English, no tool attribution.
- No secrets in tracked files. `.env` only (`HEDERA_OPERATOR_*`, `PAYER_*`, `RECEIVER_*`, `CONTRACTOR_*`, `CUSTOMER_*`, `ANCHOR_TOPIC_ID`).
- No client or partner names anywhere in the repo (check with `grep -rniw -E 'trigonum|ignat' .`). Demo data is synthetic (Agency X / Client Y).
- Base schemas `docs/schemas/mandate.v1.schema.json` and `receipt.v1.schema.json` are byte-identical copies of the source and are never edited; `payment.v1.schema.json` is regenerated only via `docs/schemas/build_payment_profile.py`.
- Amounts in tinybars. Facilitator `https://api.testnet.blocky402.com`; network `hedera:testnet`; HBAR asset `0.0.0`; client must opt HBAR in via `setSpendControls({allowedAssets:[{network:"hedera:testnet", asset:"0.0.0", maxAmountPerPayment}]})` (spike gotcha 1).
- Transaction ids: facilitator returns `0.0.X@sec.nanos`; mirror node uses `0.0.X-sec-nanos` (spike gotcha 2). One helper does the conversion; nothing else compares ids.
- Verifier trusts only `https://testnet.mirrornode.hedera.com/api/v1/*`. It never calls the contractor or the customer.
- The "what this proves / does not prove" text in `docs/schemas/README.md` is printed by the verifier on every run and copied into the README.

## File Structure
```
protocol/   canonical.ts (RFC 8785)        envelope.ts (sign/verify/hash)     schemas.ts (ajv validators)   types.ts
anchor/     topic.ts (create topic)        client.ts (submit + read anchors)  records.ts (wr-anchor.v1 shape)
contractor/ server.ts (Express + x402)     store.ts (JSON file job store)     work.ts (deterministic simulated deliverable)   receipts.ts (build receipt.v1 ± payment)
customer/   cli.ts (order / collect)       pay.ts (x402 client with spend controls)  wallet.ts (keys from .env)
verifier/   cli.ts                          checks.ts (each check = one function)   mirror.ts (REST reads with retry)   statement.ts (proves / does not prove)
demo/       run-e2e.ts                      fixtures/story-*.json
tests/      unit per module + tampered fixtures; integration tests skip when .env is absent
```

---

### Task 1: protocol — canonical JSON, envelopes, schema validators
**Files:** Create `protocol/canonical.ts`, `protocol/envelope.ts`, `protocol/schemas.ts`, `protocol/types.ts`, `tests/protocol/*.test.ts`. Modify `package.json` (add `vitest`, `ajv`, `ajv-formats`, `@noble/ed25519`, `@noble/hashes`, `json-canonicalize`; scripts `test`, `test:unit`).
**Interfaces (produces):**
- `canonicalize(value: unknown): string` — RFC 8785 string.
- `sha256Hex(s: string | Uint8Array): string`.
- `type Envelope<T> = { schema: "mandate.v1"|"receipt.v1"|"receipt.v1+payment.v1"; from: string; to: string; thread_id: string; issued_at: string; data: T; sig: { alg: "ed25519"; pub: string /*hex*/; value: string /*hex*/ } }`.
- `signEnvelope<T>(body: Omit<Envelope<T>,"sig">, privateKeyHex: string): Envelope<T>` — signature over `canonicalize(body)`.
- `verifyEnvelope(env: Envelope<unknown>): boolean`.
- `envelopeHash(env: Envelope<unknown>): string` — sha256 of `canonicalize(env)` **including** `sig` ("as signed", spec §4.2).
- `validateMandate(data): asserts Mandate`, `validateReceipt(data): asserts Receipt`, `validatePaymentReceipt(data): asserts PaymentReceipt` — throw `SchemaError` with ajv error path.
- [ ] Tests first: `canonical.test.ts` (key order, unicode, numbers per RFC 8785 vectors); `envelope.test.ts` (sign→verify true; flip one byte of `data` → false; `envelopeHash` changes when `sig` changes); `schemas.test.ts` (all three `docs/schemas/examples/*.json` pass; `hours` key rejected on mandate and profile; `kind:"delivered"` without `result` rejected; base `receipt.v1` rejects `payment`).
- [ ] Run `npm test` → red, implement, → green. Commit: `Add protocol: canonical JSON, Ed25519 envelopes, schema validators`.

### Task 2: anchor — HCS topic, anchor records, mirror reads
**Files:** Create `anchor/records.ts`, `anchor/topic.ts`, `anchor/client.ts`, `tests/anchor/*.test.ts`. Scripts: `anchor:create-topic`.
**Interfaces (produces):**
- `type AnchorRecord = { v: "wr-anchor.v1"; kind: "mandate_in"|"accepted"|"delivered"|"payment_intake"|"payment_balance"|"receipt"; mandate_id: string; hash: string /*sha256 hex of the thing anchored*/; ref?: string /*tx id in mirror form for payment_* kinds*/; at: string /*ISO*/ }`.
- `createTopic(client, memo: string): Promise<string /*0.0.X*/>`.
- `submitAnchor(client, topicId, rec: AnchorRecord): Promise<{ seq: number; consensus_ts: string }>` — waits for receipt; message body = `canonicalize(rec)`.
- `readAnchors(topicId, opts?: { since?: string }): Promise<Array<AnchorRecord & { seq: number; consensus_ts: string }>>` — mirror REST `/topics/{id}/messages` with pagination; retries up to 30 s for lag.
- `toMirrorTxId("0.0.7162784@1788539653.433840739") === "0.0.7162784-1788539653-433840739"` and back.
- [ ] Unit tests: record canonical bytes are stable; id conversion both ways; `readAnchors` parses a recorded mirror fixture (`tests/anchor/fixtures/topic-messages.json`). Integration test (skipped without `.env`): create topic, submit two records, read both back within 30 s with ascending `seq`.
- [ ] Commit: `Add anchor: HCS topic, wr-anchor.v1 records, mirror reads`.

### Task 3: contractor — x402-gated mandate intake and receipt release
**Files:** Create `contractor/server.ts`, `contractor/store.ts`, `contractor/work.ts`, `contractor/receipts.ts`, `tests/contractor/*.test.ts`. Reuse `spike/server.ts` wiring (facilitator sync gives `extra.feePayer`; never hardcode it). Script `contractor:start`.
**Behaviour:**
- `POST /mandates` — x402 price `INTAKE_TINYBARS` (default 1 000 000). Body = `Envelope<Mandate>`. Steps: verify envelope signature → validate `mandate.v1` → anchor `mandate_in` (hash = `envelopeHash`) → anchor `payment_intake` (ref = settled tx id from the x402 middleware response) → build and sign `receipt.v1 {kind:"accepted", mandate_envelope_hash, mandate_anchor:{topic,seq,consensus_ts}, taken: mandate.acceptance}` → anchor `accepted` → persist job → `201 {receipt: Envelope<Receipt>}`.
- `POST /mandates/{id}/deliver` — local only (header `X-Contractor-Token` from `.env`); body `{pr_url, staging_url, notion_status}` or empty → `work.ts` generates deterministic synthetic links; anchors `delivered`.
- `GET /mandates/{id}/receipt` — `409` until delivered; x402 price `BALANCE_TINYBARS` (default 4 000 000); on settle: anchor `payment_balance`, build `receipt.v1 kind:"delivered"` + `payment` (profile), sign, anchor `receipt`, `200 {receipt}`.
- Idempotent: repeated paid call returns the stored receipt without new anchors.
- [ ] Tests: unit for `receipts.ts` (built receipts validate against `receipt.v1` and the profile; `envelopeHash` linkage) and `store.ts` (round-trip). Integration (skipped without `.env`): run server on a free port with the spike payer → full intake → deliver → collect; assert both settled tx ids exist on the mirror node and 6 anchors appear in order.
- [ ] Commit: `Add contractor service: paid mandate intake, delivery, paid receipt release`.

### Task 4: customer — CLI agent that orders, pays and collects
**Files:** Create `customer/cli.ts`, `customer/pay.ts`, `customer/wallet.ts`, `demo/fixtures/story-history-grouping.json` (synthetic), `tests/customer/*.test.ts`. Script `customer -- <cmd>`.
- `customer order --story demo/fixtures/story-history-grouping.json --to http://localhost:4021` → builds `mandate.v1` from the fixture, signs (customer Ed25519 key from `.env`), pays intake with `@x402/fetch` (spend controls: HBAR opt-in, cap from `.env`), saves `out/<mandate_id>/mandate.json`, `accepted.json`, prints tx id + HashScan.
- `customer collect <mandate_id> --to …` → pays balance, saves `receipt.json` (profile), prints both tx ids + HashScan links.
- [ ] Tests: mandate built from fixture validates; `out/` files validate; unit for spend-control config. Integration (skipped without `.env`) exercised by Task 6.
- [ ] Commit: `Add customer agent CLI: order and collect with x402 payments`.

### Task 5: verifier — public, trustless reconstruction
**Files:** Create `verifier/cli.ts`, `verifier/checks.ts`, `verifier/mirror.ts`, `verifier/statement.ts`, `tests/verifier/*.test.ts` with fixtures `golden/` (real run from Task 6) and `tampered/` (edited receipt hash; swapped tx id; missing anchor; wrong payee).
- `verify --topic 0.0.X --receipt out/<id>/receipt.json [--mandate out/<id>/mandate.json]` → checks, each a pure function over `(receipt, anchors, txs)` returning `{name, ok, detail}`:
  1. receipt envelope signature valid; 2. `mandate_envelope_hash` equals anchor `mandate_in.hash` and (if mandate given) equals `envelopeHash(mandate)`; 3. anchors `mandate_in → payment_intake → accepted → delivered → payment_balance → receipt` exist for `mandate_id` in ascending consensus order; 4. `payment.intake.transaction_id` and `.balance.transaction_id` exist on the mirror node with `result: SUCCESS`, payer debited exactly `tinybars`, payee credited exactly `tinybars`, fee payer ≠ payer; 5. anchor `receipt.hash` equals `envelopeHash(receipt)`.
  Output: table of checks, then the statement (proves / does not prove) from `statement.ts`, exit 0 iff all ok, exit 1 otherwise, exit 2 on network errors.
- [ ] Tests: golden fixture → all ok; each tampered fixture → exactly the intended check fails and the exit code is 1. Commit: `Add verifier: trustless reconstruction from mirror node`.

### Task 6: end-to-end demo, README, disclosure
**Files:** Create `demo/run-e2e.ts` (starts contractor, runs customer order → deliver → collect → verifier, prints all HashScan links, writes `demo/last-run.json`), `docs/diagrams/flow.mmd`; Modify `README.md` (Setup · Architecture · Payment flow · What it proves · HashScan links table · **AI collaboration** section listing which files were produced with Claude Code and pointing to `docs/specs`, `docs/plans`, `spike/` as spec/prompt artifacts · **Prior art** paragraph: authors previously built a closed HCS anchor for agent messaging, not included; all code here written inside the window · Roadmap / take-to-market).
- [ ] `npm run demo` succeeds on testnet twice in a row; verifier PASS; capture `tests/verifier/golden/` from this run. Commit: `Add end-to-end demo and README`.

### Task 7 (extras, only after Task 6 is green): identity, retainer, custom fee, MCP, hosting
- HCS-14 style `uaid` for both agents in `Envelope.from/to` + resolution in verifier (extra c).
- Scheduled Transaction retainer script `retainer/schedule.ts` + anchor kind `retainer` (extra g).
- HIP-991 custom fee on the anchor topic (extra e) — only if `submitAnchor` still works through the fee.
- `mcp/server.ts` exposing `order`/`collect`/`verify` as MCP tools (Bazantic).
- Hosted contractor on Zeabur + uptime watcher through 16.09.
Each as its own lane and commit; skip any that is not green by 10.09 23:00 EDT.

### Task 8 (separate repo): Hedera Harness PR — deterministic mirror-node check for CHAIN
Fork `hedera-dev/hedera-harness`, branch from `dev`; add `verify-mirror` step + tests + before/after in PR description. Only if Tasks 1–6 are merged by 10.09.

### Task 9: submission
Dashboard: create project (name, category, emoji), team = solo, check-ins 07.09 and 10.09 23:59 EDT; run `hedera-skills validate-submission` against the repo; video 2–4 min (first 20 s = verifier catching a tampered receipt, then the paid flow with HashScan); submit by 12.09 evening; deadline 13.09 12:00 EDT; freeze after.

## Schedule (EDT)
| Day | Lanes | Gate |
|---|---|---|
| Fri 04.09 | Task 1 (canary) → Task 2 | both green, merged to main |
| Sat 05.09 | Task 3, Task 4 | integration on testnet passes |
| Sun 06.09 | Task 5 | tampered fixtures fail correctly |
| Mon 07.09 | Task 6 + **check-in #1 23:59** | `npm run demo` twice green |
| Tue–Wed 08–09.09 | Task 7 extras, hosting + watcher | each extra independently green |
| Thu 10.09 | **check-in #2 23:59**; Task 8 if capacity; `validate-submission` | sponsor checklist reviewed line by line |
| Fri 11.09 | README/video script, red-team the verifier | |
| Sat 12.09 | video, **submit** | |
| Sun 13.09 | buffer to 12:00; then freeze | |

## Self-review
Spec coverage: components 1–7 of the design map to Tasks 1–7; error handling (facilitator verify fail, anchor retry, mirror lag, tamper detection) lands in Tasks 3 and 5; testing section in Tasks 1–6. Types named here (`Envelope`, `AnchorRecord`, `toMirrorTxId`, `envelopeHash`) are the ones later tasks consume. Open: exact HIP-991 fee interaction with `submitAnchor` is unverified (Task 7 gate).
