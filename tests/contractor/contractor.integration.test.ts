/**
 * The whole contractor flow against Hedera testnet: two real HBAR payments
 * settled by the Blocky402 facilitator, six real messages on a real consensus
 * topic, and a signed delivery receipt at the end of it.
 *
 * Nothing is stubbed. The paying side is the same `@x402/fetch` wiring the
 * spike proved, and every claim the test makes about money is checked against
 * the public mirror node rather than against the facilitator's own answer.
 *
 * Skipped when `.env` has no operator, so the unit suite still runs on a
 * machine with no Hedera credentials.
 */
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { afterAll, describe, expect, it } from "vitest";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { SettleResponse } from "@x402/core/types";
import { envelopeHash, publicKeyHex, signEnvelope, verifyEnvelope } from "../../protocol/envelope";
import { validatePaymentReceipt, validateReceipt } from "../../protocol/schemas";
import type { Envelope, Mandate, PaymentReceipt, Receipt } from "../../protocol/types";
import { operatorClient, readAnchors, submitAnchor } from "../../anchor/client";
import { toMirrorTxId } from "../../anchor/records";
import { ANCHOR_TOPIC_MEMO, createTopic } from "../../anchor/topic";
import { createContractorApp, createPaymentGate, type ContractorConfig } from "../../contractor/server";
import { JobStore } from "../../contractor/store";
import { paymentAnchorHash } from "../../contractor/receipts";
import { mandateFixture } from "./helpers";

const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(ENV_PATH)) {
  loadEnv({ path: ENV_PATH });
}

const CAN_RUN =
  existsSync(ENV_PATH) &&
  Boolean(
    process.env.HEDERA_OPERATOR_ID &&
      process.env.HEDERA_OPERATOR_KEY &&
      process.env.PAYER_ACCOUNT_ID &&
      process.env.PAYER_PRIVATE_KEY &&
      process.env.RECEIVER_ACCOUNT_ID,
  );

const NETWORK = "hedera:testnet";
const HBAR_ASSET = "0.0.0";
const MIRROR_NODE = "https://testnet.mirrornode.hedera.com";
const INTAKE_TINYBARS = 1_000_000;
const BALANCE_TINYBARS = 4_000_000;
const DELIVER_TOKEN = "integration-token";

/** Mirror node shape for the fields this test reads. */
type MirrorTransaction = {
  transaction_id: string;
  result: string;
  transfers: { account: string; amount: number }[];
};

const cleanup: Array<() => void> = [];

afterAll(() => {
  for (const close of cleanup) {
    close();
  }
});

