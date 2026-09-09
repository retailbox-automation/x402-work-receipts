/**
 * The contractor's own identity: what it publishes about itself, and what it
 * signs as.
 *
 * The point of the suite is a single invariant — the identifier on the card,
 * the identifier in the envelope and the key in `sig.pub` are three views of
 * one key. If they can drift apart, the verifier's identity check is checking
 * nothing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publicKeyHex, verifyEnvelope } from "../../protocol/envelope";
import { parseUaid, uaidFromPublicKey, uaidMatchesPublicKey } from "../../protocol/identity";
import type { Envelope, Receipt } from "../../protocol/types";
import {
  type ContractorConfig,
  type SettledPayment,
  agentCard,
  contractorUaid,
  createContractorApp,
} from "../../contractor/server";
import { JobStore } from "../../contractor/store";
import {
  CONTRACTOR_HANDLE,
  CONTRACTOR_KEY,
  INTAKE_TX_ID,
  PAYEE_ACCOUNT,
  PAYER_ACCOUNT,
  TOPIC_ID,
  type AnchorStub,
  anchorStub,
  mandateEnvelope,
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "contractor-identity-"));
  anchors = anchorStub();
  store = JobStore.open(join(dir, "jobs.json"));
  gateCalls = [];
  const settlements = new Map<string, SettledPayment>();

  const paymentGate: RequestHandler = (req, _res, next) => {
    gateCalls.push(`${req.method} ${req.path}`);
    const header = req.header("payment-signature");
    if (header) {
      settlements.set(header, {
        transaction: INTAKE_TX_ID,
        payer: PAYER_ACCOUNT,
        network: "hedera:testnet",
        tinybars: CONFIG.intakeTinybars,
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

describe("the contractor's identifier", () => {
  it("is derived from the key it signs receipts with", () => {
    const uaid = contractorUaid(CONFIG);
    expect(uaidMatchesPublicKey(uaid, publicKeyHex(CONTRACTOR_KEY))).toBe(true);
    expect(parseUaid(uaid)?.params).toMatchObject({
      uid: "0",
      registry: "self",
      proto: "rest",
      nativeId: `hedera:testnet:${PAYEE_ACCOUNT}`,
    });
  });

  it("is whatever the configuration says, when it says anything", () => {
    const configured = uaidFromPublicKey(publicKeyHex("9".repeat(64)), { registry: "hol" });
    expect(contractorUaid({ ...CONFIG, uaid: configured })).toBe(configured);
  });
});

describe("GET /.well-known/agent.json", () => {
  it("publishes the identifier, the key behind it and the x402 terms, without payment", async () => {
    const response = await fetch(`${baseUrl}/.well-known/agent.json`);
    expect(response.status).toBe(200);

    const card = (await response.json()) as ReturnType<typeof agentCard>;
    expect(card["did"]).toBe(contractorUaid(CONFIG));
    expect(card["handle"]).toBe(CONTRACTOR_HANDLE);
    expect(card["signingKey"]).toEqual({ alg: "ed25519", pub: publicKeyHex(CONTRACTOR_KEY) });
    expect(uaidMatchesPublicKey(String(card["did"]), publicKeyHex(CONTRACTOR_KEY))).toBe(true);
    expect(card["audit"]).toEqual({ topic: TOPIC_ID });

    const extensions = (card["capabilities"] as { extensions: { params: Record<string, unknown> }[] })
      .extensions;
    expect(extensions[0]?.params).toMatchObject({
      network: "hedera:testnet",
      payTo: PAYEE_ACCOUNT,
      intakeTinybars: CONFIG.intakeTinybars,
      balanceTinybars: CONFIG.balanceTinybars,
    });

    // The card is how a stranger addresses this agent for the first time, so it
    // must sit in front of the payment gate, not behind it.
    expect(gateCalls).toEqual([]);
  });

  it("claims only skills from the HCS-14 tables", async () => {
    const card = (await (await fetch(`${baseUrl}/.well-known/agent.json`)).json()) as {
      skills: number[];
    };
    expect(card.skills.length).toBeGreaterThan(0);
    for (const skill of card.skills) {
      expect(Number.isInteger(skill)).toBe(true);
      expect(skill < 40 || skill >= 100).toBe(true);
    }
  });
});

describe("what the contractor signs as", () => {
  it("sends receipts from the identifier on its card", async () => {
    const envelope = mandateEnvelope();
    const response = await fetch(`${baseUrl}/mandates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": "intake" },
      body: JSON.stringify(envelope),
    });
    expect(response.status).toBe(201);

    const { receipt } = (await response.json()) as { receipt: Envelope<Receipt> };
    expect(receipt.from).toBe(contractorUaid(CONFIG));
    expect(uaidMatchesPublicKey(receipt.from, receipt.sig.pub)).toBe(true);
    expect(verifyEnvelope(receipt)).toBe(true);
    // The handle stays where the schema puts it: inside the document.
    expect(receipt.data.issuer).toBe(CONTRACTOR_HANDLE);
  });

  it("signs a refusal as the same agent", async () => {
    const response = await fetch(`${baseUrl}/mandates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": "intake" },
      body: JSON.stringify({ schema: "note.v1", from: "someone", thread_id: "t", data: {} }),
    });
    expect(response.status).toBe(422);

    const { receipt } = (await response.json()) as { receipt: Envelope<Receipt> };
    expect(receipt.from).toBe(contractorUaid(CONFIG));
    expect(uaidMatchesPublicKey(receipt.from, receipt.sig.pub)).toBe(true);
  });
});
