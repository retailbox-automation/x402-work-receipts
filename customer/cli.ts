/**
 * The customer agent.
 *
 * Two commands, one order:
 *
 *   customer order --story demo/fixtures/story-history-grouping.json --to http://localhost:4021
 *   customer collect <mandate_id> --to http://localhost:4021
 *
 * `order` turns a story card into a signed `mandate.v1`, pays the contractor's
 * intake fee with x402 and stores the acceptance. `collect` pays the balance
 * once the work exists and stores the delivered receipt with its payment legs.
 * Everything the agent receives is checked before it is written to disk — the
 * signature first, then the schema, then whether the document is about this
 * order at all — because these files are what the public verifier later reads.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { config as loadEnv } from "dotenv";
import { envelopeHash, signEnvelope, verifyEnvelope } from "../protocol/envelope.js";
import { validateMandate, validatePaymentReceipt, validateReceipt } from "../protocol/schemas.js";
import type { Envelope, Mandate, PaymentReceipt, Receipt } from "../protocol/types.js";
import { createPaidFetch, hashscanTopicUrl, hashscanTransactionUrl, payFor } from "./pay.js";
import { loadCustomerConfig, type CustomerConfig, type SigningIdentity } from "./wallet.js";

/** A story card as the customer's tracker exports it. */
export type Story = {
  /** Story id in the customer's tracker. */
  story_ref: string;
  /** Link to the card. */
  story_url: string;
  /** Card title, verbatim. */
  title: string;
  /** Acceptance criteria, verbatim. */
  acceptance: string[];
  /** Project, epic, target branch, staging — the frame in words. */
  frame: string;
  /** Optional due date. */
  due?: string;
};

/** Where one order's artifacts live. */
export type ArtifactPaths = {
  dir: string;
  mandate: string;
  accepted: string;
  receipt: string;
};

/** Options for {@link buildMandate}. */
export type BuildMandateOptions = {
  /** Handle written into `issuer`; must match the envelope's `from`. */
  issuer: string;
  /** Order id; a fresh uuid v7 by default. */
  mandateId?: string;
  /** Issue time; now by default. */
  issuedAt?: string;
};

/** Order ids are also directory names, so they may not contain a path. */
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Reads a story card from disk.
 *
 * @param path - Path to the story JSON
 * @returns The story
 * @throws When the file is not a JSON object with a title and acceptance criteria
 */
