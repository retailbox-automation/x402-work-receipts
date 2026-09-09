/**
 * `retainer` — hold money for a contractor before the work exists, release it
 * after.
 *
 *   npm run retainer -- create  --mandate <id> [--tinybars n] [--expires-in s]
 *   npm run retainer -- release --mandate <id> --schedule 0.0.x
 *   npm run retainer -- status  --schedule 0.0.x
 *
 * `create` is run by the customer: it authorises one transfer to the contractor
 * as a Hedera Scheduled Transaction and anchors `retainer_scheduled` on the
 * order's audit topic. `release` is run by the contractor once the work is
 * delivered: it adds the signature the transfer is waiting for and anchors
 * `retainer_released`. `status` reads the public mirror node and reports what
 * the ledger currently says, holding no keys.
 *
 * The two anchors go on the same topic as the rest of the order, so the public
 * verifier picks the retainer up from the topic alone — the receipt schemas are
 * a copy of an external protocol and were not touched to make room for it.
 */
import { Command } from "commander";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import {
  AccountId,
  Client,
  type Client as HederaClient,
  PrivateKey,
} from "@hiero-ledger/sdk";
import { operatorClient, submitAnchor } from "../anchor/client.js";
import { loadPaymentIdentity } from "../customer/wallet.js";
import { hashscanTransactionUrl } from "../customer/pay.js";
import { releaseRetainer, retainerStatus, waitForExecution } from "./release.js";
import { buildRetainerAnchor, type RetainerFacts, toMirrorScheduledTxId } from "./records.js";
import { DEFAULT_EXPIRY_SECONDS, scheduleRetainer } from "./schedule.js";

/** Amount held when none is given: 0.01 ℏ, the same order of size as the intake fee. */
export const DEFAULT_RETAINER_TINYBARS = 1_000_000;

/** Hedera account id, the only form a transfer accepts. */
const ACCOUNT_ID_PATTERN = /^0\.0\.[0-9]+$/;

/** Everything a retainer command needs from the environment. */
export type RetainerConfig = {
  /** CAIP-2 network, e.g. `hedera:testnet`. */
  network: string;
  /** Customer account and its key — the side that authorises. */
  customer: { accountId: string; privateKeyHex: string; keyType: string };
  /** Contractor account and its key — the side that releases. */
  contractor: { accountId: string; privateKeyHex: string; keyType: string };
  /** The audit topic the order is anchored to. */
  topicId: string;
  /** Amount to hold, in tinybars. */
  tinybars: number;
  /** Seconds until the authorisation lapses. */
  expiresInSeconds: number;
};

/**
 * Reads the configuration.
 *
 * The customer side reuses the customer agent's own payment identity, so a
 * retainer is authorised by exactly the account that pays for the order. The
 * contractor side is new: until now the contractor only ever received money and
 * never had to sign a transfer, so it needed no key of its own here.
 *
 * @param env - Environment to read, defaults to the process environment
 * @returns The configuration
 * @throws When an account, a key or the topic is missing or malformed
 */
export function loadRetainerConfig(env: NodeJS.ProcessEnv = process.env): RetainerConfig {
  const customer = loadPaymentIdentity(env);

  const contractorAccount = (env["CONTRACTOR_ACCOUNT_ID"] ?? env["RECEIVER_ACCOUNT_ID"])?.trim();
  if (!contractorAccount || !ACCOUNT_ID_PATTERN.test(contractorAccount)) {
    throw new Error(
      "Missing or malformed CONTRACTOR_ACCOUNT_ID (or RECEIVER_ACCOUNT_ID) — a retainer credits a real 0.0.x account",
    );
  }
  const contractorKey = (env["CONTRACTOR_PRIVATE_KEY"] ?? env["RECEIVER_PRIVATE_KEY"])?.trim();
  if (!contractorKey) {
    throw new Error(
      "Missing CONTRACTOR_PRIVATE_KEY (or RECEIVER_PRIVATE_KEY) — the contractor signs to release a retainer",
    );
  }

  const topicId = env["ANCHOR_TOPIC_ID"]?.trim();
  if (!topicId) {
    throw new Error("Missing ANCHOR_TOPIC_ID — the retainer is anchored on the order's audit topic");
  }

  return {
    network: customer.network,
    customer: {
      accountId: customer.accountId,
      privateKeyHex: customer.privateKeyHex,
      keyType: (env["CUSTOMER_KEY_TYPE"] ?? env["PAYER_KEY_TYPE"] ?? "ecdsa").trim().toLowerCase(),
    },
    contractor: {
      accountId: contractorAccount,
      privateKeyHex: contractorKey,
      keyType: (env["CONTRACTOR_KEY_TYPE"] ?? env["RECEIVER_KEY_TYPE"] ?? "ecdsa").trim().toLowerCase(),
    },
    topicId,
    tinybars: readNumber(env["RETAINER_TINYBARS"], DEFAULT_RETAINER_TINYBARS, "RETAINER_TINYBARS"),
    expiresInSeconds: readNumber(
      env["RETAINER_EXPIRY_SECONDS"],
      DEFAULT_EXPIRY_SECONDS,
      "RETAINER_EXPIRY_SECONDS",
    ),
  };
}

