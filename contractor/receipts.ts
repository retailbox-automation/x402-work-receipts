/**
 * Building and signing the contractor's receipts.
 *
 * Three kinds exist. `accepted` acknowledges an order the moment it is taken;
 * `delivered` releases the work and accounts for both x402 payments; `rejected`
 * refuses a message that is not a work order this pair speaks at all, so the
 * exchange closes without a human reading it.
 *
 * Every builder validates against the published schema before returning, and
 * `sealReceipt` is the only place a receipt is signed. A receipt that leaves
 * this module therefore always matches `docs/schemas` — a receipt the customer
 * cannot validate is worth nothing to the customer.
 */
import { randomBytes } from "node:crypto";
import { canonicalize, sha256Hex } from "../protocol/canonical.js";
import { signEnvelope } from "../protocol/envelope.js";
import { validatePaymentReceipt, validateReceipt } from "../protocol/schemas.js";
import type {
  Anchor,
  DeclinedCriterion,
  Envelope,
  Mandate,
  Payment,
  PaymentReceipt,
  Receipt,
  ReceiptResult,
} from "../protocol/types.js";

/** Schema tag of a receipt without money fields. */
export const RECEIPT_SCHEMA = "receipt.v1";

/** Schema tag of a receipt that carries the x402 payment profile. */
export const PAYMENT_RECEIPT_SCHEMA = "receipt.v1+payment.v1";

/** The only work-order format this service accepts, named in every refusal. */
export const EXPECTED_SCHEMA = "mandate.v1";

/**
 * Where that format is specified, so a refusal is actionable on its own.
 *
 * The schema's own `$id` points at the source protocol's namespace, which is
 * not a published document. A refusal is useless if the reader cannot open the
 * url it names, so this is the copy in this repository — the exact bytes this
 * service validates against.
 */
export const EXPECTED_SCHEMA_URL =
  "https://raw.githubusercontent.com/retailbox-automation/x402-work-receipts/main/docs/schemas/mandate.v1.schema.json";

/** Version tag inside a payment anchor's hash preimage. */
const PAYMENT_ANCHOR_VERSION = "wr-payment.v1";

/** Fields shared by both receipt builders. */
type ReceiptBase = {
  /** The order being acknowledged. */
  mandate: Mandate;
  /** sha-256 of the mandate envelope as signed. */
  mandateEnvelopeHash: string;
  /** Where that envelope is anchored. */
  mandateAnchor: Anchor;
  /** Contractor handle; goes into `issuer`. */
  issuer: string;
  /** ISO timestamp; defaults to now. */
  issuedAt?: string;
  /** Receipt id; defaults to a fresh uuid7. */
  receiptId?: string;
  /** Criteria the contractor does not take, with reasons. */
  declined?: DeclinedCriterion[];
};

/** One settled payment leg, as far as the anchor hash is concerned. */
export type PaymentAnchorInput = {
  network: string;
  asset: string;
  payer: string;
  payee: string;
  tinybars: number;
  /** Facilitator form, `0.0.X@seconds.nanos`. */
  transaction_id: string;
};

/**
 * Builds the acceptance receipt issued on intake.
 *
 * `taken` is the mandate's acceptance criteria minus anything declined, so the
 * customer can see exactly which of its criteria the contractor committed to.
 *
 * @param input - Mandate, its anchor, and the issuer
 * @returns A validated `accepted` receipt
 * @throws {SchemaError} When the result does not match `receipt.v1`
 */
export function buildAcceptedReceipt(input: ReceiptBase): Receipt {
  const declined = input.declined ?? [];
  const refused = new Set(declined.map(entry => entry.criterion));
  const receipt: Receipt = {
    receipt_id: input.receiptId ?? newReceiptId(),
    kind: "accepted",
    mandate_id: input.mandate.mandate_id,
    mandate_envelope_hash: input.mandateEnvelopeHash,
    mandate_anchor: input.mandateAnchor,
    taken: input.mandate.acceptance.filter(criterion => !refused.has(criterion)),
    ...(declined.length > 0 ? { declined } : {}),
    issued_at: input.issuedAt ?? new Date().toISOString(),
    issuer: input.issuer,
  };
  validateReceipt(receipt);
  return receipt;
}

/**
 * Builds the delivery receipt released once the balance is paid.
 *
 * Both payment legs must be present: a delivery receipt exists to account for
 * the whole order, and one that names only the intake would let the balance
 * payment disappear from the record it is supposed to prove.
 *
 * @param input - Mandate, anchor, issuer, delivered links and both payments
 * @returns A validated `delivered` receipt carrying the payment profile
 * @throws {SchemaError} When the result does not match the `payment.v1` profile
 */