export function loadStory(path: string): Story {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const parsed: unknown = JSON.parse(readFileSync(absolute, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a story object`);
  }
  const story = parsed as Partial<Story>;
  if (typeof story.title !== "string" || !Array.isArray(story.acceptance)) {
    throw new Error(`${path} is missing "title" or "acceptance"`);
  }
  return story as Story;
}

/**
 * Turns a story card into a work order.
 *
 * The acceptance criteria are copied verbatim: they are what the contractor
 * signs up to, and a paraphrase would make the receipt unfalsifiable. The
 * result is validated here, so a malformed order is caught before it is signed,
 * paid for and anchored.
 *
 * @param story - The story card
 * @param options - Issuer handle and optional id and time
 * @returns A valid `mandate.v1` document
 * @throws SchemaError when the story does not make a valid work order
 */
export function buildMandate(story: Story, options: BuildMandateOptions): Mandate {
  const mandate: Mandate = {
    mandate_id: options.mandateId ?? uuidV7(),
    story_ref: story.story_ref,
    story_url: story.story_url,
    title: story.title,
    acceptance: [...story.acceptance],
    frame: story.frame,
    ...(story.due === undefined ? {} : { due: story.due }),
    issued_at: options.issuedAt ?? new Date().toISOString(),
    issuer: options.issuer,
  };
  validateMandate(mandate);
  return mandate;
}

/**
 * Signs a work order for the contractor agent.
 *
 * The thread is the order itself, so every later document about it — the
 * acceptance, the delivered receipt — comes back under the same `thread_id`.
 *
 * @param mandate - A validated work order
 * @param identity - The customer's signing identity
 * @returns The signed envelope
 */
export function buildMandateEnvelope(mandate: Mandate, identity: SigningIdentity): Envelope<Mandate> {
  return signEnvelope<Mandate>(
    {
      schema: "mandate.v1",
      from: identity.agent,
      to: identity.counterparty,
      thread_id: mandate.mandate_id,
      issued_at: mandate.issued_at,
      data: mandate,
    },
    identity.privateKeyHex,
  );
}

/**
 * Checks the contractor's answer to `POST /mandates`.
 *
 * @param body - Parsed response body
 * @param mandateEnvelope - The order that was sent
 * @returns The acceptance envelope
 * @throws When the receipt is missing, unsigned, malformed, or about another order
 */
export function parseAcceptedResponse(
  body: unknown,
  mandateEnvelope: Envelope<Mandate>,
): Envelope<Receipt> {
  const envelope = takeReceipt(body);
  validateReceipt(envelope.data);
  const receipt = envelope.data as Receipt;

  if (receipt.kind !== "accepted") {
    throw new Error(`Expected an accepted receipt, got kind "${receipt.kind}"`);
  }
  if (receipt.mandate_id !== mandateEnvelope.data.mandate_id) {
    throw new Error(
      `Receipt is for mandate ${receipt.mandate_id}, not ${mandateEnvelope.data.mandate_id}`,
    );
  }
  const expectedHash = envelopeHash(mandateEnvelope);
  if (receipt.mandate_envelope_hash !== expectedHash) {
    throw new Error(
      `Receipt refers to mandate envelope hash ${receipt.mandate_envelope_hash}, ours is ${expectedHash}`,
    );
  }
  return envelope as Envelope<Receipt>;
}

/**
 * Checks the contractor's answer to `GET /mandates/{id}/receipt`.
 *
 * @param body - Parsed response body
 * @param mandateId - The order being collected
 * @returns The delivered receipt with its payment legs
 * @throws When the receipt is missing, unsigned, malformed, or about another order
 */
export function parseDeliveredResponse(body: unknown, mandateId: string): Envelope<PaymentReceipt> {
  const envelope = takeReceipt(body);
  validatePaymentReceipt(envelope.data);
  const receipt = envelope.data as PaymentReceipt;

  if (receipt.kind !== "delivered") {
    throw new Error(`Expected a delivered receipt, got kind "${receipt.kind}"`);
  }
  if (receipt.mandate_id !== mandateId) {
    throw new Error(`Receipt is for mandate ${receipt.mandate_id}, not ${mandateId}`);
  }
  return envelope as Envelope<PaymentReceipt>;
}

/**
 * Paths of one order's artifacts.
 *
 * @param outDir - Root output directory
 * @param mandateId - Order id, used as the directory name
 * @returns The directory and the three files in it
 * @throws When the order id is not usable as a directory name
 */
export function artifactPaths(outDir: string, mandateId: string): ArtifactPaths {
  if (!SAFE_ID_PATTERN.test(mandateId)) {
    throw new Error(`Mandate id "${mandateId}" is not usable as a directory name`);
  }
  const dir = join(outDir, mandateId);
  return {
    dir,
    mandate: join(dir, "mandate.json"),
    accepted: join(dir, "accepted.json"),
    receipt: join(dir, "receipt.json"),
  };
}

/**
 * Writes a value as readable JSON, creating the directory if needed.
 *
 * @param path - File to write
 * @param value - Value to serialize
 * @returns The path written
 */
export function writeJson(path: string, value: unknown): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

/**
 * Stores the signed order and the acceptance.
 *
 * @param outDir - Root output directory
 * @param mandateEnvelope - The order as it was sent, signature included
 * @param acceptedEnvelope - The acceptance as it was received
 * @returns The paths written
 */
export function saveOrderArtifacts(
  outDir: string,
  mandateEnvelope: Envelope<Mandate>,
  acceptedEnvelope: Envelope<Receipt>,
): ArtifactPaths {
  const paths = artifactPaths(outDir, mandateEnvelope.data.mandate_id);
  writeJson(paths.mandate, mandateEnvelope);
  writeJson(paths.accepted, acceptedEnvelope);
  return paths;
}

/**
 * Stores the delivered receipt.
 *
 * @param outDir - Root output directory
 * @param mandateId - Order id
 * @param receiptEnvelope - The receipt as it was received
 * @returns The path written
 */
export function saveReceiptArtifact(
  outDir: string,
  mandateId: string,
  receiptEnvelope: Envelope<PaymentReceipt>,
): string {
  return writeJson(artifactPaths(outDir, mandateId).receipt, receiptEnvelope);
}

/**
 * Generates a uuid version 7: 48 bits of millisecond time, then randomness.
 *
 * Order ids sort by the time they were issued, which makes a directory of
 * orders readable without opening any of them.
 *
 * @returns The uuid
 */
export function uuidV7(): string {
  const bytes = randomBytes(16);
  const milliseconds = BigInt(Date.now());
  for (let index = 0; index < 6; index++) {
    bytes[index] = Number((milliseconds >> BigInt(8 * (5 - index))) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Places an order: sign, pay the intake fee, store the acceptance.
 *
 * @param options - Story path and overrides for the contractor url and output directory
 * @returns Nothing; progress is printed
 */
export async function runOrder(options: {
  story: string;
  to?: string;
  out?: string;
}): Promise<void> {
  const config = configure();
  const base = trimSlash(options.to ?? config.contractorUrl);
  const outDir = options.out ?? config.outDir;

  const story = loadStory(options.story);
  const mandate = buildMandate(story, { issuer: config.signing.handle });
  const envelope = buildMandateEnvelope(mandate, config.signing);

  console.log(`order      ${mandate.mandate_id}`);
  console.log(`story      ${mandate.title}`);
  console.log(`from       ${envelope.from} → ${envelope.to}`);
  console.log(`contractor ${base}`);
  console.log(`payer      ${config.payment.accountId} on ${config.payment.network}`);
  console.log("\npaying the intake fee…");

  const paid = createPaidFetch(config.payment);
  const result = await payFor<unknown>(paid, `${base}/mandates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });

  const accepted = parseAcceptedResponse(result.body, envelope);
  const paths = saveOrderArtifacts(outDir, envelope, accepted);

  console.log(`\nintake paid: ${result.transactionId}`);
  console.log(`hashscan:    ${result.hashscanUrl}`);
  reportAnchor(accepted.data.mandate_anchor.topic, config);
  console.log(`\naccepted by ${accepted.data.issuer}, ${accepted.data.taken.length} criteria taken`);
  for (const criterion of accepted.data.taken) {
    console.log(`  · ${criterion}`);
  }
  for (const declined of accepted.data.declined ?? []) {
    console.log(`  ✗ ${declined.criterion} — ${declined.reason}`);
  }
  console.log(`\nsaved ${paths.mandate}`);
  console.log(`saved ${paths.accepted}`);
  console.log(`\ncollect it with: npm run customer -- collect ${mandate.mandate_id} --to ${base}`);
}

