/**
 * The contractor service, exercised over real HTTP with the payment gate and
 * the consensus topic replaced by stubs.
 *
 * The two things stubbed here are the two that cost money — settling with the
 * facilitator and writing to HCS — and they are injected rather than mocked in
 * place, so this suite runs the same route code the testnet integration test
 * runs. What it can prove that the integration test cannot: the order and the
 * content of the anchors, and every refusal path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envelopeHash, verifyEnvelope } from "../../protocol/envelope";
import { validatePaymentReceipt, validateReceipt } from "../../protocol/schemas";
import type { Envelope, Mandate, PaymentReceipt, Receipt } from "../../protocol/types";
import { toMirrorTxId } from "../../anchor/records";
import {
  type ContractorConfig,
  type SettledPayment,
  createContractorApp,
} from "../../contractor/server";
import { JobStore } from "../../contractor/store";
import { synthesizeResult } from "../../contractor/work";
import {
  BALANCE_TX_ID,
  CONTRACTOR_HANDLE,
  CONTRACTOR_KEY,
  INTAKE_TX_ID,
  PAYEE_ACCOUNT,
  PAYER_ACCOUNT,
  TOPIC_ID,
  type AnchorStub,
  anchorStub,
  mandateEnvelope,
  mandateFixture,
} from "./helpers";

const DELIVER_TOKEN = "local-token";

const CONFIG: ContractorConfig = {
  topicId: TOPIC_ID,
  network: "hedera:testnet",
  asset: "0.0.0",
  payTo: PAYEE_ACCOUNT,
  facilitatorUrl: "https://api.testnet.blocky402.com",
  intakeTinybars: 1_000_000,
  balanceTinybars: 4_000_000,
  handle: CONTRACTOR_HANDLE,
  signingKeyHex: CONTRACTOR_KEY,
  deliverToken: DELIVER_TOKEN,
  port: 0,
};

let dir: string;
let anchors: AnchorStub;
let store: JobStore;
let server: Server;
let baseUrl: string;
let gateCalls: string[];
let settlements: Map<string, SettledPayment>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "contractor-server-"));
  anchors = anchorStub();
  store = JobStore.open(join(dir, "jobs.json"));
  gateCalls = [];
  settlements = new Map();

  // Stands in for `@x402/express`: a request that carries a payment header is
  // treated as settled before the handler runs, which is exactly what the
  // `upfront` payment flow does on testnet.
  const paymentGate: RequestHandler = (req, _res, next) => {
    gateCalls.push(`${req.method} ${req.path}`);
    const header = req.header("payment-signature");
    if (header) {
      settlements.set(header, {
        transaction: header === "balance" ? BALANCE_TX_ID : INTAKE_TX_ID,
        payer: PAYER_ACCOUNT,
        network: "hedera:testnet",
        tinybars: header === "balance" ? CONFIG.balanceTinybars : CONFIG.intakeTinybars,
      });
    }
    next();
  };

  const app = createContractorApp({
    config: CONFIG,
    store,
    anchors: anchors.write,
    settlements: { claim: key => (key ? settlements.get(key) : undefined) },
    paymentGate,
  });

  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Sends a mandate to the intake route as a paying customer would.
 *
 * @param envelope - The signed mandate envelope, or any body to test a refusal
 * @param paid - Whether the request carries a settled payment
 * @returns The HTTP response
 */
async function postMandate(envelope: unknown, paid = true): Promise<Response> {
  return fetch(`${baseUrl}/mandates`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(paid ? { "PAYMENT-SIGNATURE": "intake" } : {}),
    },
    body: JSON.stringify(envelope),
  });
}

/**
 * Marks a mandate delivered through the contractor-local route.
 *
 * @param mandateId - Mandate to deliver
 * @param body - Optional explicit links
 * @param token - Token to present
 * @returns The HTTP response
 */
async function deliver(mandateId: string, body: unknown = {}, token = DELIVER_TOKEN): Promise<Response> {
  return fetch(`${baseUrl}/mandates/${mandateId}/deliver`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Contractor-Token": token },
    body: JSON.stringify(body),
  });
}

/**
 * Collects the delivery receipt as a paying customer would.
 *
 * @param mandateId - Mandate to collect
 * @param paid - Whether the request carries a settled payment
 * @returns The HTTP response
 */
async function collect(mandateId: string, paid = true): Promise<Response> {
  return fetch(`${baseUrl}/mandates/${mandateId}/receipt`, {
    headers: paid ? { "PAYMENT-SIGNATURE": "balance" } : {},
  });
}

