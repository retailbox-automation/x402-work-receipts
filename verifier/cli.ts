/**
 * `verify` — reconstruct one order from public data alone.
 *
 * Given a topic id and a receipt file, the command reads the Hedera mirror node
 * and answers whether the receipt is what the ledger says it is. It talks to
 * nobody else: not the contractor that issued the receipt, not the customer
 * that paid for it. That is the whole point — a stranger with this repository,
 * a topic id and a receipt can reach the same verdict as either party.
 *
 * Exit codes are three, not two, because "the receipt does not check out" and
 * "I could not look" must never arrive as the same answer:
 *
 * | code | meaning |
 * |---|---|
 * | 0 | every check passed |
 * | 1 | at least one check failed — the evidence contradicts the receipt |
 * | 2 | the check could not be completed: unreadable input, or the mirror node |
 */
import { readFileSync } from "node:fs";
import { Command } from "commander";
import type { AnchorEntry } from "../anchor/records.js";
import { validatePaymentReceipt } from "../protocol/schemas.js";
import type { Envelope, Mandate, PaymentReceipt } from "../protocol/types.js";
import {
  type CheckResult,
  anchorsForMandate,
  paymentTransactionIds,
  runChecks,
} from "./checks.js";
import {
  type AnchorReader,
  type MirrorTransaction,
  type ScheduleReader,
  type TransactionReader,
  liveMirror,
} from "./mirror.js";
import { type RetainerEvidence, retainerLookups } from "./retainer.js";
import { renderStatement } from "./statement.js";

/** Every check passed. */
export const EXIT_OK = 0;

/** At least one check failed. */
export const EXIT_FAILED = 1;

/** The check could not be completed. */
export const EXIT_ERROR = 2;

/** Width the report is wrapped to. */
const REPORT_WIDTH = 88;

/** What to verify. */
export type VerifyRequest = {
  topicId: string;
  receiptPath: string;
  mandatePath?: string;
};

/**
 * The reads the command makes; injected so tests run offline.
 *
 * The two schedule readers are optional because most orders have no retainer
 * and nothing asks for them. When an order *does* anchor one and no reader was
 * supplied, the retainer check says so rather than passing quietly.
 */
export type VerifyDeps = {
  readAnchors: AnchorReader;
  readTransaction: TransactionReader;
  readSchedule?: ScheduleReader;
  readScheduledTransaction?: TransactionReader;
};

/** The outcome of one run. */
export type VerifyOutcome = {
  code: number;
  checks: CheckResult[];
  output: string;
};

/** Reading the real, public mirror node. */
export const liveDeps: VerifyDeps = liveMirror;

/** A file that could not be read or is not the document it should be. */
class InputError extends Error {}

/**
 * Verifies one receipt against the public record.
 *
 * @param request - Topic, receipt file and optional work-order file
 * @param deps - Mirror readers; the live ones by default
 * @returns Exit code, the individual verdicts and the printable report
 */
export async function verify(
  request: VerifyRequest,
  deps: VerifyDeps = liveDeps,
): Promise<VerifyOutcome> {
  let receipt: Envelope<PaymentReceipt>;
  try {
    receipt = loadReceipt(request.receiptPath);
  } catch (error) {
    return errorOutcome(`Could not read the receipt: ${describe(error)}`);
  }

  // Kept apart from the receipt so a bad work-order file is not reported as a
  // bad receipt: the two are supplied separately and fail for different reasons.
  let mandate: Envelope<Mandate> | undefined;
  try {
    mandate = request.mandatePath ? loadMandate(request.mandatePath) : undefined;
  } catch (error) {
    return errorOutcome(`Could not read the work order: ${describe(error)}`);
  }

  let anchors;
  let retainer: RetainerEvidence | undefined;
  const transactions = new Map<string, MirrorTransaction | null>();
  try {
    anchors = await deps.readAnchors(request.topicId);
    for (const transactionId of paymentTransactionIds(receipt)) {
      transactions.set(transactionId, await deps.readTransaction(transactionId));
    }
    retainer = await readRetainer(deps, anchors, receipt.data.mandate_id);
  } catch (error) {
    // Every failure here is "I could not look", whatever its type: a mirror
    // read that did not complete says nothing about the receipt.
    return errorOutcome(`Could not read the public record: ${describe(error)}`);
  }

  const checks = runChecks({
    topicId: request.topicId,
    receipt,
    mandate,
    anchors,
    transactions,
    retainer,
  });
  const passed = checks.every(check => check.ok);

  return {
    code: passed ? EXIT_OK : EXIT_FAILED,
    checks,
    output: report(request, receipt, checks, passed),
  };
}

