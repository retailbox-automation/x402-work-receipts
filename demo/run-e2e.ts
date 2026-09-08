/**
 * The whole exchange in one command, against Hedera testnet.
 *
 * A customer agent orders a piece of work, pays the intake fee, the contractor
 * agent delivers it, the customer pays the balance and collects a signed
 * receipt — and then a verifier that has never spoken to either of them
 * reconstructs the order from the public mirror node and says whether the
 * receipt holds up.
 *
 * Nothing here re-implements the flow. The contractor is the real service, the
 * two paid calls are the customer CLI's own `order` and `collect`, and the last
 * step is the published `verify` command. This file only wires them together,
 * waits for the two things that are genuinely asynchronous — the facilitator
 * sync and the mirror node's indexing lag — and writes down what happened.
 *
 * It costs real testnet HBAR: two payments per run.
 *
 * Run: npm run demo
 */
import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { operatorClient, submitAnchor } from "../anchor/client.js";
import type { AnchorEntry } from "../anchor/records.js";
import { toMirrorTxId } from "../anchor/records.js";
import {
  contractorConfigFromEnv,
  createContractorApp,
  createPaymentGate,
  type ContractorConfig,
} from "../contractor/server.js";
import { JobStore } from "../contractor/store.js";
import { artifactPaths, runCollect, runOrder } from "../customer/cli.js";
import { hashscanTopicUrl, hashscanTransactionUrl } from "../customer/pay.js";
import type { Envelope, Mandate, PaymentReceipt } from "../protocol/types.js";
import { EXIT_OK, verify } from "../verifier/cli.js";
import { MIRROR_NODE_URL, liveMirror } from "../verifier/mirror.js";

/** Repository root, so the demo runs the same from any working directory. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The story card the demo orders; synthetic, like everything else in `demo/`. */
const STORY = join(ROOT, "demo", "fixtures", "story-history-grouping.json");

/** Where the run's own record is written. */
const LAST_RUN = join(ROOT, "demo", "last-run.json");

/** How long to wait for the facilitator's `/supported` sync before giving up. */
const GATE_TIMEOUT_MS = 60_000;

/** How long to wait for the mirror node to index this run. */
const MIRROR_TIMEOUT_MS = 180_000;

/** Pause between polls, for both waits. */
const POLL_MS = 2_000;

/** The six anchors one order leaves on the topic, in the order they are written. */
const EXPECTED_ANCHORS = 6;

/** What the run produced, as written to `demo/last-run.json`. */
type RunRecord = {
  started_at: string;
  finished_at: string;
  network: string;
  facilitator: string;
  mirror_node: string;
  order: {
    mandate_id: string;
    title: string;
    story_ref: string;
    customer: string;
    contractor: string;
    acceptance_criteria: number;
  };
  topic: { id: string; hashscan: string };
  payments: Record<string, PaymentRecord | undefined>;
  anchors: Array<{
    kind: string;
    seq: number;
    consensus_ts: string;
    hash: string;
    ref?: string;
    mirror_node: string;
  }>;
  deliverable?: { pr_url: string; staging_url: string; notion_status: string };
  artifacts: { mandate: string; accepted: string; receipt: string };
  verification: {
    verdict: "PASS" | "FAIL";
    exit_code: number;
    checks: Array<{ name: string; ok: boolean; detail: string }>;
  };
};

/** One settled payment leg, with the links a reader can follow. */
type PaymentRecord = {
  tinybars: number;
  payer: string;
  payee: string;
  transaction_id: string;
  mirror_transaction_id: string;
  hashscan: string;
  mirror_node: string;
};

/**
 * Runs the whole demo.
 *
 * @returns Nothing; the process exit code carries the verdict
 */
