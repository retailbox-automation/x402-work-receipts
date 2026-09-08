/**
 * What the agent leaves on disk after an order: the signed work order, the
 * acceptance, and the paid receipt. These files are the customer's own copy of
 * the exchange and the input to the public verifier, so they are checked here
 * exactly as the verifier will read them.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { envelopeHash, signEnvelope, verifyEnvelope } from "../../protocol/envelope";
import { validateMandate, validatePaymentReceipt, validateReceipt } from "../../protocol/schemas";
import type { Envelope, PaymentReceipt, Receipt } from "../../protocol/types";
import {
  artifactPaths,
  buildMandate,
  buildMandateEnvelope,
  loadStory,
  parseDeliveredResponse,
  saveOrderArtifacts,
  saveReceiptArtifact,
  uuidV7,
} from "../../customer/cli";
import { loadSigningIdentity } from "../../customer/wallet";

const FIXTURE = fileURLToPath(new URL("../../demo/fixtures/story-history-grouping.json", import.meta.url));
const CONTRACTOR_KEY = "66".repeat(32);

const identity = loadSigningIdentity({
  CUSTOMER_SIGNING_KEY: "77".repeat(32),
  CUSTOMER_HANDLE: "client-y",
  CONTRACTOR_AGENT: "agency-x",
  CUSTOMER_ACCOUNT_ID: "0.0.10365982",
  CUSTOMER_PRIVATE_KEY: "302e020100300506032b657004220420" + "88".repeat(16),
});

const mandate = buildMandate(loadStory(FIXTURE), { issuer: identity.handle });
const mandateEnvelope = buildMandateEnvelope(mandate, identity);
const outDir = mkdtempSync(join(tmpdir(), "x402-work-receipts-"));

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

/**
 * Reads a JSON artifact back from disk.
 *
 * @param path - File to read
 * @returns The parsed value
 */
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The acceptance receipt the contractor returns from `POST /mandates`. */
const acceptedEnvelope = signEnvelope<Receipt>(
  {
    schema: "receipt.v1",
    from: "agency-x",
    to: "client-y",
    thread_id: mandate.mandate_id,
    issued_at: "2026-09-08T10:00:00.000Z",
    data: {
      receipt_id: uuidV7(),
      kind: "accepted",
      mandate_id: mandate.mandate_id,
      mandate_envelope_hash: envelopeHash(mandateEnvelope),
      mandate_anchor: { topic: "0.0.10366318", seq: 3, consensus_ts: "1788539659.779000000" },
      taken: mandate.acceptance,
      issued_at: "2026-09-08T10:00:00.000Z",
      issuer: "agency-x",
    },
  },
  CONTRACTOR_KEY,
);

/** The paid receipt the contractor returns from `GET /mandates/{id}/receipt`. */
const deliveredEnvelope = signEnvelope<PaymentReceipt>(
  {
    schema: "receipt.v1+payment.v1",
    from: "agency-x",
    to: "client-y",
    thread_id: mandate.mandate_id,
    issued_at: "2026-09-08T12:00:00.000Z",
    data: {
      receipt_id: uuidV7(),
      kind: "delivered",
      mandate_id: mandate.mandate_id,
      mandate_envelope_hash: envelopeHash(mandateEnvelope),
      mandate_anchor: { topic: "0.0.10366318", seq: 3, consensus_ts: "1788539659.779000000" },
      taken: mandate.acceptance,
      result: {
        pr_url: "https://github.com/agency-x/client-y-web/pull/41",
        staging_url: "https://staging.client-y.example.com/history",
        notion_status: "In testing",
      },
      payment: {
        network: "hedera:testnet",
        asset: "0.0.0",
        facilitator: "https://api.testnet.blocky402.com",
        payer: "0.0.10365982",
        payee: "0.0.10365984",
        intake: { tinybars: 1000000, transaction_id: "0.0.7162784@1788539653.433840739" },
        balance: { tinybars: 4000000, transaction_id: "0.0.7162784@1788539999.100000000" },
      },
      issued_at: "2026-09-08T12:00:00.000Z",
      issuer: "agency-x",
    },
  },
  CONTRACTOR_KEY,
);

describe("artifact paths", () => {
  it("keeps one directory per order", () => {
    const paths = artifactPaths(outDir, "wo-1");
    expect(paths.dir).toBe(join(outDir, "wo-1"));
    expect(paths.mandate).toBe(join(outDir, "wo-1", "mandate.json"));
    expect(paths.accepted).toBe(join(outDir, "wo-1", "accepted.json"));
    expect(paths.receipt).toBe(join(outDir, "wo-1", "receipt.json"));
  });

  it("refuses an order id that would escape the output directory", () => {
    expect(() => artifactPaths(outDir, "../elsewhere")).toThrow();
  });
});

describe("saved order artifacts", () => {
  it("writes a work order and an acceptance that still validate and verify", () => {
    const saved = saveOrderArtifacts(outDir, mandateEnvelope, acceptedEnvelope);

    const storedMandate = readJson(saved.mandate) as Envelope<unknown>;
    expect(verifyEnvelope(storedMandate)).toBe(true);
    expect(() => validateMandate(storedMandate.data)).not.toThrow();
    expect(envelopeHash(storedMandate)).toBe(envelopeHash(mandateEnvelope));

    const storedAccepted = readJson(saved.accepted) as Envelope<unknown>;
    expect(verifyEnvelope(storedAccepted)).toBe(true);
    expect(() => validateReceipt(storedAccepted.data)).not.toThrow();
  });

  it("writes readable JSON that ends with a newline", () => {
    const saved = saveOrderArtifacts(outDir, mandateEnvelope, acceptedEnvelope);
    const text = readFileSync(saved.mandate, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n").length).toBeGreaterThan(3);
  });
});

describe("saved receipt", () => {
  it("writes a paid receipt that validates against the payment profile", () => {
    const path = saveReceiptArtifact(outDir, mandate.mandate_id, deliveredEnvelope);
    const stored = readJson(path) as Envelope<unknown>;
    expect(verifyEnvelope(stored)).toBe(true);
    expect(() => validatePaymentReceipt(stored.data)).not.toThrow();
  });
});

describe("parseDeliveredResponse", () => {
  it("accepts the paid receipt for this order", () => {
    const parsed = parseDeliveredResponse({ receipt: deliveredEnvelope }, mandate.mandate_id);
    expect(parsed.data.payment.balance?.transaction_id).toBe("0.0.7162784@1788539999.100000000");
  });

  it("refuses a receipt without the payment legs", () => {
    const withoutPayment = { ...deliveredEnvelope, data: { ...deliveredEnvelope.data } } as Record<string, unknown>;
    delete (withoutPayment["data"] as Record<string, unknown>)["payment"];
    expect(() => parseDeliveredResponse({ receipt: withoutPayment }, mandate.mandate_id)).toThrow();
  });

  it("refuses a receipt issued for another order", () => {
    expect(() => parseDeliveredResponse({ receipt: deliveredEnvelope }, "wo-somebody-else")).toThrow(
      /mandate/i,
    );
  });
});
