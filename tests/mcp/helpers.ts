/**
 * A local stand-in contractor for the MCP `order` and `collect` tools.
 *
 * It speaks the real x402 402 → pay → 201/200 dance at the HTTP level (the
 * same codec `pay.http.test.ts` uses for the customer side), and it builds
 * its receipts with the real `contractor/receipts.ts` and `contractor/work.ts`
 * — so what a test asserts on is the same receipt shape the real contractor
 * issues, without a testnet, a facilitator, or an HCS topic anywhere near it.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { PrivateKey } from "@x402/hedera";
import { buildAcceptedReceipt, buildDeliveredReceipt, sealReceipt } from "../../contractor/receipts";
import { synthesizeResult } from "../../contractor/work";
import { envelopeHash, verifyEnvelope } from "../../protocol/envelope";
import { validateMandate } from "../../protocol/schemas";
import type { Envelope, Mandate, Payment } from "../../protocol/types";
import type { PaymentIdentity, SigningIdentity } from "../../customer/wallet";

/** The facilitator account that would pay the Hedera fee on testnet; here it pays nothing. */
export const STAND_IN_FEE_PAYER = "0.0.7162784";

/** The audit topic the stand-in claims to anchor to. No message is ever written to it. */
export const STAND_IN_TOPIC = "0.0.10366321";

/** Handles of the two synthetic parties. */
export const STAND_IN_CONTRACTOR_HANDLE = "agency-x-agent";
export const STAND_IN_CUSTOMER_HANDLE = "client-y-agent";

/** Prices the stand-in quotes, matching the contractor's own defaults. */
export const STAND_IN_INTAKE_TINYBARS = 1_000_000;
export const STAND_IN_BALANCE_TINYBARS = 4_000_000;

/** One order as the stand-in tracks it. */
type StandInJob = {
  mandate: Mandate;
  mandateEnvelope: Envelope<Mandate>;
  mandateHash: string;
  accepted: Envelope<unknown>;
  intake: { tinybars: number; transaction_id: string };
  delivered: boolean;
  receipt?: Envelope<unknown>;
};

/** What a test gets back: the base url, control over delivery, and what to close. */
export type StandInContractor = {
  url: string;
  /** Marks an order delivered, the way the contractor-local route would. */
  deliver: (mandateId: string) => void;
  /** Every order the stand-in has accepted, for assertions. */
  jobs: Map<string, StandInJob>;
  close: () => Promise<void>;
};

/**
 * Fresh signing and payment identities for one test's customer agent — a
 * fresh Ed25519 key to sign with and a fresh ECDSA key to pay with, exactly
 * as `wallet.ts` expects, generated locally so no test shares state with
 * another.
 *
 * @returns Signing and payment identities
 */
export function customerIdentities(): { signing: SigningIdentity; payment: PaymentIdentity } {
  const signingKeyHex = randomBytes(32).toString("hex");
  const payerKey = PrivateKey.generateECDSA().toStringRaw();
  return {
    signing: {
      handle: STAND_IN_CUSTOMER_HANDLE,
      agent: STAND_IN_CUSTOMER_HANDLE,
      counterparty: STAND_IN_CONTRACTOR_HANDLE,
      privateKeyHex: signingKeyHex,
      publicKeyHex: "", // wallet.ts derives this; the stand-in never reads it
    },
    payment: {
      network: "hedera:testnet",
      asset: "0.0.0",
      accountId: "0.0.10365982",
      privateKeyHex: payerKey,
      maxAmountPerPayment: "5000000",
      facilitator: "https://facilitator.invalid",
    },
  };
}

/**
 * Starts the stand-in contractor on a free local port.
 *
 * @returns The running stand-in
 */