async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  loadEnv({ path: join(ROOT, ".env"), quiet: true });

  const config: ContractorConfig = { ...contractorConfigFromEnv(), port: 0 };
  const hedera = operatorClient();
  const closers: Array<() => void> = [() => hedera.close()];

  try {
    heading("1 · contractor");
    const { server, baseUrl } = await startContractor(config, hedera);
    closers.push(() => server.close());
    console.log(`listening   ${baseUrl}`);
    console.log(`payTo       ${config.payTo} on ${config.network}`);
    console.log(`topic       ${config.topicId}`);
    console.log(`facilitator ${config.facilitatorUrl}`);
    console.log(`prices      intake ${config.intakeTinybars} · balance ${config.balanceTinybars} tinybars`);

    process.stdout.write("waiting for the facilitator sync… ");
    const feePayer = await waitForPaymentGate(baseUrl);
    console.log(`ready, fee payer ${feePayer}`);

    // A directory per run, so the order this run produced is the only one in it
    // and the demo never has to guess which artifacts are its own.
    const outDir = join(ROOT, "out", "demo", stamp(startedAt));
    mkdirSync(outDir, { recursive: true });

    heading("2 · customer orders and pays the intake fee");
    await runOrder({ story: STORY, to: baseUrl, out: outDir });
    const mandateId = onlyOrderIn(outDir);

    heading("3 · contractor delivers the work");
    const delivery = await deliver(baseUrl, mandateId, config.deliverToken);
    console.log(`pull request ${delivery.result.pr_url}`);
    console.log(`staging      ${delivery.result.staging_url}`);
    console.log(`status       ${delivery.result.notion_status}`);
    console.log(`anchored     seq ${delivery.anchor.seq} at ${delivery.anchor.consensus_ts}`);

    heading("4 · customer pays the balance and collects the receipt");
    await runCollect(mandateId, { to: baseUrl, out: outDir });

    const paths = artifactPaths(outDir, mandateId);
    const mandate = readEnvelope<Mandate>(paths.mandate);
    const receipt = readEnvelope<PaymentReceipt>(paths.receipt);
    const transactionIds = [
      receipt.data.payment.intake.transaction_id,
      receipt.data.payment.balance?.transaction_id,
    ].filter((id): id is string => typeof id === "string");

    heading("5 · waiting for the public record");
    const anchors = await waitForPublicRecord(config.topicId, mandateId, transactionIds);
    console.log(`${anchors.length} anchors and ${transactionIds.length} transfers are readable by anyone`);

    heading("6 · verifier — public data only");
    const outcome = await verify({
      topicId: config.topicId,
      receiptPath: paths.receipt,
      mandatePath: paths.mandate,
    });
    console.log(outcome.output);

    heading("links");
    const record = buildRecord({
      startedAt,
      config,
      mandate,
      receipt,
      anchors,
      paths,
      outcome,
    });
    printLinks(record);

    writeFileSync(LAST_RUN, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    console.log(`\nwrote ${relative(ROOT, LAST_RUN)}`);

    process.exitCode = outcome.code === EXIT_OK ? 0 : 1;
  } finally {
    for (const close of closers.reverse()) {
      close();
    }
  }
}

/**
 * Starts the real contractor service on a free port.
 *
 * @param config - Service configuration, with `port` 0
 * @param hedera - Operator-backed client the anchors are written with
 * @returns The listening server and its base url
 */
