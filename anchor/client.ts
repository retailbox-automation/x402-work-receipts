/**
 * Writing anchors to the HCS audit topic and reading them back from the public
 * mirror node.
 *
 * Writing needs an operator key; reading needs nothing at all — that asymmetry
 * is the point of the design. Anyone can reconstruct the order from
 * {@link readAnchors} without access to either company's server.
 */
import { Buffer } from "node:buffer";
import { AccountId, Client, PrivateKey, TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import type { Timestamp } from "@hiero-ledger/sdk";
import { type AnchorEntry, type AnchorRecord, encodeAnchor, parseAnchor } from "./records";

/** Public mirror node used for every read. Overridable for other networks. */
export const DEFAULT_MIRROR_NODE_URL = "https://testnet.mirrornode.hedera.com";

/** How long `readAnchors` keeps retrying while the mirror node lags consensus. */
const DEFAULT_MIRROR_TIMEOUT_MS = 30_000;

/** Page size for `/topics/{id}/messages`; the mirror node caps this at 100. */
const PAGE_SIZE = 100;

/** Stops a malformed `links.next` chain from looping forever (100 000 messages). */
const MAX_PAGES = 1000;

/** Per-request ceiling, so one stuck connection cannot outlive the retry window. */
const REQUEST_TIMEOUT_MS = 10_000;

/** The mirror node does not know this topic — not the same thing as an empty topic. */
export class MirrorTopicNotFoundError extends Error {
  /**
   * @param topicId - The topic that could not be read
   */
  constructor(public readonly topicId: string) {
    super(`Topic ${topicId} is not on the mirror node (unknown, or not indexed yet)`);
    this.name = "MirrorTopicNotFoundError";
  }
}

/** One message as returned by `GET /api/v1/topics/{id}/messages`. */
type MirrorTopicMessage = {
  consensus_timestamp: string;
  message: string;
  sequence_number: number;
  topic_id: string;
  chunk_info?: { number: number; total: number } | null;
};

/** The envelope of a mirror-node message page. */
type MirrorMessagePage = {
  messages?: MirrorTopicMessage[];
  links?: { next?: string | null };
};

/**
 * Builds a testnet client operated by the account in `.env`, the same way the
 * spike does. Callers own the client and must `close()` it.
 *
 * @returns Configured Hedera client
 */
export function operatorClient(): Client {
  const operatorId = requireEnv("HEDERA_OPERATOR_ID");
  const operatorKey = requireEnv("HEDERA_OPERATOR_KEY");
  const keyType = (process.env.HEDERA_OPERATOR_KEY_TYPE ?? "ecdsa").trim().toLowerCase();
  const key = keyType.startsWith("ed25519")
    ? PrivateKey.fromStringED25519(operatorKey)
    : PrivateKey.fromStringECDSA(operatorKey);
  return Client.forTestnet().setOperator(AccountId.fromString(operatorId), key);
}

/**
 * Reads a required environment variable.
 *
 * @param name - Variable name
 * @returns The value
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in .env`);
  }
  return value;
}

/**
 * Base URL of the mirror node, read at call time so a test or another network
 * can point the reads elsewhere.
 *
 * @returns Mirror node base URL without a trailing slash
 */
function mirrorNodeUrl(): string {
  const configured = process.env.HEDERA_MIRROR_NODE_URL ?? DEFAULT_MIRROR_NODE_URL;
  return configured.replace(/\/+$/, "");
}

/**
 * How long reads may retry, in milliseconds. Zero means a single attempt.
 *
 * @returns Retry window
 */
function mirrorTimeoutMs(): number {
  const configured = process.env.ANCHOR_MIRROR_TIMEOUT_MS;
  if (configured === undefined || configured.trim() === "") {
    return DEFAULT_MIRROR_TIMEOUT_MS;
  }
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIRROR_TIMEOUT_MS;
}

/**
 * Renders an SDK consensus timestamp the way the mirror node prints it:
 * `seconds.nanoseconds` with the nanoseconds zero-padded to nine digits.
 *
 * The padding is not cosmetic. The mirror node always prints nine digits, so
 * `1788541858.008959007` unpadded would read as `1788541858.8959007` — a
 * different instant, and a `since` filter or an ordering check built on it
 * would be quietly wrong for every message whose nanoseconds start with a zero.
 *
 * @param timestamp - Consensus timestamp from a transaction record
 * @returns Timestamp string, e.g. `1788539659.779738844`
 */
export function formatConsensusTimestamp(timestamp: Timestamp): string {
  return `${timestamp.seconds.toString()}.${timestamp.nanos.toString().padStart(9, "0")}`;
}

/**
 * Submits one anchor to a topic and waits for consensus.
 *
 * The transaction record (not just the receipt) is fetched because it carries
 * the consensus timestamp, which is what later reads and the verifier order
 * anchors by.
 *
 * There is deliberately no retry here: a submit that times out locally may
 * still have reached consensus, and retrying would put a duplicate anchor on a
 * permanent public log. Callers that need to retry (see the spec's error
 * handling) should first read the topic back and check whether the anchor
 * landed.
 *
 * @param client - Operator-backed Hedera client
 * @param topicId - Topic to write to, e.g. `0.0.123456`
 * @param rec - The anchor record
 * @returns Sequence number and consensus timestamp of the message
 */
export async function submitAnchor(
  client: Client,
  topicId: string,
  rec: AnchorRecord,
): Promise<{ seq: number; consensus_ts: string }> {
  const body = encodeAnchor(rec);
  const response = await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId))
    .setMessage(body)
    .execute(client);

  const record = await response.getRecord(client);
  const sequenceNumber = record.receipt.topicSequenceNumber;
  if (sequenceNumber === null) {
    throw new Error(`Topic message receipt for ${topicId} carried no sequence number`);
  }

  return {
    seq: sequenceNumber.toNumber(),
    consensus_ts: formatConsensusTimestamp(record.consensusTimestamp),
  };
}

