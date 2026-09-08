/**
 * Creates the public HCS topic that carries the audit log.
 *
 * Run as a script (`npm run anchor:create-topic`) it creates one topic and
 * prints the line to paste into `.env`. It never writes `.env` itself: the file
 * holds keys, and a script that edits it is a script that can lose them.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { operatorClient } from "./client";

/** Memo carried by the audit topic, so it is recognisable in any explorer. */
export const ANCHOR_TOPIC_MEMO = "x402-work-receipts anchors";

/**
 * Creates a consensus topic.
 *
 * The topic is created without an admin or submit key on purpose: it is a
 * public audit log, it must not be editable or deletable afterwards, and
 * readers must not have to trust who wrote a message. Every anchor is a hash
 * that the verifier re-computes from a signed document, so a message from a
 * stranger proves nothing and changes nothing.
 *
 * @param client - Operator-backed Hedera client
 * @param memo - Topic memo
 * @returns The new topic id, e.g. `0.0.123456`
 */
export async function createTopic(client: Client, memo: string): Promise<string> {
  const receipt = await new TopicCreateTransaction()
    .setTopicMemo(memo)
    .execute(client)
    .then(response => response.getReceipt(client));

  const topicId = receipt.topicId;
  if (!topicId) {
    throw new Error("TopicCreateTransaction receipt carried no topicId");
  }
  return topicId.toString();
}

/**
 * Entry point: creates the audit topic and prints the `.env` line for it.
 */
async function main(): Promise<void> {
  loadEnv();
  const client = operatorClient();
  let topicId: string;
  try {
    topicId = await createTopic(client, ANCHOR_TOPIC_MEMO);
  } finally {
    client.close();
  }

  console.log(`topic memo:  ${ANCHOR_TOPIC_MEMO}`);
  console.log(`hashscan:    https://hashscan.io/testnet/topic/${topicId}`);
  console.log(`mirror node: https://testnet.mirrornode.hedera.com/api/v1/topics/${topicId}/messages`);
  console.log("\nAdd this line to .env (nothing writes .env for you):\n");
  console.log(`ANCHOR_TOPIC_ID=${topicId}`);
}

/**
 * True when this file was started directly rather than imported.
 *
 * @returns Whether the module is the process entry point
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) {
    return false;
  }
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
