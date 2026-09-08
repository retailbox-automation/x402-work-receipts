/**
 * Receipts are the only thing the contractor signs, and the only thing the
 * customer keeps. A receipt that does not validate against the published
 * schema, or whose hash does not tie back to the mandate that was anchored, is
 * worthless to a third party — so every assertion here is about one of those
 * two properties.
 */
import { describe, expect, it } from "vitest";
import { canonicalize, sha256Hex } from "../../protocol/canonical";
import { envelopeHash, publicKeyHex, verifyEnvelope } from "../../protocol/envelope";
import { SchemaError, validatePaymentReceipt, validateReceipt } from "../../protocol/schemas";
import type { Payment, PaymentReceipt, Receipt } from "../../protocol/types";
import {
  buildAcceptedReceipt,
  buildDeliveredReceipt,
  buildRejectedReceipt,
  newReceiptId,
  paymentAnchorHash,
  sealReceipt,
} from "../../contractor/receipts";
import {
  BALANCE_TX_ID,
  CONTRACTOR_HANDLE,
  CONTRACTOR_KEY,
  CUSTOMER_HANDLE,
  INTAKE_TX_ID,
  PAYEE_ACCOUNT,
  PAYER_ACCOUNT,
  TOPIC_ID,
  mandateEnvelope,
  mandateFixture,
} from "./helpers";

const MANDATE = mandateFixture();
const ENVELOPE = mandateEnvelope(MANDATE);
const MANDATE_HASH = envelopeHash(ENVELOPE);
const ANCHOR = { topic: TOPIC_ID, seq: 1, consensus_ts: "1788600001.000000001" };
const ISSUED_AT = "2026-09-08T10:00:00.000Z";

const PAYMENT: Payment = {
  network: "hedera:testnet",
  asset: "0.0.0",
  facilitator: "https://api.testnet.blocky402.com",
  payer: PAYER_ACCOUNT,
  payee: PAYEE_ACCOUNT,
  intake: { tinybars: 1_000_000, transaction_id: INTAKE_TX_ID },
  balance: { tinybars: 4_000_000, transaction_id: BALANCE_TX_ID },
};

const RESULT = {
  pr_url: "https://git.example.com/agency-x/client-y-web/-/merge_requests/101",
  staging_url: "https://staging.example-client.app/preview/1a2b3c4",
  notion_status: "Testing",
};

/**
 * Builds the acceptance receipt used by most of these tests.
 *
 * @returns The receipt
 */
function accepted(): Receipt {
  return buildAcceptedReceipt({
    mandate: MANDATE,
    mandateEnvelopeHash: MANDATE_HASH,
    mandateAnchor: ANCHOR,
    issuer: CONTRACTOR_HANDLE,
    issuedAt: ISSUED_AT,
    receiptId: "0192c3f1-2c8f-7b21-8e3f-7a2b3c4d5e6f",
  });
}

/**
 * Builds the delivery receipt used by most of these tests.
 *
 * @param payment - Payment profile to embed
 * @returns The receipt
 */
function delivered(payment: Payment = PAYMENT): PaymentReceipt {
  return buildDeliveredReceipt({
    mandate: MANDATE,
    mandateEnvelopeHash: MANDATE_HASH,
    mandateAnchor: ANCHOR,
    issuer: CONTRACTOR_HANDLE,
    issuedAt: ISSUED_AT,
    receiptId: "0192c3f9-9a1b-7c32-8f4a-8b3c4d5e6f70",
    result: RESULT,
    payment,
  });
}

