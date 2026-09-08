/**
 * The paying half of the customer agent: it answers a 402 with a signed Hedera
 * transfer and hands back what the resource served plus the settled
 * transaction id.
 *
 * The wiring is the one proven in `spike/client.ts`. Two things it does not
 * inherit from the defaults:
 * - HBAR has to be opted into explicitly. The Hedera scheme's default assets
 *   are stablecoins, so without {@link spendControlsFor} every payment is
 *   refused client-side before it is ever signed.
 * - The per-payment cap is stated in tinybars, not dollars, and travels with
 *   the network, so a mainnet cap can never authorise a testnet payment.
 */
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { SpendControlAsset, SpendControls } from "@x402/core/client";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { fromMirrorTxId, toMirrorTxId } from "../anchor/records.js";
import type { HederaNetwork, PaymentIdentity } from "./wallet.js";

/** Spend controls that always name their allowed assets explicitly. */
export type AssetSpendControls = SpendControls & { allowedAssets: SpendControlAsset[] };

/** A fetch that pays for what it fetches, with the client that configured it. */
export type PaidFetch = {
  /** Fetch that answers a 402 by paying and retrying once. */
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** The x402 client, kept so callers can inspect or extend the configuration. */
  client: x402Client;
  /** HTTP layer, used to decode the settlement out of the paid response. */
  httpClient: x402HTTPClient;
  /** The identity that pays. */
  payment: PaymentIdentity;
};

/** A resource served after a payment settled. */
export type PaidResult<T> = {
  status: number;
  body: T;
  /** Settlement as reported by the facilitator. */
  settlement: SettleResponse;
  /** Transaction id in the facilitator's form, `0.0.x@sec.nanos`. */
  transactionId: string;
  /** The same transaction as the mirror node addresses it, `0.0.x-sec-nanos`. */
  mirrorTransactionId: string;
  /** Deep link to the transaction on the public explorer. */
  hashscanUrl: string;
};

/** The resource answered with an error status and no payment was settled. */
export class ResourceRequestError extends Error {
  readonly status: number;
  readonly body: unknown;

  /**
   * @param status - HTTP status returned by the resource
   * @param body - Parsed response body, when there was one
   * @param url - Resource that was called
   */
  constructor(status: number, body: unknown, url: string) {
    super(`${url} answered HTTP ${status}: ${describeBody(body)}`);
    this.name = "ResourceRequestError";
    this.status = status;
    this.body = body;
  }
}

/** The payment was refused, failed to settle, or was never created. */
export class PaymentNotSettledError extends Error {
  /** Decoded x402 header, when the server sent one. */
  readonly header?: SettleResponse | PaymentRequired;

  /**
   * @param message - What went wrong
   * @param header - Decoded x402 header, when present
   * @param cause - Underlying error, when the failure happened before the request
   */
  constructor(message: string, header?: SettleResponse | PaymentRequired, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PaymentNotSettledError";
    this.header = header;
  }
}

/**
 * Builds the spend controls for one payment identity: HBAR on the configured
 * network, capped per payment.
 *
 * @param payment - The paying identity
 * @returns Spend controls to hand to the x402 client
 */
export function spendControlsFor(payment: PaymentIdentity): AssetSpendControls {
  return {
    allowedAssets: [
      {
        network: payment.network,
        asset: payment.asset,
        maxAmountPerPayment: payment.maxAmountPerPayment,
      },
    ],
  };
}

/**
 * Wires a paying fetch for one identity.
 *
 * @param payment - The paying identity
 * @returns The paying fetch and the clients behind it
 */
export function createPaidFetch(payment: PaymentIdentity): PaidFetch {
  const signer = createClientHederaSigner(
    payment.accountId,
    PrivateKey.fromStringECDSA(payment.privateKeyHex),
    { network: payment.network },
  );

  const client = new x402Client().register("hedera:*", new ExactHederaScheme(signer));
  client.setSpendControls(spendControlsFor(payment));

  const httpClient = new x402HTTPClient(client);

  return {
    client,
    httpClient,
    payment,
    fetch: wrapFetchWithPayment(fetch, httpClient),
  };
}

/**
 * Calls a priced resource, paying the 402 if there is one.
 *
 * @param paid - The paying fetch
 * @param url - Resource to call
 * @param init - Request options, as for `fetch`
 * @returns The served body and the settled transaction
 * @throws ResourceRequestError when the resource answered an error status
 * @throws PaymentNotSettledError when the payment was refused or failed
 */
export async function payFor<T>(
  paid: PaidFetch,
  url: string,
  init?: RequestInit,
): Promise<PaidResult<T>> {
  let response: Response;
  try {
    response = await paid.fetch(url, init);
  } catch (cause) {
    throw new PaymentNotSettledError(
      `Payment for ${url} was not made: ${cause instanceof Error ? cause.message : String(cause)}`,
      undefined,
      cause,
    );
  }

  let parsed;
  try {
    parsed = await paid.httpClient.processResponse(response);
  } catch (cause) {
    throw new PaymentNotSettledError(
      `Could not read the payment result from ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      undefined,
      cause,
    );
  }

  if (parsed.paymentStatus === "settle_failed" || parsed.paymentStatus === "payment_required") {
    throw new PaymentNotSettledError(
      `Payment for ${url} did not settle (${parsed.paymentStatus})`,
      parsed.header,
    );
  }

  if (parsed.status >= 400) {
    throw new ResourceRequestError(parsed.status, parsed.body, url);
  }

  if (parsed.paymentStatus !== "settled") {
    throw new PaymentNotSettledError(`${url} served a body without settling a payment`, parsed.header);
  }

  const settlement = parsed.header as SettleResponse;
  const transactionId = settlement.transaction;
  if (!transactionId) {
    throw new PaymentNotSettledError(`${url} reported a settlement without a transaction id`, settlement);
  }

  return {
    status: parsed.status,
    body: parsed.body as T,
    settlement,
    transactionId: fromMirrorTxId(transactionId),
    mirrorTransactionId: toMirrorTxId(transactionId),
    hashscanUrl: hashscanTransactionUrl(transactionId, paid.payment.network),
  };
}

/**
 * Deep link to a transaction on the public explorer.
 *
 * Accepts a transaction id in either form; HashScan addresses transactions the
 * way the facilitator reports them.
 *
 * @param transactionId - Transaction id in either form
 * @param network - Network the transaction settled on
 * @returns The explorer URL
 */
export function hashscanTransactionUrl(transactionId: string, network: HederaNetwork): string {
  return `https://hashscan.io/${networkPath(network)}/transaction/${fromMirrorTxId(transactionId)}`;
}

/**
 * Deep link to the audit topic on the public explorer.
 *
 * @param topicId - HCS topic id
 * @param network - Network the topic lives on
 * @returns The explorer URL
 */
export function hashscanTopicUrl(topicId: string, network: HederaNetwork): string {
  return `https://hashscan.io/${networkPath(network)}/topic/${topicId}`;
}

/**
 * The network segment HashScan uses in its paths.
 *
 * @param network - CAIP-2 network
 * @returns `testnet` or `mainnet`
 */
function networkPath(network: HederaNetwork): string {
  return network.slice("hedera:".length);
}

/**
 * Renders a response body for an error message without dumping a whole page.
 *
 * @param body - Parsed body
 * @returns A short description
 */
function describeBody(body: unknown): string {
  if (body === undefined || body === null) return "no body";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
