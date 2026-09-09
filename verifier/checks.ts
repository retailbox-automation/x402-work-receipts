/**
 * The checks that turn a receipt and a public topic back into a verdict.
 *
 * Each check is a pure function over `(receipt, anchors, transactions)`. It
 * fetches nothing, so it can be run against recorded data, and it decides one
 * thing, so a failure names the step that broke rather than "verification
 * failed". The reading of the ledger belongs to `mirror.ts`; the judgement
 * belongs here.
 *
 * What the checks do NOT do is trust either company: the receipt is checked
 * against its own signature, against hashes on a public topic, and against
 * transfers on the ledger. Nothing in this file calls the contractor or the
 * customer.
 */
import { type AnchorEntry, type AnchorKind, toMirrorTxId } from "../anchor/records.js";
import { paymentAnchorHash } from "../contractor/receipts.js";
import { envelopeHash, verifyEnvelope } from "../protocol/envelope.js";
import { isUaid, publicKeyForUaid, uaidProblems } from "../protocol/identity.js";
import type { Envelope, Mandate, Payment, PaymentLeg, PaymentReceipt } from "../protocol/types.js";
import type { MirrorTransaction } from "./mirror.js";

/** Check 1: the contractor really signed this receipt. */
export const CHECK_SIGNATURE = "receipt signature";

/** Check 2: the identifier the receipt comes from is the key that signed it. */
export const CHECK_IDENTITY = "agent identity";

/** Check 3: the receipt, the topic and the work order all name the same order. */
export const CHECK_MANDATE_LINK = "mandate hash linkage";

/** Check 4: all six steps are on the topic, in the order they must have happened. */
export const CHECK_ANCHOR_SEQUENCE = "anchor sequence";

/** Check 5: both payments are on the ledger, with the stated parties and amounts. */
export const CHECK_PAYMENTS = "payments on ledger";

/** Check 6: the receipt on the topic is this receipt. */
export const CHECK_RECEIPT_ANCHOR = "receipt anchor";

/** The checks, in the order they are run and printed. */
export const CHECK_NAMES = [
  CHECK_SIGNATURE,
  CHECK_IDENTITY,
  CHECK_MANDATE_LINK,
  CHECK_ANCHOR_SEQUENCE,
  CHECK_PAYMENTS,
  CHECK_RECEIPT_ANCHOR,
] as const;

/** The six anchors of one order, in the only order they can legitimately appear. */
export const EXPECTED_STEPS: AnchorKind[] = [
  "mandate_in",
  "payment_intake",
  "accepted",
  "delivered",
  "payment_balance",
  "receipt",
];

/** One verdict. */
export type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
  /**
   * False when the check had nothing to decide — the document carries no claim
   * of the kind this check examines. Absent means the check ran.
   *
   * It is kept apart from `ok` because "there was nothing to check" is not a
   * pass, and a reader who is told six things passed when one of them was never
   * examined has been told something false.
   */
  applicable?: boolean;
};

/** Everything a check is allowed to look at. */
export type VerificationInput = {
  /** Audit topic the anchors were read from. */
  topicId: string;
  /** The receipt under examination, as the customer stored it. */
  receipt: Envelope<PaymentReceipt>;
  /** The work order, when the person verifying happens to hold it. */
  mandate?: Envelope<Mandate>;
  /** Every anchor on the topic — including other orders'. */
  anchors: AnchorEntry[];
  /** Payment transactions, keyed by mirror-form id; null means "not on the ledger". */
  transactions: Map<string, MirrorTransaction | null>;
};

/**
 * The anchors that belong to one order.
 *
 * The topic is shared: several orders, and anyone else's messages, live on it.
 * Filtering by `mandate_id` is what keeps a neighbouring order from standing in
 * for a missing step of this one.
 *
 * @param anchors - Every anchor read from the topic
 * @param mandateId - The order to keep
 * @returns That order's anchors, ascending by sequence number
 */
export function anchorsForMandate(anchors: AnchorEntry[], mandateId: string): AnchorEntry[] {
  return anchors
    .filter(anchor => anchor.mandate_id === mandateId)
    .sort((left, right) => left.seq - right.seq);
}

/**
 * The transaction ids a verifier has to look up, in mirror-node form.
 *
 * @param receipt - The receipt under examination
 * @returns Intake first, then the balance when the receipt accounts for one
 */
