# Retainer — a Scheduled Transaction the contractor releases after delivering

A customer can put money behind an order before the work exists, without handing
it over. The retainer is an ordinary HBAR transfer from the customer to the
contractor, wrapped in a Hedera **Scheduled Transaction**: the authorisation is
public and fixed on the ledger from the start, nothing moves until the
contractor releases it, and if the contractor never does, the schedule expires
and the customer keeps the balance.

Two anchors record it on the same audit topic as the rest of the order, so the
public verifier picks the retainer up from the topic alone. The `mandate.v1`,
`receipt.v1` and `payment.v1` schemas are byte-identical copies of an external
protocol and were **not** touched to make room for this.

## How it holds

Two facts do all the work, both verified on testnet before this was written:

1. **The customer signs the `ScheduleCreate`**, and that signature counts as the
   sender's signature on the inner transfer. The authorisation exists, in
   public, before anyone has done anything.
2. **The contractor is named as the scheduled transaction's payer account**, and
   a scheduled transaction does not execute until its payer has signed. So the
   release is genuinely in the contractor's hands — and the contractor pays the
   fee for collecting.

After the create the mirror node shows one signature and `executed_timestamp:
null`. After the contractor's `ScheduleSign` it shows two signatures and an
execution timestamp, and the transfer is on the ledger.

The expiry is set explicitly (default 30 minutes, the network's ceiling is 62
days) and `wait_for_expiry` is **false**: the retainer should move when the
contractor releases it, not on a timer.

## Running it

```bash
# the customer authorises, and anchors retainer_scheduled
npm run retainer -- create --mandate <mandate_id> [--tinybars 1000000] [--expires-in 600]

# the contractor releases after delivering, and anchors retainer_released
npm run retainer -- release --mandate <mandate_id> --schedule 0.0.x

# anyone reads the public record; holds no keys
npm run retainer -- status --schedule 0.0.x
```

Additional `.env` values, all optional except the contractor's key:

| Variable | Default | Meaning |
|---|---|---|
| `CONTRACTOR_PRIVATE_KEY` | falls back to `RECEIVER_PRIVATE_KEY` | The key the contractor releases with. New: until now the contractor only received money and never signed a transfer |
| `CONTRACTOR_KEY_TYPE` | `ecdsa` | How that key is parsed |
| `CUSTOMER_KEY_TYPE` | `ecdsa` | Same, for the customer's payment key |
| `RETAINER_TINYBARS` | `1000000` (0.01 ℏ) | Amount held when `--tinybars` is not given |
| `RETAINER_EXPIRY_SECONDS` | `1800` | Window when `--expires-in` is not given; 60 … 5 356 800 |

The customer side reuses the customer agent's own payment identity
(`CUSTOMER_ACCOUNT_ID` / `PAYER_ACCOUNT_ID`), so a retainer is authorised by
exactly the account that pays for the order.

## What the verifier now checks

A sixth check, `retainer on ledger`, joins the five. It is **optional by
construction**: an order whose topic carries no `retainer_*` anchor is reported
as *not applicable*, never failed, and `EXPECTED_STEPS` still requires the same
six anchors — so every order without a retainer verifies exactly as before.

When a retainer *is* anchored the check is strict. Reading nothing but the
public mirror node, it confirms that:

- the schedule named by `retainer_scheduled` exists, is not deleted, and was
  **created by the account the receipt names as payer** — the customer really
  authorised it;
- the transaction named by `retainer_released` is the transfer a schedule
  executed (`scheduled: true`), succeeded, and reached consensus at exactly the
  schedule's `executed_timestamp`;
- that transfer **debits the payer and credits the payee** the same amount;
- both anchored hashes **recompute** from those ledger facts, so an anchor
  claiming a different amount, account, network or schedule fails;
- the release reached consensus **after the `delivered` anchor**. This is the
  whole difference between a retainer released for work and a payment that
  happened to be scheduled, and both instants are fixed by consensus rather than
  by either party's clock.

Before the release there is nothing to fail: the check reports the
authorisation as *still pending*, with its expiry.

## A real run

Hedera testnet, 2026-09-09, order `wo-ret-1788963564713`, topic
[`0.0.10426298`](https://hashscan.io/testnet/topic/0.0.10426298).

| What | Where |
|---|---|
| Schedule | [`0.0.10440517`](https://hashscan.io/testnet/schedule/0.0.10440517) — created `1788963565.088024184`, expiry `1788964164.000000000`, 2 signatures |
| Authorised by | `0.0.10365982` (customer) |
| Released by | `0.0.10365984` (contractor, the scheduled payer) |
| Executed transfer | [`0.0.10365982@1788963559.838648293`](https://hashscan.io/testnet/transaction/0.0.10365982-1788963559-838648293) — `CRYPTOTRANSFER`, `scheduled: true`, `1788963570.036220105`, −1 000 000 / +1 000 000 tinybars |

The three anchors of that run, in consensus order:

| # | Kind | Consensus timestamp | `ref` |
|---|---|---|---|
| 112 | `retainer_scheduled` | 1788963567.109755972 | `0.0.10440517` |
| 113 | `delivered` | 1788963568.663429526 | — |
| 114 | `retainer_released` | 1788963574.079858648 | `0.0.10365982-1788963559-838648293` |

Reproduced by `tests/retainer/retainer.integration.test.ts`, which runs the
whole thing — authorise, confirm pending, anchor the delivery, release, anchor
it, then verify — and asserts the verifier's verdict at the end.

## Gotchas worth keeping

- **A schedule and the transfer it runs share one transaction id.**
  `/api/v1/transactions/{id}` therefore answers with two records, both `SUCCESS`:
  the `ScheduleCreate`, whose transfer list is a network fee, and the transfer
  itself. Only the `scheduled: true` flag tells them apart, so the existing
  "first successful record" reader would have returned the wrong one.
  `readScheduledTransaction` exists for this.
- **A schedule does not publish the transaction id of the transfer it executed**
  — the transfer inherits the id of the `ScheduleCreate`, whose own consensus
  timestamp is a *different* instant. The join is `executed_timestamp` →
  `/api/v1/transactions?timestamp=…`, which is what `retainerStatus` does.
- **The SDK prints the scheduled transaction id with a `?scheduled` suffix.** The
  mirror node will not accept it in a path; `toMirrorScheduledTxId` strips it.
- **The mirror node answers 404 for a schedule for a second or two after it is
  created.** Read immediately and "not on the mirror node" comes back — the same
  answer a mistyped id gives. `waitForSchedule` covers the lag.
- **A `retainer_scheduled` anchor carries a schedule id, a `retainer_released`
  anchor a transaction id**, and `assertWritableAnchor` refuses the wrong one:
  putting either where the other belongs sends every later reader to the wrong
  endpoint, on a topic that is permanent.
- **The amount is only confirmed on release.** While a retainer is pending, the
  amount lives inside the scheduled transaction body, which the mirror node
  publishes as protobuf; the verifier does not decode it, and says so rather
  than implying the pending amount was checked.

## For the docs lane

The README currently says the verifier has **five** checks, in two places (the
"Verifying it yourself" table and the section above it). With this merged there
are six, the sixth being optional. `tests/verifier/checks.test.ts` also has a
test *titled* "passes all five checks" — it asserts against `CHECK_NAMES` and
passes unchanged, but the title is now stale. Both were left alone deliberately:
this lane did not edit the README or existing tests.
