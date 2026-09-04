/**
 * Schema validators over the canonical schemas in docs/schemas.
 *
 * The schema files are external inputs: this suite reads them and their
 * examples from the repository and never edits them.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SchemaError, validateMandate, validatePaymentReceipt, validateReceipt } from "../../protocol/schemas.js";

/**
 * Reads an example document from `docs/schemas/examples`.
 *
 * @param name - File name inside the examples directory
 * @returns The parsed document
 */
function example(name: string): Record<string, unknown> {
  const url = new URL(`../../docs/schemas/examples/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

const mandate = (): Record<string, unknown> => example("mandate.v1.example.json");
const accepted = (): Record<string, unknown> => example("receipt.v1.accepted.example.json");
const delivered = (): Record<string, unknown> => example("receipt.v1.delivered+payment.example.json");

describe("the shipped examples", () => {
  it("validates the mandate example", () => {
    expect(() => validateMandate(mandate())).not.toThrow();
  });

  it("validates the accepted receipt example", () => {
    expect(() => validateReceipt(accepted())).not.toThrow();
  });

  it("validates the delivered receipt example against the payment profile", () => {
    expect(() => validatePaymentReceipt(delivered())).not.toThrow();
  });

  it("validates a delivered receipt without payment against the base schema", () => {
    const { payment: _payment, ...base } = delivered();
    expect(() => validateReceipt(base)).not.toThrow();
  });
});

describe("money and hours stay out of the base protocol", () => {
  it("rejects an hours key on a mandate", () => {
    expect(() => validateMandate({ ...mandate(), hours: 8 })).toThrow(SchemaError);
    expect(() => validateMandate({ ...mandate(), hours: 8 })).toThrow(/hours/);
  });

  it("rejects an hours key on the payment profile", () => {
    expect(() => validatePaymentReceipt({ ...delivered(), hours: 8 })).toThrow(/hours/);
  });

  it("rejects any other money key the base protocol keeps out", () => {
    expect(() => validateMandate({ ...mandate(), rate: 120 })).toThrow(/rate/);
    expect(() => validateReceipt({ ...accepted(), amount_usd: 500 })).toThrow(/amount_usd/);
  });

  it("rejects a payment object on the base receipt schema", () => {
    expect(() => validateReceipt(delivered())).toThrow(SchemaError);
    expect(() => validateReceipt(delivered())).toThrow(/payment/);
  });
});

describe("receipt rules", () => {
  it("rejects kind delivered without a result", () => {
    const { payment: _payment, result: _result, ...noResult } = delivered();
    expect(() => validateReceipt(noResult)).toThrow(/result/);
  });

  it("rejects kind delivered without a result on the payment profile too", () => {
    const { result: _result, ...noResult } = delivered();
    expect(() => validatePaymentReceipt(noResult)).toThrow(/result/);
  });

  it("rejects kind accepted with an empty taken list", () => {
    expect(() => validateReceipt({ ...accepted(), taken: [] })).toThrow(SchemaError);
  });

  it("accepts an anchor the mirror node has not caught up with yet", () => {
    const pending = { ...accepted(), mandate_anchor: { topic: "0.0.10366000", seq: null, consensus_ts: null } };
    expect(() => validateReceipt(pending)).not.toThrow();
  });

  it("accepts declined criteria and rejects one without a reason", () => {
    const declined = [{ criterion: "Existing sort order inside a day is preserved", reason: "Out of the agreed frame" }];
    expect(() => validateReceipt({ ...accepted(), declined })).not.toThrow();
    expect(() => validateReceipt({ ...accepted(), declined: [{ criterion: "x" }] })).toThrow(/reason/);
  });

  it("rejects a mandate envelope hash that is not 64 hex characters", () => {
    expect(() => validateReceipt({ ...accepted(), mandate_envelope_hash: "abc" })).toThrow(/mandate_envelope_hash/);
  });

  it("requires a payment object on the profile", () => {
    expect(() => validatePaymentReceipt(accepted())).toThrow(/payment/);
  });

  it("rejects a payment leg without a transaction id", () => {
    const doc = delivered();
    const payment = doc.payment as Record<string, unknown>;
    const broken = { ...doc, payment: { ...payment, intake: { tinybars: 1000000 } } };
    expect(() => validatePaymentReceipt(broken)).toThrow(/transaction_id/);
  });
});

describe("mandate rules", () => {
  it("rejects a missing required field", () => {
    const { issuer: _issuer, ...noIssuer } = mandate();
    expect(() => validateMandate(noIssuer)).toThrow(/issuer/);
  });

  it("rejects a story url that is not https", () => {
    expect(() => validateMandate({ ...mandate(), story_url: "http://example.com/story" })).toThrow(/story_url/);
  });

  it("rejects an issued_at that is not a date-time", () => {
    expect(() => validateMandate({ ...mandate(), issued_at: "yesterday" })).toThrow(/issued_at/);
  });

  it("rejects an empty acceptance list", () => {
    expect(() => validateMandate({ ...mandate(), acceptance: [] })).toThrow(SchemaError);
  });

  it("rejects a non-object document", () => {
    expect(() => validateMandate("nope")).toThrow(SchemaError);
    expect(() => validateMandate(null)).toThrow(SchemaError);
  });
});

describe("SchemaError", () => {
  it("names the schema and the failing instance path", () => {
    let error: SchemaError | undefined;
    try {
      validateMandate({ ...mandate(), story_url: "http://example.com/story" });
    } catch (caught) {
      error = caught as SchemaError;
    }
    expect(error).toBeInstanceOf(SchemaError);
    expect(error?.schema).toBe("mandate.v1");
    expect(error?.message).toContain("/story_url");
    expect(error?.errors.length).toBeGreaterThan(0);
    expect(error?.errors[0]?.instancePath).toBe("/story_url");
  });

  it("does not mutate the document it rejects", () => {
    const doc = { ...mandate(), hours: 8 };
    const before = JSON.stringify(doc);
    expect(() => validateMandate(doc)).toThrow();
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("assertion typing", () => {
  it("narrows the document for the caller", () => {
    const doc: unknown = mandate();
    validateMandate(doc);
    expect(doc.mandate_id).toBe("0192c3f0-5b7e-7a10-9d2e-6f1a2b3c4d5e");
    const receiptDoc: unknown = delivered();
    validatePaymentReceipt(receiptDoc);
    expect(receiptDoc.payment.intake.tinybars).toBe(1000000);
  });
});