export function paymentTransactionIds(receipt: Envelope<PaymentReceipt>): string[] {
  const payment = receipt.data.payment;
  return [payment.intake?.transaction_id, payment.balance?.transaction_id]
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map(toMirrorTxId);
}

/**
 * Runs every check, in printing order.
 *
 * @param input - The receipt and the public data it is judged against
 * @returns One result per check
 */
export function runChecks(input: VerificationInput): CheckResult[] {
  return [
    checkReceiptSignature(input),
    checkAgentIdentity(input),
    checkMandateLinkage(input),
    checkAnchorSequence(input),
    checkPayments(input),
    checkReceiptAnchor(input),
  ];
}

/**
 * Check 1 — the receipt carries a valid Ed25519 signature over its own body.
 *
 * This says the document was not edited after signing. It says nothing about
 * who holds the key; that is stated plainly in the closing statement.
 *
 * @param input - Verification input
 * @returns The verdict
 */
export function checkReceiptSignature(input: VerificationInput): CheckResult {
  const { sig } = input.receipt;
  const ok = verifyEnvelope(input.receipt);
  return {
    name: CHECK_SIGNATURE,
    ok,
    detail: ok
      ? `signed by ${short(sig?.pub)} over the receipt as issued`
      : "the signature does not cover this document — it was edited after signing, or the key does not match",
  };
}

/**
 * Check 2 — the identifier the receipt comes from is the key that signed it.
 *
 * Check 1 establishes that a key signed this document. It does not establish
 * *whose* key: `sig.pub` is 32 bytes, and a handle like `agency-x-agent` is a
 * name anyone may write. An HCS-14 identifier closes that gap when it is a
 * `uaid:did:` over `did:key`, because the identifier is the public key in
 * another encoding — decode it, compare, done, with no registry to ask and
 * nobody to trust.
 *
 * Where there is no such claim the check says so and decides nothing. Two
 * cases: envelopes that still carry plain handles, which is what every receipt
 * issued before this existed carries; and identifiers that would have to be
 * resolved — a `uaid:aid:`, which is a hash of descriptive fields, or a DID of
 * some other method. This verifier reads the public mirror node and nothing
 * else, so it cannot resolve either, and pretending a lookup it never made came
 * back clean would be the one dishonest thing in the report.
 *
 * @param input - Verification input
 * @returns The verdict, or a not-applicable result when there is no claim
 */
export function checkAgentIdentity(input: VerificationInput): CheckResult {
  const { from, to, sig } = input.receipt;
  const signer = sig?.pub?.toLowerCase() ?? "";

  if (!isUaid(from)) {
    return {
      name: CHECK_IDENTITY,
      ok: true,
      applicable: false,
      detail: `the receipt comes from "${from}", a handle rather than an HCS-14 identifier — it makes no identity claim to check`,
    };
  }

  const problems = uaidProblems(from).map(problem => `the issuer identifier: ${problem}`);
  if (typeof to === "string" && to.startsWith("uaid:") && !isUaid(to)) {
    problems.push(`the receipt is addressed to "${to}", which is not a well-formed identifier`);
  }
  if (problems.length > 0) {
    return fail(CHECK_IDENTITY, problems.join("; "));
  }

  const claimed = publicKeyForUaid(from);
  if (claimed === null) {
    return {
      name: CHECK_IDENTITY,
      ok: true,
      applicable: false,
      detail: `${from} names no key of its own — it would have to be resolved, and this verifier reads only the public mirror node`,
    };
  }
  if (claimed !== signer) {
    return fail(
      CHECK_IDENTITY,
      `the receipt is signed by ${short(signer)} but comes from an identifier that names ${short(claimed)}`,
    );
  }

  const mismatches = counterpartyProblems(input);
  if (mismatches.length > 0) {
    return fail(CHECK_IDENTITY, mismatches.join("; "));
  }

  const addressed = typeof to === "string" && isUaid(to) ? `, addressed to ${shortId(to)}` : "";
  return {
    name: CHECK_IDENTITY,
    ok: true,
    detail: `${shortId(from)} is the key that signed this receipt (${short(signer)})${addressed}`,
  };
}

/**
 * What the work order says about who the receipt is addressed to.
 *
 * Only checkable when the verifier holds the order: it is the customer's own
 * signed document, so it is the one place an outsider can see whether the
 * agent the contractor answered is the agent that asked.
 *
 * @param input - Verification input
 * @returns Problems; empty when there is no work order or nothing disagrees
 */
