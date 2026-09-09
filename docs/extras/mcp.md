# MCP server

`mcp/server.ts` exposes the whole flow as three [Model Context Protocol](https://modelcontextprotocol.io)
tools — `order`, `collect`, `verify` — over stdio, so any MCP-speaking agent runtime (Claude Code, Claude
Desktop, or any other MCP client) can drive an order without shelling out to the CLIs.

It is a thin wrapper. Every tool calls the same functions the CLIs call: `customer/cli.ts` and
`customer/pay.ts` for signing and paying, `verifier/cli.ts` for checking a receipt against the public
mirror node. Nothing about x402, envelope signing, schema validation or the verifier's checks is
re-implemented here — this file only adapts them to MCP's tool-call shape and shapes the reply as
structured JSON plus a matching text block.

## Run it

```bash
npm run mcp
```

This starts the server on stdio and blocks; a client (see below) connects to it as a subprocess.
Configuration is the same `.env` the CLIs read — `CUSTOMER_SIGNING_KEY`, `CUSTOMER_ACCOUNT_ID`,
`CUSTOMER_PRIVATE_KEY`, `CONTRACTOR_URL`, `CUSTOMER_OUT_DIR`, and the rest of the `CUSTOMER_*` and
`HEDERA_*` variables documented in the repository [`README.md`](../../README.md#setup).

## Registering it with a client

Any MCP client that can launch a stdio server works. A minimal `.mcp.json` (the shape Claude Code reads
from a project root, or from `claude mcp add-json`):

```json
{
  "mcpServers": {
    "x402-work-receipts": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts"],
      "cwd": "/absolute/path/to/x402-work-receipts"
    }
  }
}
```

## The three tools

| Tool | Input | What it does |
|---|---|---|
| `order` | `story` (inline) **or** `storyPath`, plus optional `to` / `out` | Signs a `mandate.v1`, pays the intake fee, stores the acceptance. Returns the taken/declined criteria and the anchor topic. |
| `collect` | `mandateId`, plus optional `to` / `out` | Pays the balance once delivered, stores `receipt.v1+payment.v1`. Returns both payment legs with their amounts (from the signed receipt, not from the client's own record of what it sent) and the deliverable links. |
| `verify` | `topic`, plus `receiptPath` **or** `receipt` (inline JSON), optionally `mandatePath` / `mandate` | Runs the same checks the `verify` CLI runs, against the public mirror node only. Returns `verdict` (`PASS`/`FAIL`/`ERROR`), `exit_code` (0/1/2, same meaning as the CLI), the check table, and the full printable report. |

`order`'s `story` and `collect`'s deliverable both flow straight from `customer/cli.ts`'s own types — an
inline `story` argument is the same shape as a story-card JSON file (`story_ref`, `story_url`, `title`,
`acceptance[]`, `frame`, optional `due`).

A `verify` call given an inline `receipt`/`mandate` writes it to a scratch file and calls the exact same
`verify()` a file path would — one loading and validation path either way, not a second one.

### Errors

Every tool catches its own failures and returns them as a normal MCP result with `isError: true` — a
schema violation, an unreachable contractor, a bad receipt file. The process itself never crashes on bad
input; a client always gets an answer, not a dropped connection.

## Tests

`tests/mcp/server.test.ts` connects a real `@modelcontextprotocol/sdk` `Client` to the server over
`InMemoryTransport.createLinkedPair()` — no stdio, no subprocess, but the same protocol messages a real
client sends. It lists the tools and runs `verify` against the golden and tampered fixtures already used
by `tests/verifier/`, injecting offline mirror reads so the suite never touches the network.

`tests/mcp/order.test.ts` and `tests/mcp/collect.test.ts` call `runOrderTool` / `runCollectTool` directly
against a local stand-in contractor (`tests/mcp/helpers.ts`) — a plain `node:http` server that speaks the
same 402 → pay → 201/200 dance as the real one and builds its receipts with the real
`contractor/receipts.ts` builders, so the shape under test is the real receipt shape. The payment is a
real signed Hedera transfer built by the x402 Hedera scheme; the only thing absent is the network — no
testnet, no facilitator, no HCS topic. `npm run test:unit` runs all of it offline.

## A real run

Verified by hand against the real contractor (`npm run contractor:start`, real testnet credentials) and
the real MCP server, through a real `@modelcontextprotocol/sdk` client — `tools/list`, then `order`,
`collect` and `verify` as tool calls, with the contractor's own delivery route called directly in between
(delivery isn't an MCP tool; nothing in the flow needs it to be, since the customer only ever calls
`order` and `collect`).

Order `01a08689-0b4c-7b08-b092-67c02635afe8`, 2026-09-09, Hedera testnet, topic
[`0.0.10426298`](https://hashscan.io/testnet/topic/0.0.10426298):

- **`order`** → intake paid,
  [`0.0.7162784@1788963519.791801487`](https://hashscan.io/testnet/transaction/0.0.7162784@1788963519.791801487),
  anchored `mandate_in` #104, `payment_intake` #106, `accepted` #107.
- **`collect`** → balance paid,
  [`0.0.7162784@1788963528.689876936`](https://hashscan.io/testnet/transaction/0.0.7162784@1788963528.689876936),
  anchored `delivered` #108, `payment_balance` #109, `receipt` #110.
- **`verify`** → `{"verdict":"PASS","exit_code":0}`, all 5 checks — the transcript below is the run as it
  happened, before the `agent identity` and `retainer on ledger` checks existed; the same order verifies
  today with those two reported `N/A`:

```
      check                 detail
PASS  receipt signature     signed by 99573eae7ac7… over the receipt as issued
PASS  mandate hash linkage  e4d2d020374c…f426 anchored at #104; no mandate file given, so the
                            fingerprint was not recomputed
PASS  anchor sequence       mandate_in #104 → payment_intake #106 → accepted #107 → delivered #108
                            → payment_balance #109 → receipt #110
PASS  payments on ledger    intake 1000000 tinybars 0.0.10365982 → 0.0.10365984
                            (0.0.7162784-1788963519-791801487); balance 4000000 tinybars
                            0.0.10365982 → 0.0.10365984 (0.0.7162784-1788963528-689876936)
PASS  receipt anchor        67394e30b743…7534 anchored at #110 (1788963536.083204088)

VERIFIED — all 5 checks passed against the public record.
```

The run script that produced this was a throwaway wrapper (connect a client, call the three tools,
call the contractor's delivery route directly in between) and was not kept — the tests above cover the
same three tools without a live contractor.

## Limits

- **No `deliver` tool.** Delivery is the contractor's own pipeline finishing the work, not something the
  customer side of this repository calls — it stays a plain HTTP route (`POST /mandates/{id}/deliver`,
  token-gated), not an MCP tool. The two MCP-facing actors, in this repository's own words, are the
  customer's `order`/`collect` and anyone's `verify`.
- **One process per identity.** The signing and payment identities come from `.env` at server start, the
  same as the CLI — this server does not multiplex several customer identities behind one stdio
  connection.
- **`verify` still talks only to the public mirror node.** The MCP wrapper adds no new trust: the
  verifier's mirror-node url is a constant in `verifier/mirror.ts`, not an environment variable, by
  design — a verifier a caller could point elsewhere would prove nothing to a stranger, and that
  property does not change by being reached over MCP instead of the CLI.