/**
 * Builds a Hedera client operated by one of the two parties.
 *
 * @param network - CAIP-2 network
 * @param party - Account and key of the operator
 * @returns A client the caller owns and must `close()`
 */
export function clientFor(
  network: string,
  party: { accountId: string; privateKeyHex: string; keyType: string },
): HederaClient {
  const client = network.endsWith("mainnet") ? Client.forMainnet() : Client.forTestnet();
  const key = party.keyType.startsWith("ed25519")
    ? PrivateKey.fromStringED25519(party.privateKeyHex)
    : PrivateKey.fromStringECDSA(party.privateKeyHex);
  return client.setOperator(AccountId.fromString(party.accountId), key);
}

/**
 * Creates a retainer and anchors the authorisation.
 *
 * @param options - The order it belongs to, and optional overrides
 * @returns Nothing; progress is printed
 */
export async function runCreate(options: {
  mandate: string;
  tinybars?: string;
  expiresIn?: string;
}): Promise<void> {
  const config = configure();
  const tinybars = options.tinybars ? Number(options.tinybars) : config.tinybars;
  const expiresIn = options.expiresIn ? Number(options.expiresIn) : config.expiresInSeconds;

  const customerClient = clientFor(config.network, config.customer);
  const anchorClient = operatorClient();
  try {
    console.log(`order       ${options.mandate}`);
    console.log(`customer    ${config.customer.accountId} on ${config.network}`);
    console.log(`contractor  ${config.contractor.accountId}`);
    console.log(`holding     ${tinybars} tinybars for ${expiresIn} s`);

    const scheduled = await scheduleRetainer(customerClient, {
      customerId: config.customer.accountId,
      contractorId: config.contractor.accountId,
      tinybars,
      expiresInSeconds: expiresIn,
      memo: `retainer ${options.mandate}`.slice(0, 100),
    });

    const facts: RetainerFacts = {
      network: config.network,
      payer: config.customer.accountId,
      payee: config.contractor.accountId,
      tinybars,
      schedule_id: scheduled.scheduleId,
    };
    const anchor = buildRetainerAnchor("scheduled", options.mandate, facts);
    const position = await submitAnchor(anchorClient, config.topicId, anchor);

    console.log(`\nschedule    ${scheduled.scheduleId}`);
    console.log(`hashscan    https://hashscan.io/${shortNetwork(config.network)}/schedule/${scheduled.scheduleId}`);
    console.log(`expires     ${scheduled.expiresAt}`);
    console.log(`anchored    retainer_scheduled #${position.seq} at ${position.consensus_ts}`);
    console.log(
      `\nNothing has moved yet. Release it with:\n  npm run retainer -- release --mandate ${options.mandate} --schedule ${scheduled.scheduleId}`,
    );
  } finally {
    customerClient.close();
    anchorClient.close();
  }
}

/**
 * Releases a retainer and anchors the executed transfer.
 *
 * @param options - The order and the schedule to release
 * @returns Nothing; progress is printed
 */