function counterpartyProblems(input: VerificationInput): string[] {
  const mandate = input.mandate;
  if (!mandate) {
    return [];
  }
  const problems: string[] = [];
  const sender = mandate.from;

  if (isUaid(sender)) {
    const key = publicKeyForUaid(sender);
    const signer = mandate.sig?.pub?.toLowerCase() ?? "";
    if (key !== null && key !== signer) {
      problems.push(
        `the work order comes from an identifier naming ${short(key)} but was signed by ${short(signer)}`,
      );
    }
  }
  if (input.receipt.to !== sender) {
    problems.push(
      `the receipt is addressed to "${input.receipt.to}" but the work order came from "${sender}"`,
    );
  }
  return problems;
}

/**
 * Check 3 — receipt, topic and work order all point at the same sealed mandate.
 *
 * The receipt claims a mandate envelope hash. That claim is worth something
 * only if the same hash is on the public topic; and if the verifier also holds
 * the work order, recomputing its hash closes the loop from the document all
 * the way to consensus.
 *
 * @param input - Verification input
 * @returns The verdict
 */
export function checkMandateLinkage(input: VerificationInput): CheckResult {
  const receipt = input.receipt.data;
  const claimed = receipt.mandate_envelope_hash.toLowerCase();
  const mandateIn = anchorsForMandate(input.anchors, receipt.mandate_id).find(
    anchor => anchor.kind === "mandate_in",
  );

  if (!mandateIn) {
    return fail(
      CHECK_MANDATE_LINK,
      `no mandate_in anchor for order ${receipt.mandate_id} on topic ${input.topicId}`,
    );
  }
  if (mandateIn.hash.toLowerCase() !== claimed) {
    return fail(
      CHECK_MANDATE_LINK,
      `the receipt names ${short(claimed)} but the topic anchored ${short(mandateIn.hash)}`,
    );
  }

  if (!input.mandate) {
    return {
      name: CHECK_MANDATE_LINK,
      ok: true,
      detail: `${claimed} anchored at #${mandateIn.seq}; no mandate file given, so the fingerprint was not recomputed`,
    };
  }

  if (input.mandate.data.mandate_id !== receipt.mandate_id) {
    return fail(
      CHECK_MANDATE_LINK,
      `the mandate file is order ${input.mandate.data.mandate_id}, the receipt is for ${receipt.mandate_id}`,
    );
  }

  const recomputed = envelopeHash(input.mandate);
  if (recomputed !== claimed) {
    return fail(
      CHECK_MANDATE_LINK,
      `the mandate file hashes to ${short(recomputed)}, but the receipt and the topic say ${short(claimed)}`,
    );
  }

  return {
    name: CHECK_MANDATE_LINK,
    ok: true,
    detail: `${claimed} — receipt, anchor #${mandateIn.seq} and the mandate file agree`,
  };
}

/**
 * Check 4 — the six steps of the order are on the topic, in order.
 *
 * Order is taken from consensus time, not from the anchors' own `at` field: the
 * network decides when something happened, the writer only claims it.
 *
 * @param input - Verification input
 * @returns The verdict
 */
export function checkAnchorSequence(input: VerificationInput): CheckResult {
  const mandateId = input.receipt.data.mandate_id;
  const mine = anchorsForMandate(input.anchors, mandateId);

  if (mine.length === 0) {
    return fail(
      CHECK_ANCHOR_SEQUENCE,
      `topic ${input.topicId} holds no anchors for order ${mandateId}`,
    );
  }

  const duplicated = EXPECTED_STEPS.filter(
    step => mine.filter(anchor => anchor.kind === step).length > 1,
  );
  if (duplicated.length > 0) {
    return fail(
      CHECK_ANCHOR_SEQUENCE,
      `anchored twice for this order: ${duplicated.join(", ")} — the trail is ambiguous`,
    );
  }

  const missing = EXPECTED_STEPS.filter(step => !mine.some(anchor => anchor.kind === step));
  if (missing.length > 0) {
    return fail(CHECK_ANCHOR_SEQUENCE, `missing from the topic: ${missing.join(", ")}`);
  }

  const byConsensus = [...mine].sort((left, right) =>
    compareConsensus(left.consensus_ts, right.consensus_ts),
  );
  const actual = byConsensus.map(anchor => anchor.kind);
  const expected = EXPECTED_STEPS.filter(step => actual.includes(step));
  if (actual.join(" → ") !== expected.join(" → ")) {
    return fail(
      CHECK_ANCHOR_SEQUENCE,
      `the steps reached consensus out of order: ${actual.join(" → ")}`,
    );
  }

  const positions = byConsensus.map(anchor => `${anchor.kind} #${anchor.seq}`).join(" → ");
  return { name: CHECK_ANCHOR_SEQUENCE, ok: true, detail: positions };
}

