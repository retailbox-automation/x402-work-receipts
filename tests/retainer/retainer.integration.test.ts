/**
 * The retainer, end to end on Hedera testnet: nothing here is mocked.
 *
 * The customer authorises a small transfer as a Scheduled Transaction, the
 * ledger holds it while the schedule reports no execution, the work is anchored
 * as delivered, the contractor releases it with a single signature, and the
 * public verifier — reading only the mirror node — agrees that all of that
 * happened in that order.
 *
 * Skipped entirely when `.env` has no accounts, which is why the unit suite
 * still runs on a machine with no Hedera credentials. It costs real testnet
 * HBAR: one schedule create, one schedule sign, three topic messages, and the
 * retainer itself, which moves between the two accounts of the pair.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { describe, expect, it } from "vitest";
import { operatorClient, submitAnchor } from "../../anchor/client";
import { ANCHOR_VERSION, type AnchorEntry, type AnchorRecord } from "../../anchor/records";
import { sha256Hex } from "../../protocol/canonical";
import type { Envelope, PaymentReceipt } from "../../protocol/types";
import { clientFor, loadRetainerConfig } from "../../retainer/cli";
import { buildRetainerAnchor, type RetainerFacts } from "../../retainer/records";
import {
  releaseRetainer,
  retainerStatus,
  waitForExecution,
  waitForSchedule,
} from "../../retainer/release";
import { scheduleRetainer } from "../../retainer/schedule";
import { checkRetainer } from "../../verifier/retainer";
import { readSchedule, readScheduledTransaction, readTopicAnchors } from "../../verifier/mirror";

const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(ENV_PATH)) {
  loadEnv({ path: ENV_PATH });
}

const CAN_RUN =
  existsSync(ENV_PATH) &&
  Boolean(
    process.env.HEDERA_OPERATOR_ID &&
      process.env.HEDERA_OPERATOR_KEY &&
      process.env.ANCHOR_TOPIC_ID &&
      (process.env.CUSTOMER_ACCOUNT_ID ?? process.env.PAYER_ACCOUNT_ID) &&
      (process.env.CONTRACTOR_PRIVATE_KEY ?? process.env.RECEIVER_PRIVATE_KEY),
  );

/** 0.01 ℏ — the same order of size as the intake fee, and cheap to repeat. */
const RETAINER_TINYBARS = 1_000_000;

/** Ten minutes: long enough to release by hand, short enough not to linger. */
const EXPIRY_SECONDS = 600;