async function startContractor(
  config: ContractorConfig,
  hedera: ReturnType<typeof operatorClient>,
): Promise<{ server: Server; baseUrl: string }> {
  const { gate, settlements } = createPaymentGate(config);
  const app = createContractorApp({
    config,
    store: JobStore.open(process.env.CONTRACTOR_STORE ?? join(ROOT, "out", "contractor", "jobs.json")),
    settlements,
    paymentGate: gate,
    anchors: record => submitAnchor(hedera, config.topicId, record),
  });

  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/**
 * Waits until the payment gate can quote a price.
 *
 * `extra.feePayer` is not ours to configure: it arrives from the facilitator's
 * `/supported` response after the middleware has synced. Until it does, an
 * unpaid call is answered without it and a paying client has nothing to build a
 * transaction against — so the demo asks the gate itself rather than sleeping
 * for a guessed number of seconds.
 *
 * @param baseUrl - The contractor's base url
 * @returns The facilitator account that will pay the network fee
 * @throws When the sync has not happened within the timeout
 */
async function waitForPaymentGate(baseUrl: string): Promise<string> {
  const deadline = Date.now() + GATE_TIMEOUT_MS;
  let lastSeen = "no answer yet";

  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/mandates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (response.status === 402) {
        const requirements = paymentRequirements(response, await response.text());
        const feePayer = requirements?.accepts?.[0]?.extra?.feePayer;
        if (typeof feePayer === "string" && feePayer.length > 0) {
          return feePayer;
        }
        lastSeen = "402 without a fee payer";
      } else {
        lastSeen = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastSeen = error instanceof Error ? error.message : String(error);
    }

    if (Date.now() > deadline) {
      throw new Error(
        `The payment gate never quoted a price (${lastSeen}). The facilitator at the configured url may be down.`,
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * Reads the payment requirements out of a 402.
 *
 * They travel base64 in the `PAYMENT-REQUIRED` header; some versions also put
 * them in the body, so both are tried.
 *
 * @param response - The 402 response
 * @param body - Its body, already read as text
 * @returns The parsed requirements, or undefined
 */
function paymentRequirements(
  response: Response,
  body: string,
): { accepts?: Array<{ extra?: { feePayer?: string } }> } | undefined {
  const header = response.headers.get("payment-required");
  if (header) {
    try {
      return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      // Fall through to the body: an unreadable header is not fatal here.
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Records the deliverable, the way the contractor's own operator would.
 *
 * @param baseUrl - The contractor's base url
 * @param mandateId - Order to deliver
 * @param token - The contractor-local delivery token
 * @returns The synthetic result and the anchor it was written to
 * @throws When the route refuses
 */
async function deliver(
  baseUrl: string,
  mandateId: string,
  token: string,
): Promise<{
  result: { pr_url: string; staging_url: string; notion_status: string };
  anchor: { topic: string; seq: number; consensus_ts: string };
}> {
  const response = await fetch(`${baseUrl}/mandates/${mandateId}/deliver`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-contractor-token": token },
    body: "{}",
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Delivery refused with HTTP ${response.status}: ${body}`);
  }
  return JSON.parse(body);
}

/**
 * Waits until a stranger could see this run.
 *
 * Consensus and public readability are not the same moment: the anchors and the
 * transfers are final on the network before the mirror node has indexed them.
 * The verifier reads only the mirror node, so the demo waits for the mirror
 * node — using the verifier's own readers, so what it waits for is exactly what
 * the verifier will see.
 *
 * @param topicId - Audit topic
 * @param mandateId - Order to wait for
 * @param transactionIds - The settled payments
 * @returns This order's anchors, ascending
 * @throws When the record is still incomplete after the timeout
 */
async function waitForPublicRecord(
  topicId: string,
  mandateId: string,
  transactionIds: string[],
): Promise<AnchorEntry[]> {
  const deadline = Date.now() + MIRROR_TIMEOUT_MS;

  for (;;) {
    const anchors = (await liveMirror.readAnchors(topicId)).filter(
      entry => entry.mandate_id === mandateId,
    );
    const transfers = await Promise.all(
      transactionIds.map(id => liveMirror.readTransaction(id)),
    );
    const visible = transfers.filter(transfer => transfer !== null).length;

    if (anchors.length >= EXPECTED_ANCHORS && visible === transactionIds.length) {
      return anchors;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `The mirror node still shows ${anchors.length} of ${EXPECTED_ANCHORS} anchors and ` +
          `${visible} of ${transactionIds.length} transfers for ${mandateId}`,
      );
    }
    process.stdout.write(
      `\ranchors ${anchors.length}/${EXPECTED_ANCHORS} · transfers ${visible}/${transactionIds.length}   `,
    );
    await sleep(POLL_MS);
  }
}

/**
 * Assembles the record of the run.
 *
 * @param input - Everything the run produced
 * @returns The record written to `demo/last-run.json`
 */
function buildRecord(input: {
  startedAt: string;
  config: ContractorConfig;
  mandate: Envelope<Mandate>;
  receipt: Envelope<PaymentReceipt>;
  anchors: AnchorEntry[];
  paths: { mandate: string; accepted: string; receipt: string };
  outcome: { code: number; checks: Array<{ name: string; ok: boolean; detail: string }> };
}): RunRecord {
  const { config, receipt } = input;
  const payment = receipt.data.payment;

  return {
    started_at: input.startedAt,
    finished_at: new Date().toISOString(),
    network: payment.network,
    facilitator: payment.facilitator,
    mirror_node: `${MIRROR_NODE_URL}/api/v1`,
    order: {
      mandate_id: receipt.data.mandate_id,
      title: input.mandate.data.title,
      story_ref: input.mandate.data.story_ref,
      customer: input.mandate.from,
      contractor: receipt.from,
      acceptance_criteria: input.mandate.data.acceptance.length,
    },
    topic: { id: config.topicId, hashscan: hashscanTopicUrl(config.topicId, payment.network) },
    payments: {
      intake: paymentRecord(payment.intake.tinybars, payment.intake.transaction_id, payment.payer, payment.payee, payment.network),
      balance: payment.balance
        ? paymentRecord(payment.balance.tinybars, payment.balance.transaction_id, payment.payer, payment.payee, payment.network)
        : undefined,
    },
    anchors: input.anchors.map(entry => ({
      kind: entry.kind,
      seq: entry.seq,
      consensus_ts: entry.consensus_ts,
      hash: entry.hash,
      ...(entry.ref ? { ref: entry.ref } : {}),
      mirror_node: `${MIRROR_NODE_URL}/api/v1/topics/${config.topicId}/messages/${entry.seq}`,
    })),
    ...(receipt.data.result ? { deliverable: receipt.data.result } : {}),
    artifacts: {
      mandate: relative(ROOT, input.paths.mandate),
      accepted: relative(ROOT, input.paths.accepted),
      receipt: relative(ROOT, input.paths.receipt),
    },
    verification: {
      verdict: input.outcome.code === EXIT_OK ? "PASS" : "FAIL",
      exit_code: input.outcome.code,
      checks: input.outcome.checks,
    },
  };
}

/**
 * One payment leg with its public links.
 *
 * @param tinybars - Amount moved
 * @param transactionId - Facilitator form, `0.0.x@s.n`
 * @param payer - Debited account
 * @param payee - Credited account
 * @param network - Network the transfer settled on
 * @returns The record
 */
function paymentRecord(
  tinybars: number,
  transactionId: string,
  payer: string,
  payee: string,
  network: "hedera:testnet" | "hedera:mainnet",
): PaymentRecord {
  const mirrorId = toMirrorTxId(transactionId);
  return {
    tinybars,
    payer,
    payee,
    transaction_id: transactionId,
    mirror_transaction_id: mirrorId,
    hashscan: hashscanTransactionUrl(transactionId, network),
    mirror_node: `${MIRROR_NODE_URL}/api/v1/transactions/${mirrorId}`,
  };
}

/**
 * Prints every link the run produced.
 *
 * @param record - The run record
 */
function printLinks(record: RunRecord): void {
  console.log(`topic       ${record.topic.hashscan}`);
  for (const [leg, payment] of Object.entries(record.payments)) {
    if (payment) {
      console.log(`${leg.padEnd(12)}${payment.hashscan}`);
      console.log(`${"".padEnd(12)}${payment.tinybars} tinybars, ${payment.payer} → ${payment.payee}`);
    }
  }
  console.log("\nanchors on the topic:");
  for (const anchor of record.anchors) {
    console.log(`  seq ${String(anchor.seq).padStart(4)}  ${anchor.kind.padEnd(15)} ${anchor.mirror_node}`);
  }
}

/**
 * The single order directory a run produced.
 *
 * @param outDir - The run's output directory
 * @returns The order id
 * @throws When the directory does not hold exactly one order
 */
function onlyOrderIn(outDir: string): string {
  const orders = readdirSync(outDir).filter(entry => statSync(join(outDir, entry)).isDirectory());
  if (orders.length !== 1) {
    throw new Error(`Expected exactly one order in ${outDir}, found ${orders.length}`);
  }
  return orders[0] as string;
}

/**
 * Reads a signed envelope written by the customer agent.
 *
 * @param path - File to read
 * @returns The envelope
 */
function readEnvelope<T>(path: string): Envelope<T> {
  return JSON.parse(readFileSync(path, "utf8")) as Envelope<T>;
}

/**
 * A timestamp usable as a directory name.
 *
 * @param iso - ISO timestamp
 * @returns The stamp, e.g. `2026-09-08T14-05-09`
 */
function stamp(iso: string): string {
  return iso.replace(/[:.]/g, "-").replace(/Z$/, "").slice(0, 19);
}

/**
 * Prints a section heading.
 *
 * @param title - Heading text
 */
function heading(title: string): void {
  console.log(`\n${"─".repeat(88)}\n${title}\n`);
}

/**
 * Waits.
 *
 * @param ms - Milliseconds
 * @returns A promise that resolves after the delay
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

await main();
