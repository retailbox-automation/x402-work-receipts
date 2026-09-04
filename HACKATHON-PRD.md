# x402-work-receipts — Hackathon PRD

**Event:** ETHOnline 2026 · **Primary prize:** Hedera — *AI & Agentic Payments on Hedera*
**Repository:** `github.com/retailbox-automation/x402-work-receipts` (public) · **Team:** solo
**Hacking window:** opened 2026-09-04 12:00 EDT · check-ins 09-07 and 09-10 23:59 EDT · submission deadline 2026-09-13 12:00 EDT
**This document written:** 2026-09-04 (day 1)

> **Status legend used throughout this document.** This PRD distinguishes three states and never blurs them.
> **[SHIPPED]** — in the repository today and demonstrable. **[PLANNED · Task N]** — specified in
> `docs/plans/2026-09-04-implementation-plan.md`, not built yet. **[PROJECTION]** — an arithmetic model with
> its assumptions stated, not an observed measurement.
>
> Shipped on day 1: the design (`docs/specs/`), the implementation plan (`docs/plans/`), the canonical
> schemas and synthetic examples (`docs/schemas/`), and a spike that settled **three real HBAR payments** on
> Hedera testnet through the Blocky402 facilitator (`spike/`). Everything else in this document is planned or
> projected and is labelled as such.

---

## 1. Problem Statement

> What problem are you solving? Why does it matter?

Two organizations each run AI agents. The customer organization's agent wants the contractor organization's
agent to do **a unit of work** — a backlog story, a research brief, a data-labelling batch, a translation —
and wants to pay for it **without a human, a card or an API key**. Later, somebody has to be able to prove
what was ordered, what was paid, and what was delivered — including an auditor who trusts neither company's
servers.

Nothing today closes that loop. Agent-to-agent messaging protocols move **messages**, not money. x402 moves
money for **one HTTP response**, which is exactly the right primitive for an API call and exactly the wrong
shape for a unit of work: a story is ordered on Monday, accepted on Monday, delivered on Wednesday, and
settles in **stages**. Marketplaces do handle staged work, but the truth lives in the marketplace's own
database — the record is only as good as the company holding it, and it is not checkable by a third party.

So the practical failure mode is mundane and expensive: at the end of the month there is an invoice, a
delivery claim, and one party's private log. Disagreement is resolved by seniority, not by evidence.

**Target Users**

| Segment | Who exactly | The pain they feel |
|---|---|---|
| Delivery agencies (contractor side, "Agency X") | Software, data, design and research agencies running agent-assisted delivery for several clients | Cannot bill per unit of work at machine speed; must reconcile "what did we actually deliver" by hand at invoice time |
| Client companies (customer side, "Client Y") | Companies with a backlog and an agent or PM system that manages it | Cannot dispatch and pay for a story without a human authorizing a card or a monthly invoice; must trust the vendor's delivery log |
| Auditors and finance | The people who sign off the invoice on either side | Have no independent record; reconciliation is a conversation, not a check |
| Agent platform builders | Teams building Agent2Agent (A2A) / Model Context Protocol (MCP) agent networks | Have transport for messages, no settlement or receipt layer underneath it |

**Current Solutions** — and why each is insufficient

| Today | Why it does not solve this |
|---|---|
| Freelance / vendor marketplaces with escrow | Human in the loop, onboarding and KYC, platform fee, weekly cycles. Decisive flaw: the record of order and delivery is the platform's private database — a third party cannot verify it without the platform's cooperation. |
| Invoices + bank transfer / card | Not machine-payable. A card needs a human authorization and an account relationship that must exist before the first transaction. Reconciliation between the invoice line and the actual work is manual. |
| API keys + monthly billing | Requires a pre-existing commercial relationship and credentials handed over out of band. Prices access, not units of work, and produces no counter-signed record of what was ordered. |
| x402 as it is used today | Correct and elegant for a single request → pay → response cycle. It has no notion of an order that is accepted now, worked on for two days, and settled in two legs — and no notion of a receipt anyone can verify afterwards. |
| A2A / agent messaging protocols | Move signed messages between agents. They deliberately carry no money fields; there is no settlement and no shared audit record. |
| A company's own append-only audit log | It is *one party's* log. The counterparty has no reason to trust it, which is precisely the situation being fixed. |

**Why Web3?**

Three properties are required at once, and only a public ledger supplies all three:

1. **A record neither side can forge, backdate or delete.** The claim being protected is "this exact order
   existed at this time and this exact receipt answers it". A Hedera Consensus Service topic provides
   ordering and a consensus timestamp that neither counterparty controls. A Web2 equivalent means "trust my
   database", which is the failure being removed.
2. **A record a *third* party can check without either party's cooperation.** The verifier in this project is
   designed to read only the public mirror node **[PLANNED · Task 5]**. That is a structural property, not a
   policy: there will be no endpoint of ours it could call even if it wanted to.
3. **Payment a machine can complete unattended, with no account, card or API key.** x402 on Hedera settles a
   direct, *partially signed* `TransferTransaction`: the paying agent signs first, and the facilitator
   completes it with its own `feePayer` signature before submitting — so the paying agent never holds gas or
   reasons about network fees. That was proven on day 1 (§ "Evidence" below).

What is deliberately *not* claimed: the chain does not prove the content of the order, the quality of the
work, or that a key belongs to a particular human. That boundary is written into `docs/schemas/README.md`
today, and the verifier is specified to print it on every run **[PLANNED · Task 5]**. Overclaiming here would
be the easiest way to lose the trust the project is built to create.

**Evidence that the payment leg is real, day 1** — three settled testnet payments, not a mock:

> HashScan: <https://hashscan.io/testnet/transaction/0.0.7162784@1788539653.433840739>
> Transaction `0.0.7162784@1788539653.433840739` · consensus `1788539659.779738844` (2026-09-04 16:34:19 UTC)
> · result `SUCCESS` · payer `0.0.10365982` −1 000 000 tinybars · receiver `0.0.10365984` +1 000 000 tinybars
> · facilitator `0.0.7162784` paid the 261 078 tinybar network fee. Full write-up and every gotcha:
> [`spike/README.md`](https://github.com/retailbox-automation/x402-work-receipts/blob/main/spike/README.md).
> The design and the plan behind this document are equally public:
> [`docs/specs/`](https://github.com/retailbox-automation/x402-work-receipts/blob/main/docs/specs/2026-09-04-work-order-receipts-design.md)
> · [`docs/plans/`](https://github.com/retailbox-automation/x402-work-receipts/blob/main/docs/plans/2026-09-04-implementation-plan.md)
> · [`docs/schemas/`](https://github.com/retailbox-automation/x402-work-receipts/tree/main/docs/schemas).

---

## 2. Solution Overview

> **Read this section as the target design, not as a status report.** Of what follows, only the schemas are
> in the repository today; the contractor service, the customer agent, the anchoring and the verifier are
> **[PLANNED · Tasks 1–5]**. The per-feature build status is in the *Hackathon Track Alignment* table and the
> *Key Features (MVP)* list that follow. The payment mechanism itself is the one part already proven end to
> end (§1, "Evidence").

**x402-work-receipts** turns a unit of work into a signed, priced, publicly verifiable transaction between
two organizations' agents. Client Y's agent signs a **work order** (`mandate.v1`: story reference, title,
acceptance criteria verbatim, a scope `frame` — project, epic, target branch, staging environment, in words —
and a due date) and posts it to Agency X's contractor service. That route is
x402-gated: the price is the **intake fee**. When the payment settles through the Blocky402 facilitator on
Hedera testnet, the contractor returns a signed **receipt** (`receipt.v1`, `kind: accepted`) that names which
acceptance criteria it takes on. The contractor then does the work. When the deliverable exists, the customer
agent calls the receipt route; that route is x402-gated too, and its price is the **balance**. Paying it
releases the signed `receipt.v1` with `kind: delivered`, the result links, and — once the balance leg has
settled — a `payment` object naming both transaction ids. (In the schema only the `intake` leg is required,
so a receipt issued before the balance settles is still a valid document; the delivered receipt this product
hands over carries both.)

Underneath, every step is anchored on a Hedera Consensus Service topic as a small record containing **only a
hash and public identifiers** — never the content of the work. Six anchors per order: `mandate_in`,
`payment_intake`, `accepted`, `delivered`, `payment_balance`, `receipt`. Finally, a stand-alone **verifier
CLI** takes a topic id and a receipt file and reconstructs `ordered → paid → delivered` **from the public
mirror node alone**: every envelope hash matches its anchor, both transfers exist with the right payer, payee
and amount, and the consensus order is coherent. It exits non-zero on any mismatch and prints, on every run,
what the chain proves and what it does not. It never calls the contractor or the customer — it cannot, by
construction.

**Hackathon Track Alignment — Hedera "AI & Agentic Payments on Hedera"**

| Qualification requirement | How it is met | Status |
|---|---|---|
| A live x402-gated service on Hedera testnet, settled through Blocky402 | Contractor service with two x402-gated routes (`POST /mandates`, `GET /mandates/{id}/receipt`), `hedera:testnet`, facilitator `https://api.testnet.blocky402.com`. The payment path itself is already proven end to end by the spike against the same facilitator. The design is deliberately facilitator-agnostic, but **the submitted demo run settles through Blocky402**, as the prize requires — no other facilitator is substituted for the qualifying run. | Payment path **[SHIPPED]** (`spike/`); the two work-order routes **[PLANNED · Task 3]**; public hosting **[PLANNED · Task 7]** |
| An agent completes at least one real paid request | The customer agent CLI pays both legs with `@x402/fetch` and stores the receipts; the day-1 spike client already completed three real paid requests. | Spike client **[SHIPPED]**; customer agent **[PLANNED · Task 4]** |
| Public repo README with setup, architecture and payment flow | README rewrite covering setup, architecture, payment flow, the proves/does-not-prove statement, a HashScan link table, an AI-collaboration disclosure and prior-art note. | **[PLANNED · Task 6]** |
| Demo video ≤ 5 minutes | 2–4 minute recording; first 20 seconds are the verifier catching a **tampered** receipt, then the full paid flow with HashScan links. | **[PLANNED · Task 9]** |
| Extra — A2A between two agents | Customer agent and contractor agent are separate processes, with separate signing keys and separate Hedera accounts, exchanging signed envelopes over HTTP. **Scope note:** this is agent-to-agent in the literal sense; conformance with the *Agent2Agent (A2A) protocol specification* — its agent cards, its JSON-RPC methods — is **not** claimed, and the envelope format here comes from the RetailBox A2A Bridge specification instead. | **[PLANNED · Tasks 3–4]** |
| Extra — on-chain agent identity | An HCS-14 style universal agent identifier for both agents, carried in the envelope `from` / `to` and resolved by the verifier. **Caveat:** "HCS-14" is a community HCS standard, not a Hedera HIP — it does not appear anywhere in docs.hedera.com (checked 2026-09-04). Conformance against the published standard text is unverified and is itself a Task 7 gate; if it does not hold up, this ships as a plainly documented key-derived agent identifier rather than under a standard's name. | **[PLANNED · Task 7]** |
| Extra — verifiable payment audit trails on HCS | Six anchor records per order on an HCS topic, plus the verifier that reconstructs the chain from them. | **[PLANNED · Tasks 2 and 5]** |
| Extra — Scheduled Transactions | A monthly retainer from Client Y to Agency X created as a Scheduled Transaction and referenced from the audit topic. | **[PLANNED · Task 7]** |

**Secondary targets.** Hedera *"Improve the Harness"* — a separate PR to `hedera-dev/hedera-harness` adding a
deterministic mirror-node verification step, **[PLANNED · Task 8, only if Tasks 1–6 are merged by 09-10]**.
Bazantic *"x402 gateway + MCP for an API"* — exposing `order` / `collect` / `verify` as MCP tools over the
same x402-gated service, **[PLANNED · Task 7]**.

### Key Features (MVP)

1. **The work-order protocol — `mandate.v1` / `receipt.v1` + the `payment.v1` profile.** *[SHIPPED as
   schemas; envelope code PLANNED · Task 1]* Canonical JSON (RFC 8785) with Ed25519 signatures over the
   envelope; the hash "as signed" is the identity of the document. **Why for MVP:** everything else is
   downstream of it. If the document is not canonical and signed, no anchor and no receipt mean anything.
   The base schemas deliberately carry **no money fields** — payment is a *profile* added via a separate
   schema, so the same order and receipt stay valid between parties who settle off-chain or not at all. That
   separation is what lets the protocol be adopted without adopting our payment choices.
2. **Contractor agent with two x402-gated routes.** *[PLANNED · Task 3]* `POST /mandates` priced at the
   intake fee (default 1 000 000 tinybars); `GET /mandates/{id}/receipt` priced at the balance (default
   4 000 000 tinybars), `409` until the deliverable exists, idempotent once paid. **Why for MVP:** this is the
   whole thesis — **the receipt is released *by* a payment**, not emailed beside one.
3. **Customer agent CLI.** *[PLANNED · Task 4]* `customer order` builds and signs the mandate, pays the
   intake with `@x402/fetch` under explicit spend controls, and stores the accepted receipt; `customer
   collect` pays the balance and stores the delivered receipt. **Why for MVP:** it is the *agent completes a
   real paid request* requirement, and it is the half of A2A a demo can show.
4. **HCS audit anchor.** *[PLANNED · Task 2]* Six `wr-anchor.v1` records per order, hashes and public ids
   only. **Why for MVP:** without the public anchor the receipt is just a file the contractor produced.
5. **Verifier CLI.** *[PLANNED · Task 5]* Mirror node only, one pure function per check, a table of checks,
   the proves/does-not-prove statement, exit 0 / 1 / 2. **Why for MVP:** it is the demo's opening shot and the
   only component that makes the claim *falsifiable*. A receipt system whose failure mode nobody has seen is
   not credible; the tamper cases are the product.

### Non-Goals (v1)

- **Escrow and arbitration.** No funds are held. Disputes are made *evidenceable*, not adjudicated.
- **Mainnet.** Testnet only for the hackathon; mainnet is a configuration change plus a facilitator swap, not
  a redesign — Blocky402 advertises `hedera:mainnet` at `https://api.blocky402.com` with fee payer
  `0.0.10571514` ([Hedera docs, *x402 Facilitators*](https://docs.hedera.com/solutions/ai/x402/facilitators)).
  Untested by us: no mainnet payment has been made.
- **USDC and Hedera Token Service (HTS) token payments.** HBAR only. HTS adds token association as a separate failure surface
  (`TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`) with no benefit to the thesis. The schema already permits an HTS token
  id in `payment.asset`, so this is deferred, not designed out.
- **A UI beyond a minimal status page.** The users here are agents; the human surfaces are the CLI output,
  the HashScan links and the verifier table.
- **Storing work content on-chain.** Only fingerprints. Anything else would leak both companies' business.
- **Replacing the customer's tracker or the contractor's pipeline.** The mandate references a story that
  lives in the customer's tracker and the receipt references a PR and a staging URL that live in the
  contractor's systems. This is a settlement and evidence layer, not a workflow tool.
- **Identity beyond keys.** The planned agent identifier (with the HCS-14 caveat noted in the track table
  above) binds an agent to a key, not to a legal person. No KYC.

---

## 3. Hedera Integration Architecture

> How does your solution leverage the Hedera network?

### Network Services Used

| Service | Purpose | Status | Why this service? |
|---|---|---|---|
| **x402 `exact` scheme on Hedera + facilitator** (`@x402/core`, `@x402/hedera`, `@x402/express`, `@x402/fetch` 2.24.0, Blocky402 testnet `https://api.testnet.blocky402.com`) | Both payment legs: the intake fee on order acceptance and the balance on receipt release | Single-leg payment path **[SHIPPED]** (`spike/`); the two work-order legs **[PLANNED · Tasks 3–4]** | Hedera's `exact` scheme settles a **direct, partially signed `TransferTransaction`** — the client signs, the facilitator completes it as `feePayer` and submits — with **no `ScheduleCreate` wrapping**, no gas reasoning on the agent side and sub-cent predictable fees ([Hedera docs, *exact scheme*](https://docs.hedera.com/solutions/ai/x402/exact-scheme)). Proven on day 1: the payer moved exactly the resource price and the facilitator carried the 261 078 tinybar network fee. That fee-payer model is what makes an *unattended* agent payment sane. |
| **Hedera Consensus Service (HCS)** | The joint audit register: six `wr-anchor.v1` records per work order (`mandate_in`, `payment_intake`, `accepted`, `delivered`, `payment_balance`, `receipt`), each a canonicalized JSON body carrying a sha-256 hash, the mandate id and — for payment kinds — the transaction id | **[PLANNED · Task 2]** | Ordering and a consensus timestamp from a network *neither counterparty controls*, at $0.0008 per message, with a 1 024-byte per-message ceiling that comfortably fits a hash-only record. This is the property a private append-only log cannot buy at any price. |
| **Mirror Node REST API** (`https://testnet.mirrornode.hedera.com/api/v1/*`) | The verifier's **only** data source: `/topics/{id}/messages` for anchors, `/transactions/{id}` for the transfer lists | Used ad hoc by the spike client **[SHIPPED]**; the verifier **[PLANNED · Task 5]** | Makes third-party verification structural rather than promised. The verifier has no credentials and no route to either company's servers. |
| **Hedera accounts (ECDSA)** | One account per participating agent — payer and payee of both legs | Two agent accounts **[SHIPPED]** (`spike/create-accounts.ts`) | Agents get plain `0.0.x` accounts created with `setKeyWithoutAlias`; both spike accounts are confirmed `ECDSA_SECP256K1` on the mirror node. Two caveats, stated as what they are — *observations from our spike, not documented guarantees*: the `@x402/hedera` client path we used assumed an ECDSA payer key, and Blocky402 rejected an alias as `payTo`. Hedera documents alias handling as a **per-facilitator policy** whose reference implementation defaults to reject ([*How x402 works*](https://docs.hedera.com/solutions/ai/x402/how-it-works)), and recommends ECDSA for new accounts generally rather than for this scheme specifically. |
| **Scheduled Transactions** *(extra)* | A monthly retainer transfer from Client Y to Agency X, created ahead of time and referenced from the audit topic under a `retainer` anchor kind | **[PLANNED · Task 7]** | Long-term scheduled transactions (HIP-423) let a recurring commitment be **visible and countersigned in advance**, executing up to about two months out and optionally waiting for expiry, instead of living in a billing cron job on one party's server. A retainer both parties can see queued on a public ledger is a different commercial object from an invoice. |
| **HIP-991 topic custom fees** *(extra, gated)* | An optional submission fee on the anchor topic, so a shared audit register can fund its own operation | **[PLANNED · Task 7, gated]** | Turns the audit topic from a cost centre into a service a neutral operator could run for many pairs of companies. Gated: adopted only if `submitAnchor` still succeeds through the fee, and the economics are honest — a custom-fee topic costs $2.00 to create and $0.05 per message versus $0.01 and $0.0008, so it is a v2 decision, not a demo trick. Note the fee schedule key must be set **at topic creation**; it cannot be added later. |

**Deliberately not used, with reasons.** *Smart contracts and the Hedera Token Service (HTS)* — the money
movement is a plain transfer and the evidence is a hash; a contract would add EVM surface, gas reasoning and
an upgrade problem without changing what is proven. *Hedera File Service (HFS)* — the documents belong to the
two companies; putting them on-chain would leak both parties' business, and the fingerprint is sufficient for
the claim being made. *Wallet connect platforms (HashPack, Kabila)* — deliberately absent, and the absence is
the point: both agents hold keys programmatically and there is no human in the payment loop to approve
anything. A wallet UI would reintroduce exactly the human step this product removes. Naming these is part of
the design: the project uses Hedera where Hedera is load-bearing and nowhere else.

### Ecosystem Integrations

| Partner / Platform | Integration type | Value added |
|---|---|---|
| **Blocky402** | The x402 facilitator for both legs — `GET /supported`, `POST /verify`, `POST /settle`; the resource server copies `extra.feePayer` out of `/supported` at startup and never hardcodes it | Removes the need to operate a facilitator, and demonstrates a live Hedera-supporting facilitator working outside its own examples. Testnet fee payer `0.0.7162784`; the same code path reaches mainnet by swapping the base URL. |
| **HashScan** | Every settlement is linked from the receipt, the README table and the demo video | A judge, an auditor or a client can confirm a payment in one click without running anything. |
| **Public mirror node** | The verifier's sole source of truth; also used by the spike client to re-check its own settlement | Third-party verifiability with no privileged access. |
| **Hiero SDK (`@hiero-ledger/sdk` 2.85.0, pinned)** | Topic creation, message submission, account creation | Pinned deliberately: `@x402/hedera` depends on 2.85.0 and a standalone install pulls 2.87.0, producing two on-disk copies and a runtime failure inside the SDK's brand checks. |
| **x402 `exact`-Hedera reference implementation** | Used as published, not forked | Any facilitator advertising `hedera:testnet` — including the official `https://x402.org/facilitator`, which Hedera's own [facilitators page](https://docs.hedera.com/solutions/ai/x402/facilitators) lists as Hedera-testnet capable — can settle these payments. The qualifying demo still settles through Blocky402. |
| **`hedera-dev/hedera-harness`** *(secondary prize)* | **[PLANNED · Task 8]** A separate PR adding a deterministic mirror-node verification step, opened only after Tasks 1–6 are merged | Would contribute the project's most reusable idea back to the ecosystem's own tooling. |
| **MCP** *(Bazantic prize)* | **[PLANNED · Task 7]** `order` / `collect` / `verify` exposed as MCP tools over the same x402-gated service | Would let any MCP-capable agent — not only this repository's CLI — order and pay for work. |

### Architecture Diagram

The flow below is the target design **[PLANNED · Tasks 1–5]**. Only step 2's payment mechanism — a single
x402-gated route settling through Blocky402 — has actually been executed, in the spike.

```
  CLIENT Y (customer org)                AGENCY X (contractor org)              HEDERA
  ─────────────────────                  ─────────────────────────              ──────
  customer agent                         contractor service
  ├ wallet.ts  (Ed25519 doc key,         ├ Express + @x402/express
  │             ECDSA Hedera key)        ├ store.ts   (job state)
  ├ pay.ts     (@x402/fetch,             ├ work.ts    (deliverable)
  │             spend controls)          └ receipts.ts(sign receipt)
  └ cli.ts     (order | collect)

  1. sign mandate.v1 ──── POST /mandates ────────▶  402  price = intake fee
  2. pay ──── POST /mandates + PAYMENT-SIGNATURE ▶  verify + settle ──▶ Blocky402 ──▶ CryptoTransfer
                                                    anchor mandate_in ─────────────▶ HCS topic  seq 1
                                                    anchor payment_intake ─────────▶ HCS topic  seq 2
  3.        ◀──── 201 receipt.v1 {accepted} ─────   anchor accepted ──────────────▶ HCS topic  seq 3

                        · · · the work happens (hours or days) · · ·

  4.                     POST /mandates/{id}/deliver (contractor-local, token-gated)
                                                    anchor delivered ─────────────▶ HCS topic  seq 4
  5. GET /mandates/{id}/receipt ─────────────────▶  402  price = balance
  6. pay ──── GET + PAYMENT-SIGNATURE ───────────▶  settle ──────────▶ Blocky402 ──▶ CryptoTransfer
                                                    anchor payment_balance ───────▶ HCS topic  seq 5
  7.  ◀── 200 receipt.v1 {delivered} + payment ──   anchor receipt ───────────────▶ HCS topic  seq 6

  ANYONE, with no access to either company:
     verify --topic 0.0.X --receipt receipt.json
        └─▶ mirror node REST only ─▶ 5 checks ─▶ PASS / FAIL(reason) ─▶ exit 0 / 1 / 2
```

**The five verifier checks** *[PLANNED · Task 5]*, each a pure function of `(receipt, anchors, txs)`:
(1) the receipt envelope signature verifies; (2) `mandate_envelope_hash` equals the `mandate_in` anchor hash
and, if the mandate is supplied, equals its recomputed envelope hash; (3) all six anchors exist for this
mandate id in ascending consensus order; (4) both `transaction_id`s exist on the mirror node with result
`SUCCESS`, the payer debited exactly `tinybars`, the payee credited exactly `tinybars`, and the fee payer is
not the payer — the facilitator carried the network fee; (5) the `receipt` anchor hash equals the recomputed
receipt envelope hash.

---

## 4. Hedera Network Impact

> How does your solution grow the Hedera ecosystem?

All figures in this section are **[PROJECTION]** — an arithmetic model built from the design's transaction
count, with assumptions stated. None of them is an observed measurement, and none should be read as traction.

### The unit: what one completed work order costs the network

The transaction **count** is counted from the design in §3, not estimated. The **prices** are Hedera's
published per-operation fees ([docs.hedera.com/networks/fees](https://docs.hedera.com/networks/fees)):

| Operation | Count per order | Published fee | Subtotal |
|---|---|---|---|
| `CryptoTransfer` (intake, balance) | 2 | $0.0001 | $0.0002 |
| `ConsensusSubmitMessage` (six anchors) | 6 | $0.0008 | $0.0048 |
| **Total per completed work order** | **8 transactions** | | **≈ $0.005** |

One-time, per relationship: `ConsensusCreateTopic` $0.01. One-time, per participating organization:
`CryptoCreate` $0.05 for the agent's account. Optional retainer, per period: `ScheduleCreate` $0.01 +
`ScheduleSign` $0.001 + the executed `CryptoTransfer` $0.0001.

*Precision note, so the number is not overstated in our favour:* Hedera describes that fee table as a
**low-end estimate** under a `base fee + extras` model (HIP-1261), where extras are charged for things such
as signatures beyond the first. Every transfer here carries two signatures — the paying agent's and the
facilitator's — so the true per-order cost sits marginally above $0.005. The order of magnitude is what the
argument rests on, and it is right.

The important structural number is **8 on-chain transactions per unit of work, six of which are HCS
messages**. This is an HCS-heavy workload, not a transfer-heavy one — the audit trail generates three times
as many transactions as the payments do.

### Account Creation

Every organization that joins needs at least one Hedera account per agent (ECDSA, plain `0.0.x`), and
realistically two — one for the delivering agent and one for the paying agent — plus one topic per
relationship. Account creation is a *precondition* of using the product at all, which is the useful property:
there is no free tier that avoids the ledger.

**[PROJECTION]** — *assumption:* one agency onboards `A` client companies; each side runs one agent account.
Accounts created = `2A`, topics created = `A`. For a single agency with 10 clients: 20 accounts, 10 topics.
The growth is linear in relationships, and each relationship is a commercial one, so the accounts created are
economically active rather than dormant airdrop wallets.

### Active Accounts

An account here is active whenever a story moves — so **monthly active accounts (MAA)** is simply the number
of agent accounts whose relationships shipped anything that month. **[PROJECTION]** — *assumption:* a
delivery agency ships 20 stories per week per client team, which is an ordinary sprint cadence for a small
team; both accounts in the pair transact on each story; a month is counted as four working weeks. One agency
serving 10 clients would put **20 accounts into monthly activity (MAA = 20)** and roughly
`20 stories × 10 clients × 4 weeks = 800` work orders through the ledger per month — 80 per relationship.
The point is not the absolute size — it is that **activity is proportional to real delivered work**, so it
does not decay when an incentive programme ends.

### Transactions Per Second (TPS)

**[PROJECTION]** — at 800 orders per month, one agency generates `800 × 8 = 6 400` transactions per month.
Spread over a 30-day calendar month that is **≈ 213 transactions per day** and **≈ 0.0025 sustained TPS** per
agency. Stating it rather than hiding it: that is a small number, this workload is bursty and low-rate per relationship, and it will not
move network TPS on its own. Its value to Hedera is different and worth stating plainly rather than
inflating:

- It is **recurring and non-speculative** — the traffic exists because work was delivered, not because a
  token was being farmed. It survives market conditions.
- It is **multiplicative in relationships, not in users** — every new agency↔client pair adds its own topic
  and its own steady stream, so the curve is `pairs × cadence`, not a one-off spike.
- It is **HCS-weighted**, which exercises exactly the service Hedera is differentiated on, at a message size
  (well under the 1 024-byte limit) that scales cheaply.

### Audience Exposure

The audience this reaches is **service businesses and their finance functions** — delivery agencies, their
client companies, the people who approve invoices — plus builders of A2A and MCP agent networks who need a
settlement and receipt layer under their transport. This is deliberately a **non-crypto-native** audience:
the paying agent never touches gas, never manages a wallet UI, and never sees the word "blockchain" in the
CLI output — it sees a receipt and a link. Hedera arrives as the thing that makes the receipt trustworthy,
which is the most durable way for infrastructure to be adopted.

Sizing the market with a cited figure is deliberately **not** done here: we have not researched a defensible
one, and inventing a TAM number would be exactly the kind of unsupported metric this document refuses to
produce. §9 gives a bottom-up unit model instead.

---

## 5. Innovation & Differentiation

### Ecosystem Gap

Hedera has an official x402 `exact` scheme, a live facilitator ecosystem and excellent per-request payment
examples. What we have not found in the Hedera ecosystem is the layer above: **a multi-stage,
staged-settlement work order with a counter-signed receipt whose provenance a stranger can verify from public
data.** x402 today answers "pay me for this response". This project answers "pay me for this *job*, and here
is a receipt that survives our relationship".

*Scope of that claim, stated honestly:* it is based on Hedera's own x402 documentation and facilitator pages
and on the ecosystem material we read while building the spike. A systematic prior-art sweep across other
ecosystems is **not** something we have run, and it is listed as a validation action in §8 rather than
asserted here. If a judge knows of an existing implementation, that is a useful answer and not a defeat —
the composition, not the parts, is what we claim is new.

The gap is specifically in the *evidence*, not the payment. Payments settle fine today. What has no home is
the artefact you show six months later when the invoice is questioned.

### Cross-Chain Comparison

x402 itself is chain-agnostic and live on several networks, and per-request payment demos exist across them.
Escrow marketplaces and freelance protocols exist on other chains too. What is different here:

- **Staged settlement of one logical job.** Two 402 challenges bound to one mandate id — an intake gate and a
  delivery gate — rather than one payment for one response, or a lump escrow release.
- **No escrow, no custody, no arbitration.** Nothing is held. The counterparty risk is managed by making the
  facts *cheap to check* rather than by making a protocol into a judge. That is a much smaller trust surface
  and it is why this can be adopted without a legal opinion.
- **The receipt is a first-class, portable document with a schema** — usable by parties who settle
  off-chain, because the money fields live in a *profile* layered over the base schema rather than inside it.
- **Hashes only.** Comparable systems put job metadata on-chain. Here the ledger holds fingerprints and
  public ids, so two competitors can share one audit register without leaking anything.

### Novel Hedera Usage

The five mechanics below are the design target and are **[PLANNED · Tasks 2, 3 and 5]**; none of them has run
yet. They are listed here because they are what makes the composition novel, not because they are built.

1. **HCS as a *joint* register between mutually distrusting companies, not as a message bus.** The common HCS
   pattern is one operator broadcasting to subscribers. Here two counterparties write to the same topic and
   *neither* is the authority; the topic's value comes precisely from the fact that neither of them can
   reorder it.
2. **A 402 as the delivery mechanism for the receipt.** The delivered receipt is not emailed after payment —
   it *is* the paid resource. Payment and delivery of proof are the same HTTP exchange, which removes the
   classic "we paid, they never sent the paperwork" failure entirely.
3. **A self-locating receipt.** `receipt.v1` carries `mandate_anchor {topic, seq, consensus_ts}`, so the
   document tells a verifier where on the ledger to look for its own provenance. A receipt found on a disk
   years later is independently checkable with no other context — no index, no registry, no server.
4. **Verification as a first-class, adversarial deliverable.** The verifier will be a stand-alone CLI whose
   test suite runs it against *tampered* fixtures — an edited receipt hash, a swapped transaction id, a
   missing anchor, a wrong payee — with each fixture required to fail the *specific* check it targets, and
   the demo is scripted to open with it catching one. Most projects demonstrate the happy path; the claim
   here is only worth something if the failure path is visible.
5. **A retainer as a Scheduled Transaction** *(extra)*: a recurring commercial commitment queued on a public
   ledger and referenced from the same audit topic, instead of a billing cron on the vendor's server.

---

## 6. Feasibility & Business Model

### Technical Feasibility

**Hedera services required:** HCS (topic create, message submit), the x402 `exact` Hedera scheme with a
facilitator, mirror node REST, ECDSA accounts. Extras: Scheduled Transactions, HIP-991 topic custom fees.

**Stack** (from `docs/plans/`): Node ≥ 22, TypeScript 5.9 via `tsx`, `vitest`; `@x402/core|hedera|express|fetch`
2.24.0; `@hiero-ledger/sdk` 2.85.0 pinned; `ajv` 8 + `ajv-formats` (draft 2020-12); `@noble/ed25519` +
`@noble/hashes`; `json-canonicalize` (RFC 8785); `express` 5; `commander`.

**Team capabilities — stated honestly.** One builder, working solo, running each task as an isolated agent
lane in its own git worktree with a review-and-merge gate. Direct domain experience: the mandate/receipt
schemas in `docs/schemas/` are byte-identical copies of the canonical **RetailBox A2A Bridge** specification
the same team authored for agency-to-client agent delivery, which is the exact problem this product
addresses. The riskiest external
dependency — an undocumented facilitator — was retired on day 1 by probing it directly and settling three
real payments through it before writing any product code.

**Technical Risks and Mitigations**

| Risk | Why it is real | Mitigation |
|---|---|---|
| **The hosted service is not actually live/HTTPS** — the qualification asks for a live testnet service, and the spike ran entirely on `http://localhost:4021` | `spike/README.md` lists "HTTPS / deployed service" explicitly as *not proven*. The facilitator never needs to reach our server (the client carries the signed payload), so it is not a protocol blocker — but it is an untested deployment surface and a submission requirement | Hosting is its own task with its own gate (**Task 7**) and an uptime watcher through the judging period; the demo records a run against the hosted URL, not localhost |
| **The client's own spend controls reject native HBAR before anything is signed** | Verified on day 1: the `@x402/hedera` default-asset table contains only testnet USDC `0.0.429274`, so an HBAR-priced route is refused *client-side* with an error that names spend controls, not HBAR — very easy to misread as a server fault | Every client opts HBAR in explicitly with a real cap: `setSpendControls({ allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0", maxAmountPerPayment }] })`. Documented as gotcha 1 in `spike/README.md` and pinned into the plan's global constraints |
| **Transaction-id format mismatch produces a false negative** | The facilitator returns `0.0.X@sec.nanos`; the mirror node uses `0.0.X-sec-nanos`. On day 1 this made our own checker report "not found" on a payment that had settled perfectly | One helper does the conversion and nothing else compares ids (`toMirrorTxId`, Task 2). Restated as a discipline in the spike write-up: *a failing confirmation step is not evidence of a failed payment* |
| **Mirror node lag (~1–2 s) reads as a missing anchor** | The verifier would produce false FAILs on a fresh run — the worst possible failure for a tool whose entire value is trustworthy verdicts | The verifier will retry reads for up to 30 s before declaring anything missing; `receipt.mandate_anchor.seq` and `consensus_ts` are explicitly nullable in the schema for exactly this window |
| **Settlement succeeds but anchoring fails** — a paid-for receipt that cannot be proven | Would break the core promise silently | Ordering rule from the design: the receipt is **not issued** until the anchor for its payment exists; anchoring retries with backoff |
| **SDK duplication** | `@x402/hedera` needs `@hiero-ledger/sdk` 2.85.0; installing the SDK standalone pulls 2.87.0, yielding two on-disk copies and a runtime failure in the SDK's internal brand checks | Pinned to `2.85.0` before first install and verified a single copy resolves. Avoided rather than survived |
| **Extras crowd out the core** | Four declared extras plus two secondary prizes is more surface than a solo builder can land | Hard gate in the plan: no extra is started until Task 6 (end-to-end demo + README) is green, and any extra not green by 09-10 23:00 EDT is dropped rather than half-shipped |
| **A declared extra does not ship** | All four extras sit in Task 7 behind the Task 6 gate, so any slip in Tasks 1–6 eats all of them at once. The Scheduled-Transaction retainer is the most *visible* omission because the prize names it explicitly — though it is also the cheapest of the four to build, which is why it is sequenced first | Sequence the extras cheapest-first (retainer → agent identity → HIP-991 experiment → MCP) so a slip costs the least valuable ones. Name any omission *now* rather than explaining it away later: if an extra is dropped, the README and the video say so in one line. The qualification requirements themselves (Tasks 3–6) never depend on any extra, so a dropped extra costs an extra, not the entry |
| **HIP-991 fee interaction with anchoring is unverified** | A custom-fee topic changes the submit path and could break `submitAnchor` | Named as an open question in the plan's self-review; it is a gated extra, and the base design uses a plain topic |

### Business Model (Lean Canvas)

| Element | Description |
|---|---|
| **Problem** | (1) Two organizations' agents cannot transact a unit of work without a human, a card or an API key. (2) The record of what was ordered, paid and delivered lives in one party's database, so an invoice dispute is one party's word against the other's. (3) x402 pays for a response; a unit of work settles in stages over days. |
| **Solution** | (1) Two x402-gated routes — intake fee and balance — that turn a work order into a machine-payable transaction. (2) A signed mandate and counter-signed receipt anchored as hashes on a shared HCS topic. (3) A verifier anyone can run against the public mirror node with no access to either company. |
| **Key Metrics** | Work orders completed end to end; verifier PASS rate on real runs; tamper cases correctly caught; median time from order to accepted receipt; anchors per order (must be exactly 6); organizations onboarded; retainers scheduled. *None of these are measured yet — they are the instrument panel being built, and the demo run produces the first values.* |
| **Unique Value Prop** | **A receipt for agent work that your counterparty cannot forge and a stranger can check** — paid for, and released by, the payment itself. |
| **Unfair Advantage** | Operating experience of the exact workflow: the canonical mandate/receipt schemas come from the RetailBox A2A Bridge specification for agency↔client delivery, so the protocol is shaped by how delivery actually settles rather than by how a payment demo looks. Plus a proven, documented Hedera x402 payment path with the non-obvious failure modes already written down. |
| **Channels** | The open-source repository and the verifier CLI as the entry artefact; the Hedera and x402 developer ecosystems (facilitator lists, ecosystem directories, the harness PR); MCP tool distribution so any agent framework can order work; direct outreach to delivery agencies already running agent-assisted work. |
| **Customer Segments** | Beachhead: **delivery agencies with 3–20 client relationships already using agents in delivery**, and their client companies. Adjacent: A2A / MCP platform builders needing a settlement + receipt layer; finance and audit functions on both sides. |
| **Cost Structure** | Near-zero variable cost: ≈ $0.005 of network fees per completed work order plus one-time account and topic creation. No custody, no escrow float, no facilitator to operate (Blocky402 is used as a service). Fixed cost is engineering and hosting the contractor reference service. |
| **Revenue Streams** | *(model, not yet tested with any buyer)* (1) A hosted contractor gateway for agencies that do not want to run the service — priced per relationship. (2) A neutral, shared audit topic operated for many pairs, funded by HIP-991 topic submission fees. (3) Verification-as-a-service and long-term receipt archival for finance/audit teams. (4) The protocol and verifier stay open source — the paid surface is operation, not the standard. |

### Why Web3 is Required

Strip out the ledger and the design collapses into "trust one of the two companies' databases". Specifically:
the ordering and timestamping of the audit trail must come from a party neither company can influence; a
third party must be able to check a receipt **without either company's cooperation**, which is only possible
if the evidence is public and the verifier needs no credentials; and the payment must complete unattended
without a card, an account or an API key — which is what x402's facilitator fee-payer model provides. A Web2
implementation could reproduce the *shape* of this system in a weekend and would fail the only requirement
that matters: being believed by someone who trusts neither participant.

---

## 7. Execution Plan

### MVP Scope (Hackathon)

Effort is given in **lane-days** — the unit the plan's schedule actually allocates — rather than invented
hour counts. One lane-day is one isolated agent lane working a single task to a green test run and a commit;
two tasks sharing a day means each gets roughly half of it.

| Feature | Priority | Task | Effort | Gate / day (EDT) | Hedera service |
|---|---|---|---|---|---|
| Protocol — canonical JSON, Ed25519 envelopes, schema validators | P0 | 1 | ~0.5 lane-day | Fri 09-04 (canary lane) | — (foundation) |
| Anchor — HCS topic, `wr-anchor.v1` records, mirror reads | P0 | 2 | ~0.5 lane-day | Fri 09-04 | HCS + mirror node |
| Contractor — x402-gated intake and paid receipt release | P0 | 3 | ~0.5 lane-day | Sat 09-05 | x402 / Blocky402, HCS |
| Customer agent CLI — order and collect with real payments | P0 | 4 | ~0.5 lane-day | Sat 09-05 | x402 / Blocky402 |
| Verifier — trustless reconstruction + tamper fixtures | P0 | 5 | 1 lane-day | Sun 09-06 | Mirror node only |
| End-to-end demo, README, disclosure | P0 | 6 | 1 lane-day | Mon 09-07 (check-in #1) | all of the above |
| Extras — agent identity, Scheduled-Transaction retainer, HIP-991 fee, MCP server, hosting + watcher | P1 | 7 | 2 lane-days | Tue–Wed 09-08/09 | Scheduled Transactions, HCS |
| Harness PR — deterministic mirror-node check | P2 | 8 | ~0.5 lane-day | Thu 09-10, only if 1–6 merged | Mirror node |
| Submission — validate, record video, submit | P0 | 9 | 1 lane-day | Fri–Sat 09-11/12 | — |

**Definition of done for the MVP:** `npm run demo` completes on testnet **twice in a row**, the verifier
returns PASS on the real run and FAIL — with the *intended* check failing — on each of the four tampered
fixtures, and every HashScan link in the README resolves in a browser.

### Team Roles

| Member | Role | Key responsibilities |
|---|---|---|
| Solo builder | Architect, implementer, reviewer, submitter | Owns the design and the plan; runs each task as an isolated agent lane in its own git worktree (`lane-<task>`); reviews and merges every lane; owns the testnet run, the video and the submission |

**How a solo team is kept honest.** Each task is specified before it is built — files, interfaces, tests and
acceptance are fixed in the plan so a lane can run without the author's context; each lane ends with tests
passing and its own commit; the orchestrator reviews the diff rather than trusting a lane's summary. The
review gate is the substitute for a second pair of human eyes, and it is why the plan fixes interfaces
(`Envelope`, `AnchorRecord`, `toMirrorTxId`, `envelopeHash`) before any lane starts.

### Design Decisions

| Decision | Options considered | Choice | Rationale |
|---|---|---|---|
| Payment asset | Native HBAR (`0.0.0`) vs testnet USDC vs an HTS token | **Native HBAR** | HTS adds token association as an independent failure surface with no benefit to the thesis. The schema still allows an HTS token id in `payment.asset`, so this is deferred rather than designed out |
| Where money lives in the schema | Add money fields to `mandate.v1` / `receipt.v1` vs a separate profile | **Separate `payment.v1` profile** | The base protocol deliberately forbids money and hours fields, so the same order and receipt stay valid between parties who settle off-chain or not at all. Adoption of the document format does not require adoption of our payment rail |
| How the profile extends the base | Plain `allOf` + `$ref` vs generating a self-closing profile | **Generated profile** (`build_payment_profile.py`) | The base sets `unevaluatedProperties: false`, which makes a plain `allOf` + `$ref` extension impossible in JSON Schema 2020-12. The generator embeds the core keywords and closes the profile — and the base files stay byte-identical to their source, never hand-edited |
| What goes on-chain | Full documents vs metadata vs hashes only | **Hashes and public ids only** | Two competitors can share one audit register without leaking anything. The fingerprint is exactly sufficient for the claim being made, and nothing more is claimed |
| Signature scheme | One scheme everywhere vs two | **Ed25519 for envelopes, ECDSA for payments** | Ed25519 matches the source protocol's envelopes; ECDSA is required by the Hedera `exact` x402 flow. Splitting them is honest about two different trust domains rather than bending one to fit |
| Settlement path | Self-hosted facilitator vs a hosted one | **Hosted (Blocky402)** | Removes the need to operate and fund a fee-payer service during a nine-day event, and demonstrates the ecosystem's own infrastructure working outside its examples. Facilitator-agnostic by design: any facilitator advertising `hedera:testnet` works |
| Fee payer | Configure `extra.feePayer` ourselves vs read it from the facilitator | **Read from `GET /supported` at startup** | It is the facilitator's own account; hardcoding it would break the moment the facilitator rotates. Observed in the spike: `@x402/express` syncs `/supported` on startup and `ExactHederaScheme.enhancePaymentRequirements` copies `extra.feePayer` into the requirements — package-level detail from the x402 packages themselves, not from Hedera's docs |
| Settlement stages | One payment on delivery vs escrow vs two legs | **Two legs — intake fee + balance** | Mirrors how delivery work actually settles, gives the contractor a real commitment signal at intake, and creates the demo's central mechanic: the receipt is released *by* the second payment. No custody, so no escrow risk and no arbitration surface |
| Verifier trust model | Read from our API vs read the ledger | **Mirror node only** | Structural, not promised: the verifier has no credentials and no route to either company. A verifier that phoned home would prove nothing |
| Evidence layer | HCS topic vs a smart contract vs a private append-only log | **HCS topic** | Ordering and consensus timestamps at $0.0008 per message with no contract surface to audit or upgrade. A private log fails the only requirement that matters — being believed by an outsider |
| Contractor state | A database vs a JSON file store | **JSON file store** | State is small and the ledger is the record of consequence. Fewer moving parts inside a nine-day window |
| Deliverable in the demo | A real pipeline run vs a deterministic synthetic result | **Deterministic synthetic result**, clearly labelled | The claim under test is the settlement and evidence chain, not the quality of the work. A deterministic deliverable keeps the demo reproducible, and the synthetic Agency X / Client Y fixture keeps real client data out of a public repository |

### Post-Hackathon Roadmap

- **Month 1–2 — make it usable by someone else.** Mainnet configuration and a mainnet facilitator; the
  contractor service packaged so an agency can run it against its own tracker; the verifier published as a
  stand-alone binary and web page (paste a receipt, get a verdict); HTS/USDC as an alternative asset for
  parties who need a stable unit; first design-partner integration with a real agency↔client pair, with
  their tracker and their staging environment. **Also in this window, and named because the rubric is right
  to ask:** a solo builder can ship this but should not be the one taking it to market alone — the explicit
  action is to bring in a second person or an advisor who owns go-to-market, before the second design
  partner rather than after. No such person is lined up today.
- **Month 3–6 — make it neutral.** A shared audit topic operated for multiple relationships, funded by
  HIP-991 topic fees; retainers and multi-story mandates; a finance-facing export that reconciles a month of
  receipts against an invoice; the receipt format proposed as an interoperable profile so other agent
  networks can emit compatible documents.
- **Month 6–12 — make it standard.** Dispute *evidence* tooling (not arbitration): a one-command bundle an
  auditor or a court can check offline; MCP and A2A distribution so ordering work is a tool call in any agent
  framework; a facilitator-agnostic conformance suite so any x402 facilitator can be certified against the
  work-order flow.

---

## 8. Validation Strategy

> How will you prove market demand?

**Where this stands today, stated plainly.** There are **no external users, no signups, no trials and no
revenue**. Nobody outside the team has tested this. What exists on day 1 is a working payment spike with
three real settled testnet transactions, an approved design, an implementation plan with fixed interfaces and
acceptance gates, and canonical schemas taken from the RetailBox A2A Bridge specification for agency↔client
delivery.
The strongest honest statement available is that the *problem* comes from operating the workflow, and the
*payment mechanism* is proven — not that the market has spoken.

### Feedback Sources

| Source | Why them | How they are reached | When |
|---|---|---|---|
| Delivery leads at agencies running agent-assisted delivery | They live the reconciliation pain; they decide whether a receipt is worth paying for | Walk them through a real order → paid → verified run and ask one question: *would you attach this to an invoice?* | During the event and the week after |
| *(open)* — the named Cycle-1 participants | The rubric rewards cycles that actually ran, and a persona is not a participant | **No participant is confirmed today.** The commitment is to name the two or three actual Cycle-1 people in the repository before 09-08, and to publish their verbatim reactions afterwards whether or not they are flattering | Named by 09-08 |
| Client-side PM / finance | They are the ones who dispute the invoice; the receipt has to convince *them*, not the vendor | Show a delivered receipt plus a verifier PASS and ask what is missing before they would accept it as evidence | Week after the event |
| Hedera mentors, DevRel and judges | Fastest access to whether the HCS and Scheduled-Transaction usage is idiomatic and whether the network-impact model is credible | Hackathon office hours and Discord; ask specifically about the anchor-record shape and the HIP-991 topic-fee economics | During the event (both check-ins) |
| x402 / facilitator maintainers | The two-leg staged-settlement pattern is a use case the scheme was not demonstrated for; their reaction determines whether this generalizes | Issue or discussion in the x402 repository describing the pattern, and the Blocky402 usage report from the spike | 09-08 onwards |
| Other hackathon teams building agent payments | Nearest-neighbour builders; the fastest source of "we needed exactly this" or "we solved it differently" | Direct outreach with the verifier CLI — it takes a minute to run and produces an opinion | During the event |
| The `hedera-harness` maintainers | A code-level reaction to the project's most reusable idea | The Task 8 PR and its review thread | 09-10 onwards |

### Validation Milestones

Targets are **commitments to run the cycle**, not predicted counts — a predicted signup number would be
invented, and this document does not invent numbers.

| Milestone | Target | Timeline |
|---|---|---|
| First run by someone who is not the author | Any external person runs `verify` against our published topic and receipt and reports what they understood, and what they did not | 09-07 → 09-13 (as soon as the demo is green) |
| Feedback cycle 1 — the receipt as evidence | Structured conversations with agency-side and client-side practitioners around one real run; the single question is whether the receipt would be accepted as evidence attached to an invoice | Week of 09-08 |
| Feedback cycle 2 — the protocol as a standard | Reaction from x402 / facilitator maintainers and Hedera DevRel on the two-leg pattern, the anchor record shape and the topic-fee economics | 09-08 → post-event |
| Feedback cycle 3 — iterate and re-test | Fold cycles 1 and 2 into the schemas and the verifier output, then re-run with the same people and record what changed | Post-event, first two weeks |
| Design partner | One agency↔client pair running the flow against their real tracker and staging environment | Month 1–2 |
| First paid usage | Any revenue at all, and the terms it was agreed on | Not before a design partner exists — deliberately not forecast |

### Market Feedback Cycles

1. **Cycle 1 — "would you attach this to an invoice?"** Run one real order end to end in front of a
   practitioner on each side, hand them the delivered receipt and the verifier output, and record the first
   objection. The measurable outcome is a list of what the receipt is missing before it is accepted as
   evidence, which lands directly in `receipt.v1` and in the verifier's printed statement.
2. **Cycle 2 — "is this idiomatic, does it already exist, and does it generalize?"** Put the anchor record
   shape, the two-leg pattern and the topic-fee economics in front of Hedera mentors and the x402
   maintainers. This cycle also carries the **prior-art sweep** that §5 deliberately does not assert: ask the
   people best placed to know whether a staged-settlement x402 work order with a public receipt already
   exists anywhere. The measurable outcomes are a decision on HIP-991 for the audit topic, a yes/no on prior
   art, and whether the pattern belongs in the scheme's own examples.
3. **Cycle 3 — iterate and re-test with the same people.** Ship the changes from cycles 1 and 2 and go back to
   the same practitioners rather than to fresh ones, because the signal that matters is whether their
   objection was actually removed.

---

## 9. Go-To-Market Strategy

### Target Market

- **TAM (Total Addressable Market) — defined, not sized.** Every pair of organizations whose agents exchange discrete units of work and
  need a settlement plus an evidence record: agency↔client delivery, research and data-labelling suppliers,
  translation and localization, audit and compliance work, and agent-network marketplaces. A cited figure is
  deliberately **not** stated: we have not researched one, and an invented number would undermine every other
  number in this document.
- **SAM (Serviceable Addressable Market).** Organizations that already run agents in delivery *and* already settle in stages — the segment
  where the intake-fee/balance shape matches how they invoice today, so adoption changes the plumbing rather
  than the commercial model.
- **Initial target segment (beachhead).** Delivery agencies with roughly 3–20 client relationships that are
  already using agents in delivery and already feel invoice reconciliation as a monthly cost. They have the
  pain, they control both ends of one relationship (so they can adopt without waiting for an ecosystem), and
  they can put the receipt in front of their own client the same month.
- **Bottom-up unit model [PROJECTION].** *Assumptions:* one relationship ships 20 stories per week over a
  four-week month (80 orders); on-chain cost is $0.005 per completed order (computed in §4). Network cost per
  relationship ≈ $0.40/month — under one percent of any plausible per-relationship price. The economics are not the constraint; trust and
  integration are. That is where the effort goes.

### Distribution Channels

1. **The verifier as the entry artefact.** It is the cheapest possible first contact: one command, no
   account, no keys, no server — paste a topic id and a receipt, get a verdict. Anyone can try the product
   without adopting it, which is the only distribution advantage a two-sided protocol gets for free.
2. **Ecosystem placement.** Publish in the Hedera and x402 developer surfaces where builders already look for
   payment plumbing: facilitator and ecosystem directories, the `hedera-harness` contribution, and the x402
   discussion of the staged-settlement pattern. Contribution first, promotion second.
3. **MCP and A2A distribution.** Exposing `order` / `collect` / `verify` as MCP tools means any MCP-capable
   agent can order and pay for work without importing this repository. The protocol travels through the agent
   frameworks rather than through a signup form.
4. **Direct design-partner outreach.** One agency↔client pair at a time, integrated against their real
   tracker and staging environment. Two-sided products are won relationship by relationship, and each
   relationship is independently useful — there is no network-effect threshold to cross first.

### Growth Strategy

Growth is **per relationship, not per user**: an agency that adopts it for one client adopts it for the next
at near-zero marginal cost (one topic, one account pair), and the client experiences the receipt without
integrating anything — which makes the client the natural next customer as a *buyer* of work elsewhere. Each
side has a reason to propose it to the other, which is the cheapest growth loop available to a settlement
protocol.

**Partnership opportunities:** facilitators (a certified work-order flow gives them a use case beyond
per-request billing); agent-network and A2A platform builders (this is the settlement layer under their
transport); tracker and PM tooling (a mandate is one webhook away from a story); accounting and audit tooling
(a month of verified receipts is a reconciliation feature); Hedera ecosystem tooling, where an audit topic and
a public verifier are directly reusable.

---

## 10. Pitch Outline

> Key points for the presentation and the ≤ 5 minute demo video.

1. **The Problem (30 s).** *"Two companies' agents can already talk to each other. They still cannot do
   business with each other. One agent orders work, the other delivers it — and the only record of what was
   ordered, what was paid and what was delivered sits in one of those two companies' databases. At invoice
   time that is not evidence. That is somebody's word."*
2. **The Solution (60 s).** *"A work order signed by the customer's agent. An intake fee paid over x402. A
   receipt counter-signed by the contractor. Work happens. The balance is paid — and paying it is what
   releases the delivered receipt. Every step is anchored on a Hedera Consensus Service topic as a hash. Then
   anyone — with no access to either company — runs one command and gets a verdict."* Demo beats: **(a)** the
   verifier catching a **tampered** receipt in the first 20 seconds, naming the exact failing check; **(b)**
   `customer order` → 402 → paid → accepted receipt; **(c)** deliver; **(d)** `customer collect` → 402 → paid
   → delivered receipt; **(e)** the same verifier returning PASS; **(f)** the HashScan links, live.
3. **Hedera Integration (45 s).** *"Payments settle through the x402 `exact` Hedera scheme with the Blocky402
   facilitator as fee payer — our paying agent never touches gas. Evidence lives on HCS: six anchors per
   order, hashes only, ordered and timestamped by a network neither company controls. Verification reads only
   the public mirror node. Eight Hedera transactions per unit of work, about half a cent. Hedera is not where
   we store a token here — it is the reason a stranger believes the receipt."*
4. **Traction (30 s) — stated exactly as it is.** *"Day one: three real HBAR payments settled on testnet
   through Blocky402, HashScan links in the repository, and every failure mode we hit written up — including
   the one where our own checker said the payment failed and the ledger said it had not. No users yet. The
   feedback cycles are named, with who and when, and the first one runs the day the demo is green."*
5. **The Opportunity (30 s).** *"Every pair of organizations whose agents exchange units of work needs this,
   and the network cost is about $0.005 per order — under one percent of any plausible price. I am not going
   to quote you a market size, because I do not have one I can source, and every other number in this deck
   has a link behind it. What I can show you is the unit: about forty cents a month of network cost per
   client relationship. We are not selling the standard; the protocol and the verifier stay open. We sell
   operating it: a hosted contractor gateway, and a neutral shared audit topic funded by HIP-991 topic
   fees."*
6. **The Ask / Next Steps (15 s).** *"One agency↔client pair willing to run a real story through it, and a
   review of the two-leg pattern from the x402 and Hedera maintainers. Mainnet is a configuration change, not
   a redesign."*

### Key Metrics to Present

Every number below has a source a judge can open, and the two groups are kept apart on purpose — mixing a
measurement with a design target is how decks lose credibility.

**Observed — these happened, on the public ledger:**

| Metric | Value | Data source |
|---|---|---|
| Real HBAR payments settled through Blocky402 on testnet | 3, all `SUCCESS`, identical transfer shape | `spike/README.md`; HashScan <https://hashscan.io/testnet/transaction/0.0.7162784@1788539653.433840739> |
| Payer / payee movement on the headline payment | −1 000 000 / +1 000 000 tinybars, exact | Mirror node `/transactions/0.0.7162784-1788539653-433840739` |
| Network fee paid by the **facilitator**, not our agent | 261 078 tinybars | Same transaction's transfer list |
| Documented Hedera x402 gotchas published for other builders | 7 — five hit live and written up with the verbatim output, one (the SDK version clash) pre-empted by pinning before it could fire, one a key-type constraint recorded up front | `spike/README.md` "Gotchas hit" |

**Design targets and projections — not yet run, and labelled so:**

| Metric | Value | Basis |
|---|---|---|
| Hedera transactions per completed work order | 8 (2 `CryptoTransfer` + 6 `ConsensusSubmitMessage`) | Counted from the design, `docs/specs/` — **[PROJECTION]** until the first end-to-end run |
| On-chain cost per completed work order | ≈ $0.005 (a low-end figure; see §4's precision note) | Hedera published fees: `CryptoTransfer` $0.0001, `ConsensusSubmitMessage` $0.0008 — **[PROJECTION]** |
| Verifier checks, and tamper cases it must catch | 5 checks; 4 tamper fixtures (edited receipt hash, swapped tx id, missing anchor, wrong payee) | `docs/plans/` — **[PLANNED · Task 5]**; this is the specification, not a test result |

---

## Parking Lot (Future Ideas)

- **Dispute evidence bundles** — one command produces an offline-checkable package (mandate, receipts,
  anchors, transactions) for an auditor or a court. Evidence, still never arbitration.
- **Multi-story mandates and milestone ladders** — one order, several acceptance gates, several 402 legs.
- **Reputation from receipts** — a contractor's verifiable history of delivered receipts, computed by anyone
  from public anchors, with no platform holding the score.
- **A neutral audit-topic operator** — one shared HIP-991 topic serving many relationships, so no
  counterparty owns the register.
- **Receipt-native invoicing** — reconcile a month of verified receipts against an invoice automatically.
- **Cross-facilitator conformance suite** — certify any x402 facilitator against the work-order flow.
- **HTS / stablecoin settlement** — for parties who need a stable unit; the schema already allows it.
- **Selective disclosure** — reveal individual mandate fields against the anchored hash without publishing
  the document.

---

## Section-to-Criteria Mapping

| PRD Section | Judging Criteria Addressed |
|---|---|
| 1. Problem Statement | Feasibility, Pitch |
| 2. Solution Overview | Innovation, Pitch, Execution |
| 3. Hedera Integration | Integration (primary), Innovation |
| 4. Network Impact | Success (primary) |
| 5. Innovation | Innovation (primary) |
| 6. Feasibility & Business Model | Feasibility (primary) |
| 7. Execution Plan | Execution (primary) |
| 8. Validation Strategy | Validation (primary) |
| 9. Go-To-Market | Execution, Success |
| 10. Pitch Outline | Pitch (primary) |

---

## Appendix A — Predicted Score Assessment (day 1)

Scored against `.claude/skills/hedera-hackathon-prd/references/judging-criteria.md` using the 1/3/5
descriptors. This is a **self**-assessment written on day 1 to steer the remaining build, not a claim about
how judges will score. It assumes Tasks 1–6 land as planned; where it does not, that is said.

| Section | Predicted score | Rationale | How to improve |
|---|---|---|---|
| **Innovation (10%)** | 4/5 | Aligns to the track directly and introduces a capability the Hedera ecosystem does not have — staged settlement of a unit of work with a publicly verifiable counter-signed receipt. HCS used as a joint register between distrusting parties, and a receipt released *by* a 402, are both non-obvious. Short of 5 because the components (x402, HCS anchoring) exist individually; the novelty is the composition | Land the extras that make the composition unmistakable: agent identity resolved *by the verifier*, and the Scheduled-Transaction retainer referenced from the same audit topic. Show one screen where identity, payment and evidence are the same object |
| **Feasibility (10%)** | 4/5 | Riskiest dependency retired on day 1 with three real settlements; complete Lean Canvas; a stack pinned for known-bad interactions; domain experience is direct (the schemas come from the RetailBox A2A Bridge spec for exactly this workflow). Short of 5 because "complete capability to take it to market" is a stretch for a solo team | Convert the revenue model from a model into a conversation: get one agency and one client-side finance person to react to the pricing shape, and record what they said |
| **Execution (20%)** | 3/5 **today**, 4–5/5 if Tasks 1–6 land | Today the repository holds a design, a plan, schemas and a spike — a strong day-1 position, but the MVP is not built. Strategy, roadmap, GTM, design decisions and feedback cycles are all documented, which is where most submissions lose this criterion | Highest-leverage work in the whole event. Get `npm run demo` green twice in a row by 09-07, then treat CLI and verifier output as the UI: a clean check table, plain-language failure reasons, and clickable HashScan links. UI/UX is scored, and for an agent product the terminal output *is* the interface |
| **Integration (15%)** | 4/5, 5/5 with the extras | Multiple services used where each is load-bearing: HCS for evidence, x402 + facilitator for settlement, mirror node for trustless verification, ECDSA accounts for agents, Scheduled Transactions for the retainer. Ecosystem partners are real (Blocky402, HashScan, mirror node, Hiero SDK, and a contribution back to `hedera-harness`). The non-obvious usage the rubric rewards is present: HCS as a shared register, not a bus | Ship the HIP-991 topic-fee experiment or publish why it was rejected — a documented negative result on the fee interaction is worth more than silence. Land the harness PR |
| **Validation (15%)** | 2/5 **today** | Honest floor: nobody outside the team has used it. The rubric's 3 requires at least one external feedback cycle with early adopters onboarded. Sources, cycles and dates are named, but naming is not running | The cheapest points available in the whole rubric. Run cycle 1 the day the demo is green: hand the verifier and one real receipt to three external people and record verbatim what they said. Publish the notes in the repository. That alone is the difference between 2 and 3 |
| **Success (20%)** | 3/5 | The impact model is honest and arithmetic — 8 transactions per work order, HCS-weighted, growing per relationship — and every new organization must create Hedera accounts to participate at all. But at realistic hackathon-horizon volumes this does not move network TPS, and claiming otherwise would be the invented metric this document avoids | Strengthen with *quality* of impact rather than invented quantity: recurring non-speculative traffic, a non-crypto-native audience arriving through a normal commercial workflow, and a per-relationship growth curve. If a design partner is secured before submission, that is a real account-creation number and moves this to 4 |
| **Pitch (10%)** | 4/5 | Problem and solution are sharp, the demo opens with the failure case rather than the happy path, every presented number has a clickable source, and Hedera is the reason the product works rather than a sponsor mention. Short of 5 until the video exists | Record early enough to re-record. Rehearse the answer to the obvious hostile question — *"why not just use a database?"* — and answer it in one sentence: because the counterparty has no reason to believe your database, and the verifier needs no access to it |

**Weighted estimate today**, using the rubric's own formula `(score/5) × (weight/100 × 35)`, summed, then
`/35 × 100`. Innovation 4, Feasibility 4, Execution 3, Integration 4, Validation 2, Success 3, Pitch 4 →
2.8 + 2.8 + 4.2 + 4.2 + 2.1 + 4.2 + 2.8 = **23.1 / 35 = 66%**. With Tasks 1–6 green, one external feedback
cycle actually run and the video recorded (Execution 4, Validation 3, Pitch 5, the rest unchanged) →
**26.25 / 35 = 75%**. The arithmetic is shown rather than asserted, for the same reason every other number in
this document carries its source.

---

## Appendix B — Next Steps

**1 · MVP features to build first, ranked by score impact.**
Tasks 1 → 2 → 3 → 4 → 5 → 6, in that order, because they are a dependency chain and because Execution (20%)
is the criterion currently furthest below its ceiling. Do not start any extra before Task 6 is green — a
half-shipped extra costs Execution points and gains no Integration points. Task 5 (the verifier) is the
single highest-value piece: it carries the demo's opening 20 seconds, it is what makes the claim falsifiable,
and it is the artefact an outsider can run without adopting anything.

**2 · Quick wins for the Integration score.**
The Scheduled-Transaction retainer is the cheapest genuine addition and is therefore sequenced first among
the extras (§6's risk row) — a distinct service, a distinct commercial idea, and it anchors into the topic
that already exists. For agent identity, do the cheap check
first: "HCS-14" does not appear anywhere in docs.hedera.com, so before building against the name, find the
actual published standard text and confirm what conformance requires — and if it cannot be confirmed, ship a
plainly documented key-derived identifier instead of borrowing a standard's number. Either way, resolving
the identifier *inside the verifier* rather than only publishing it is what turns identity from a claim into
a check. The
HIP-991 topic fee is worth one timeboxed experiment: if `submitAnchor` still works through the fee, it is a
strong non-obvious usage; if it does not, publish the negative result — the plan already flags the
interaction as unverified, and a documented negative result is a contribution.

**3 · Validation actions during the hackathon.**
This is the largest scoring gap and the cheapest to close. The day the demo is green: publish the topic id
and one real receipt in the README so anyone can verify without asking; get three external people to run
`verify` and record verbatim what they understood and what they did not; ask Hedera mentors at both check-ins
specifically about the anchor record shape and the topic-fee economics; open the x402 discussion of the
two-leg staged-settlement pattern. Commit the notes to the repository — the rubric rewards *established
cycles*, and a file of real quotes is the evidence that one happened.

**4 · Pitch preparation.**
Record a throwaway take on 09-11 so the real one on 09-12 is a second attempt. Open on the tampered receipt,
never on the architecture diagram. Keep every claim to something with a link behind it, and say the traction
sentence exactly as it is — *"three real settled payments, no users yet, first feedback cycle running"* —
because the rubric rewards numbers that make sense, and an honest small number is more persuasive than a
large one nobody can source. Have `spike/README.md` open in a tab for the questions: it is the strongest
artefact in the repository on day 1, and the gotcha where our own checker was wrong about a payment that had
actually settled is the most memorable thirty seconds available.