describe("POST /mandates", () => {
  it("anchors the order and the payment, then answers with a signed acceptance", async () => {
    const envelope = mandateEnvelope();
    const response = await postMandate(envelope);

    expect(response.status).toBe(201);
    const body = (await response.json()) as { receipt: Envelope<Receipt> };
    const receipt = body.receipt;

    expect(receipt.schema).toBe("receipt.v1");
    expect(verifyEnvelope(receipt)).toBe(true);
    expect(() => validateReceipt(receipt.data)).not.toThrow();
    expect(receipt.data.kind).toBe("accepted");
    expect(receipt.data.mandate_envelope_hash).toBe(envelopeHash(envelope));
    expect(receipt.data.taken).toEqual(envelope.data.acceptance);
    expect(receipt.to).toBe(envelope.from);
    expect(receipt.thread_id).toBe(envelope.thread_id);

    // The order the audit topic must show: the order, then the money, then the
    // acceptance that references both.
    expect(anchors.records.map(record => record.kind)).toEqual([
      "mandate_in",
      "payment_intake",
      "accepted",
    ]);
    expect(anchors.records[0].hash).toBe(envelopeHash(envelope));
    expect(anchors.records[1].ref).toBe(toMirrorTxId(INTAKE_TX_ID));
    expect(anchors.records[2].hash).toBe(envelopeHash(receipt));
    expect(anchors.records.every(record => record.mandate_id === envelope.data.mandate_id)).toBe(true);
  });

  it("stores the job with the settled intake leg so the balance call can find it", async () => {
    const envelope = mandateEnvelope();
    await postMandate(envelope);

    const job = store.get(envelope.data.mandate_id);
    // The leg keeps a pointer to its own anchor, so a reader of the receipt can
    // go straight to the message on the topic that records this payment.
    expect(job?.payment.intake).toEqual({
      tinybars: 1_000_000,
      transaction_id: INTAKE_TX_ID,
      anchor: { topic: TOPIC_ID, seq: 2, consensus_ts: expect.any(String) },
    });
    expect(job?.payment.payer).toBe(PAYER_ACCOUNT);
    expect(job?.payment.payee).toBe(PAYEE_ACCOUNT);
    expect(job?.mandate_anchor).toEqual({
      topic: TOPIC_ID,
      seq: 1,
      consensus_ts: expect.any(String),
    });
  });

  it("refuses a body that is not a signed envelope with a signed rejection", async () => {
    const response = await postMandate({ hello: "world" });

    expect(response.status).toBe(422);
    const body = (await response.json()) as { receipt: Envelope<Receipt> };
    expect(verifyEnvelope(body.receipt)).toBe(true);
    expect(() => validateReceipt(body.receipt.data)).not.toThrow();
    expect(body.receipt.data.kind).toBe("rejected");
    expect(body.receipt.data.expected_schema).toBe("mandate.v1");
    // Nothing was accepted, so nothing goes on the public topic.
    expect(anchors.records).toEqual([]);
  });

  it("refuses an envelope whose signature does not cover its contents", async () => {
    const envelope = mandateEnvelope();
    const tampered = {
      ...envelope,
      data: { ...envelope.data, title: "Something the customer never signed" },
    };

    const response = await postMandate(tampered);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { receipt: Envelope<Receipt> };
    expect(body.receipt.data.kind).toBe("rejected");
    expect(body.receipt.data.reason).toMatch(/signature/i);
    expect(anchors.records).toEqual([]);
  });

  it("refuses a mandate that carries money fields the protocol forbids", async () => {
    const envelope = mandateEnvelope({ ...mandateFixture(), hours: 12 } as unknown as Mandate);

    const response = await postMandate(envelope);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { receipt: Envelope<Receipt> };
    expect(body.receipt.data.kind).toBe("rejected");
    expect(body.receipt.data.reason).toMatch(/hours/);
  });

  it("does not issue an acceptance when the order cannot be anchored", async () => {
    anchors.fail("consensus node unavailable");
    const envelope = mandateEnvelope();

    const response = await postMandate(envelope);

    // A receipt that is not anchored cannot be proven later, so it is not issued
    // at all rather than issued and quietly unprovable.
    expect(response.status).toBe(502);
    expect(store.get(envelope.data.mandate_id)).toBeUndefined();
  });

  it("does not anchor the same mandate twice", async () => {
    const envelope = mandateEnvelope();
    const first = await postMandate(envelope);
    const second = await postMandate(envelope);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(anchors.records).toHaveLength(3);

    const firstBody = (await first.json()) as { receipt: Envelope<Receipt> };
    const secondBody = (await second.json()) as { receipt: Envelope<Receipt> };
    expect(envelopeHash(secondBody.receipt)).toBe(envelopeHash(firstBody.receipt));
  });
});