/**
 * Check 5 — both payments really happened, to the parties the receipt names.
 *
 * Four things have to line up per leg: the transfer succeeded; the payer lost
 * exactly the stated amount; the payee gained exactly the stated amount; and
 * somebody other than the payer paid the network fee — which is what the x402
 * facilitator does, and what stops a "payment" from being a self-transfer
 * dressed up. On top of that the anchored payment hash must cover exactly the
 * payment the receipt publishes, so the topic and the receipt cannot disagree.
 *
 * @param input - Verification input
 * @returns The verdict
 */
export function checkPayments(input: VerificationInput): CheckResult {
  const receipt = input.receipt.data;
  const payment = receipt.payment;
  const mine = anchorsForMandate(input.anchors, receipt.mandate_id);
  const problems: string[] = [];
  const summaries: string[] = [];

  const legs: { name: "intake" | "balance"; leg: PaymentLeg | undefined; kind: AnchorKind }[] = [
    { name: "intake", leg: payment.intake, kind: "payment_intake" },
    { name: "balance", leg: payment.balance, kind: "payment_balance" },
  ];

  for (const { name, leg, kind } of legs) {
    if (!leg) {
      problems.push(
        name === "balance"
          ? "the receipt claims delivery but accounts for no balance payment"
          : "the receipt accounts for no intake payment",
      );
      continue;
    }
    const legProblems = inspectLeg(name, leg, kind, payment, mine, input.transactions);
    problems.push(...legProblems);
    summaries.push(
      `${name} ${leg.tinybars} tinybars ${payment.payer} → ${payment.payee} (${toMirrorTxId(leg.transaction_id)})`,
    );
  }

  if (problems.length > 0) {
    return fail(CHECK_PAYMENTS, problems.join("; "));
  }
  return { name: CHECK_PAYMENTS, ok: true, detail: summaries.join("; ") };
}

/**
 * Check 6 — the receipt on the topic is byte for byte this receipt.
 *
 * The hash covers the envelope as signed, so this is what fixes the document in
 * time: any later edit changes the hash and this check stops matching.
 *
 * @param input - Verification input
 * @returns The verdict
 */
export function checkReceiptAnchor(input: VerificationInput): CheckResult {
  const receipt = input.receipt.data;
  const anchor = anchorsForMandate(input.anchors, receipt.mandate_id).find(
    entry => entry.kind === "receipt",
  );
  if (!anchor) {
    return fail(
      CHECK_RECEIPT_ANCHOR,
      `no receipt anchor for order ${receipt.mandate_id} on topic ${input.topicId}`,
    );
  }

  const computed = envelopeHash(input.receipt);
  if (computed !== anchor.hash.toLowerCase()) {
    return fail(
      CHECK_RECEIPT_ANCHOR,
      `this receipt hashes to ${short(computed)}, the topic anchored ${short(anchor.hash)} at #${anchor.seq}`,
    );
  }

  return {
    name: CHECK_RECEIPT_ANCHOR,
    ok: true,
    detail: `${computed} anchored at #${anchor.seq} (${anchor.consensus_ts})`,
  };
}

/**
 * Everything wrong with one payment leg.
 *
 * @param name - Leg name, for the messages
 * @param leg - The leg the receipt publishes
 * @param kind - The anchor kind that should cover it
 * @param payment - The payment block the leg belongs to
 * @param mine - This order's anchors
 * @param transactions - Transactions read from the mirror node
 * @returns Human-readable problems; empty when the leg checks out
 */
