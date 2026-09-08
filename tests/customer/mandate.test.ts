/**
 * Building a signed work order out of a story card, and reading the
 * contractor's answers back safely.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { envelopeHash, signEnvelope, verifyEnvelope } from "../../protocol/envelope";
import { SchemaError, validateMandate, validateReceipt } from "../../protocol/schemas";
import type { Envelope, Receipt } from "../../protocol/types";
import {
  buildMandate,
  buildMandateEnvelope,
  loadStory,
  parseAcceptedResponse,
  uuidV7,
} from "../../customer/cli";
import { loadSigningIdentity } from "../../customer/wallet";

const FIXTURE = fileURLToPath(new URL("../../demo/fixtures/story-history-grouping.json", import.meta.url));

const SIGNING_KEY = "33".repeat(32);
const IDENTITY = loadSigningIdentity({
  CUSTOMER_SIGNING_KEY: SIGNING_KEY,
  CUSTOMER_HANDLE: "client-y",
  CONTRACTOR_AGENT: "agency-x",
  CUSTOMER_ACCOUNT_ID: "0.0.10365982",
  CUSTOMER_PRIVATE_KEY: "302e020100300506032b657004220420" + "44".repeat(16),
});

describe("story fixture", () => {
  it("loads and carries acceptance criteria", () => {
    const story = loadStory(FIXTURE);
    expect(story.title.length).toBeGreaterThan(0);
    expect(story.acceptance.length).toBeGreaterThanOrEqual(3);
  });
});

describe("buildMandate", () => {
  it("produces a document that validates against mandate.v1", () => {
    const mandate = buildMandate(loadStory(FIXTURE), { issuer: IDENTITY.handle });
    expect(() => validateMandate(mandate)).not.toThrow();
  });

  it("copies the acceptance criteria verbatim and keeps the issuer handle", () => {
    const story = loadStory(FIXTURE);
    const mandate = buildMandate(story, { issuer: "client-y" });
    expect(mandate.acceptance).toEqual(story.acceptance);
    expect(mandate.title).toBe(story.title);
    expect(mandate.issuer).toBe("client-y");
  });

  it("mints a fresh mandate id per order and honours an explicit one", () => {
    const story = loadStory(FIXTURE);
    const first = buildMandate(story, { issuer: "client-y" });
    const second = buildMandate(story, { issuer: "client-y" });
    expect(first.mandate_id).not.toBe(second.mandate_id);
    expect(buildMandate(story, { issuer: "client-y", mandateId: "wo-fixed" }).mandate_id).toBe("wo-fixed");
  });

  it("rejects a story that is missing acceptance criteria", () => {
    const story = { ...loadStory(FIXTURE), acceptance: [] };
    expect(() => buildMandate(story, { issuer: "client-y" })).toThrow(SchemaError);
  });

  it("carries no money or hours fields, which the base schema forbids", () => {
    const mandate = buildMandate(loadStory(FIXTURE), { issuer: "client-y" }) as Record<string, unknown>;
    expect(mandate["hours"]).toBeUndefined();
    expect(mandate["price"]).toBeUndefined();
  });
});

describe("buildMandateEnvelope", () => {
  it("signs an envelope that verifies and is tagged mandate.v1", () => {
    const mandate = buildMandate(loadStory(FIXTURE), { issuer: IDENTITY.handle });
    const envelope = buildMandateEnvelope(mandate, IDENTITY);
    expect(envelope.schema).toBe("mandate.v1");
    expect(envelope.from).toBe("client-y");
    expect(envelope.to).toBe("agency-x");
    expect(envelope.thread_id).toBe(mandate.mandate_id);
    expect(envelope.sig.pub).toBe(IDENTITY.publicKeyHex);
    expect(verifyEnvelope(envelope)).toBe(true);
  });

  it("is detected when a single character of the order is changed", () => {
    const mandate = buildMandate(loadStory(FIXTURE), { issuer: IDENTITY.handle });
    const envelope = buildMandateEnvelope(mandate, IDENTITY);
    const tampered = { ...envelope, data: { ...envelope.data, title: envelope.data.title + "!" } };
    expect(verifyEnvelope(tampered)).toBe(false);
    expect(envelopeHash(tampered)).not.toBe(envelopeHash(envelope));
  });
});

describe("uuidV7", () => {
  it("looks like a version 7 uuid and sorts by time", async () => {
    const first = uuidV7();
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = uuidV7();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first < second).toBe(true);
  });
});

describe("parseAcceptedResponse", () => {
  const mandate = buildMandate(loadStory(FIXTURE), { issuer: IDENTITY.handle });
  const mandateEnvelope = buildMandateEnvelope(mandate, IDENTITY);
  const contractorKey = "55".repeat(32);

  /**
   * Builds a signed acceptance receipt the way the contractor service does.
   *
   * @param overrides - Receipt fields to replace
   * @returns The signed envelope
   */
  function acceptance(overrides: Partial<Receipt> = {}): Envelope<Receipt> {
    const receipt: Receipt = {
      receipt_id: uuidV7(),
      kind: "accepted",
      mandate_id: mandate.mandate_id,
      mandate_envelope_hash: envelopeHash(mandateEnvelope),
      mandate_anchor: { topic: "0.0.10366318", seq: 12, consensus_ts: "1788539659.779000000" },
      taken: mandate.acceptance,
      issued_at: new Date().toISOString(),
      issuer: "agency-x",
      ...overrides,
    };
    return signEnvelope<Receipt>(
      {
        schema: "receipt.v1",
        from: "agency-x",
        to: "client-y",
        thread_id: mandate.mandate_id,
        issued_at: receipt.issued_at,
        data: receipt,
      },
      contractorKey,
    );
  }

  it("accepts a well-formed acceptance for this order", () => {
    const parsed = parseAcceptedResponse({ receipt: acceptance() }, mandateEnvelope);
    expect(parsed.data.kind).toBe("accepted");
    expect(() => validateReceipt(parsed.data)).not.toThrow();
  });

  it("refuses a receipt whose signature does not match", () => {
    const forged = acceptance();
    forged.data.taken = ["something else"];
    expect(() => parseAcceptedResponse({ receipt: forged }, mandateEnvelope)).toThrow(/signature/i);
  });

  it("refuses a receipt that points at a different order", () => {
    const other = acceptance({ mandate_envelope_hash: "0".repeat(64) });
    expect(() => parseAcceptedResponse({ receipt: other }, mandateEnvelope)).toThrow(/envelope hash/i);
  });

  it("refuses a body that carries no receipt", () => {
    expect(() => parseAcceptedResponse({ error: "nope" }, mandateEnvelope)).toThrow(/receipt/i);
  });
});