/**
 * Reads a signed delivery receipt from disk.
 *
 * @param path - Path to the receipt file
 * @returns The envelope
 * @throws {InputError} When the file is missing, unparsable or not a receipt
 */
export function loadReceipt(path: string): Envelope<PaymentReceipt> {
  const envelope = loadEnvelope(path);
  if (envelope.schema !== "receipt.v1+payment.v1") {
    throw new InputError(
      `${path} is a "${envelope.schema}" envelope; verification needs a receipt.v1+payment.v1 receipt`,
    );
  }
  try {
    validatePaymentReceipt(envelope.data);
  } catch (error) {
    throw new InputError(`${path} is not a valid receipt: ${describe(error)}`);
  }
  return envelope as Envelope<PaymentReceipt>;
}

/**
 * Reads a signed work order from disk.
 *
 * @param path - Path to the mandate file
 * @returns The envelope
 * @throws {InputError} When the file is missing, unparsable or not a mandate
 */
export function loadMandate(path: string): Envelope<Mandate> {
  const envelope = loadEnvelope(path);
  if (envelope.schema !== "mandate.v1") {
    throw new InputError(`${path} is a "${envelope.schema}" envelope, not a mandate.v1 work order`);
  }
  return envelope as Envelope<Mandate>;
}

/**
 * Renders the verdicts as a table.
 *
 * A check with nothing to decide prints `N/A`, never `PASS`: the reader is
 * being told what the evidence establishes, and "the document made no such
 * claim" is not the same statement as "the claim holds".
 *
 * @param results - One entry per check
 * @returns The table, without a trailing newline
 */
export function renderTable(results: CheckResult[]): string {
  const width = Math.max(...results.map(result => result.name.length), 5);
  const lines = [`${"".padEnd(6)}${"check".padEnd(width)}  detail`];
  for (const result of results) {
    const status = result.applicable === false ? "N/A" : result.ok ? "PASS" : "FAIL";
    lines.push(`${status.padEnd(6)}${result.name.padEnd(width)}  ${result.detail}`);
  }
  return lines.join("\n");
}

/**
 * Builds the command-line program.
 *
 * @returns A commander program that throws rather than exiting on bad usage
 */
export function buildProgram(): Command {
  return new Command()
    .name("verify")
    .description(
      "Reconstruct one work order from the public Hedera mirror node and check a receipt against it",
    )
    .requiredOption("--topic <id>", "audit topic the order was anchored to, e.g. 0.0.10426298")
    .requiredOption("--receipt <path>", "path to the signed delivery receipt")
    .option("--mandate <path>", "path to the signed work order, to recompute its fingerprint")
    .exitOverride();
}

/**
 * Entry point: parse, verify, print, set the exit code.
 *
 * @param argv - Process arguments
 */
export async function main(argv: string[] = process.argv): Promise<void> {
  let request: VerifyRequest;
  try {
    const program = buildProgram();
    program.parse(argv);
    const options = program.opts<{ topic: string; receipt: string; mandate?: string }>();
    request = {
      topicId: options.topic,
      receiptPath: options.receipt,
      mandatePath: options.mandate,
    };
  } catch (error) {
    // Commander prints its own message for `--help` and for bad usage; anything
    // that stops us before a check has run is "could not look", not "failed".
    process.exitCode = isHelpRequest(error) ? EXIT_OK : EXIT_ERROR;
    return;
  }

  const outcome = await verify(request);
  console.log(outcome.output);
  process.exitCode = outcome.code;
}