describe("POST /mandates/:id/deliver", () => {
  it("needs the contractor's own token", async () => {
    const envelope = mandateEnvelope();
    await postMandate(envelope);

    const response = await deliver(envelope.data.mandate_id, {}, "wrong-token");
    expect(response.status).toBe(401);
    expect(anchors.records.map(record => record.kind)).toEqual([
      "mandate_in",
      "payment_intake",
      "accepted",
    ]);
  });

  it("anchors the delivery and returns deterministic links", async () => {
    const envelope = mandateEnvelope();
    await postMandate(envelope);

    const response = await deliver(envelope.data.mandate_id);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { result: Record<string, string> };
    expect(body.result).toEqual(synthesizeResult(envelope.data.mandate_id));
    expect(anchors.records.at(-1)?.kind).toBe("delivered");
    expect(store.get(envelope.data.mandate_id)?.result).toEqual(body.result);
  });

  it("accepts explicit links from the contractor's own pipeline", async () => {
    const envelope = mandateEnvelope();
    await postMandate(envelope);

    const response = await deliver(envelope.data.mandate_id, {
      pr_url: "https://git.example.com/agency-x/web/-/merge_requests/77",
      notion_status: "In review",
    });

    const body = (await response.json()) as { result: Record<string, string> };
    expect(body.result.pr_url).toBe("https://git.example.com/agency-x/web/-/merge_requests/77");
    expect(body.result.notion_status).toBe("In review");
  });

  it("is idempotent: delivering twice writes one anchor", async () => {
    const envelope = mandateEnvelope();
    await postMandate(envelope);
    await deliver(envelope.data.mandate_id);
    const second = await deliver(envelope.data.mandate_id);

    expect(second.status).toBe(200);
    expect(anchors.records.filter(record => record.kind === "delivered")).toHaveLength(1);
  });

  it("answers 404 for a mandate it never accepted", async () => {
    expect((await deliver("wo-never-seen")).status).toBe(404);
  });
});

describe("GET /mandates/:id/receipt", () => {
  it("answers 409 before delivery, without asking the customer to pay", async () => {
    const envelope = mandateEnvelope();
    await postMandate(envelope);
    gateCalls.length = 0;

    const response = await collect(envelope.data.mandate_id);

    expect(response.status).toBe(409);
    // The gate is never reached, so there is no 402 and nothing settles for a
    // deliverable that does not exist yet.
    expect(gateCalls).toEqual([]);
  });

  it("releases the delivery receipt with both payment legs once paid", async () => {
    const envelope = mandateEnvelope();
    await postMandate(envelope);
    await deliver(envelope.data.mandate_id);

    const response = await collect(envelope.data.mandate_id);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { receipt: Envelope<PaymentReceipt> };
    const receipt = body.receipt;

    expect(receipt.schema).toBe("receipt.v1+payment.v1");
    expect(verifyEnvelope(receipt)).toBe(true);
    expect(() => validatePaymentReceipt(receipt.data)).not.toThrow();
    expect(receipt.data.kind).toBe("delivered");
    expect(receipt.data.result).toEqual(synthesizeResult(envelope.data.mandate_id));
    expect(receipt.data.payment.intake.transaction_id).toBe(INTAKE_TX_ID);
    expect(receipt.data.payment.balance?.transaction_id).toBe(BALANCE_TX_ID);
    expect(receipt.data.mandate_envelope_hash).toBe(envelopeHash(envelope));

    expect(anchors.records.map(record => record.kind)).toEqual([
      "mandate_in",
      "payment_intake",
      "accepted",
      "delivered",
      "payment_balance",
      "receipt",
    ]);
    expect(anchors.records.at(-2)?.ref).toBe(toMirrorTxId(BALANCE_TX_ID));
    expect(anchors.records.at(-1)?.hash).toBe(envelopeHash(receipt));
  });

  it("returns the stored receipt on a repeat call and anchors nothing new", async () => {
    const envelope = mandateEnvelope();
    await postMandate(envelope);
    await deliver(envelope.data.mandate_id);

    const first = (await (await collect(envelope.data.mandate_id)).json()) as {
      receipt: Envelope<PaymentReceipt>;
    };
    const anchorCount = anchors.records.length;
    const second = (await (await collect(envelope.data.mandate_id)).json()) as {
      receipt: Envelope<PaymentReceipt>;
    };

    expect(envelopeHash(second.receipt)).toBe(envelopeHash(first.receipt));
    expect(anchors.records).toHaveLength(anchorCount);
  });

  it("answers 404 for a mandate it never accepted", async () => {
    expect((await collect("wo-never-seen")).status).toBe(404);
  });
});

describe("what the service blames the caller for", () => {
  it("answers 400 when the body parser cannot read the request", async () => {
    const response = await fetch(`${baseUrl}/mandates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": "intake" },
      body: "{ this is not json",
    });

    expect(response.status).toBe(400);
  });

  it("answers 500, not 400, when the service itself throws", async () => {
    // A TypeError inside a handler is a bug in this service. Reporting it as a
    // 400 would tell a customer who paid and sent a perfectly good order that
    // their request was malformed, and send them off to fix nothing.
    const brokenApp = createContractorApp({
      config: CONFIG,
      store: JobStore.open(join(dir, "broken.json")),
      anchors: anchors.write,
      settlements: {
        claim: () => {
          throw new TypeError("undefined is not an object");
        },
      },
      paymentGate: (_req, _res, next) => next(),
    });
    const brokenServer = brokenApp.listen(0);
    await new Promise<void>(resolve => brokenServer.once("listening", () => resolve()));
    const port = (brokenServer.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/mandates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mandateEnvelope()),
    });
    await new Promise<void>(resolve => brokenServer.close(() => resolve()));

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toBe("Internal Server Error");
  });
});
