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
 * Minimal RFC 8785 (JSON Canonicalization Scheme) serializer: object keys
 * sorted by UTF-16 code unit, no whitespace, and `JSON.stringify` semantics for
 * numbers and strings, which is exactly what RFC 8785 prescribes for them.
 *
 * It lives here so this module has no dependency on `protocol/`, which is built
 * in a separate lane; to be replaced by protocol/canonical.ts on merge — the
 * output is byte-identical, so anchors written before and after the swap stay
 * comparable.
 *
 * @param value - Any JSON-representable value
 * @returns Canonical JSON string
 */
export function canonicalize(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "object") {
    const withToJson = value as { toJSON?: unknown };
    if (typeof withToJson.toJSON === "function") {
      return canonicalize((withToJson.toJSON as () => unknown).call(value));
    }

    if (Array.isArray(value)) {
      // JSON.stringify renders holes, undefined and functions inside an array as null.
      const items = value.map(item =>
        item === undefined || typeof item === "function" ? "null" : canonicalize(item),
      );
      return `[${items.join(",")}]`;
    }

    const source = value as Record<string, unknown>;
    const keys = Object.keys(source)
      .filter(key => source[key] !== undefined && typeof source[key] !== "function")
      .sort(compareByCodeUnits);
    const members = keys.map(key => `${JSON.stringify(key)}:${canonicalize(source[key])}`);
    return `{${members.join(",")}}`;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize the non-finite number ${value}`);
    }
    return JSON.stringify(value);
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  throw new TypeError(`Cannot canonicalize a value of type ${typeof value}`);
}

/**
 * Orders two strings by UTF-16 code unit, which is the ordering RFC 8785 asks
 * for and the one JavaScript's `<` on strings already implements.
 *
 * @param a - First key
 * @param b - Second key
 * @returns Negative, zero or positive per the comparator contract
 */
function compareByCodeUnits(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

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