/**
 * Collects a finished order: pay the balance, store the receipt.
 *
 * @param mandateId - Order to collect
 * @param options - Overrides for the contractor url and output directory
 * @returns Nothing; progress is printed
 */
export async function runCollect(
  mandateId: string,
  options: { to?: string; out?: string },
): Promise<void> {
  const config = configure();
  const base = trimSlash(options.to ?? config.contractorUrl);
  const outDir = options.out ?? config.outDir;

  console.log(`order      ${mandateId}`);
  console.log(`contractor ${base}`);
  console.log(`payer      ${config.payment.accountId} on ${config.payment.network}`);
  console.log("\npaying the balance…");

  const paid = createPaidFetch(config.payment);
  const result = await payFor<unknown>(paid, `${base}/mandates/${mandateId}/receipt`, { method: "GET" });

  const receiptEnvelope = parseDeliveredResponse(result.body, mandateId);
  const receipt = receiptEnvelope.data;
  const path = saveReceiptArtifact(outDir, mandateId, receiptEnvelope);

  console.log(`\nbalance paid: ${result.transactionId}`);
  console.log(`hashscan:     ${result.hashscanUrl}`);
  console.log(`\npayments on this order:`);
  console.log(`  intake  ${receipt.payment.intake.tinybars} tinybars  ${receipt.payment.intake.transaction_id}`);
  console.log(`          ${hashscanTransactionUrl(receipt.payment.intake.transaction_id, config.payment.network)}`);
  if (receipt.payment.balance) {
    console.log(`  balance ${receipt.payment.balance.tinybars} tinybars  ${receipt.payment.balance.transaction_id}`);
    console.log(`          ${hashscanTransactionUrl(receipt.payment.balance.transaction_id, config.payment.network)}`);
  }
  reportAnchor(receipt.mandate_anchor.topic, config);
  if (receipt.result) {
    console.log(`\ndelivered:`);
    console.log(`  pull request ${receipt.result.pr_url}`);
    console.log(`  staging      ${receipt.result.staging_url}`);
    console.log(`  status       ${receipt.result.notion_status}`);
  }
  console.log(`\nsaved ${path}`);
}

