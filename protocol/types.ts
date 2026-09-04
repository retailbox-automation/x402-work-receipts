/**
 * Document and envelope types of the work-order protocol.
 *
 * The shapes mirror the canonical schemas in `docs/schemas`: `mandate.v1`
 * (work order), `receipt.v1` (acceptance and delivery) and this repository's
 * `payment.v1` profile, which is `receipt.v1` plus the x402 payment legs.
 * The schema files are the normative source; these types exist so callers
 * get compile-time help after a validator has run.
 */

/**
 * Signed envelope around one protocol document.
 *
 * `sig.value` is an Ed25519 signature over `canonicalize(envelope without sig)`;
 * the envelope hash used for anchoring is taken over the envelope *including*
 * `sig` (spec section 4.2, "as signed").
 */
export type Envelope<T> = {
  schema: "mandate.v1" | "receipt.v1" | "receipt.v1+payment.v1";
  from: string;
  to: string;
  thread_id: string;
  issued_at: string;
  data: T;
  sig: { alg: "ed25519"; pub: string /* hex */; value: string /* hex */ };
};

/** Schema tag carried by an envelope, and the name of the schema it validates against. */
export type EnvelopeSchema = Envelope<unknown>["schema"];

/** An envelope before it is signed. */
export type EnvelopeBody<T> = Omit<Envelope<T>, "sig">;

/** Work order from the customer agent to the contractor agent (`mandate.v1`). */
export type Mandate = {
  mandate_id: string;
  story_ref: string;
  story_url: string;
  title: string;
  acceptance: string[];
  frame: string;
  due?: string;
  issued_at: string;
  issuer: string;
};

/** Pointer to the HCS message that anchors a document. */
export type Anchor = {
  topic: string;
  seq: number | null;
  consensus_ts: string | null;
};

/** Links to the delivered work; required when `kind` is `delivered`. */
export type ReceiptResult = {
  pr_url: string;
  staging_url: string;
  notion_status: string;
};

/** An acceptance criterion the contractor does not take, with the reason. */
export type DeclinedCriterion = {
  criterion: string;
  reason: string;
};

/** Contractor receipt for one mandate (`receipt.v1`). */
export type Receipt = {
  receipt_id: string;
  kind: "accepted" | "delivered";
  mandate_id: string;
  mandate_envelope_hash: string;
  mandate_anchor: Anchor;
  taken: string[];
  declined?: DeclinedCriterion[];
  result?: ReceiptResult;
  issued_at: string;
  issuer: string;
};

/** One settled x402 payment: intake on acceptance, balance on delivery. */
export type PaymentLeg = {
  tinybars: number;
  /** Facilitator form, `0.0.X@seconds.nanos`. */
  transaction_id: string;
  consensus_timestamp?: string;
  anchor?: { topic: string; seq?: number | null; consensus_ts?: string | null };
};

/** The x402 legs a receipt accounts for (`payment.v1` profile). */
export type Payment = {
  network: "hedera:testnet" | "hedera:mainnet";
  /** `0.0.0` is HBAR; anything else is an HTS token id. */
  asset: string;
  facilitator: string;
  payer: string;
  payee: string;
  intake: PaymentLeg;
  balance?: PaymentLeg;
};

/** A receipt carrying the payment profile (`receipt.v1+payment.v1`). */
export type PaymentReceipt = Receipt & { payment: Payment };
