/**
 * The verifier's only window onto the world: the public Hedera mirror node.
 *
 * Two things make this module different from `anchor/client.ts`, which also
 * reads topics. First, the base url is a constant rather than an environment
 * variable — a verifier that can be pointed at a private endpoint proves
 * nothing to a stranger, and "trust only the public mirror node" has to be a
 * property of the code, not of how it was launched. Second, nothing here
 * imports the Hedera SDK: verification needs no keys, no operator account and
 * no ability to write, so the reader is plain REST and stays that way.
 *
 * The record shape itself is not re-implemented — `parseAnchor` and the
 * transaction-id conversion come from `anchor/records.ts`, so a verifier and a
 * contractor can never disagree about what an anchor is.
 */
import { Buffer } from "node:buffer";
import { type AnchorEntry, parseAnchor, toMirrorTxId } from "../anchor/records.js";

/** The public testnet mirror node. Deliberately not configurable. */
export const MIRROR_NODE_URL = "https://testnet.mirrornode.hedera.com";

/** Page size for `/topics/{id}/messages`; the mirror node caps this at 100. */
const PAGE_SIZE = 100;

/** Stops a malformed `links.next` chain from looping forever. */
const MAX_PAGES = 1000;

/** Per-request ceiling, so one stuck connection cannot hang the command. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Attempts per request, including the first. */
const DEFAULT_ATTEMPTS = 4;

/** Base backoff between attempts; each retry waits a multiple of this. */
const DEFAULT_DELAY_MS = 750;

/**
 * The mirror node could not be read.
 *
 * Kept apart from every verification verdict on purpose: "this receipt does not
 * check out" and "I could not look" are different answers, and the command
 * exits with a different code for each.
 */
export class MirrorError extends Error {
  /**
   * @param message - What failed
   * @param options - Standard error options, e.g. `{ cause }`
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MirrorError";
  }
}

/** One line of a transaction's HBAR transfer list. */
export type TransferEntry = {
  account: string;
  amount: number;
  is_approval?: boolean;
};

/** A transaction as returned by `GET /api/v1/transactions/{id}`. */
export type MirrorTransaction = {
  transaction_id: string;
  result: string;
  name?: string;
  consensus_timestamp?: string;
  charged_tx_fee?: number;
  /** True for the inner transfer of a Scheduled Transaction, false for its ScheduleCreate. */
  scheduled?: boolean;
  transfers: TransferEntry[];
};

/**
 * A schedule as returned by `GET /api/v1/schedules/{id}`.
 *
 * `executed_timestamp` is the whole point: null while the schedule waits for
 * signatures, and the consensus time of the transfer once it has run.
 */
export type MirrorSchedule = {
  schedule_id: string;
  creator_account_id?: string;
  payer_account_id?: string;
  consensus_timestamp?: string;
  executed_timestamp?: string | null;
  expiration_time?: string | null;
  wait_for_expiry?: boolean;
  deleted?: boolean;
  memo?: string;
};

/** How hard to try before giving up on a read. */
export type RetryOptions = {
  attempts?: number;
  delayMs?: number;
};

/** Reads every anchor on a topic. Injectable so tests can run offline. */
export type AnchorReader = (topicId: string) => Promise<AnchorEntry[]>;

/** Reads one transaction, or null when the ledger does not have it. */
export type TransactionReader = (transactionId: string) => Promise<MirrorTransaction | null>;

/** Reads one schedule entity, or null when the ledger does not have it. */
export type ScheduleReader = (scheduleId: string) => Promise<MirrorSchedule | null>;

/** One message of `GET /api/v1/topics/{id}/messages`. */
type TopicMessage = {
  consensus_timestamp: string;
  message: string;
  sequence_number: number;
  chunk_info?: { number: number; total: number } | null;
};

/** A page of topic messages. */
type TopicMessagePage = {
  messages?: TopicMessage[];
  links?: { next?: string | null };
};

/** The body of a transaction lookup. */
type TransactionPage = {
  transactions?: MirrorTransaction[];
};

/** What a single GET produced: a body, or a definite "not there". */
type Fetched<T> = { found: true; body: T } | { found: false };

/**
 * Reads every anchor on a topic, oldest first.
 *
 * Messages that are not `wr-anchor.v1` records are skipped rather than
 * rejected: a topic without a submit key is writable by anyone, and a stranger's
 * message must not stop a reader. Nothing read here is trusted — every hash is
 * checked against a signed document by the checks.
 *
 * @param topicId - Topic to read, e.g. `0.0.10426298`
 * @param options - Retry behaviour
 * @returns Anchors with their sequence number and consensus timestamp
 * @throws {MirrorError} When the topic is unknown or cannot be read
 */
export async function readTopicAnchors(
  topicId: string,
  options?: RetryOptions,
): Promise<AnchorEntry[]> {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE), order: "asc" });
  let url: string | null = `${MIRROR_NODE_URL}/api/v1/topics/${topicId}/messages?${query.toString()}`;
  const entries: AnchorEntry[] = [];

  for (let page = 0; url !== null && page < MAX_PAGES; page++) {
    const fetched: Fetched<TopicMessagePage> = await getJson<TopicMessagePage>(url, options);
    if (!fetched.found) {
      throw new MirrorError(
        `The mirror node does not know topic ${topicId} (unknown id, or not indexed yet)`,
      );
    }

    for (const message of fetched.body.messages ?? []) {
      const entry = toAnchorEntry(message);
      if (entry) {
        entries.push(entry);
      }
    }

    const next: string | null | undefined = fetched.body.links?.next;
    url = next ? `${MIRROR_NODE_URL}${next.startsWith("/") ? next : `/${next}`}` : null;
  }

  if (url !== null) {
    // A short answer would report anchors as missing that are in fact on the
    // topic — the one failure a verifier must never produce quietly.
    throw new MirrorError(
      `Topic ${topicId} still had pages after ${MAX_PAGES}; refusing to judge a truncated log`,
    );
  }

  if (entries.length === 0) {
    // `/messages` answers 200 with an empty list for a topic that does not
    // exist at all, so an empty result on its own would let a mistyped topic id
    // read as "this order was never anchored". That is a false statement about
    // the order rather than about the id, and it would come out as a failed
    // verification instead of an unanswerable one.
    await assertTopicExists(topicId, options);
  }

  return entries.sort((left, right) => left.seq - right.seq);
}