export async function startStandInContractor(): Promise<StandInContractor> {
  const jobs = new Map<string, StandInJob>();
  let intakeSettled = 0;
  let balanceSettled = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(error => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://stand-in.invalid");
    const body = await readBody(req);

    if (req.method === "POST" && url.pathname === "/mandates") {
      return handleMandates(req, res, url, body);
    }
    const receiptMatch = /^\/mandates\/([^/]+)\/receipt$/.exec(url.pathname);
    if (req.method === "GET" && receiptMatch) {
      return handleReceipt(req, res, url, receiptMatch[1] as string);
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `No route for ${req.method} ${url.pathname}` }));
  }

  function handleMandates(req: IncomingMessage, res: ServerResponse, url: URL, body: string): void {
    const signature = req.headers["payment-signature"];
    if (typeof signature !== "string") {
      respond402(res, url.href, String(STAND_IN_INTAKE_TINYBARS));
      return;
    }

    let envelope: Envelope<Mandate>;
    try {
      envelope = JSON.parse(body) as Envelope<Mandate>;
      if (!verifyEnvelope(envelope)) {
        throw new Error("envelope signature does not verify");
      }
      validateMandate(envelope.data);
    } catch (error) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      return;
    }

    const existing = jobs.get(envelope.data.mandate_id);
    if (existing) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ receipt: existing.accepted, repeated: true }));
      return;
    }

    decodePaymentSignatureHeader(signature); // exercises the same decode the real gate performs
    intakeSettled += 1;
    const transactionId = `0.0.7162784@1788600000.${String(intakeSettled).padStart(9, "0")}`;
    const mandateHash = envelopeHash(envelope);
    const accepted = sealReceipt(
      buildAcceptedReceipt({
        mandate: envelope.data,
        mandateEnvelopeHash: mandateHash,
        mandateAnchor: { topic: STAND_IN_TOPIC, seq: jobs.size + 1, consensus_ts: `178860000${jobs.size + 1}.000000001` },
        issuer: STAND_IN_CONTRACTOR_HANDLE,
        issuedAt: new Date().toISOString(),
      }),
      {
        from: STAND_IN_CONTRACTOR_HANDLE,
        to: envelope.from,
        threadId: envelope.thread_id,
        privateKeyHex: CONTRACTOR_STAND_IN_KEY,
      },
    );
    jobs.set(envelope.data.mandate_id, {
      mandate: envelope.data,
      mandateEnvelope: envelope,
      mandateHash,
      accepted,
      intake: { tinybars: STAND_IN_INTAKE_TINYBARS, transaction_id: transactionId },
      delivered: false,
    });

    const settlement: SettleResponse = {
      success: true,
      transaction: transactionId,
      network: "hedera:testnet",
      payer: "0.0.10365982",
    };
    res.writeHead(201, {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement),
    });
    res.end(JSON.stringify({ receipt: accepted }));
  }

  function handleReceipt(req: IncomingMessage, res: ServerResponse, url: URL, mandateId: string): void {
    const job = jobs.get(mandateId);
    if (!job) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `No mandate ${mandateId}` }));
      return;
    }
    if (job.receipt) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ receipt: job.receipt, repeated: true }));
      return;
    }
    if (!job.delivered) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "The deliverable for this mandate does not exist yet" }));
      return;
    }

    const signature = req.headers["payment-signature"];
    if (typeof signature !== "string") {
      respond402(res, url.href, String(STAND_IN_BALANCE_TINYBARS));
      return;
    }
    decodePaymentSignatureHeader(signature);
    balanceSettled += 1;
    const balanceTx = `0.0.7162784@1788600100.${String(balanceSettled).padStart(9, "0")}`;

    const payment: Payment = {
      network: "hedera:testnet",
      asset: "0.0.0",
      facilitator: "https://facilitator.invalid",
      payer: "0.0.10365982",
      payee: "0.0.10365984",
      intake: job.intake,
      balance: { tinybars: STAND_IN_BALANCE_TINYBARS, transaction_id: balanceTx },
    };
    const receipt = sealReceipt(
      buildDeliveredReceipt({
        mandate: job.mandate,
        mandateEnvelopeHash: job.mandateHash,
        mandateAnchor: { topic: STAND_IN_TOPIC, seq: 1, consensus_ts: "1788600001.000000001" },
        issuer: STAND_IN_CONTRACTOR_HANDLE,
        issuedAt: new Date().toISOString(),
        result: synthesizeResult(mandateId),
        payment,
      }),
      {
        from: STAND_IN_CONTRACTOR_HANDLE,
        to: job.mandateEnvelope.from,
        threadId: job.mandateEnvelope.thread_id,
        privateKeyHex: CONTRACTOR_STAND_IN_KEY,
      },
    );
    job.receipt = receipt;

    const settlement: SettleResponse = {
      success: true,
      transaction: balanceTx,
      network: "hedera:testnet",
      payer: "0.0.10365982",
    };
    res.writeHead(200, {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement),
    });
    res.end(JSON.stringify({ receipt }));
  }

  function respond402(res: ServerResponse, resourceUrl: string, amount: string): void {
    const required: PaymentRequired = {
      x402Version: 2,
      resource: { url: resourceUrl, description: "stand-in", mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: "hedera:testnet",
          asset: "0.0.0",
          amount,
          payTo: "0.0.10365984",
          maxTimeoutSeconds: 120,
          extra: { feePayer: STAND_IN_FEE_PAYER },
        },
      ],
    };
    res.writeHead(402, {
      "content-type": "application/json",
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required),
    });
    res.end(JSON.stringify({ x402Version: 2, accepts: required.accepts }));
  }

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    jobs,
    deliver(mandateId: string) {
      const job = jobs.get(mandateId);
      if (!job) {
        throw new Error(`No mandate ${mandateId} to deliver`);
      }
      job.delivered = true;
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/** Fixed contractor signing key, so a failing test is reproducible. */
const CONTRACTOR_STAND_IN_KEY = "3".repeat(64);

/**
 * Reads a request body to completion.
 *
 * @param req - The incoming request
 * @returns The body as utf-8 text
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
