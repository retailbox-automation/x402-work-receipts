# anchor — the public audit log on Hedera Consensus Service

Every step of an order (ordered, paid, accepted, delivered, paid again, receipt issued) is written to
an HCS topic as a small `wr-anchor.v1` record. A record carries **only hashes and public ids** — never
the work order, the deliverable or anything else a competitor would like to read. Anyone can then
replay the order from the public mirror node without asking either company for anything.

| File | Role |
|---|---|
| `records.ts` | The `wr-anchor.v1` shape, its canonical bytes, and the transaction-id conversion the mirror node needs |
| `topic.ts` | Creates the topic; also the `npm run anchor:create-topic` script |
| `client.ts` | Builds the Hedera client from `.env`, submits anchors, reads them back from the mirror node |

## The topic

```bash
npm run anchor:create-topic     # needs HEDERA_OPERATOR_* in .env
```

It prints the line to paste into `.env` and never edits the file itself. The run on 2026-09-04:

| | |
|---|---|
| Topic | `0.0.10366318` |
| Memo | `x402-work-receipts anchors` |
| HashScan | https://hashscan.io/testnet/topic/0.0.10366318 |
| Mirror node | https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10366318/messages |
| `.env` line | `ANCHOR_TOPIC_ID=0.0.10366318` |

## The integration run

`tests/anchor/anchor.integration.test.ts` is not a mock: it creates a fresh topic, submits two
anchors and one message that is deliberately *not* an anchor, then reads everything back from the
public mirror node. It is skipped when `.env` has no operator, so `npm test` still works on a machine
with no Hedera credentials.

The first real run, 2026-09-04 17:06 UTC:

| | |
|---|---|
| Topic | `0.0.10366321` |
| HashScan | https://hashscan.io/testnet/topic/0.0.10366321 |
| Messages | https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10366321/messages |

Both topics were confirmed by rendering the HashScan page in a browser, because HashScan answers
`404` to `curl` on every deep link while rendering fine (`spike/README.md` gotcha 3).

What that topic holds, straight from the mirror node:

```
1  1788541611.325778104  {"at":"2026-09-04T17:06:48.576Z","hash":"20cd309f…dc96","kind":"mandate_in","mandate_id":"wo-int-1788541608576","v":"wr-anchor.v1"}
2  1788541612.585759402  {"at":"2026-09-04T17:06:50.990Z","hash":"a862dd7c…4429","kind":"payment_intake","mandate_id":"wo-int-1788541608576","ref":"0.0.7162784-1788539653-433840739","v":"wr-anchor.v1"}
3  1788541614.521543104  not an anchor at all
```

`tests/anchor/fixtures/topic-messages.json` is that mirror-node response recorded verbatim (only
re-indented), so the parsing tests run against real data rather than something we invented. The
message at sequence 3 is why `readAnchors` returns two records and not three.

## Reading the log

```ts
import { readAnchors } from "./anchor/client";

const anchors = await readAnchors("0.0.10366318");          // everything, oldest first
const recent  = await readAnchors("0.0.10366318", { since: "1788541611.325778104" });
```

Reading needs no key and no account: it is plain REST against
`https://testnet.mirrornode.hedera.com`. `HEDERA_MIRROR_NODE_URL` points it at another network, and
`ANCHOR_MIRROR_TIMEOUT_MS` (30 000 by default) is how long a read keeps retrying while the mirror node
lags consensus by a second or two.

## Decisions worth knowing

**The topic has no admin key and no submit key.** It cannot be edited or deleted afterwards, which is
the point of an audit log, and anyone may write to it. That is safe here because nothing is trusted
because it is on the topic: every anchor is a hash the verifier recomputes from a signed document, so
a message from a stranger proves nothing. `readAnchors` therefore skips anything that is not a
well-formed `wr-anchor.v1` record instead of failing on it.

**Transaction ids are stored in mirror-node form.** The facilitator returns
`0.0.7162784@1788539653.433840739`; the mirror node uses `0.0.7162784-1788539653-433840739`. Comparing
the two forms directly is the false negative recorded in `spike/README.md` gotcha 2 — a payment that
had settled perfectly read as "not found". `toMirrorTxId` / `fromMirrorTxId` are the only place that
conversion happens, and a payment anchor is refused before submission unless its `ref` is already in
mirror form.

**`submitAnchor` never retries by itself.** A submit that fails locally may still have reached
consensus, and a retry would put a duplicate anchor on a permanent public log. A caller that needs to
retry (the spec's "settle succeeded but anchoring failed" path) should read the topic back first and
check whether the anchor landed.

**The canonicalizer in `records.ts` is temporary.** It is a minimal RFC 8785 implementation — sorted
keys, no whitespace, JavaScript number and string semantics — kept local so this module has no
dependency on `protocol/`, which is built separately. It is to be replaced by `protocol/canonical.ts`
on merge; the output is byte-identical, so anchors written before and after the swap stay comparable.

**Anchors are validated before they are written.** A record with an uppercase hash, a hash that is not
64 hex characters, an unknown kind, a non-date `at`, or a payment step without a transaction id is
rejected in `encodeAnchor` rather than becoming a permanent, unfixable message. Reading is more
forgiving than writing on purpose: we would rather read a record that differs from our own convention
than go blind to it.

## What this does not do

- No submit-key access control and no HIP-991 custom fee on the topic (the fee is a later, optional
  step; it has to be proven not to break `submitAnchor` first).
- No chunking: an anchor is far below the 1 KiB single-message limit, and messages that arrive chunked
  are treated as somebody else's.
- Hashes come from the caller. Producing them (`envelopeHash`) belongs to `protocol/`.
- Testnet only.