/**
 * Throws unless the mirror node knows the topic.
 *
 * Unlike the messages endpoint, `/topics/{id}` answers 404 for a topic that
 * does not exist, which is what makes "empty" and "wrong id" distinguishable.
 *
 * @param topicId - Topic to confirm
 * @param options - Retry behaviour
 * @throws {MirrorError} When the topic is unknown to the mirror node
 */
async function assertTopicExists(topicId: string, options?: RetryOptions): Promise<void> {
  const found = await getJson<unknown>(`${MIRROR_NODE_URL}/api/v1/topics/${topicId}`, options);
  if (!found.found) {
    throw new MirrorError(
      `The mirror node does not know topic ${topicId} (unknown id, or not indexed yet)`,
    );
  }
}

/**
 * Reads one transaction from the mirror node.
 *
 * A transaction the ledger does not have comes back as null, because that is a
 * fact about the payment and belongs in a check. Anything that merely prevented
 * the lookup throws instead.
 *
 * @param transactionId - Facilitator (`0.0.x@s.n`) or mirror (`0.0.x-s-n`) form
 * @param options - Retry behaviour
 * @returns The transaction, or null when it is not on the ledger
 * @throws {MirrorError} When the lookup itself failed
 */
export async function readTransaction(
  transactionId: string,
  options?: RetryOptions,
): Promise<MirrorTransaction | null> {
  const mirrorId = toMirrorTxId(transactionId);
  const url = `${MIRROR_NODE_URL}/api/v1/transactions/${mirrorId}`;
  const fetched = await getJson<TransactionPage>(url, options);
  if (!fetched.found) {
    return null;
  }

  const transactions = fetched.body.transactions ?? [];
  if (transactions.length === 0) {
    return null;
  }
  // One transaction id can carry several records (a duplicate submission, a
  // child transaction). The successful one is the one that moved the money.
  return transactions.find(transaction => transaction.result === "SUCCESS") ?? transactions[0];
}

/**
 * Reads a schedule entity from the mirror node.
 *
 * @param scheduleId - Schedule entity id, `0.0.x`
 * @param options - Retry behaviour
 * @returns The schedule, or null when the ledger does not have it
 * @throws {MirrorError} When the lookup itself failed
 */
export async function readSchedule(
  scheduleId: string,
  options?: RetryOptions,
): Promise<MirrorSchedule | null> {
  const fetched = await getJson<MirrorSchedule>(
    `${MIRROR_NODE_URL}/api/v1/schedules/${scheduleId}`,
    options,
  );
  return fetched.found ? fetched.body : null;
}

