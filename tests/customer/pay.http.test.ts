/**
 * The 402 → pay → retry loop at the HTTP level, against a local stand-in for
 * the contractor and the facilitator. The payment itself is a real signed
 * Hedera transfer built by the x402 Hedera scheme; only the network is absent,
 * so this test runs on a machine with no credentials and no testnet access.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PrivateKey } from "@x402/hedera";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import { PaymentNotSettledError, ResourceRequestError, createPaidFetch, payFor } from "../../customer/pay";
import type { PaymentIdentity } from "../../customer/wallet";

/** The facilitator account that pays the Hedera fee on testnet. */
const FEE_PAYER = "0.0.7162784";
/** Transaction id the stand-in facilitator reports as settled. */
const SETTLED_TX = "0.0.7162784@1788539653.433840739";

const PAYER = { accountId: "0.0.10365982", privateKey: PrivateKey.generateECDSA().toStringRaw() };

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server?.close(() => resolve()));
    server = undefined;
  }
});

/**
 * Payment configuration pointing at the local stand-in.
 *
 * @param maxAmountPerPayment - Per-payment cap in tinybars
 * @returns The payment identity
 */
function identity(maxAmountPerPayment = "5000000"): PaymentIdentity {
  return {
    network: "hedera:testnet",
    asset: "0.0.0",
    accountId: PAYER.accountId,
    privateKeyHex: PAYER.privateKey,
    maxAmountPerPayment,
    facilitator: "https://facilitator.invalid",
  };
}

/**
 * The 402 body and header a contractor route produces for a priced resource.
 *
 * @param url - Resource url
 * @param amount - Price in tinybars
 * @returns The payment requirements
 */
function paymentRequired(url: string, amount: string): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url, description: "One unit of work", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.0",
        amount,
        payTo: "0.0.10365984",
        maxTimeoutSeconds: 120,
        extra: { feePayer: FEE_PAYER },
      },
    ],
  };
}

/**
 * Starts a resource that answers 402 once and serves the body after payment.
 *
 * @param options - Price, served body, and an optional unpaid status
 * @returns The base url and the payloads the server received
 */
async function startResource(options: {
  amount?: string;
  body?: unknown;
  unpaidStatus?: number;
  settle?: Partial<SettleResponse>;
}): Promise<{ url: string; payments: PaymentPayload[] }> {
  const payments: PaymentPayload[] = [];
  const amount = options.amount ?? "1000000";

  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = `http://localhost/${request.url ?? ""}`;
    if (options.unpaidStatus) {
      response.writeHead(options.unpaidStatus, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not ready" }));
      return;
    }
    const signature = request.headers["payment-signature"];
    if (typeof signature !== "string") {
      const required = paymentRequired(url, amount);
      response.writeHead(402, {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required),
      });
      response.end(JSON.stringify({ x402Version: 2, accepts: required.accepts }));
      return;
    }
    payments.push(decodePaymentSignatureHeader(signature));
    const settlement: SettleResponse = {
      success: true,
      transaction: SETTLED_TX,
      network: "hedera:testnet",
      payer: PAYER.accountId,
      ...options.settle,
    };
    response.writeHead(200, {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement),
    });
    response.end(JSON.stringify(options.body ?? { ok: true }));
  });

  await new Promise<void>(resolve => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server?.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mandates`, payments };
}

describe("paying a priced route", () => {
  it("answers the 402 with a signed transfer and returns the settled transaction", async () => {
    const resource = await startResource({ body: { receipt: { schema: "receipt.v1" } } });
    const paid = createPaidFetch(identity());

    const result = await payFor<{ receipt: { schema: string } }>(paid, resource.url, { method: "POST" });

    expect(result.status).toBe(200);
    expect(result.body.receipt.schema).toBe("receipt.v1");
    expect(result.transactionId).toBe(SETTLED_TX);
    expect(result.mirrorTransactionId).toBe("0.0.7162784-1788539653-433840739");
    expect(result.hashscanUrl).toBe(`https://hashscan.io/testnet/transaction/${SETTLED_TX}`);

    expect(resource.payments).toHaveLength(1);
    const sent = resource.payments[0];
    expect(sent?.accepted.amount).toBe("1000000");
    expect(sent?.accepted.payTo).toBe("0.0.10365984");
    expect(typeof sent?.payload["transaction"]).toBe("string");
  }, 30_000);

  it("refuses to pay more than the configured cap, before signing anything", async () => {
    const resource = await startResource({ amount: "9000000" });
    const paid = createPaidFetch(identity("5000000"));

    await expect(payFor(paid, resource.url, { method: "POST" })).rejects.toThrow();
    expect(resource.payments).toHaveLength(0);
  }, 30_000);

  it("reports a settlement the facilitator rejected instead of returning a body", async () => {
    const resource = await startResource({
      settle: { success: false, errorReason: "insufficient_funds", transaction: "" },
    });
    const paid = createPaidFetch(identity());

    await expect(payFor(paid, resource.url, { method: "POST" })).rejects.toBeInstanceOf(
      PaymentNotSettledError,
    );
  }, 30_000);

  it("surfaces an unpaid error status, such as a receipt that is not ready yet", async () => {
    const resource = await startResource({ unpaidStatus: 409 });
    const paid = createPaidFetch(identity());

    const error = await payFor(paid, resource.url, { method: "GET" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ResourceRequestError);
    expect((error as ResourceRequestError).status).toBe(409);
  }, 30_000);
});