export function buildDeliveredReceipt(
  input: ReceiptBase & { result: ReceiptResult; payment: Payment },
): PaymentReceipt {
  if (!input.payment.balance) {
    throw new TypeError("A delivered receipt must account for the balance payment");
  }
  const declined = input.declined ?? [];
  const refused = new Set(declined.map(entry => entry.criterion));
  const receipt: PaymentReceipt = {
    receipt_id: input.receiptId ?? newReceiptId(),
    kind: "delivered",
    mandate_id: input.mandate.mandate_id,
    mandate_envelope_hash: input.mandateEnvelopeHash,
    mandate_anchor: input.mandateAnchor,
    taken: input.mandate.acceptance.filter(criterion => !refused.has(criterion)),
    ...(declined.length > 0 ? { declined } : {}),
    result: input.result,
    issued_at: input.issuedAt ?? new Date().toISOString(),
    issuer: input.issuer,
    payment: input.payment,
  };
  validatePaymentReceipt(receipt);
  return receipt;
}

/**
 * Builds a formal refusal of something that is not a work order for this pair.
 *
 * The refusal never quotes the refused message — only its fingerprint — so a
 * malformed or hostile payload cannot be reflected back through a signed
 * document. Nothing is anchored for a refusal, and the anchor position is
 * therefore null rather than invented.
 *
 * @param input - What arrived, why it was refused, and the issuer
 * @returns A validated `rejected` receipt
 * @throws {SchemaError} When the result does not match `receipt.v1`
 */
export function buildRejectedReceipt(input: {
  /** Id of the refused message; the mandate id when one could be read. */
  messageId: string;
  /** sha-256 of the refused message. */
  messageHash: string;
  /** Audit topic this contractor anchors on. */
  topic: string;
  /** Contractor handle. */
  issuer: string;
  /** Human-readable reason, without the message's content. */
  reason: string;
  /** How to send the order correctly. */
  hint?: string;
  issuedAt?: string;
  receiptId?: string;
}): Receipt {
  const receipt: Receipt = {
    receipt_id: input.receiptId ?? newReceiptId(),
    kind: "rejected",
    mandate_id: input.messageId,
    mandate_envelope_hash: input.messageHash,
    mandate_anchor: { topic: input.topic, seq: null, consensus_ts: null },
    taken: [],
    reason: input.reason,
    expected_schema: EXPECTED_SCHEMA,
    schema_url: EXPECTED_SCHEMA_URL,
    ...(input.hint ? { hint: input.hint } : {}),
    issued_at: input.issuedAt ?? new Date().toISOString(),
    issuer: input.issuer,
  };
  validateReceipt(receipt);
  return receipt;
}

/**
 * Signs a receipt into an envelope addressed to the customer.
 *
 * The schema tag follows the content: a receipt carrying `payment` is tagged
 * `receipt.v1+payment.v1`, because a counterparty that only implements the base
 * protocol must be able to tell from the tag that this document is more than it
 * expects.
 *
 * @param receipt - The receipt to sign
 * @param options - Envelope addressing and the contractor's Ed25519 key
 * @returns The signed envelope
 */
export function sealReceipt<T extends Receipt | PaymentReceipt>(
  receipt: T,
  options: {
    from: string;
    to: string;
    threadId: string;
    privateKeyHex: string;
    issuedAt?: string;
  },
): Envelope<T> {
  const schema = "payment" in receipt ? PAYMENT_RECEIPT_SCHEMA : RECEIPT_SCHEMA;
  return signEnvelope<T>(
    {
      schema,
      from: options.from,
      to: options.to,
      thread_id: options.threadId,
      issued_at: options.issuedAt ?? receipt.issued_at,
      data: receipt,
    },
    options.privateKeyHex,
  );
}

/**
 * Hash anchored for a settled payment.
 *
 * Anchors carry hashes, never content, but a hash nobody can recompute proves
 * nothing. This one is taken over exactly the fields the receipt's `payment`
 * profile publishes, so a verifier holding only the receipt and the public
 * topic can recompute it and see that the anchored payment is the payment the
 * receipt claims. The transaction id itself also travels in the anchor's `ref`,
 * in mirror-node form, so the transfer can be looked up independently.
 *
 * @param leg - Network, asset, both parties, amount and transaction id
 * @returns Lowercase sha-256 hex
 */
export function paymentAnchorHash(leg: PaymentAnchorInput): string {
  return sha256Hex(
    canonicalize({
      v: PAYMENT_ANCHOR_VERSION,
      network: leg.network,
      asset: leg.asset,
      payer: leg.payer,
      payee: leg.payee,
      tinybars: leg.tinybars,
      transaction_id: leg.transaction_id,
    }),
  );
}

/**
 * Generates a UUID version 7.
 *
 * Version 7 puts the millisecond timestamp in the high bits, so receipt ids
 * sort by issue time — useful when reading a store or a topic by hand, and the
 * form the schema documents.
 *
 * @param now - Issue time; defaults to the current time
 * @returns The uuid7 string
 */
export function newReceiptId(now: Date = new Date()): string {
  const bytes = randomBytes(16);
  const milliseconds = BigInt(now.getTime());
  for (let index = 0; index < 6; index++) {
    bytes[index] = Number((milliseconds >> BigInt(8 * (5 - index))) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