describe.skipIf(!CAN_RUN)("retainer on Hedera testnet", () => {
  it("holds a transfer until the contractor releases it, and the verifier agrees", async () => {
    const config = loadRetainerConfig();
    const mandateId = `wo-ret-${Date.now()}`;
    const customer = clientFor(config.network, config.customer);
    const contractor = clientFor(config.network, config.contractor);
    const anchorClient = operatorClient();

    try {
      // 1 · the customer authorises the retainer, before any work exists.
      const scheduled = await scheduleRetainer(customer, {
        customerId: config.customer.accountId,
        contractorId: config.contractor.accountId,
        tinybars: RETAINER_TINYBARS,
        expiresInSeconds: EXPIRY_SECONDS,
        memo: `retainer ${mandateId}`,
      });
      console.log(`schedule:  ${scheduled.scheduleId}`);
      console.log(`hashscan:  https://hashscan.io/testnet/schedule/${scheduled.scheduleId}`);
      console.log(`topic:     https://hashscan.io/testnet/topic/${config.topicId}`);

      const facts: RetainerFacts = {
        network: config.network,
        payer: config.customer.accountId,
        payee: config.contractor.accountId,
        tinybars: RETAINER_TINYBARS,
        schedule_id: scheduled.scheduleId,
      };
      const scheduledAnchor = await submitAnchor(
        anchorClient,
        config.topicId,
        buildRetainerAnchor("scheduled", mandateId, facts),
      );
      console.log(`anchored retainer_scheduled #${scheduledAnchor.seq}`);

      // 2 · nothing has moved: the transfer waits for the contractor's signature.
      // The wait is for the mirror node's indexing lag, not for the ledger: the
      // schedule exists the moment its create reaches consensus.
      await waitForSchedule(scheduled.scheduleId);
      const pending = await retainerStatus(scheduled.scheduleId);
      expect(pending.schedule?.schedule_id).toBe(scheduled.scheduleId);
      expect(pending.schedule?.creator_account_id).toBe(config.customer.accountId);
      expect(pending.schedule?.payer_account_id).toBe(config.contractor.accountId);
      expect(pending.executedAt).toBeNull();
      expect(pending.transfer).toBeNull();

      // 3 · the work is done and anchored, which is what the release must follow.
      const deliveredAnchor = await submitAnchor(anchorClient, config.topicId, {
        v: ANCHOR_VERSION,
        kind: "delivered",
        mandate_id: mandateId,
        hash: sha256Hex(`delivered:${mandateId}`),
        at: new Date().toISOString(),
      } satisfies AnchorRecord);
      console.log(`anchored delivered #${deliveredAnchor.seq}`);

      // 4 · one signature from the contractor, and the ledger executes it.
      const released = await releaseRetainer(contractor, scheduled.scheduleId);
      expect(released.status).toBe("SUCCESS");

      const executed = await waitForExecution(scheduled.scheduleId);
      expect(executed.executedAt).toBeTruthy();
      expect(executed.transfer?.scheduled).toBe(true);
      expect(executed.transfer?.result).toBe("SUCCESS");
      // Matched field by field: the mirror node also sets `is_approval`, which
      // is not part of what a retainer has to prove.
      expect(executed.transfer?.transfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ account: config.customer.accountId, amount: -RETAINER_TINYBARS }),
          expect.objectContaining({ account: config.contractor.accountId, amount: RETAINER_TINYBARS }),
        ]),
      );
      console.log(`released:  ${executed.transfer?.transaction_id} at ${executed.executedAt}`);
      console.log(
        `hashscan:  https://hashscan.io/testnet/transaction/${executed.executedAt}`,
      );

      const releasedAnchor = await submitAnchor(
        anchorClient,
        config.topicId,
        buildRetainerAnchor("released", mandateId, {
          ...facts,
          transaction_id: executed.transfer?.transaction_id as string,
        }),
      );
      console.log(`anchored retainer_released #${releasedAnchor.seq}`);

      // 5 · a stranger reads the topic and the ledger and reaches the same verdict.
      const anchors = await readAnchorsUntil(config.topicId, mandateId, 3);
      const schedule = await readSchedule(scheduled.scheduleId);
      const release = await readScheduledTransaction(executed.transfer?.transaction_id as string);

      const verdict = checkRetainer(
        {
          topicId: config.topicId,
          receipt: receiptFor(config.customer.accountId, config.contractor.accountId, config.network),
          anchors,
          transactions: new Map(),
          retainer: { schedule, release },
        },
        anchors,
      );
      console.log(`verdict:   ${verdict.ok ? "PASS" : "FAIL"} — ${verdict.detail}`);
      expect(verdict.ok).toBe(true);
      expect(verdict.detail).toContain(scheduled.scheduleId);
    } finally {
      customer.close();
      contractor.close();
      anchorClient.close();
    }
  }, 300_000);
});

/**
 * Reads the topic until this order's anchors have all been indexed.
 *
 * @param topicId - The audit topic
 * @param mandateId - The order to wait for
 * @param expected - How many anchors it should have
 * @returns That order's anchors
 */
async function readAnchorsUntil(
  topicId: string,
  mandateId: string,
  expected: number,
): Promise<AnchorEntry[]> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const all = await readTopicAnchors(topicId);
    const mine = all.filter(anchor => anchor.mandate_id === mandateId);
    if (mine.length >= expected || Date.now() >= deadline) {
      return mine;
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
}

/**
 * The minimum of a delivery receipt the retainer check reads: which two
 * accounts, on which network. Everything else about the receipt belongs to the
 * five required checks, which this test does not repeat.
 *
 * @param payer - Customer account
 * @param payee - Contractor account
 * @param network - CAIP-2 network
 * @returns A receipt envelope shaped for the check
 */
function receiptFor(payer: string, payee: string, network: string): Envelope<PaymentReceipt> {
  return {
    data: { payment: { network, asset: "0.0.0", payer, payee } },
  } as unknown as Envelope<PaymentReceipt>;
}
