/**
 * The verifier against the live mirror node.
 *
 * Nothing is stubbed here: the anchors and both transfers are read from
 * `testnet.mirrornode.hedera.com` as anyone would read them. The order is the
 * one recorded in `golden/`, which really happened on 2026-09-08 and is
 * permanent, so this test stays meaningful without a fresh payment.
 *
 * Skipped when `.env` is absent, in line with the rest of the suite — the
 * verifier itself needs no credentials, but a machine without `.env` is also
 * the machine we do not assume has network access to a public node.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toMirrorTxId } from "../../anchor/records";
import { CHECK_NAMES } from "../../verifier/checks";
import { EXIT_FAILED, EXIT_OK, verify } from "../../verifier/cli";
import { readTopicAnchors, readTransaction } from "../../verifier/mirror";
import { GOLDEN_TOPIC, goldenReceipt } from "./helpers";

const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));
const CAN_RUN = existsSync(ENV_PATH);

/** Path of a fixture as a user would pass it on the command line. */
function path(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

describe.skipIf(!CAN_RUN)("verifier against the public mirror node", () => {
  it("reads the shared topic and finds this order among the others", { timeout: 60_000 }, async () => {
    const anchors = await readTopicAnchors(GOLDEN_TOPIC);
    const mandateId = goldenReceipt().data.mandate_id;
    const mine = anchors.filter(anchor => anchor.mandate_id === mandateId);
    expect(mine).toHaveLength(6);
    expect(anchors.length).toBeGreaterThan(mine.length);
  });

  it("finds both settled transfers on the ledger", { timeout: 60_000 }, async () => {
    const payment = goldenReceipt().data.payment;
    for (const leg of [payment.intake, payment.balance!]) {
      const transaction = await readTransaction(leg.transaction_id);
      expect(transaction?.result).toBe("SUCCESS");
      expect(transaction?.transaction_id).toBe(toMirrorTxId(leg.transaction_id));
      expect(
        transaction?.transfers.some(
          transfer => transfer.account === payment.payee && transfer.amount === leg.tinybars,
        ),
      ).toBe(true);
    }
  });

  it("verifies the recorded run end to end", { timeout: 90_000 }, async () => {
    const result = await verify({
      topicId: GOLDEN_TOPIC,
      receiptPath: path("./golden/receipt.json"),
      mandatePath: path("./golden/mandate.json"),
    });
    expect(result.checks.map(check => check.name)).toEqual([...CHECK_NAMES]);
    expect(result.checks.filter(check => !check.ok)).toEqual([]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.output).toContain("VERIFIED");
  });

  it("refuses a tampered receipt against the same live record", { timeout: 90_000 }, async () => {
    const result = await verify({
      topicId: GOLDEN_TOPIC,
      receiptPath: path("./tampered/wrong-payee.json"),
      mandatePath: path("./golden/mandate.json"),
    });
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.output).toContain("NOT VERIFIED");
  });
});