/**
 * Builds the command line.
 *
 * @returns The configured program
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("customer")
    .description("Order work from a contractor agent and pay for it with x402 on Hedera");

  program
    .command("order")
    .description("Sign a work order, pay the intake fee and store the acceptance")
    .requiredOption("--story <path>", "story card to order, as JSON")
    .option("--to <url>", "contractor base url")
    .option("--out <dir>", "directory to write artifacts into")
    .action(async options => {
      await runOrder(options as { story: string; to?: string; out?: string });
    });

  program
    .command("collect")
    .description("Pay the balance and store the delivered receipt")
    .argument("<mandate_id>", "order to collect")
    .option("--to <url>", "contractor base url")
    .option("--out <dir>", "directory to write artifacts into")
    .action(async (mandateId: string, options) => {
      await runCollect(mandateId, options as { to?: string; out?: string });
    });

  return program;
}

/**
 * Runs the command line and turns a failure into a message and exit code 1.
 *
 * @param argv - Process arguments
 * @returns Nothing
 */
export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/**
 * Loads `.env` from the repository root and reads the configuration.
 *
 * @returns The customer configuration
 */
function configure(): CustomerConfig {
  loadEnv({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });
  return loadCustomerConfig();
}

/**
 * Pulls the receipt envelope out of a response body and checks its signature.
 *
 * @param body - Parsed response body
 * @returns The envelope, signature verified
 * @throws When there is no receipt or the signature does not hold
 */
function takeReceipt(body: unknown): Envelope<unknown> {
  if (typeof body !== "object" || body === null || !("receipt" in body)) {
    throw new Error("The contractor's answer carried no receipt envelope");
  }
  const envelope = (body as { receipt: unknown }).receipt;
  if (typeof envelope !== "object" || envelope === null) {
    throw new Error("The receipt in the contractor's answer is not an envelope");
  }
  if (!verifyEnvelope(envelope as Envelope<unknown>)) {
    throw new Error("The receipt signature does not verify — refusing to store it");
  }
  return envelope as Envelope<unknown>;
}

/**
 * Prints the public audit topic, when the receipt names one.
 *
 * @param topic - Topic id from the receipt's anchor
 * @param config - Customer configuration, for the network
 */
function reportAnchor(topic: string | undefined, config: CustomerConfig): void {
  if (topic) {
    console.log(`anchor topic ${topic}`);
    console.log(`             ${hashscanTopicUrl(topic, config.payment.network)}`);
  }
}

/**
 * Removes a trailing slash so urls are joined predictably.
 *
 * @param url - Base url
 * @returns The url without a trailing slash
 */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && pathToFileURL(entryPoint).href === import.meta.url) {
  await main();
}