describe("buildAcceptedReceipt", () => {
  it("produces a receipt that validates against receipt.v1", () => {
    const receipt = accepted();
    expect(() => validateReceipt(receipt)).not.toThrow();
    expect(receipt.kind).toBe("accepted");
    expect(receipt.result).toBeUndefined();
  });

  it("takes every acceptance criterion of the mandate, verbatim", () => {
    expect(accepted().taken).toEqual(MANDATE.acceptance);
  });

  it("carries the anchored mandate hash and its position on the topic", () => {
    const receipt = accepted();
    expect(receipt.mandate_envelope_hash).toBe(MANDATE_HASH);
    expect(receipt.mandate_anchor).toEqual(ANCHOR);
    expect(receipt.mandate_id).toBe(MANDATE.mandate_id);
  });

  it("records what it declines, with the reason", () => {
    const receipt = buildAcceptedReceipt({
      mandate: MANDATE,
      mandateEnvelopeHash: MANDATE_HASH,
      mandateAnchor: ANCHOR,
      issuer: CONTRACTOR_HANDLE,
      issuedAt: ISSUED_AT,
      declined: [{ criterion: MANDATE.acceptance[2], reason: "Needs a decision from the customer" }],
    });
    expect(receipt.taken).toEqual(MANDATE.acceptance.slice(0, 2));
    expect(receipt.declined).toEqual([
      { criterion: MANDATE.acceptance[2], reason: "Needs a decision from the customer" },
    ]);
    expect(() => validateReceipt(receipt)).not.toThrow();
  });

  it("refuses to sign a receipt whose mandate hash is not a sha-256 digest", () => {
    expect(() =>
      buildAcceptedReceipt({
        mandate: MANDATE,
        mandateEnvelopeHash: "not-a-hash",
        mandateAnchor: ANCHOR,
        issuer: CONTRACTOR_HANDLE,
        issuedAt: ISSUED_AT,
      }),
    ).toThrow(SchemaError);
  });
});

describe("buildDeliveredReceipt", () => {
  it("produces a receipt that validates against the payment profile", () => {
    const receipt = delivered();
    expect(() => validatePaymentReceipt(receipt)).not.toThrow();
    expect(receipt.kind).toBe("delivered");
    expect(receipt.result).toEqual(RESULT);
  });

  it("is rejected by the base receipt.v1, which carries no money fields", () => {
    // The base protocol validator refuses any key it has not evaluated; that is
    // the boundary the payment profile exists to cross, so it must stay closed.
    expect(() => validateReceipt(delivered())).toThrow(SchemaError);
  });

  it("keeps both payment legs and the facilitator that settled them", () => {
    const receipt = delivered();
    expect(receipt.payment.intake.transaction_id).toBe(INTAKE_TX_ID);
    expect(receipt.payment.balance?.transaction_id).toBe(BALANCE_TX_ID);
    expect(receipt.payment.facilitator).toBe("https://api.testnet.blocky402.com");
    expect(receipt.payment.payer).toBe(PAYER_ACCOUNT);
    expect(receipt.payment.payee).toBe(PAYEE_ACCOUNT);
  });

  it("refuses a delivery receipt that accounts for no balance payment", () => {
    const { balance, ...intakeOnly } = PAYMENT;
    expect(() => delivered(intakeOnly as Payment)).toThrow(/balance/i);
  });

  it("refuses a result link that is not https", () => {
    expect(() =>
      buildDeliveredReceipt({
        mandate: MANDATE,
        mandateEnvelopeHash: MANDATE_HASH,
        mandateAnchor: ANCHOR,
        issuer: CONTRACTOR_HANDLE,
        issuedAt: ISSUED_AT,
        result: { ...RESULT, pr_url: "http://git.example.com/insecure" },
        payment: PAYMENT,
      }),
    ).toThrow(SchemaError);
  });
});

