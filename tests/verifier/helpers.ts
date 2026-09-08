/**
 * Shared fixture loading for the verifier suite.
 *
 * Everything here comes from one real testnet run: the three envelopes the
 * customer saved and a recorded snapshot of the mirror-node answers that run
 * produced. The snapshot is the whole page the mirror node returned, not a
 * filtered extract — the topic is shared, so the page holds two orders, and a
 * verifier that forgot to filter by `mandate_id` would be caught by it.
 */
import { readFileSync } from "node:fs";
import type { AnchorEntry } from "../../anchor/records";
import { toMirrorTxId } from "../../anchor/records";
import type { MirrorTransaction } from "../../verifier/mirror";
import type { Envelope, Mandate, PaymentReceipt } from "../../protocol/types";

/** One page of `GET /api/v1/topics/{id}/messages`, as recorded. */
export type TopicMessagePage = {
  messages: {
    consensus_timestamp: string;
    message: string;
    sequence_number: number;
    chunk_info?: { number: number; total: number } | null;
  }[];
  links: { next: string | null };
};

/** The topic the golden run anchored to. */
export const GOLDEN_TOPIC = "0.0.10426298";

/**
 * Reads a fixture file relative to this directory.
 *
 * @param relativePath - Path under `tests/verifier`
 * @returns Parsed JSON
 */
export function fixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as T;
}

/** The signed work order of the golden run. */
export function goldenMandate(): Envelope<Mandate> {
  return fixture("./golden/mandate.json");
}

/** The signed delivery receipt of the golden run, with its payment profile. */
export function goldenReceipt(): Envelope<PaymentReceipt> {
  return fixture("./golden/receipt.json");
}

/** The recorded mirror-node page for the shared topic. */
export function goldenTopicPage(): TopicMessagePage {
  return fixture("./golden/mirror/topic-messages.json");
}

/**
 * The recorded transaction bodies, keyed by mirror-form transaction id.
 *
 * @returns One entry per settled payment leg of the golden run
 */
export function goldenTransactions(): Map<string, MirrorTransaction | null> {
  const receipt = goldenReceipt();
  const payment = receipt.data.payment;
  const legs = [payment.intake.transaction_id, payment.balance?.transaction_id].filter(
    (id): id is string => typeof id === "string",
  );
  const entries = new Map<string, MirrorTransaction | null>();
  for (const id of legs) {
    const mirrorId = toMirrorTxId(id);
    const body = fixture<{ transactions: MirrorTransaction[] }>(
      `./golden/mirror/transactions/${mirrorId}.json`,
    );
    entries.set(mirrorId, body.transactions[0]);
  }
  return entries;
}

/**
 * Decodes a recorded topic page into anchor entries the way the verifier's
 * mirror reader does, so check-level tests can work offline.
 *
 * @param page - Recorded page; defaults to the golden one
 * @returns Anchors ascending by sequence number
 */
export function anchorsFrom(page: TopicMessagePage = goldenTopicPage()): AnchorEntry[] {
  const entries: AnchorEntry[] = [];
  for (const message of page.messages) {
    const body = Buffer.from(message.message, "base64").toString("utf8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.v !== "wr-anchor.v1") continue;
    entries.push({
      ...(parsed as unknown as AnchorEntry),
      seq: message.sequence_number,
      consensus_ts: message.consensus_timestamp,
    });
  }
  return entries.sort((left, right) => left.seq - right.seq);
}
