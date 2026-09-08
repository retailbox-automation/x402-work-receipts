/**
 * `wr-anchor.v1` — the record written to the public HCS audit topic.
 *
 * An anchor carries only hashes and public ids: what step happened, for which
 * mandate, the sha-256 of the thing anchored, and for payment steps the Hedera
 * transaction id. Never the content of the work order or the receipt.
 *
 * This module also owns the canonical bytes of a record (the message body on
 * HCS) and the transaction-id conversion between the form the x402 facilitator
 * returns and the form the mirror node uses.
 */

/**
 * Canonical JSON (RFC 8785) — re-exported from `protocol/`, which owns the
 * single implementation every hash in this repository is taken over. Anchors
 * are hashed and compared against protocol envelopes, so the two must not be
 * able to drift apart.
 */
import { canonicalize } from "../protocol/canonical.js";

export { canonicalize };

/** Schema tag carried by every anchor message. */
export const ANCHOR_VERSION = "wr-anchor.v1";

/** The six steps of one order, in the order they are anchored. */
export const ANCHOR_KINDS = [
  "mandate_in",
  "accepted",
  "delivered",
  "payment_intake",
  "payment_balance",
  "receipt",
] as const;

export type AnchorKind = (typeof ANCHOR_KINDS)[number];

/** One anchor message. `ref` carries the mirror-form tx id for `payment_*` kinds. */
export type AnchorRecord = {
  v: "wr-anchor.v1";
  kind: AnchorKind;
  mandate_id: string;
  hash: string;
  ref?: string;
  at: string;
};

/** An anchor as read back from the mirror node, with its consensus position. */
export type AnchorEntry = AnchorRecord & { seq: number; consensus_ts: string };

/** `0.0.7162784@1788539653.433840739` — the form the facilitator and HashScan use. */
const FACILITATOR_TX_ID = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/;

/** `0.0.7162784-1788539653-433840739` — the form the mirror node REST API uses. */
const MIRROR_TX_ID = /^(\d+\.\d+\.\d+)-(\d+)-(\d+)$/;

/** Lowercase sha-256 hex, as produced by `protocol/envelope.ts`. */
const HASH_STRICT = /^[0-9a-f]{64}$/;

/** Same, case-insensitive: what we are willing to read back from a public topic. */
const HASH_LENIENT = /^[0-9a-fA-F]{64}$/;

/**
 * Canonical JSON body of an anchor — the exact bytes submitted to HCS.
 *
 * Validates before encoding so a malformed record cannot reach a topic, where
 * it would be permanent.
 *
 * @param record - The anchor to encode
 * @returns Canonical JSON string
 */
export function encodeAnchor(record: AnchorRecord): string {
  assertWritableAnchor(record);
  return canonicalize(record);
}

/**
 * Parses one HCS message body back into an anchor.
 *
 * A topic without a submit key is writable by anyone, so anything that is not a
 * well-formed `wr-anchor.v1` record is not an error — it is simply not ours.
 *
 * @param body - Decoded message body
 * @returns The anchor, or null if the body is not a `wr-anchor.v1` record
 */
export function parseAnchor(body: string): AnchorRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  return isAnchorRecord(parsed) ? parsed : null;
}

/**
 * Type guard for a readable anchor record.
 *
 * Deliberately more forgiving than {@link assertWritableAnchor}: we write
 * lowercase hashes and always set `ref` on payment steps, but we still read a
 * record that only differs in those conventions rather than going blind to it.
 *
 * @param value - Candidate value
 * @returns True when the value is shaped like a `wr-anchor.v1` record
 */
export function isAnchorRecord(value: unknown): value is AnchorRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<AnchorRecord>;
  return (
    candidate.v === ANCHOR_VERSION &&
    typeof candidate.kind === "string" &&
    (ANCHOR_KINDS as readonly string[]).includes(candidate.kind) &&
    typeof candidate.mandate_id === "string" &&
    candidate.mandate_id.length > 0 &&
    typeof candidate.hash === "string" &&
    HASH_LENIENT.test(candidate.hash) &&
    (candidate.ref === undefined || typeof candidate.ref === "string") &&
    typeof candidate.at === "string" &&
    Number.isFinite(Date.parse(candidate.at))
  );
}

/**
 * Throws unless the record is fit to be written to the audit topic.
 *
 * @param record - Candidate record
 */
export function assertWritableAnchor(record: AnchorRecord): void {
  if (!isAnchorRecord(record)) {
    throw new TypeError(`Not a ${ANCHOR_VERSION} record: ${JSON.stringify(record)}`);
  }
  if (!HASH_STRICT.test(record.hash)) {
    throw new TypeError(`Anchor hash must be lowercase sha-256 hex, got "${record.hash}"`);
  }
  if (record.kind.startsWith("payment_")) {
    if (record.ref === undefined) {
      throw new TypeError(`Anchor kind "${record.kind}" needs a transaction id in "ref"`);
    }
    // Store the mirror form, so the verifier never has to convert while reading.
    if (!MIRROR_TX_ID.test(record.ref)) {
      throw new TypeError(
        `Anchor "ref" must be a mirror-node transaction id (0.0.x-sec-nanos), got "${record.ref}"`,
      );
    }
  }
}

/**
 * Converts a transaction id to the hyphenated form the mirror node uses.
 *
 * The facilitator returns `0.0.7162784@1788539653.433840739`; the mirror node
 * both addresses and reports the same transaction as
 * `0.0.7162784-1788539653-433840739`. Comparing the two forms directly is the
 * false negative recorded in `spike/README.md` gotcha 2, so every id crossing
 * that boundary goes through here. Already-converted ids pass through unchanged.
 *
 * @param transactionId - Transaction id in either form
 * @returns Mirror-node transaction id
 */
export function toMirrorTxId(transactionId: string): string {
  const facilitator = FACILITATOR_TX_ID.exec(transactionId);
  if (facilitator) {
    return `${facilitator[1]}-${facilitator[2]}-${facilitator[3]}`;
  }
  if (MIRROR_TX_ID.test(transactionId)) {
    return transactionId;
  }
  throw new TypeError(`Not a Hedera transaction id: "${transactionId}"`);
}

/**
 * Inverse of {@link toMirrorTxId}: the form the facilitator, the SDK and
 * HashScan deep links use. Already-converted ids pass through unchanged.
 *
 * @param mirrorTransactionId - Transaction id in either form
 * @returns Transaction id as `0.0.x@sec.nanos`
 */
export function fromMirrorTxId(mirrorTransactionId: string): string {
  const mirror = MIRROR_TX_ID.exec(mirrorTransactionId);
  if (mirror) {
    return `${mirror[1]}@${mirror[2]}.${mirror[3]}`;
  }
  if (FACILITATOR_TX_ID.test(mirrorTransactionId)) {
    return mirrorTransactionId;
  }
  throw new TypeError(`Not a Hedera transaction id: "${mirrorTransactionId}"`);
}
