# Demo fallback — when the network is not cooperating

A live demo of this project depends on three things that are outside the room: Hedera testnet, the
Blocky402 facilitator, and the public mirror node. Any of them can be slow while someone is watching.
This page is the offline path: everything below runs with **no network at all**, from evidence that is
already in the repository, and it shows the same two things a live run shows — a receipt that holds up,
and a tampered one that does not.

Set it up before the session starts, not during it.

---

## Before the call (5 minutes, once)

```bash
git clone https://github.com/retailbox-automation/x402-work-receipts
cd x402-work-receipts
npm ci                      # the only step that needs network
```

Open these browser tabs ahead of time, so a slow page load never happens on camera:

| Tab | Url |
|---|---|
| Audit topic | https://hashscan.io/testnet/topic/0.0.10426298 |
| Intake payment | https://hashscan.io/testnet/transaction/0.0.7162784@1789130259.977921983 |
| Balance payment | https://hashscan.io/testnet/transaction/0.0.7162784@1789130270.259648782 |
| Hosted agent card | https://x402-work-receipts.zeabur.app/.well-known/agent.json |
| README | https://github.com/retailbox-automation/x402-work-receipts#a-real-run |

Loaded tabs keep working after the wifi dies. That alone covers most of the risk.

---

## Path A — the offline verifier suite (no network, ~0.3 s)

The repository carries a recorded snapshot of exactly what the mirror node returned for one real run:
`tests/verifier/golden/` holds the signed mandate, the signed receipt, the whole topic page and both
transaction bodies. The checks run against that snapshot, so they do not need a node to be reachable.

```bash
npx vitest run tests/verifier/checks.test.ts tests/verifier/cli.test.ts \
  tests/verifier/identity.test.ts tests/verifier/retainer.test.ts tests/verifier/statement.test.ts
```

Expected: **5 files, 85 tests, passed.** What to say while it runs:

> This is the verifier deciding on a real run, from a recorded copy of the public record. The same
> functions run against the live mirror node — I am only replacing the network, not the evidence.

Inside that suite is the part worth pointing at: `tests/verifier/tampered/` holds four copies of the
same run with one thing changed in each, and `cli.test.ts` asserts which check each one breaks.

| Fixture | What was changed | Check it breaks |
|---|---|---|
| `edited-receipt-hash.json` | one character of the mandate fingerprint | mandate hash linkage (plus signature, plus receipt anchor) |
| `swapped-tx-id.json` | the two payment transaction ids exchanged | payments on ledger |
| `wrong-payee.json` | the payee set to an account that was never credited | payments on ledger |
| `missing-anchor/topic-messages.json` | the `delivered` anchor removed from the topic page | anchor sequence |

The last one is the one to narrate:

> That fixture does not touch the receipt. It deletes a step from the public log instead — and the
> verifier still notices, because the contractor does not own that log.

---

## Path B — the saved run, read out loud (no network, no commands)

`demo/last-run.json` is the machine-readable record of the run the README describes, and
`demo/last-run.txt` is the verifier's own output from it, verbatim.

```bash
cat demo/last-run.txt                  # the verdict table, as it was printed
python3 -m json.tool demo/last-run.json | head -40
```

Talking points, all of them checkable later by the person watching:

- order `01a09079-548a-719d-9047-d8f4e028d126`, 2026-09-11, placed **against the hosted contractor**
  `https://x402-work-receipts.zeabur.app`, not a local process;
- six anchors `#148` → `#153` on topic `0.0.10426298`, hashes only, no content;
- two settled HBAR transfers, `0.0.10365982` → `0.0.10365984`, the network fee paid by the
  facilitator `0.0.7162784`;
- verdict `VERIFIED`, six applicable checks passed, one `N/A` — and the `N/A` is the point:
  the report says what the evidence establishes rather than rounding a silence up to a pass.

> Every id on this screen is in the README, and every one of them resolves on HashScan. Nothing here
> asks you to trust me: check it after the call.

---

## Path C — live verifier, mirror node only (needs network, no payment)

If the network is up but testnet or the facilitator is slow, this is the middle path: it re-verifies
the saved run against the live mirror node. It signs nothing, pays nothing and takes a few seconds.

```bash
npx vitest run tests/verifier/verifier.integration.test.ts
```

That suite reads the real topic and both real transfers from `testnet.mirrornode.hedera.com`. It skips
itself when there is no `.env` in the repository root, so on a clean clone it is a no-op rather than a
red failure — if it prints "skipped", fall back to Path A and say so.

---

## What not to attempt on a slow connection

**Do not run `npm run demo` or a fresh order against the host.** It costs two real testnet payments and
waits on two things that are genuinely asynchronous — the facilitator's sync and the mirror node's
indexing lag, which has taken up to a minute and a half. Verifying immediately after collecting
correctly reports the receipt anchor as missing; that is the verifier being honest, but it is a bad
thing to explain under time pressure.

If a live paid run is wanted anyway, record it beforehand on a good connection and play the recording.

---

## One-line decision rule

Network fine and time to spare → Path C, then Path B for the ids. Network doubtful → Path A, then
Path B. Nothing works at all → the pre-loaded HashScan tabs plus `demo/last-run.txt`, which is the same
evidence and needs nothing but the screen.