describe.skipIf(!CAN_RUN)("contractor on Hedera testnet", () => {
  it("takes a paid order, delivers it, and releases a paid receipt anchored end to end", async () => {
    const directory = mkdtempSync(join(tmpdir(), "contractor-integration-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));

    const hedera = operatorClient();
    cleanup.push(() => hedera.close());

    // A fresh topic per run keeps the assertions about "the six anchors of this
    // order" true even when the shared topic already carries other runs.
    const topicId = process.env.ANCHOR_TOPIC_ID ?? (await createTopic(hedera, ANCHOR_TOPIC_MEMO));
    console.log(`topic:    https://hashscan.io/testnet/topic/${topicId}`);

    const contractorKey = randomBytes(32).toString("hex");
    const customerKey = randomBytes(32).toString("hex");

    const config: ContractorConfig = {
      topicId,
      network: NETWORK,
      asset: HBAR_ASSET,
      payTo: process.env.RECEIVER_ACCOUNT_ID as string,
      facilitatorUrl: process.env.X402_FACILITATOR_URL ?? "https://api.testnet.blocky402.com",
      intakeTinybars: INTAKE_TINYBARS,
      balanceTinybars: BALANCE_TINYBARS,
      handle: "agency-x",
      signingKeyHex: contractorKey,
      deliverToken: DELIVER_TOKEN,
      port: 0,
    };

    const { gate, settlements } = createPaymentGate(config);
    const app = createContractorApp({
      config,
      store: JobStore.open(join(directory, "jobs.json")),
      settlements,
      paymentGate: gate,
      anchors: record => submitAnchor(hedera, topicId, record),
    });

    const server: Server = app.listen(0);
    cleanup.push(() => server.close());
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // The paying agent: ECDSA for Hedera, HBAR opted into the spend controls.
    // Both are the spike's gotchas 1 and 7, and both are load-bearing here.
    const signer = createClientHederaSigner(
      process.env.PAYER_ACCOUNT_ID as string,
      PrivateKey.fromStringECDSA(process.env.PAYER_PRIVATE_KEY as string),
      { network: NETWORK },
    );
    const payingClient = new x402Client().register("hedera:*", new ExactHederaScheme(signer));
    payingClient.setSpendControls({
      allowedAssets: [
        { network: NETWORK, asset: HBAR_ASSET, maxAmountPerPayment: String(BALANCE_TINYBARS) },
      ],
    });
    const httpClient = new x402HTTPClient(payingClient);
    const fetchWithPayment = wrapFetchWithPayment(fetch, httpClient);

    const mandate = mandateFixture({
      mandate_id: `wo-int-${Date.now()}`,
      issued_at: new Date().toISOString(),
    });
    const mandateEnvelope = signEnvelope<Mandate>(
      {
        schema: "mandate.v1",
        from: mandate.issuer,
        to: config.handle,
        thread_id: `thread-${mandate.mandate_id}`,
        issued_at: mandate.issued_at,
        data: mandate,
      },
      customerKey,
    );

    // 1. Order and pay the intake fee.
    const intakeResponse = await fetchWithPayment(`${baseUrl}/mandates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mandateEnvelope),
    });
    const intakeParsed = await httpClient.processResponse(intakeResponse);
    expect(intakeParsed.paymentStatus).toBe("settled");
    expect(intakeParsed.status).toBe(201);

    const intakeSettlement = intakeParsed.header as SettleResponse;
    const acceptedReceipt = (intakeParsed.body as { receipt: Envelope<Receipt> }).receipt;
    console.log(`intake:   https://hashscan.io/testnet/transaction/${intakeSettlement.transaction}`);

    expect(verifyEnvelope(acceptedReceipt)).toBe(true);
    expect(acceptedReceipt.sig.pub).toBe(publicKeyHex(contractorKey));
    expect(() => validateReceipt(acceptedReceipt.data)).not.toThrow();
    expect(acceptedReceipt.data.kind).toBe("accepted");
    expect(acceptedReceipt.data.mandate_envelope_hash).toBe(envelopeHash(mandateEnvelope));

    // 2. The contractor records the deliverable.
    const deliverResponse = await fetch(`${baseUrl}/mandates/${mandate.mandate_id}/deliver`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Contractor-Token": DELIVER_TOKEN },
      body: JSON.stringify({}),
    });
    expect(deliverResponse.status).toBe(200);

    // 3. Collect the receipt and pay the balance.
    const balanceResponse = await fetchWithPayment(`${baseUrl}/mandates/${mandate.mandate_id}/receipt`);
    const balanceParsed = await httpClient.processResponse(balanceResponse);
    expect(balanceParsed.paymentStatus).toBe("settled");
    expect(balanceParsed.status).toBe(200);

    const balanceSettlement = balanceParsed.header as SettleResponse;
    const receipt = (balanceParsed.body as { receipt: Envelope<PaymentReceipt> }).receipt;
    console.log(`balance:  https://hashscan.io/testnet/transaction/${balanceSettlement.transaction}`);

    expect(receipt.schema).toBe("receipt.v1+payment.v1");
    expect(verifyEnvelope(receipt)).toBe(true);
    expect(() => validatePaymentReceipt(receipt.data)).not.toThrow();
    expect(receipt.data.payment.intake.transaction_id).toBe(intakeSettlement.transaction);
    expect(receipt.data.payment.balance?.transaction_id).toBe(balanceSettlement.transaction);
    expect(receipt.data.payment.payer).toBe(process.env.PAYER_ACCOUNT_ID);
    expect(receipt.data.payment.payee).toBe(process.env.RECEIVER_ACCOUNT_ID);

    // 4. The audit trail, read from the public mirror node like a stranger would.
    const anchors = await waitForAnchors(topicId, mandate.mandate_id, 6);
    expect(anchors.map(entry => entry.kind)).toEqual([
      "mandate_in",
      "payment_intake",
      "accepted",
      "delivered",
      "payment_balance",
      "receipt",
    ]);
    expect(anchors[0].hash).toBe(envelopeHash(mandateEnvelope));
    expect(anchors[2].hash).toBe(envelopeHash(acceptedReceipt));
    expect(anchors[5].hash).toBe(envelopeHash(receipt));
    expect(anchors[1].ref).toBe(toMirrorTxId(intakeSettlement.transaction));
    expect(anchors[4].ref).toBe(toMirrorTxId(balanceSettlement.transaction));

    // The payment anchors are recomputable from the receipt alone, which is what
    // makes them worth anchoring at all.
    const parties = {
      network: receipt.data.payment.network,
      asset: receipt.data.payment.asset,
      payer: receipt.data.payment.payer,
      payee: receipt.data.payment.payee,
    };
    expect(anchors[1].hash).toBe(
      paymentAnchorHash({
        ...parties,
        tinybars: receipt.data.payment.intake.tinybars,
        transaction_id: receipt.data.payment.intake.transaction_id,
      }),
    );
    expect(anchors[4].hash).toBe(
      paymentAnchorHash({
        ...parties,
        tinybars: receipt.data.payment.balance?.tinybars as number,
        transaction_id: receipt.data.payment.balance?.transaction_id as string,
      }),
    );

    // 5. Both transfers, confirmed on chain rather than taken from the facilitator.
    for (const [leg, tinybars] of [
      [intakeSettlement.transaction, INTAKE_TINYBARS],
      [balanceSettlement.transaction, BALANCE_TINYBARS],
    ] as const) {
      const onChain = await fetchTransaction(leg);
      expect(onChain?.result).toBe("SUCCESS");
      expect(net(onChain as MirrorTransaction, process.env.PAYER_ACCOUNT_ID as string)).toBe(-tinybars);
      expect(net(onChain as MirrorTransaction, process.env.RECEIVER_ACCOUNT_ID as string)).toBe(tinybars);
    }
  }, 300_000);
});

/**
 * Waits for the mirror node to show every anchor of one order.
 *
 * @param topicId - Audit topic
 * @param mandateId - Order to filter by
 * @param expected - How many anchors to wait for
 * @returns The anchors, ascending by sequence number
 */
async function waitForAnchors(topicId: string, mandateId: string, expected: number) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const entries = (await readAnchors(topicId)).filter(entry => entry.mandate_id === mandateId);
    if (entries.length >= expected || Date.now() > deadline) {
      return entries;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

/**
 * Reads a settled transaction from the public mirror node, allowing for lag.
 *
 * @param transactionId - Transaction id in facilitator form
 * @returns The transaction, or null if it never appeared
 */
async function fetchTransaction(transactionId: string): Promise<MirrorTransaction | null> {
  const mirrorId = toMirrorTxId(transactionId);
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(`${MIRROR_NODE}/api/v1/transactions/${mirrorId}`);
    if (response.ok) {
      const body = (await response.json()) as { transactions?: MirrorTransaction[] };
      const found = body.transactions?.find(entry => entry.transaction_id === mirrorId);
      if (found) {
        return found;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return null;
}

/**
 * Net HBAR movement of one account in a transaction.
 *
 * @param transaction - Mirror node transaction
 * @param account - Account id
 * @returns Tinybars, negative when debited
 */
function net(transaction: MirrorTransaction, account: string): number {
  return transaction.transfers
    .filter(transfer => transfer.account === account)
    .reduce((sum, transfer) => sum + transfer.amount, 0);
}