function inspectLeg(
  name: string,
  leg: PaymentLeg,
  kind: AnchorKind,
  payment: Payment,
  mine: AnchorEntry[],
  transactions: Map<string, MirrorTransaction | null>,
): string[] {
  const problems: string[] = [];
  const mirrorId = toMirrorTxId(leg.transaction_id);
  const transaction = transactions.get(mirrorId) ?? null;

  if (!transaction) {
    problems.push(`the ${name} transaction ${mirrorId} is not on the mirror node`);
  } else {
    if (transaction.result !== "SUCCESS") {
      problems.push(`the ${name} transaction ${mirrorId} ended as ${transaction.result}`);
    }

    const transfers = transaction.transfers ?? [];
    const debited = transfers.some(
      transfer => transfer.account === payment.payer && transfer.amount === -leg.tinybars,
    );
    if (!debited) {
      problems.push(
        `the ${name} payer ${payment.payer} was not debited exactly ${leg.tinybars} tinybars`,
      );
    }

    const credited = transfers.some(
      transfer => transfer.account === payment.payee && transfer.amount === leg.tinybars,
    );
    if (!credited) {
      problems.push(
        `the ${name} payee ${payment.payee} was not credited exactly ${leg.tinybars} tinybars`,
      );
    }

    // In Hedera the account named by the transaction id pays the network fee.
    const feePayer = accountFromTransactionId(transaction.transaction_id ?? mirrorId);
    if (feePayer && feePayer === payment.payer) {
      problems.push(
        `the ${name} fee was paid by the payer ${payment.payer}, so no facilitator settled it`,
      );
    }
  }

  const anchor = mine.find(entry => entry.kind === kind);
  if (!anchor) {
    problems.push(`no ${kind} anchor for the ${name} payment`);
    return problems;
  }

  const expected = paymentAnchorHash({
    network: payment.network,
    asset: payment.asset,
    payer: payment.payer,
    payee: payment.payee,
    tinybars: leg.tinybars,
    transaction_id: leg.transaction_id,
  });
  if (expected !== anchor.hash.toLowerCase()) {
    problems.push(
      `the ${kind} anchor does not cover the ${name} payment the receipt states (anchored ${short(anchor.hash)}, receipt implies ${short(expected)})`,
    );
  }
  if (anchor.ref && safeMirrorId(anchor.ref) !== mirrorId) {
    problems.push(`the ${kind} anchor points at transaction ${anchor.ref}, not ${mirrorId}`);
  }

  return problems;
}

/**
 * The account that paid for a transaction, taken from its id.
 *
 * @param transactionId - Transaction id in either form
 * @returns The account, or null when the id is not one
 */
function accountFromTransactionId(transactionId: string): string | null {
  const match = /^(\d+\.\d+\.\d+)[-@]/.exec(transactionId);
  return match ? match[1] : null;
}

/**
 * Converts an id to mirror form without throwing on rubbish read off a topic.
 *
 * @param transactionId - Candidate id
 * @returns The mirror form, or the input unchanged when it is not an id
 */
function safeMirrorId(transactionId: string): string {
  try {
    return toMirrorTxId(transactionId);
  } catch {
    return transactionId;
  }
}

/**
 * Orders two `seconds.nanoseconds` consensus timestamps.
 *
 * Compared as numbers per part rather than as strings, so nanosecond fields of
 * different lengths cannot order wrongly.
 *
 * @param left - First timestamp
 * @param right - Second timestamp
 * @returns Negative, zero or positive as usual for a comparator
 */
function compareConsensus(left: string, right: string): number {
  const [leftSeconds, leftNanos = "0"] = left.split(".");
  const [rightSeconds, rightNanos = "0"] = right.split(".");
  const seconds = Number(leftSeconds) - Number(rightSeconds);
  if (seconds !== 0) {
    return seconds;
  }
  return Number(leftNanos.padEnd(9, "0")) - Number(rightNanos.padEnd(9, "0"));
}

/**
 * Builds a failing result.
 *
 * @param name - Check name
 * @param detail - What went wrong
 * @returns The verdict
 */
function fail(name: string, detail: string): CheckResult {
  return { name, ok: false, detail };
}

/**
 * Shortens an identifier for a one-line message, keeping the part that identifies.
 *
 * The routing parameters are dropped and the id is cut, because what a reader
 * needs from a `uaid:did:z6Mk…` in a table row is which agent it is, not the
 * whole string; the full value is in the receipt.
 *
 * @param value - An identifier
 * @returns A short form
 */
function shortId(value: string): string {
  const head = value.split(";")[0] ?? value;
  const marker = head.lastIndexOf(":");
  const id = marker === -1 ? head : head.slice(marker + 1);
  const scheme = marker === -1 ? "" : head.slice(0, marker + 1);
  return id.length <= 16 ? head : `${scheme}${id.slice(0, 12)}…`;
}

/**
 * Shortens a hash for a one-line message.
 *
 * @param value - Hash or key, possibly undefined
 * @returns A short form ending in an ellipsis
 */
function short(value: string | undefined): string {
  if (!value) {
    return "(none)";
  }
  return value.length <= 16 ? value : `${value.slice(0, 12)}…`;
}