/**
 * Reads the transfer a Scheduled Transaction executed.
 *
 * A schedule and the transfer it runs share one transaction id, so
 * `/api/v1/transactions/{id}` answers with two records: the ScheduleCreate that
 * set the retainer up, and — once it has been released — the transfer itself.
 * Both say `SUCCESS`, so {@link readTransaction}'s "first successful record"
 * rule would return the ScheduleCreate, whose transfer list is a network fee
 * and not the retainer at all. The inner transfer is the one flagged
 * `scheduled`, and that flag is the only thing that tells them apart.
 *
 * @param transactionId - Facilitator or mirror form; a `?scheduled` suffix must already be stripped
 * @param options - Retry behaviour
 * @returns The executed transfer, or null when it has not run
 * @throws {MirrorError} When the lookup itself failed
 */
export async function readScheduledTransaction(
  transactionId: string,
  options?: RetryOptions,
): Promise<MirrorTransaction | null> {
  const mirrorId = toMirrorTxId(transactionId);
  const fetched = await getJson<TransactionPage>(
    `${MIRROR_NODE_URL}/api/v1/transactions/${mirrorId}`,
    options,
  );
  if (!fetched.found) {
    return null;
  }
  return (fetched.body.transactions ?? []).find(transaction => transaction.scheduled === true) ?? null;
}

/**
 * Reads the transaction that reached consensus at an exact timestamp.
 *
 * Consensus timestamps are unique across the network, so this addresses one
 * transaction precisely. It is how a schedule is joined to the transfer it
 * executed: the schedule publishes `executed_timestamp` but not the transfer's
 * transaction id, and the transfer inherits the id of the `ScheduleCreate`
 * rather than carrying one of its own.
 *
 * @param consensusTimestamp - `seconds.nanoseconds`, as the mirror node prints it
 * @param options - Retry behaviour
 * @returns The transaction, or null when nothing is recorded at that instant
 * @throws {MirrorError} When the lookup itself failed
 */
export async function readTransactionAtTimestamp(
  consensusTimestamp: string,
  options?: RetryOptions,
): Promise<MirrorTransaction | null> {
  const query = new URLSearchParams({ timestamp: consensusTimestamp });
  const fetched = await getJson<TransactionPage>(
    `${MIRROR_NODE_URL}/api/v1/transactions?${query.toString()}`,
    options,
  );
  if (!fetched.found) {
    return null;
  }
  return (fetched.body.transactions ?? [])[0] ?? null;
}

/**
 * Live readers, used by the command unless a caller injects its own.
 */
export const liveMirror: {
  readAnchors: AnchorReader;
  readTransaction: TransactionReader;
  readSchedule: ScheduleReader;
  readScheduledTransaction: TransactionReader;
} = {
  readAnchors: topicId => readTopicAnchors(topicId),
  readTransaction: transactionId => readTransaction(transactionId),
  readSchedule: scheduleId => readSchedule(scheduleId),
  readScheduledTransaction: transactionId => readScheduledTransaction(transactionId),
};

/**
 * GETs JSON with retries.
 *
 * A 404 is a definite answer and is never retried; anything else — a network
 * error, a 5xx, a rate limit — is transient until the attempts run out.
 *
 * @param url - Absolute mirror-node url
 * @param options - Retry behaviour
 * @returns The parsed body, or a "not found" marker
 * @throws {MirrorError} When every attempt failed
 */
async function getJson<T>(url: string, options?: RetryOptions): Promise<Fetched<T>> {
  const attempts = Math.max(1, options?.attempts ?? DEFAULT_ATTEMPTS);
  const delayMs = options?.delayMs ?? DEFAULT_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.status === 404) {
        return { found: false };
      }
      if (!response.ok) {
        throw new Error(`the mirror node answered ${response.status}`);
      }
      return { found: true, body: (await response.json()) as T };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delayMs * attempt);
      }
    }
  }

  throw new MirrorError(
    `Could not read ${url} after ${attempts} attempts: ${describe(lastError)}`,
    { cause: lastError },
  );
}

/**
 * Decodes one mirror-node message into an anchor entry.
 *
 * @param message - Mirror node message
 * @returns The anchor with its consensus position, or null if it is not one
 */
function toAnchorEntry(message: TopicMessage): AnchorEntry | null {
  // An anchor is far smaller than the 1 KiB chunking threshold, so a chunked
  // message belongs to somebody else and its partial body would not parse.
  if (message.chunk_info && message.chunk_info.total > 1) {
    return null;
  }
  const record = parseAnchor(Buffer.from(message.message, "base64").toString("utf8"));
  if (!record) {
    return null;
  }
  return { ...record, seq: message.sequence_number, consensus_ts: message.consensus_timestamp };
}

/**
 * Renders an unknown thrown value as a short string.
 *
 * @param error - The thrown value
 * @returns Its message, or its string form
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
