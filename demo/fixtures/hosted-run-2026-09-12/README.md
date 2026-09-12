# One real run, bundled so the browser verifier has something to verify

These are the two documents a customer keeps after ordering from the **hosted** contractor at
`https://x402-work-receipts.zeabur.app` — the signed work order it sent, and the signed delivery
receipt it got back with the payment profile inside. Nothing else: no keys, no tokens, no host
configuration. Both files are what `npm run customer -- order` writes to `out/hosted/<mandate_id>/`.

They are here because a verifier with nothing to verify proves nothing to a visitor. `GET /verify/demo`
serves exactly these two files, so the page's "Load the demo run" button fills the form with a real
order rather than a hand-made example, and pressing Verify reads the live mirror node.

| What | Value |
|---|---|
| Order | `01a09578-9b95-7262-a5b9-84bda0ad65cf` |
| Audit topic | `0.0.10426298` |
| Anchors | `#184` – `#189` (`mandate_in`, `payment_intake`, `accepted`, `delivered`, `payment_balance`, `receipt`) |
| Intake payment | `0.0.7162784@1789214099.545024750` |
| Balance payment | `0.0.7162784@1789214127.930006280` |
| Date | 2026-09-12, Hedera testnet |

The story text inside the work order is synthetic, written for the demo. The signatures, hashes,
transaction ids and public keys are real, which is the point: every one of them can be checked against
the public record by someone who has spoken to neither party.

Verify them from a terminal instead of the browser:

```bash
npm run verify -- --topic 0.0.10426298 \
  --receipt demo/fixtures/hosted-run-2026-09-12/receipt.json \
  --mandate demo/fixtures/hosted-run-2026-09-12/mandate.json
```
