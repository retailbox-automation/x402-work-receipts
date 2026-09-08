/**
 * Integration test against Hedera testnet. It creates a throwaway topic, writes
 * anchors to it and reads them back from the public mirror node, so nothing here
 * is mocked. Skipped entirely when `.env` has no operator, which is why the unit
 * suite still runs on a machine with no Hedera credentials.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { describe, expect, it } from "vitest";
import { TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { operatorClient, readAnchors, submitAnchor } from "../../anchor/client";
import { ANCHOR_VERSION, type AnchorRecord, encodeAnchor, toMirrorTxId } from "../../anchor/records";
import { ANCHOR_TOPIC_MEMO, createTopic } from "../../anchor/topic";

const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(ENV_PATH)) {
  loadEnv({ path: ENV_PATH });
}

const CAN_RUN =
  existsSync(ENV_PATH) && Boolean(process.env.HEDERA_OPERATOR_ID && process.env.HEDERA_OPERATOR_KEY);

/** A settled payment from the day-1 spike, used as a realistic `ref`. */
const SPIKE_TX_ID = "0.0.7162784@1788539653.433840739";

/**
 * sha-256 hex of a string, standing in for `protocol/envelope.ts`'s
 * `envelopeHash` until that lane merges.
 *
 * @param value - Value to hash
 * @returns Lowercase hex digest
 */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe.skipIf(!CAN_RUN)("anchor on Hedera testnet", () => {
  it("creates a topic, submits two anchors and reads both back within 30 s", async () => {
    const client = operatorClient();
    const startedAt = new Date().toISOString();
    const mandateId = `wo-int-${Date.parse(startedAt)}`;

    try {
      const topicId = await createTopic(client, ANCHOR_TOPIC_MEMO);
      console.log(`integration topic: ${topicId}`);
      console.log(`hashscan:          https://hashscan.io/testnet/topic/${topicId}`);

      const mandateIn: AnchorRecord = {
        v: ANCHOR_VERSION,
        kind: "mandate_in",
        mandate_id: mandateId,
        hash: sha256Hex(`mandate:${mandateId}`),
        at: startedAt,
      };
      const paymentIntake: AnchorRecord = {
        v: ANCHOR_VERSION,
        kind: "payment_intake",
        mandate_id: mandateId,
        hash: sha256Hex(`intake:${mandateId}`),
        ref: toMirrorTxId(SPIKE_TX_ID),
        at: new Date().toISOString(),
      };

      const first = await submitAnchor(client, topicId, mandateIn);
      const second = await submitAnchor(client, topicId, paymentIntake);

      expect(first.seq).toBe(1);
      expect(second.seq).toBe(first.seq + 1);
      expect(first.consensus_ts).toMatch(/^\d+\.\d{9}$/);
      expect(second.consensus_ts).toMatch(/^\d+\.\d{9}$/);
      // Compared as integer nanoseconds: a float cannot hold 19 significant digits.
      expect(nanoseconds(second.consensus_ts)).toBeGreaterThan(nanoseconds(first.consensus_ts));

      // A message from a stranger: the topic has no submit key, so a reader must
      // tolerate one instead of failing on it.
      await new TopicMessageSubmitTransaction()
        .setTopicId(TopicId.fromString(topicId))
        .setMessage("not an anchor at all")
        .execute(client)
        .then(response => response.getReceipt(client));

      const deadline = Date.now() + 30_000;
      let entries = await readAnchors(topicId);
      while (entries.length < 2 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        entries = await readAnchors(topicId);
      }

      expect(Date.now()).toBeLessThan(deadline);
      expect(entries).toHaveLength(2);
      expect(entries.map(entry => entry.seq)).toEqual([first.seq, second.seq]);

      const [readMandateIn, readPaymentIntake] = entries;
      expect(encodeAnchor(stripPosition(readMandateIn))).toBe(encodeAnchor(mandateIn));
      expect(encodeAnchor(stripPosition(readPaymentIntake))).toBe(encodeAnchor(paymentIntake));

      // The consensus timestamp the SDK reported and the one the mirror node
      // publishes are the same instant, printed the same way.
      expect(readMandateIn.consensus_ts).toBe(first.consensus_ts);
      expect(readPaymentIntake.consensus_ts).toBe(second.consensus_ts);

      const after = await readAnchors(topicId, { since: first.consensus_ts });
      expect(after.map(entry => entry.seq)).toEqual([second.seq]);
    } finally {
      client.close();
    }
  }, 180_000);
});

/**
 * Turns a `seconds.nanoseconds` consensus timestamp into whole nanoseconds.
 *
 * @param consensusTs - Timestamp as the mirror node prints it
 * @returns Nanoseconds since the epoch
 */
function nanoseconds(consensusTs: string): bigint {
  const [seconds, nanos] = consensusTs.split(".");
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanos);
}

/**
 * Drops the consensus position from an entry, leaving the record as submitted.
 *
 * @param entry - Anchor read back from the mirror node
 * @returns The plain anchor record
 */
function stripPosition(entry: AnchorRecord & { seq: number; consensus_ts: string }): AnchorRecord {
  const { seq, consensus_ts, ...record } = entry;
  return record;
}