describe("buildRejectedReceipt", () => {
  it("produces a refusal that validates and quotes none of the message", () => {
    const receipt = buildRejectedReceipt({
      messageId: "msg-7f3a",
      messageHash: sha256Hex("whatever arrived"),
      topic: TOPIC_ID,
      issuer: CONTRACTOR_HANDLE,
      issuedAt: ISSUED_AT,
      reason: "Body is not a mandate.v1 envelope",
    });

    expect(() => validateReceipt(receipt)).not.toThrow();
    expect(receipt.kind).toBe("rejected");
    expect(receipt.taken).toEqual([]);
    expect(receipt.expected_schema).toBe("mandate.v1");
    expect(receipt.schema_url).toMatch(/^https:\/\//);
    // Nothing was accepted, so nothing was anchored: the position is honestly null.
    expect(receipt.mandate_anchor).toEqual({ topic: TOPIC_ID, seq: null, consensus_ts: null });
  });
});

describe("sealReceipt", () => {
  it("signs an acceptance receipt with the contractor key and tags it receipt.v1", () => {
    const envelope = sealReceipt(accepted(), {
      from: CONTRACTOR_HANDLE,
      to: CUSTOMER_HANDLE,
      threadId: ENVELOPE.thread_id,
      issuedAt: ISSUED_AT,
      privateKeyHex: CONTRACTOR_KEY,
    });

    expect(envelope.schema).toBe("receipt.v1");
    expect(envelope.sig.pub).toBe(publicKeyHex(CONTRACTOR_KEY));
    expect(verifyEnvelope(envelope)).toBe(true);
    expect(envelope.thread_id).toBe(ENVELOPE.thread_id);
  });

  it("tags a receipt that carries payment as receipt.v1+payment.v1", () => {
    const envelope = sealReceipt(delivered(), {
      from: CONTRACTOR_HANDLE,
      to: CUSTOMER_HANDLE,
      threadId: ENVELOPE.thread_id,
      issuedAt: ISSUED_AT,
      privateKeyHex: CONTRACTOR_KEY,
    });

    expect(envelope.schema).toBe("receipt.v1+payment.v1");
    expect(verifyEnvelope(envelope)).toBe(true);
  });

  it("produces an envelope hash that changes when one byte of the receipt changes", () => {
    const options = {
      from: CONTRACTOR_HANDLE,
      to: CUSTOMER_HANDLE,
      threadId: ENVELOPE.thread_id,
      issuedAt: ISSUED_AT,
      privateKeyHex: CONTRACTOR_KEY,
    };
    const original = sealReceipt(accepted(), options);
    const tampered = { ...original, data: { ...original.data, issuer: "someone-else" } };

    expect(envelopeHash(tampered)).not.toBe(envelopeHash(original));
    // The tampered copy also stops verifying, which is what the anchor and the
    // signature check catch independently of each other.
    expect(verifyEnvelope(tampered)).toBe(false);
  });
});

describe("paymentAnchorHash", () => {
  it("is recomputable by anyone holding the receipt's payment profile", () => {
    const leg = {
      network: PAYMENT.network,
      asset: PAYMENT.asset,
      payer: PAYMENT.payer,
      payee: PAYMENT.payee,
      tinybars: PAYMENT.intake.tinybars,
      transaction_id: PAYMENT.intake.transaction_id,
    };
    const expected = sha256Hex(canonicalize({ v: "wr-payment.v1", ...leg }));

    expect(paymentAnchorHash(leg)).toBe(expected);
    expect(paymentAnchorHash(leg)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs between the intake and the balance leg of the same order", () => {
    const base = {
      network: PAYMENT.network,
      asset: PAYMENT.asset,
      payer: PAYMENT.payer,
      payee: PAYMENT.payee,
    };
    expect(paymentAnchorHash({ ...base, tinybars: 1_000_000, transaction_id: INTAKE_TX_ID })).not.toBe(
      paymentAnchorHash({ ...base, tinybars: 4_000_000, transaction_id: BALANCE_TX_ID }),
    );
  });
});

describe("newReceiptId", () => {
  it("is a uuid version 7, so ids sort by the time they were issued", () => {
    const early = newReceiptId(new Date("2026-09-08T10:00:00.000Z"));
    const late = newReceiptId(new Date("2026-09-08T10:00:01.000Z"));

    expect(early).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(early < late).toBe(true);
  });

  it("does not repeat itself inside one millisecond", () => {
    const now = new Date("2026-09-08T10:00:00.000Z");
    const ids = new Set(Array.from({ length: 200 }, () => newReceiptId(now)));
    expect(ids.size).toBe(200);
  });
});
