# Agent identity — HCS-14 `uaid`, resolved by the verifier

Until this extra, an envelope said it came from `agency-x-agent`. That is a name, and a name is not
evidence: nothing tied it to the key in `sig.pub`, two agents could pick the same one, and a reader
holding a receipt had no way to tell which of them signed it. Check 1 established that *a* key signed
the document; nobody could say whose.

An HCS-14 identifier closes that gap, and it closes it without adding a third party. Both agents now
sign as `uaid:did:z6Mk…`, which is their Ed25519 public key in another encoding, and the verifier
decodes the identifier and compares it with the key that actually signed. No registry is asked, no
DID document is fetched, nothing is trusted — the check is arithmetic on a string that is already in
the receipt.

## What HCS-14 says, and which part of it this is

Spec: [`hiero-ledger/hiero-consensus-specifications`,
`docs/standards/hcs-14/index.md`](https://github.com/hiero-ledger/hiero-consensus-specifications/blob/main/docs/standards/hcs-14/index.md)
(Draft). It defines one scheme with two targets:

| Target | Form | Id is | Checked by |
|---|---|---|---|
| `aid` | `uaid:aid:{id};{params}` | Base58(SHA-384(canonical JSON of six agent fields)) | recomputing the hash — needs those six fields |
| `did` | `uaid:did:{id};{params}` | the base DID's method-specific identifier, sanitized, no new hash | resolving the DID — except for `did:key`, which needs nothing |

Sections implemented here, by name: *DID Structure*, *DID Parameter Structure* (parameter set, the
required `uid`, the emission order `uid, registry, proto, nativeId, domain`, the rule that the id
carries no `;`, `?` or `#`), *Canonical Agent Data* and *Hash Generation* steps 1–6 (normalize,
sort, canonical JSON, SHA-384, Base58), *Implementation Requirements* (skills `40–99` rejected),
*Native Protocol IDs* (CAIP-10 `hedera:<network>:<account>`), and *A2A Agent.json Integration* (the
identifier is published in the `did` field of `/.well-known/agent.json`).

**Both agents use the `did` target over `did:key`**, whose method-specific identifier is multibase
base58btc over the multicodec prefix `0xed 0x01` and then the raw 32-byte public key. That is the
whole reason for the choice: it is the only form in the standard that a verifier reading nothing but
a public mirror node can check. The `aid` target is implemented too, exactly as specified — a
counterparty may well use one — but it is derived from descriptive fields rather than from a key, so
it can never be compared against a signature, and the verifier says that rather than implying it
looked.

## What was added

| File | What it does |
|---|---|
| `protocol/identity.ts` | derive a `uaid` from an Ed25519 public key, derive an `aid` from the six canonical fields, parse and validate an identifier, and decode the key an identifier commits to |
| `contractor/server.ts` | `contractorUaid()` derives the service's identifier from its signing key; `agentCard()` publishes it; `GET /.well-known/agent.json` serves it ahead of the payment gate; every receipt and refusal is signed `from` that identifier |
| `customer/wallet.ts` | `CUSTOMER_UAID` gives the customer an identifier; `CONTRACTOR_UAID` pins the counterparty's; either side may still be a plain handle |
| `customer/cli.ts` | `resolveCounterparty()` reads the contractor's card before ordering, so the work order is addressed to the identifier the contractor publishes |
| `verifier/checks.ts` | check 2, `agent identity` |
| `verifier/cli.ts` | `N/A` in the table and in the verdict line, for a check that had nothing to decide |

The handles did not go away and were not moved: `mandate.issuer` and `receipt.issuer` still carry
them, because the published schemas require a handle there (`^[a-z0-9][a-z0-9-]{2,31}$`) and those
files are byte-locked copies of an upstream protocol. The identifier lives in the envelope, which is
this repository's own layer. So a receipt now says both things: *issued by `agency-x-agent`*, which
is a name for humans, and *from `uaid:did:z6Mkpmqam…`*, which is a claim a machine can check.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CONTRACTOR_UAID` | derived from `CONTRACTOR_SIGNING_KEY` | The contractor's identifier. On the customer side, the same variable pins the counterparty and skips card discovery |
| `CUSTOMER_UAID` | unset — the customer keeps its handle | `auto` derives one from `CUSTOMER_SIGNING_KEY`; any other value is used verbatim and must be a well-formed identifier |

The asymmetry is deliberate. The contractor's identifier is derived by default because it is the
party being addressed and it publishes a card, so nothing downstream can be surprised by it. The
customer's is opt-in because the string it signs as is what the other side's receipts are addressed
to, and changing what someone else's documents say about you is not a change to make silently.
`.env` in this repository sets `CUSTOMER_UAID=auto`, which is how the run below has identifiers on
both sides.

The identifiers the two agents derive look like this — routing parameters per the standard, `uid=0`
because neither agent is in a registry, `registry=self` as the standard requires for self-sovereign
agents, and `nativeId` in CAIP-10 form naming the Hedera account each one pays or is paid at:

```
uaid:did:z6MkpmqamYikcwnfPSEAAUQaz8spVNEnmbHi8RL2iy28T8F6;uid=0;registry=self;proto=rest;nativeId=hedera:testnet:0.0.10365984
uaid:did:z6MkpKkccyxeu45kiP5fSgPCSBzhYYe6Tv9giM2D2K9kPH37;uid=0;registry=self;proto=rest;nativeId=hedera:testnet:0.0.10365982
```

## How to run it

```bash
npm run contractor:start
curl -s localhost:4021/.well-known/agent.json        # the identifier, the key behind it, the x402 terms
npm run demo                                          # the whole flow; the customer resolves the card itself
```

Discovery is best-effort by construction: a card that is missing, slow (3 s), not JSON, or carrying
something that is not an identifier leaves the counterparty as the handle it already was and the
order goes out unchanged. A broken card on their side is not an outage on ours. Nor is the card
trusted: it decides who the order is *addressed* to, and whether the receipts that come back were
really signed by the key behind that identifier is settled afterwards, by the verifier, from the
receipt alone.

## What the verifier now checks

Check 2, `agent identity`, over the receipt envelope and — when it is supplied — the work order:

1. the `from` is a well-formed identifier (required `uid`, no `;`, `?` or `#` in the id);
2. the key it decodes to is the key in `sig.pub`;
3. the `to`, if it announces itself as an identifier, is a well-formed one;
4. the work order's own `from` names the key that signed the work order;
5. the receipt is addressed to the agent the work order came from.

Any of those failing is a `FAIL`. Two situations are neither pass nor fail and print **`N/A`**:

- **the envelope carries a plain handle** — no identity claim was made, so there is none to check.
  Every receipt issued before this extra is in this case, including the golden fixtures in
  `tests/verifier/golden`, and they still verify;
- **the identifier would have to be resolved** — a `uaid:aid:`, or a DID of a method other than
  `did:key`. The verifier reads the public mirror node and nothing else. Reporting an unmade lookup
  as a pass would be the one dishonest line in the report.

`N/A` results carry `applicable: false` and are excluded from the verdict's count, which now reads
"all 6 applicable checks passed" and names anything it skipped.

## A real run, 2026-09-09

Testnet, topic [`0.0.10426298`](https://hashscan.io/testnet/topic/0.0.10426298), order
`01a0868a-954e-772c-9995-d9c5696f2ee0`, both agents on identifiers:

| What | Where |
|---|---|
| Intake payment, 1 000 000 tinybars | [`0.0.7162784@1788963619.765994096`](https://hashscan.io/testnet/transaction/0.0.7162784@1788963619.765994096) |
| Balance payment, 4 000 000 tinybars | [`0.0.7162784@1788963626.820218273`](https://hashscan.io/testnet/transaction/0.0.7162784@1788963626.820218273) |
| Six anchors | [#115](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10426298/messages/115) `mandate_in` → [#116](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10426298/messages/116) `payment_intake` → [#117](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10426298/messages/117) `accepted` → [#118](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10426298/messages/118) `delivered` → [#119](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10426298/messages/119) `payment_balance` → [#120](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10426298/messages/120) `receipt` |

The envelopes of that run:

| Document | `from` | `to` | `sig.pub` |
|---|---|---|---|
| work order | `uaid:did:z6MkpKkccyxe…` | `uaid:did:z6MkpmqamYik…` | `92a886c29970f8d4…` |
| acceptance | `uaid:did:z6MkpmqamYik…` | `uaid:did:z6MkpKkccyxe…` | `99573eae7ac7933b…` |
| delivery receipt | `uaid:did:z6MkpmqamYik…` | `uaid:did:z6MkpKkccyxe…` | `99573eae7ac7933b…` |

and the verifier's verdict on it:

```
      check                 detail
PASS  receipt signature     signed by 99573eae7ac7… over the receipt as issued
PASS  agent identity        uaid:did:z6MkpmqamYik… is the key that signed this receipt (99573eae7ac7…), addressed to uaid:did:z6MkpKkccyxe…
PASS  mandate hash linkage  6c545cc123a2a0e98f57f8f47be3510bf0e3053592e153e03747a1fe450f8587 — receipt, anchor #115 and the mandate file agree
PASS  anchor sequence       mandate_in #115 → payment_intake #116 → accepted #117 → delivered #118 → payment_balance #119 → receipt #120
PASS  payments on ledger    intake 1000000 tinybars 0.0.10365982 → 0.0.10365984 (0.0.7162784-1788963619-765994096); balance 4000000 tinybars 0.0.10365982 → 0.0.10365984 (0.0.7162784-1788963626-820218273)
PASS  receipt anchor        c2d75097959eef53a4eb85b2c2d36d33e9c40613388cd5b77a28ef68beb68538 anchored at #120 (1788963636.004054104)

VERIFIED — all 6 applicable checks passed against the public record.
```

Anyone can repeat the decoding by hand: take `z6MkpmqamYikcwnfPSEAAUQaz8spVNEnmbHi8RL2iy28T8F6` from
the receipt's `from`, base58-decode it, drop the two-byte `ed01` prefix, and the remaining 32 bytes
are `99573eae7ac7933b1205137b24558941b1fbc6ec2412d729704c27cf607b9bcd` — the `sig.pub` of the same
receipt.

## Limits

- **An identifier says which key, never whose key.** `did:key` binds a name to a keypair; it says
  nothing about which company holds it. What the chain proves, and what it does not, is unchanged by
  this extra — the statement the verifier prints on every run still stands exactly as it did.
- **Only `did:key` is decidable offline.** A `uaid:aid:` can be recomputed only by someone holding
  the six canonical fields, which no document here transports; other DID methods need resolution.
  Both are reported `N/A`.
- **`registry=self`, so there is nothing to look up.** These agents are in no registry; the standard
  prescribes `self` for exactly that case. A registry-listed deployment would set `registry` and
  `uid` and could then be discovered, which this repository does not attempt.
- **The card is a convenience, not a credential.** It tells a customer who to address. Everything
  that matters is re-derived later from the receipt itself.
- **Key rotation is out of scope.** An agent that changes its signing key changes its identifier, and
  old receipts keep naming the old one — correctly, because the old key is what signed them. HCS-14
  points at `alsoKnownAs` linkage for that; nothing here implements it.
- **The reserved skill range is enforced, the rest of the taxonomy is not.** `40–99` are rejected as
  the standard requires; whether a claimed skill is *true* is not something code can check.

## Notes for whoever writes the README

- The root `README.md` says "five checks" in several places, lists them in a five-row table, and its
  "A real run" section describes the run recorded in `demo/last-run.json`. There are six checks now,
  the sixth is `agent identity`, and a check can print `N/A`.
- `demo/last-run.json` was deliberately **not** updated by this lane, so it still records the run the
  README's table describes. The run above is a later one; re-run `npm run demo` and update both
  together if the README should point at a run that shows the identity check.
- The README's Standards-context section says of HCS-14 that "today this repository uses plain
  handles in `Envelope.from` / `Envelope.to`; adopting `uaid` is the natural next step and is listed
  in the plan". That is now done, and the same is true of the first item in the Roadmap list.
- `docs/schemas/*` and the proves/does-not-prove statement were not touched. They are copies of an
  upstream protocol, and this extra adds no claim about what the chain proves.