export async function runRelease(options: { mandate: string; schedule: string }): Promise<void> {
  const config = configure();
  const contractorClient = clientFor(config.network, config.contractor);
  const anchorClient = operatorClient();
  try {
    console.log(`order       ${options.mandate}`);
    console.log(`schedule    ${options.schedule}`);
    console.log(`releasing as ${config.contractor.accountId}`);

    const released = await releaseRetainer(contractorClient, options.schedule);
    console.log(`sign        ${released.status} (${released.signTransactionId})`);

    process.stdout.write("waiting for the mirror node… ");
    const status = await waitForExecution(options.schedule);
    console.log("executed");

    const transfer = status.transfer;
    if (!transfer) {
      throw new Error("The schedule reports an execution the mirror node will not show");
    }
    const credit = (transfer.transfers ?? []).find(
      entry => entry.account === config.contractor.accountId && entry.amount > 0,
    );
    if (!credit) {
      throw new Error(
        `The executed transfer credits nothing to ${config.contractor.accountId} — refusing to anchor it`,
      );
    }

    const facts: RetainerFacts = {
      network: config.network,
      payer: config.customer.accountId,
      payee: config.contractor.accountId,
      tinybars: credit.amount,
      schedule_id: options.schedule,
      transaction_id: toMirrorScheduledTxId(transfer.transaction_id),
    };
    const anchor = buildRetainerAnchor("released", options.mandate, facts);
    const position = await submitAnchor(anchorClient, config.topicId, anchor);

    console.log(`\nreleased    ${credit.amount} tinybars at ${status.executedAt}`);
    console.log(`transfer    ${transfer.transaction_id}`);
    console.log(`hashscan    ${hashscanTransactionUrl(transfer.transaction_id, config.network)}`);
    console.log(`anchored    retainer_released #${position.seq} at ${position.consensus_ts}`);
  } finally {
    contractorClient.close();
    anchorClient.close();
  }
}

/**
 * Prints what the public record says about a retainer.
 *
 * @param options - The schedule to look up
 * @returns Nothing; the status is printed
 */
export async function runStatus(options: { schedule: string }): Promise<void> {
  const status = await retainerStatus(options.schedule);
  if (!status.schedule) {
    console.log(`schedule ${options.schedule} is not on the mirror node`);
    process.exitCode = 1;
    return;
  }
  console.log(`schedule    ${status.schedule.schedule_id}`);
  console.log(`authorised  ${status.schedule.creator_account_id} at ${status.schedule.consensus_timestamp}`);
  console.log(`releases by ${status.schedule.payer_account_id}`);
  console.log(`expires     ${status.schedule.expiration_time ?? "(network default)"}`);
  console.log(`deleted     ${status.schedule.deleted ? "yes" : "no"}`);
  console.log(`executed    ${status.executedAt ?? "not yet — still pending"}`);
  if (status.transfer) {
    for (const entry of status.transfer.transfers ?? []) {
      console.log(`            ${entry.account} ${entry.amount > 0 ? "+" : ""}${entry.amount}`);
    }
  }
}

/**
 * Builds the command line.
 *
 * @returns The configured program
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("retainer")
    .description("Hold a scheduled HBAR transfer for a contractor, and release it after delivery");

  program
    .command("create")
    .description("Authorise a retainer as the customer and anchor it")
    .requiredOption("--mandate <id>", "order the retainer belongs to")
    .option("--tinybars <n>", "amount to hold")
    .option("--expires-in <seconds>", "how long the authorisation stands")
    .action(async options => {
      await runCreate(options as { mandate: string; tinybars?: string; expiresIn?: string });
    });

  program
    .command("release")
    .description("Release a retainer as the contractor and anchor the transfer")
    .requiredOption("--mandate <id>", "order the retainer belongs to")
    .requiredOption("--schedule <id>", "schedule entity id, 0.0.x")
    .action(async options => {
      await runRelease(options as { mandate: string; schedule: string });
    });

  program
    .command("status")
    .description("Read the public record for a retainer")
    .requiredOption("--schedule <id>", "schedule entity id, 0.0.x")
    .action(async options => {
      await runStatus(options as { schedule: string });
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
 * @returns The retainer configuration
 */
function configure(): RetainerConfig {
  loadEnv({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });
  return loadRetainerConfig();
}

/**
 * Reads a whole positive number from the environment.
 *
 * @param raw - Raw value, possibly absent
 * @param fallback - Value to use when it is absent
 * @param name - Variable name, for the message
 * @returns The number
 * @throws When the value is present but not a whole positive number
 */
function readNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a whole positive number, got "${raw}"`);
  }
  return parsed;
}

/**
 * The network segment HashScan uses in a url.
 *
 * @param network - CAIP-2 network
 * @returns `testnet` or `mainnet`
 */
function shortNetwork(network: string): string {
  return network.endsWith("mainnet") ? "mainnet" : "testnet";
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && pathToFileURL(entryPoint).href === import.meta.url) {
  await main();
}
