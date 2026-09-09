/**
 * The contractor service: two x402-gated routes and one local route.
 *
 * - `POST /mandates` — priced at the intake fee. Verifies the customer's
 *   envelope, anchors the order and the payment, and answers with a signed
 *   `accepted` receipt.
 * - `POST /mandates/{id}/deliver` — contractor-local, token-gated. Records the
 *   deliverable and anchors it.
 * - `GET /mandates/{id}/receipt` — priced at the balance. Anchors the second
 *   payment and releases the signed `delivered` receipt with the payment
 *   profile.
 *
 * Both paid routes use the `upfront` payment flow, which the Hedera exact
 * scheme supports and which settles **before** the handler runs. That ordering
 * is not a detail: it is what lets a handler put the settled transaction id
 * inside the receipt it returns and inside the anchor it writes. Under the
 * default `authorization` flow the money settles after the response has been
 * buffered, and a receipt could only ever reference the previous payment.
 *
 * Nothing about the facilitator is hardcoded — `extra.feePayer` arrives from
 * its `/supported` response through `@x402/express`, exactly as in `spike/`.
 *
 * Run: npm run contractor:start
 */
import { timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { config as loadEnv } from "dotenv";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { SettleResultContext } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { canonicalize, sha256Hex } from "../protocol/canonical.js";
import { envelopeHash, publicKeyHex, verifyEnvelope } from "../protocol/envelope.js";
import { hederaNativeId, uaidFromPublicKey } from "../protocol/identity.js";
import { SchemaError, validateMandate } from "../protocol/schemas.js";
import type { Anchor, Envelope, Mandate, Payment, PaymentLeg } from "../protocol/types.js";
import { operatorClient, submitAnchor } from "../anchor/client.js";
import { ANCHOR_VERSION, type AnchorKind, type AnchorRecord, toMirrorTxId } from "../anchor/records.js";
import {
  buildAcceptedReceipt,
  buildDeliveredReceipt,
  buildRejectedReceipt,
  paymentAnchorHash,
  sealReceipt,
} from "./receipts.js";
import { JobStore, type Job } from "./store.js";
import { assertDeliverableLinks, deliveryHash, parseDeliveryRequest, synthesizeResult } from "./work.js";

/** Everything the service needs to know about itself. */
export type ContractorConfig = {
  /** Public HCS topic the audit trail is written to. */
  topicId: string;
  network: "hedera:testnet" | "hedera:mainnet";
  /** `0.0.0` is HBAR; anything else is an HTS token id. */
  asset: string;
  /** Hedera account that receives payments; must be a real account, not an alias. */
  payTo: string;
  facilitatorUrl: string;
  intakeTinybars: number;
  balanceTinybars: number;
  /** Contractor handle, used as `issuer` on every receipt it signs. */
  handle: string;
  /**
   * The agent's HCS-14 identifier, written into the envelope's `from`.
   * Derived from the signing key when it is not set, so a service that
   * configures nothing still publishes an identifier a reader can check.
   */
  uaid?: string;
  /** Ed25519 secret key (32 bytes hex) the receipts are signed with. */
  signingKeyHex: string;
  /** Shared secret for the contractor-local delivery route. */
  deliverToken: string;
  port: number;
};

/** A payment the facilitator has settled, reduced to what a receipt needs. */
export type SettledPayment = {
  /** Facilitator form, `0.0.X@seconds.nanos`. */
  transaction: string;
  /** Paying account. */
  payer: string;
  network: string;
  tinybars: number;
};

/** Where a handler looks up the settlement that paid for its own request. */
export interface SettlementLedger {
  /**
   * Takes the settlement recorded for a payment header, removing it.
   *
   * @param key - The request's payment header
   * @returns The settled payment, if one was recorded
   */
  claim(key: string | undefined): SettledPayment | undefined;
}

/** Writes one anchor to the audit topic and waits for consensus. */
export type AnchorWriter = (record: AnchorRecord) => Promise<{ seq: number; consensus_ts: string }>;

/** The pieces the app is built from; all injectable, so tests run the real routes. */
export type ContractorDeps = {
  config: ContractorConfig;
  store: JobStore;
  anchors: AnchorWriter;
  settlements: SettlementLedger;
  /** The x402 middleware, or a stand-in in tests. */
  paymentGate: RequestHandler;
  now?: () => Date;
};

/** Default intake price: 0.01 HBAR. */
export const DEFAULT_INTAKE_TINYBARS = 1_000_000;

/** Default balance price: 0.04 HBAR. */
export const DEFAULT_BALANCE_TINYBARS = 4_000_000;

/** How long a recorded settlement stays claimable. */
const SETTLEMENT_TTL_MS = 10 * 60 * 1000;

/** An anchor could not be written, so nothing may be issued that references it. */
class AnchorFailure extends Error {
  /**
   * @param kind - Anchor that failed
   * @param cause - Underlying error
   */
  constructor(kind: AnchorKind, cause: unknown) {
    super(`Could not anchor "${kind}": ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AnchorFailure";
  }
}

/**
 * Skills this contractor claims, as HCS-14 capability enums.
 *
 * From the standard's tables: 4 code generation, 17 API integration, 33
 * blockchain integration, 39 trust attestation. Skills are what an agent does,
 * not how it is reached, which is why they and not the endpoints are the part
 * an identifier can be derived from.
 */
export const CONTRACTOR_SKILLS = [4, 17, 33, 39];

/** Version the service advertises for its own protocol surface. */
export const CONTRACTOR_AGENT_VERSION = "0.0.1";

/**
 * The contractor's HCS-14 identifier.
 *
 * Configured explicitly, or derived from the key the service signs receipts
 * with. Deriving it is the honest default: the identifier then cannot name a
 * key other than the one that will appear in `sig.pub`, which is exactly what
 * the verifier's identity check compares.
 *
 * @param config - Service configuration
 * @returns The identifier, e.g. `uaid:did:z6Mk…;uid=0;registry=self;proto=rest;nativeId=hedera:testnet:0.0.5`
 */
export function contractorUaid(config: ContractorConfig): string {
  if (config.uaid) {
    return config.uaid;
  }
  return uaidFromPublicKey(publicKeyHex(config.signingKeyHex), {
    uid: "0",
    registry: "self",
    proto: "rest",
    nativeId: hederaNativeId(config.network, config.payTo),
  });
}

/**
 * The agent card the service publishes about itself.
 *
 * HCS-14 §"A2A Agent.json Integration" puts the identifier in the `did` field
 * of `/.well-known/agent.json`, which is how a counterparty learns who it is
 * addressing without being told out of band. The card also names the raw
 * signing key: anyone can check that the key and the identifier are the same
 * thing, and a card that quietly disagreed with itself would be caught here
 * rather than three steps later.
 *
 * @param config - Service configuration
 * @returns The card, as JSON
 */
export function agentCard(config: ContractorConfig): Record<string, unknown> {
  return {
    name: config.handle,
    description: "Accepts signed work orders, anchors them on a public Hedera topic and returns signed receipts",
    version: CONTRACTOR_AGENT_VERSION,
    did: contractorUaid(config),
    handle: config.handle,
    signingKey: { alg: "ed25519", pub: publicKeyHex(config.signingKeyHex) },
    skills: CONTRACTOR_SKILLS,
    capabilities: {
      streaming: false,
      extensions: [
        {
          uri: "https://github.com/a2aproject/A2A/blob/main/docs/extensions/x402.md",
          description: "x402 micropayment protocol",
          required: true,
          params: {
            network: config.network,
            asset: config.asset,
            payTo: config.payTo,
            facilitator: config.facilitatorUrl,
            intakeTinybars: config.intakeTinybars,
            balanceTinybars: config.balanceTinybars,
          },
        },
      ],
    },
    audit: { topic: config.topicId },
  };
}

/**
 * Builds the Express application.
 *
 * @param deps - Configuration and collaborators
 * @returns The application, ready to listen
 */
export function createContractorApp(deps: ContractorDeps): Express {
  const { config, store, settlements } = deps;
  const now = deps.now ?? (() => new Date());
  // Who this service is, as one string, computed once: the envelopes it signs
  // and the card it publishes must never be able to name different agents.
  const agent = contractorUaid(config);
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  /**
   * Writes one anchor, turning any failure into {@link AnchorFailure}.
   *
   * @param kind - Anchor kind
   * @param hash - What is being anchored
   * @param mandateId - Order the anchor belongs to
   * @param ref - Mirror-node transaction id, for payment anchors
   * @returns The anchor's position on the topic
   */
  async function anchor(
    kind: AnchorKind,
    hash: string,
    mandateId: string,
    ref?: string,
  ): Promise<Anchor> {
    const record: AnchorRecord = {
      v: ANCHOR_VERSION,
      kind,
      mandate_id: mandateId,
      hash,
      ...(ref ? { ref } : {}),
      at: now().toISOString(),
    };
    try {
      const { seq, consensus_ts } = await deps.anchors(record);
      return { topic: config.topicId, seq, consensus_ts };
    } catch (error) {
      throw new AnchorFailure(kind, error);
    }
  }

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      network: config.network,
      payTo: config.payTo,
      topic: config.topicId,
      facilitator: config.facilitatorUrl,
      prices: { intakeTinybars: config.intakeTinybars, balanceTinybars: config.balanceTinybars },
    });
  });

  // Unpaid on purpose: an agent that charges for its own name cannot be
  // addressed by anyone who has not already met it.
  app.get("/.well-known/agent.json", (_req, res) => {
    res.json(agentCard(config));
  });

  // Contractor-local. Registered before the payment gate because the contractor
  // does not pay itself to record its own work.
  app.post(
    "/mandates/:id/deliver",
    handler(async (req, res) => {
      if (!tokenMatches(req.header("x-contractor-token"), config.deliverToken)) {
        res.status(401).json({ error: "Invalid or missing X-Contractor-Token" });
        return;
      }

      const mandateId = String(req.params.id);
      const job = store.get(mandateId);
      if (!job) {
        res.status(404).json({ error: `No mandate ${mandateId}` });
        return;
      }
      if (job.result && job.delivered_anchor) {
        // Already delivered: answer with what was anchored the first time rather
        // than putting a second delivery for one order on a permanent log.
        res.json({ result: job.result, anchor: job.delivered_anchor, repeated: true });
        return;
      }

      const result = synthesizeResult(job.mandate_id, parseDeliveryRequest(req.body));
      assertDeliverableLinks(result);
      const delivered = await anchor("delivered", deliveryHash(result), job.mandate_id);
      store.update(job.mandate_id, current => ({ ...current, result, delivered_anchor: delivered }));

      res.json({ result, anchor: delivered });
    }),
  );

  // Runs before the gate so an order that is not delivered yet — or one whose
  // receipt was already issued — never turns into a 402. The customer is asked
  // to pay only for a receipt that exists and has not been paid for.
  app.get("/mandates/:id/receipt", (req, res, nextHandler) => {
    const mandateId = String(req.params.id);
    const job = store.get(mandateId);
    if (!job) {
      res.status(404).json({ error: `No mandate ${mandateId}` });
      return;
    }
    if (job.receipt) {
      // Already paid for and issued: the same bytes come back, and the customer
      // is not charged a second time for a receipt it already owns.
      res.json({ receipt: job.receipt, repeated: true });
      return;
    }
    if (!job.result) {
      res.status(409).json({
        error: "The deliverable for this mandate does not exist yet",
        mandate_id: job.mandate_id,
      });
      return;
    }
    nextHandler();
  });

  app.use(deps.paymentGate);

  app.post(
    "/mandates",
    handler(async (req, res) => {
      const settlement = settlements.claim(paymentKey(req));
      if (!settlement) {
        res.status(500).json({ error: "No settled payment was recorded for this request" });
        return;
      }

      const refusal = refuse(req.body);
      if (refusal) {
        const receipt = sealRefusal(config, req.body, refusal, now);
        res.status(422).json({ receipt, settled: settlement.transaction });
        return;
      }

      const envelope = req.body as Envelope<Mandate>;
      const mandate = envelope.data;

      const existing = store.get(mandate.mandate_id);
      if (existing) {
        // The order is already on the topic. Re-anchoring it would put a second
        // record of one order on a permanent log, so the first receipt is
        // returned unchanged.
        res.status(200).json({ receipt: existing.accepted_receipt, repeated: true });
        return;
      }

      const mandateHash = envelopeHash(envelope);
      const mandateAnchor = await anchor("mandate_in", mandateHash, mandate.mandate_id);

      const intake: PaymentLeg = {
        tinybars: settlement.tinybars,
        transaction_id: settlement.transaction,
      };
      const payment: Payment = {
        network: config.network,
        asset: config.asset,
        facilitator: config.facilitatorUrl,
        payer: settlement.payer,
        payee: config.payTo,
        intake,
      };
      const intakeAnchor = await anchor(
        "payment_intake",
        paymentAnchorHash({ ...paymentParties(payment), ...intake }),
        mandate.mandate_id,
        toMirrorTxId(settlement.transaction),
      );

      const accepted = sealReceipt(
        buildAcceptedReceipt({
          mandate,
          mandateEnvelopeHash: mandateHash,
          mandateAnchor,
          issuer: config.handle,
          issuedAt: now().toISOString(),
        }),
        {
          from: agent,
          to: envelope.from,
          threadId: envelope.thread_id,
          privateKeyHex: config.signingKeyHex,
        },
      );
      await anchor("accepted", envelopeHash(accepted), mandate.mandate_id);

      const job: Job = {
        mandate_id: mandate.mandate_id,
        thread_id: envelope.thread_id,
        customer: envelope.from,
        contractor: config.handle,
        mandate: envelope,
        mandate_envelope_hash: mandateHash,
        mandate_anchor: mandateAnchor,
        accepted_receipt: accepted,
        payment: { ...payment, intake: { ...intake, anchor: intakeAnchor } },
        created_at: now().toISOString(),
        updated_at: now().toISOString(),
      };
      store.put(job);

      res.status(201).json({ receipt: accepted });
    }),
  );

  app.get(
    "/mandates/:id/receipt",
    handler(async (req, res) => {
      const job = store.get(String(req.params.id));
      if (!job?.result) {
        // The guard above already answered these; reaching here means the store
        // changed under us mid-request.
        res.status(409).json({ error: "The deliverable for this mandate does not exist yet" });
        return;
      }

      const settlement = settlements.claim(paymentKey(req));
      if (!settlement) {
        res.status(500).json({ error: "No settled payment was recorded for this request" });
        return;
      }

      const balance: PaymentLeg = {
        tinybars: settlement.tinybars,
        transaction_id: settlement.transaction,
      };
      const balanceAnchor = await anchor(
        "payment_balance",
        paymentAnchorHash({ ...paymentParties(job.payment), ...balance }),
        job.mandate_id,
        toMirrorTxId(settlement.transaction),
      );

      const payment: Payment = {
        ...job.payment,
        balance: { ...balance, anchor: balanceAnchor },
      };
      const receipt = sealReceipt(
        buildDeliveredReceipt({
          mandate: job.mandate.data,
          mandateEnvelopeHash: job.mandate_envelope_hash,
          mandateAnchor: job.mandate_anchor,
          issuer: config.handle,
          issuedAt: now().toISOString(),
          result: job.result,
          payment,
        }),
        {
          from: agent,
          to: job.customer,
          threadId: job.thread_id,
          privateKeyHex: config.signingKeyHex,
        },
      );
      const receiptAnchor = await anchor("receipt", envelopeHash(receipt), job.mandate_id);

      store.update(job.mandate_id, current => ({
        ...current,
        payment,
        receipt,
        receipt_anchor: receiptAnchor,
      }));

      res.json({ receipt });
    }),
  );

  app.use(errors);
  return app;
}

/**
 * Records settlements as they happen and hands each one to the request that
 * paid it.
 *
 * The key is the request's payment header, which is unique per payment and
 * visible both to the settle hook and to the route handler — the two places
 * that have to agree on which money paid for which order.
 */
export class SettlementRegistry implements SettlementLedger {
  private readonly entries = new Map<string, { payment: SettledPayment; at: number }>();

  /**
   * @param ttlMs - How long an unclaimed settlement is kept
   */
  constructor(private readonly ttlMs: number = SETTLEMENT_TTL_MS) {}

  /**
   * Stores one settled payment.
   *
   * @param key - The request's payment header
   * @param payment - The settlement
   */
  record(key: string, payment: SettledPayment): void {
    this.prune();
    this.entries.set(key, { payment, at: Date.now() });
  }

  /**
   * Takes a settlement, removing it so one payment cannot pay for two requests.
   *
   * @param key - The request's payment header
   * @returns The settlement, if one is held
   */
  claim(key: string | undefined): SettledPayment | undefined {
    if (!key) {
      return undefined;
    }
    const entry = this.entries.get(key);
    this.entries.delete(key);
    return entry && Date.now() - entry.at <= this.ttlMs ? entry.payment : undefined;
  }

  /**
   * Drops settlements nobody claimed.
   */
  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff) {
        this.entries.delete(key);
      }
    }
  }
}

/**
 * Builds the x402 payment gate for the two paid routes.
 *
 * The `upfront` payment flow is requested explicitly: it settles before the
 * handler, which is what makes the settled transaction id available to the
 * receipt and to the anchor. `extra.feePayer` is not set here — the middleware
 * syncs it from the facilitator's `/supported` response.
 *
 * @param config - Service configuration
 * @returns The middleware and the ledger its settlements land in
 */
export function createPaymentGate(config: ContractorConfig): {
  gate: RequestHandler;
  settlements: SettlementRegistry;
} {
  const settlements = new SettlementRegistry();
  const facilitatorClient = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(config.network as Network, new ExactHederaScheme())
    .onAfterSettle(async (context: SettleResultContext) => {
      if (context.phase !== "before-handler" || !context.result.success) {
        return;
      }
      const key = settlementKey(context);
      if (!key) {
        return;
      }
      settlements.record(key, {
        transaction: context.result.transaction,
        payer: context.result.payer ?? "",
        network: context.result.network,
        tinybars: Number(context.result.amount ?? context.requirements.amount),
      });
    });

  const gate = paymentMiddleware(
    {
      "POST /mandates": {
        accepts: {
          scheme: "exact",
          network: config.network as Network,
          payTo: config.payTo,
          price: { asset: config.asset, amount: String(config.intakeTinybars) },
          maxTimeoutSeconds: 120,
          extra: { paymentFlow: "upfront" },
        },
        description: "Intake of one signed work order (mandate.v1)",
        mimeType: "application/json",
      },
      "GET /mandates/:id/receipt": {
        accepts: {
          scheme: "exact",
          network: config.network as Network,
          payTo: config.payTo,
          price: { asset: config.asset, amount: String(config.balanceTinybars) },
          maxTimeoutSeconds: 120,
          extra: { paymentFlow: "upfront" },
        },
        description: "Release of the signed delivery receipt (receipt.v1+payment.v1)",
        mimeType: "application/json",
      },
    },
    resourceServer,
  );

  return { gate, settlements };
}

/**
 * Reads the service configuration from the environment.
 *
 * @returns The configuration
 * @throws When a required variable is missing
 */
export function contractorConfigFromEnv(): ContractorConfig {
  return {
    topicId: requireEnv("ANCHOR_TOPIC_ID"),
    network: (process.env.X402_NETWORK ?? "hedera:testnet") as ContractorConfig["network"],
    asset: process.env.X402_ASSET ?? "0.0.0",
    // The spike's RECEIVER account is the default payee, so a machine that ran
    // the spike can start the contractor without creating another account.
    payTo: process.env.CONTRACTOR_ACCOUNT_ID ?? requireEnv("RECEIVER_ACCOUNT_ID"),
    facilitatorUrl: process.env.X402_FACILITATOR_URL ?? "https://api.testnet.blocky402.com",
    intakeTinybars: readNumber("INTAKE_TINYBARS", DEFAULT_INTAKE_TINYBARS),
    balanceTinybars: readNumber("BALANCE_TINYBARS", DEFAULT_BALANCE_TINYBARS),
    // Matches the customer agent's default counterparty, so the two halves of
    // the demo address each other without either side setting a variable.
    handle: process.env.CONTRACTOR_HANDLE ?? "agency-x-agent",
    ...(process.env.CONTRACTOR_UAID?.trim() ? { uaid: process.env.CONTRACTOR_UAID.trim() } : {}),
    signingKeyHex: requireEnv("CONTRACTOR_SIGNING_KEY"),
    deliverToken: requireEnv("CONTRACTOR_DELIVER_TOKEN"),
    port: readNumber("CONTRACTOR_PORT", 4021),
  };
}

/**
 * Wraps an async route so a rejection reaches the error middleware.
 *
 * @param route - The handler
 * @returns An Express handler
 */
function handler(route: (req: Request, res: Response) => Promise<void> | void): RequestHandler {
  return (req, res, nextHandler) => {
    Promise.resolve()
      .then(() => route(req, res))
      .catch(nextHandler);
  };
}

/**
 * Maps errors to status codes.
 *
 * An anchor failure is a 502 on purpose: the payment settled but the order
 * could not be put on the public log, and a receipt that is not anchored cannot
 * be proven later — so none is issued.
 *
 * Only two things are the caller's fault: a document that does not validate,
 * and a request the body parser could not read. Everything else — a `TypeError`
 * above all, which in this service means a bug rather than a bad request — is a
 * 500, logged. Telling a paying customer "400, your fault" for our own mistake
 * would send them off to fix a request that was never wrong.
 *
 * @param error - The error
 * @param _req - The request
 * @param res - The response
 * @param _next - Express's next function
 */
function errors(error: unknown, _req: Request, res: Response, _next: express.NextFunction): void {
  if (res.headersSent) {
    return;
  }
  if (error instanceof AnchorFailure) {
    console.error(error);
    res.status(502).json({ error: error.message });
    return;
  }
  if (error instanceof SchemaError) {
    res.status(400).json({ error: error.message });
    return;
  }
  const status = clientErrorStatus(error);
  if (status !== undefined) {
    res.status(status).json({ error: error instanceof Error ? error.message : "Bad Request" });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "Internal Server Error" });
}

/**
 * The status of an error that already knows it is the caller's fault.
 *
 * Express's body parser rejects unreadable or oversized bodies with
 * `http-errors` objects, which carry a 4xx `status` and `expose: true` — the
 * flag meaning the message is safe to show the caller. Nothing else in this
 * service sets those, so nothing else can accidentally claim to be a 400.
 *
 * @param error - The thrown value
 * @returns The status to answer with, or undefined when this is not a client error
 */
function clientErrorStatus(error: unknown): number | undefined {
  const candidate = error as { status?: unknown; statusCode?: unknown; expose?: unknown } | null;
  if (!candidate || candidate.expose !== true) {
    return undefined;
  }
  const status = typeof candidate.status === "number" ? candidate.status : candidate.statusCode;
  return typeof status === "number" && status >= 400 && status < 500 ? status : undefined;
}

/**
 * Decides whether an intake body must be refused, and why.
 *
 * @param body - Parsed request body
 * @returns The reason, or null when the body is a valid mandate envelope
 */
function refuse(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Body is not a signed envelope";
  }
  const envelope = body as Partial<Envelope<unknown>>;
  if (envelope.schema !== "mandate.v1") {
    return `Envelope schema is "${String(envelope.schema)}", not "mandate.v1"`;
  }
  if (typeof envelope.from !== "string" || typeof envelope.thread_id !== "string") {
    return "Envelope is missing from or thread_id";
  }
  if (!verifyEnvelope(body as Envelope<unknown>)) {
    return "Envelope signature does not verify against the key it carries";
  }
  try {
    validateMandate((body as Envelope<unknown>).data);
  } catch (error) {
    return error instanceof SchemaError ? error.message : "Payload is not a valid mandate.v1";
  }
  return null;
}

/**
 * Signs a refusal for a message that is not a work order.
 *
 * @param config - Service configuration
 * @param body - What arrived
 * @param reason - Why it is refused
 * @param now - Clock
 * @returns The signed refusal envelope
 */
function sealRefusal(
  config: ContractorConfig,
  body: unknown,
  reason: string,
  now: () => Date,
): Envelope<ReturnType<typeof buildRejectedReceipt>> {
  const messageHash = sha256Hex(canonicalize(body ?? null));
  const candidate = (body as { data?: { mandate_id?: unknown } } | null)?.data?.mandate_id;
  const messageId =
    typeof candidate === "string" && candidate.length > 0 && candidate.length <= 64
      ? candidate
      : `msg-${messageHash.slice(0, 16)}`;

  const receipt = buildRejectedReceipt({
    messageId,
    messageHash,
    topic: config.topicId,
    issuer: config.handle,
    issuedAt: now().toISOString(),
    reason,
    hint: "Send a mandate.v1 document in a signed envelope; see the schema url",
  });
  return sealReceipt(receipt, {
    from: contractorUaid(config),
    // A refusal answers whoever sent the message; an unreadable envelope has no
    // usable sender, so it is addressed to nobody in particular.
    to: readSender(body),
    threadId: readThread(body) ?? `rejected-${messageHash.slice(0, 12)}`,
    privateKeyHex: config.signingKeyHex,
  });
}

/**
 * Reads the sender handle out of an untrusted body.
 *
 * @param body - What arrived
 * @returns The sender, or a placeholder
 */
function readSender(body: unknown): string {
  const from = (body as { from?: unknown } | null)?.from;
  return typeof from === "string" && from.length > 0 ? from : "unknown";
}

/**
 * Reads the thread id out of an untrusted body.
 *
 * @param body - What arrived
 * @returns The thread id, or undefined
 */
function readThread(body: unknown): string | undefined {
  const thread = (body as { thread_id?: unknown } | null)?.thread_id;
  return typeof thread === "string" && thread.length > 0 ? thread : undefined;
}

/**
 * The parties and asset of a payment, shared by both legs.
 *
 * @param payment - The payment profile
 * @returns Network, asset, payer and payee
 */
function paymentParties(payment: Payment): {
  network: string;
  asset: string;
  payer: string;
  payee: string;
} {
  return {
    network: payment.network,
    asset: payment.asset,
    payer: payment.payer,
    payee: payment.payee,
  };
}

/**
 * The header that identifies which payment paid for this request.
 *
 * @param req - The request
 * @returns The payment header, if present
 */
function paymentKey(req: Request): string | undefined {
  return req.header("payment-signature") ?? req.header("x-payment");
}

/**
 * The same header, read from a settle hook's transport context.
 *
 * @param context - Settle hook context
 * @returns The payment header, if present
 */
function settlementKey(context: SettleResultContext): string | undefined {
  const transport = context.transportContext as
    | { paymentHeader?: string; request?: { paymentHeader?: string } }
    | undefined;
  return transport?.request?.paymentHeader ?? transport?.paymentHeader;
}

/**
 * Compares a presented token with the configured one in constant time.
 *
 * @param presented - Token from the request
 * @param expected - Token from the environment
 * @returns True when they match
 */
function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || !expected) {
    return false;
  }
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Reads a required environment variable.
 *
 * @param name - Variable name
 * @returns The value
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in .env (see contractor/README.md)`);
  }
  return value;
}

/**
 * Reads a numeric environment variable.
 *
 * @param name - Variable name
 * @param fallback - Value used when the variable is unset
 * @returns The number
 */
function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return parsed;
}