/**
 * Reads the schedule and the transfer an order's retainer anchors point at.
 *
 * Nothing is fetched for the common case of an order without a retainer, and
 * nothing is fetched when the caller supplied no schedule readers — an offline
 * test injects only the two it needs.
 *
 * @param deps - The injected mirror readers
 * @param anchors - Every anchor on the topic
 * @param mandateId - The order being verified
 * @returns The evidence, or undefined when there is no retainer to resolve
 */
async function readRetainer(
  deps: VerifyDeps,
  anchors: AnchorEntry[],
  mandateId: string,
): Promise<RetainerEvidence | undefined> {
  const { scheduleId, releaseTransactionId } = retainerLookups(
    anchorsForMandate(anchors, mandateId),
  );
  if (!scheduleId && !releaseTransactionId) {
    return undefined;
  }
  if (!deps.readSchedule || !deps.readScheduledTransaction) {
    return undefined;
  }
  return {
    schedule: scheduleId ? await deps.readSchedule(scheduleId) : null,
    release: releaseTransactionId ? await deps.readScheduledTransaction(releaseTransactionId) : null,
  };
}

/**
 * Reads and parses any signed envelope.
 *
 * @param path - Path to the file
 * @returns The envelope
 * @throws {InputError} When the file is missing, unparsable or not an envelope
 */
function loadEnvelope(path: string): Envelope<unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new InputError(`cannot open ${path} (${describe(error)})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new InputError(`${path} is not JSON (${describe(error)})`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InputError(`${path} does not hold a signed envelope`);
  }
  const envelope = parsed as Partial<Envelope<unknown>>;
  if (typeof envelope.schema !== "string" || envelope.data === undefined || !envelope.sig) {
    throw new InputError(`${path} does not hold a signed envelope`);
  }
  return envelope as Envelope<unknown>;
}

/**
 * The printable report: what was checked, the verdicts, then the statement.
 *
 * @param request - What was asked for
 * @param receipt - The receipt under examination
 * @param checks - The verdicts
 * @param passed - Whether every check passed
 * @returns The report
 */
function report(
  request: VerifyRequest,
  receipt: Envelope<PaymentReceipt>,
  checks: CheckResult[],
  passed: boolean,
): string {
  const rule = "─".repeat(REPORT_WIDTH);
  const failed = checks.filter(check => !check.ok);
  const skipped = checks.filter(check => check.applicable === false);
  const ran = checks.length - skipped.length;
  const aside =
    skipped.length === 0
      ? ""
      : ` ${skipped.length} had nothing to check: ${skipped.map(check => check.name).join(", ")}.`;
  const verdict = passed
    ? `VERIFIED — all ${ran} applicable checks passed against the public record.${aside}`
    : `NOT VERIFIED — ${failed.length} of ${ran} checks failed: ${failed
        .map(check => check.name)
        .join(", ")}.${aside}`;

  return [
    `order   ${receipt.data.mandate_id}`,
    `receipt ${receipt.data.receipt_id} (${receipt.data.kind}, issued by ${receipt.data.issuer})`,
    `topic   ${request.topicId}`,
    `source  ${MIRROR_LABEL}`,
    "",
    renderTable(checks),
    "",
    rule,
    verdict,
    rule,
    renderStatement(REPORT_WIDTH),
  ].join("\n");
}

/** Named in the report so the reader knows exactly what was consulted. */
const MIRROR_LABEL = "https://testnet.mirrornode.hedera.com/api/v1 (public mirror node only)";

/**
 * Builds the outcome for a run that never got as far as a verdict.
 *
 * @param message - What stopped it
 * @returns Outcome with the error exit code
 */
function errorOutcome(message: string): VerifyOutcome {
  return { code: EXIT_ERROR, checks: [], output: message };
}

/**
 * Whether a commander error was just `--help`.
 *
 * @param error - The thrown value
 * @returns True for help and version output
 */
function isHelpRequest(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return code === "commander.helpDisplayed" || code === "commander.help" || code === "commander.version";
}

/**
 * Renders an unknown thrown value as a short string.
 *
 * @param error - The thrown value
 * @returns Its message, or its string form
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// `tsx verifier/cli.ts` runs the command; importing the module does not.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