/**
 * Reads every anchor on a topic from the public mirror node, oldest first.
 *
 * The mirror node lags consensus by a second or two, so an empty answer and a
 * read error are both retried until the window in `ANCHOR_MIRROR_TIMEOUT_MS`
 * (30 s by default, 0 for a single attempt) runs out. An empty topic then comes
 * back as an empty array, while an unreadable one throws: "no anchors" and
 * "could not look" must not arrive as the same answer.
 *
 * Messages that are not `wr-anchor.v1` are skipped rather than rejected: a topic
 * without a submit key is writable by anyone, and a spam message must not break
 * a reader. Nothing here is trusted — every hash is checked against a signed
 * document by the verifier.
 *
 * @param topicId - Topic to read, e.g. `0.0.123456`
 * @param opts - `since`: consensus timestamp to read strictly after
 * @returns Anchors with their sequence number and consensus timestamp, ascending
 * @throws {MirrorTopicNotFoundError} When the mirror node does not know the topic
 */
export async function readAnchors(
  topicId: string,
  opts?: { since?: string },
): Promise<AnchorEntry[]> {
  const timeoutMs = mirrorTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  const pollMs = Math.min(2000, Math.max(50, Math.floor(timeoutMs / 10)));

  for (;;) {
    // Read once more after the deadline, so the answer is always a real read
    // rather than "we ran out of time while waiting".
    const lastAttempt = Date.now() >= deadline;
    try {
      const entries = await readAnchorsOnce(topicId, opts?.since);
      if (entries.length > 0) {
        return entries;
      }
      if (lastAttempt) {
        // `/topics/{id}/messages` answers 200 with an empty list for a topic
        // that does not exist at all, so an empty result on its own would let a
        // mistyped topic id read as "this order was never anchored". Confirm the
        // topic before returning nothing.
        await assertTopicExists(topicId);
        return entries;
      }
    } catch (error) {
      if (lastAttempt) {
        throw error;
      }
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Throws unless the mirror node knows the topic.
 *
 * Unlike the messages endpoint, `/topics/{id}` answers 404 for a topic that does
 * not exist, which is what makes "empty" and "wrong id" distinguishable.
 *
 * @param topicId - Topic to check
 * @throws {MirrorTopicNotFoundError} When the topic is unknown to the mirror node
 */
async function assertTopicExists(topicId: string): Promise<void> {
  const url = `${mirrorNodeUrl()}/api/v1/topics/${topicId}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.status === 404) {
    throw new MirrorTopicNotFoundError(topicId);
  }
  if (!response.ok) {
    throw new Error(`Mirror node answered ${response.status} for ${url}`);
  }
}

/**
 * One full pass over the topic's messages, following pagination.
 *
 * @param topicId - Topic to read
 * @param since - Optional consensus timestamp to read strictly after
 * @returns Anchors found in this pass, ascending by sequence number
 */
async function readAnchorsOnce(topicId: string, since?: string): Promise<AnchorEntry[]> {
  const base = mirrorNodeUrl();
  const query = new URLSearchParams({ limit: String(PAGE_SIZE), order: "asc" });
  if (since) {
    query.set("timestamp", `gt:${since}`);
  }

  let url: string | null = `${base}/api/v1/topics/${topicId}/messages?${query.toString()}`;
  const entries: AnchorEntry[] = [];

  for (let page = 0; url !== null && page < MAX_PAGES; page++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (response.status === 404 && page === 0) {
      // Either the topic was created seconds ago and the mirror node has not
      // indexed it yet, or it does not exist. Both are retried; neither is
      // reported as "this topic has no anchors", which would turn a lookup
      // failure into a false statement about the order.
      throw new MirrorTopicNotFoundError(topicId);
    }
    if (!response.ok) {
      throw new Error(`Mirror node answered ${response.status} for ${url}`);
    }

    const body = (await response.json()) as MirrorMessagePage;
    for (const message of body.messages ?? []) {
      const entry = toAnchorEntry(message);
      if (entry) {
        entries.push(entry);
      }
    }

    const next = body.links?.next;
    url = next ? `${base}${next.startsWith("/") ? next : `/${next}`}` : null;
  }

  if (url !== null) {
    // Better a loud failure than a short answer: a reader that stops early would
    // report anchors as missing that are in fact on the topic.
    throw new Error(
      `Mirror node still had pages after ${MAX_PAGES} for topic ${topicId}; refusing to return a truncated log`,
    );
  }

  entries.sort((left, right) => left.seq - right.seq);
  return entries;
}

/**
 * Decodes one mirror-node message into an anchor entry.
 *
 * @param message - Mirror node message
 * @returns The anchor with its consensus position, or null if it is not one
 */
function toAnchorEntry(message: MirrorTopicMessage): AnchorEntry | null {
  // Messages over 1 KiB arrive as chunks; an anchor is far smaller than that,
  // so a chunked message is somebody else's and a partial body would not parse.
  if (message.chunk_info && message.chunk_info.total > 1) {
    return null;
  }

  const body = Buffer.from(message.message, "base64").toString("utf8");
  const record = parseAnchor(body);
  if (!record) {
    return null;
  }

  return {
    ...record,
    seq: message.sequence_number,
    consensus_ts: message.consensus_timestamp,
  };
}

/**
 * Waits.
 *
 * @param ms - Milliseconds to wait
 * @returns A promise resolving after the delay
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