/**
 * Entry point: starts the service against Hedera testnet.
 */
async function main(): Promise<void> {
  loadEnv();
  const config = contractorConfigFromEnv();
  const store = JobStore.open(process.env.CONTRACTOR_STORE ?? "out/contractor/jobs.json");
  const client = operatorClient();
  const { gate, settlements } = createPaymentGate(config);

  const app = createContractorApp({
    config,
    store,
    settlements,
    paymentGate: gate,
    anchors: record => submitAnchor(client, config.topicId, record),
  });

  app.listen(config.port, () => {
    console.log(`contractor service on http://localhost:${config.port}`);
    console.log(`  POST /mandates                 ${config.intakeTinybars} tinybars`);
    console.log(`  POST /mandates/:id/deliver     contractor-local (X-Contractor-Token)`);
    console.log(`  GET  /mandates/:id/receipt     ${config.balanceTinybars} tinybars`);
    console.log(`  payTo        ${config.payTo}`);
    console.log(`  facilitator  ${config.facilitatorUrl}`);
    console.log(`  topic        ${config.topicId}`);
    console.log(`  hashscan     https://hashscan.io/testnet/topic/${config.topicId}`);
    console.log(`  jobs         ${store.path}`);
  });
}

/**
 * True when this file was started directly rather than imported.
 *
 * @returns Whether the module is the process entry point
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) {
    return false;
  }
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
