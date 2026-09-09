/**
 * MCP server exposing the flow as three tools: `order`, `collect`, `verify`.
 *
 * This is a thin wrapper. It builds nothing itself — the customer agent's own
 * functions place and pay for orders, the verifier's own function checks a
 * receipt — this file only adapts them to the Model Context Protocol so any
 * MCP-speaking agent runtime can drive the exchange without shelling out to
 * the CLI. The x402 payment logic, the envelope signing, the schema
 * validation and the five checks all live where they already did; nothing
 * here re-implements any of them.
 *
 * Every tool answers with a structured result and a matching JSON text block,
 * and every failure is caught and returned as an MCP tool error (`isError:
 * true`) rather than thrown to the transport — a caller should never see this
 * process crash because an order id was malformed or a contractor was
 * unreachable.
 *
 * Run: npm run mcp
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { config as loadEnv } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  buildMandate,
  buildMandateEnvelope,
  parseAcceptedResponse,
  parseDeliveredResponse,
  saveOrderArtifacts,
  saveReceiptArtifact,
  type Story,
} from "../customer/cli.js";
import { createPaidFetch, hashscanTopicUrl, hashscanTransactionUrl, payFor } from "../customer/pay.js";
import { toMirrorTxId } from "../anchor/records.js";
import { loadCustomerConfig, type CustomerConfig } from "../customer/wallet.js";
import { EXIT_OK, verify, type VerifyOutcome, type VerifyRequest } from "../verifier/cli.js";
import type { Anchor } from "../protocol/types.js";

/** Repository root, so `.env` and the schemas README load the same from any cwd. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Everything a tool handler needs, injected so tests never touch the real
 * `.env`, a live contractor, or the public mirror node unless they choose to.
 */
export type ToolDeps = {
  /** Reads the customer's signing and payment identities; env-backed by default. */
  config: () => CustomerConfig;
  /** Checks a receipt against the public record; the real verifier by default. */
  verify: (request: VerifyRequest) => Promise<VerifyOutcome>;
};

/**
 * The default dependencies: `.env` in the repository root, and the live
 * mirror node. This is what `main()` wires up; tests supply their own.
 *
 * @returns Dependencies backed by the environment and the public network
 */
export function liveDeps(): ToolDeps {
  let loaded = false;
  return {
    config: () => {
      if (!loaded) {
        loadEnv({ path: join(ROOT, ".env"), quiet: true });
        loaded = true;
      }
      return loadCustomerConfig();
    },
    verify: request => verify(request),
  };
}

/** A story card, given inline or read from a file — `order`'s only two shapes. */
const StorySchema = z.object({
  story_ref: z.string().describe("Story id in the customer's tracker"),
  story_url: z.string().describe("Link to the card"),
  title: z.string().describe("Card title, verbatim"),
  acceptance: z.array(z.string()).min(1).describe("Acceptance criteria, verbatim, at least one"),
  frame: z.string().describe("Project, epic, target branch, staging — the frame in words"),
  due: z.string().optional().describe("Optional due date"),
});

const OrderInputShape = {
  story: StorySchema.optional().describe(
    "The story card inline. Provide this or `storyPath`, not both.",
  ),
  storyPath: z
    .string()
    .optional()
    .describe("Path to a story card JSON file. Provide this or `story`, not both."),
  to: z.string().optional().describe("Contractor base url; defaults to CONTRACTOR_URL"),
  out: z.string().optional().describe("Directory to write order artifacts into; defaults to CUSTOMER_OUT_DIR"),
};

/**
 * A payment leg as the RECEIPT accounts for it: an amount the counterparty
 * signed for, not merely a transaction id the client happened to see.
 */
const PaymentLegShape = {
  tinybars: z.number().describe("Amount moved, in tinybars"),
  transaction_id: z.string().describe("Facilitator form, 0.0.x@sec.nanos"),
  mirror_transaction_id: z.string().describe("Mirror-node form, 0.0.x-sec-nanos"),
  hashscan_url: z.string().describe("Deep link to the transaction on the public explorer"),
};

/**
 * A settlement as the PAYING CLIENT saw it: a transaction id and a link, with
 * no amount — the `exact` scheme's settlement response does not carry one,
 * and a receipt does not exist yet to ask instead (the base `receipt.v1` an
 * `accepted` acknowledgement carries forbids a `payment` block).
 */
const SettledTransactionShape = {
  transaction_id: z.string().describe("Facilitator form, 0.0.x@sec.nanos"),
  mirror_transaction_id: z.string().describe("Mirror-node form, 0.0.x-sec-nanos"),
  hashscan_url: z.string().describe("Deep link to the transaction on the public explorer"),
};

const OrderOutputShape = {
  mandate_id: z.string(),
  title: z.string(),
  from: z.string().describe("The customer's protocol handle"),
  to: z.string().describe("The contractor's protocol handle"),
  contractor_base: z.string().describe("Base url the order was placed against"),
  intake_payment: z
    .object(SettledTransactionShape)
    .optional()
    .describe("Absent when this mandate_id was already paid for — no new charge, no new anchor"),
  accepted: z.object({
    issuer: z.string(),
    taken: z.array(z.string()).describe("Acceptance criteria the contractor committed to"),
    declined: z
      .array(z.object({ criterion: z.string(), reason: z.string() }))
      .describe("Acceptance criteria the contractor did not take, with reasons"),
  }),
  anchor: z
    .object({ topic: z.string(), hashscan_url: z.string() })
    .optional()
    .describe("The public audit topic the order was anchored to"),
  artifacts: z.object({ mandate: z.string(), accepted: z.string() }),
  next_step: z.string().describe("How to collect this order once it is delivered"),
};

const CollectInputShape = {
  mandateId: z.string().describe("Order id returned by `order`"),
  to: z.string().optional().describe("Contractor base url; defaults to CONTRACTOR_URL"),
  out: z.string().optional().describe("Directory to write the receipt into; defaults to CUSTOMER_OUT_DIR"),
};

const CollectOutputShape = {
  mandate_id: z.string(),
  payments: z
    .object({
      intake: z.object(PaymentLegShape),
      balance: z.object(PaymentLegShape).optional(),
    })
    .describe("Both legs, with amounts, as the signed receipt accounts for them"),
  deliverable: z
    .object({ pr_url: z.string(), staging_url: z.string(), notion_status: z.string() })
    .optional(),
  anchor: z.object({ topic: z.string(), hashscan_url: z.string() }).optional(),
  artifact: z.string().describe("Where the receipt was written"),
};

const VerifyInputShape = {
  topic: z.string().describe("Audit topic the order was anchored to, e.g. 0.0.10426298"),
  receiptPath: z.string().optional().describe("Path to the signed receipt file. Provide this or `receipt`."),
  receipt: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("The signed receipt envelope inline, as JSON. Provide this or `receiptPath`."),
  mandatePath: z
    .string()
    .optional()
    .describe("Path to the signed work-order file, to recompute its fingerprint. Optional."),
  mandate: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("The signed work-order envelope inline, as JSON. Optional; provide at most this or `mandatePath`."),
};

const VerifyOutputShape = {
  verdict: z.enum(["PASS", "FAIL", "ERROR"]).describe(
    "PASS: every check held up. FAIL: the evidence contradicts the receipt. ERROR: the check could not be completed.",
  ),
  exit_code: z.number().describe("0 verified, 1 a check failed, 2 the check could not be completed"),
  checks: z
    .array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() }))
    .describe("Empty when the run never reached a verdict (ERROR before any check ran)"),
  report: z.string().describe("The same report the `verify` CLI prints, statement included"),
};

/**
 * Places an order: signs the mandate, pays the intake fee, stores the
 * acceptance.
 *
 * Every step is the customer agent's own function — this only decides where
 * the story card comes from and shapes the reply.
 *
 * @param args - Tool input, validated against {@link OrderInputShape}
 * @param deps - Injected configuration
 * @returns The MCP tool result
 */
export async function runOrderTool(
  args: { story?: Story; storyPath?: string; to?: string; out?: string },
  deps: ToolDeps,
): Promise<CallToolResult> {
  if ((args.story === undefined) === (args.storyPath === undefined)) {
    return toolError("Provide exactly one of `story` or `storyPath`");
  }

  try {
    const config = deps.config();
    const base = trimSlash(args.to ?? config.contractorUrl);
    const outDir = args.out ?? config.outDir;

    const story = args.storyPath ? loadStoryFile(args.storyPath) : (args.story as Story);
    const mandate = buildMandate(story, { issuer: config.signing.handle });
    const envelope = buildMandateEnvelope(mandate, config.signing);

    const paid = createPaidFetch(config.payment);
    const result = await payFor<unknown>(paid, `${base}/mandates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });

    const accepted = parseAcceptedResponse(result.body, envelope);
    const paths = saveOrderArtifacts(outDir, envelope, accepted);
    const anchor = accepted.data.mandate_anchor;

    return jsonResult({
      mandate_id: mandate.mandate_id,
      title: mandate.title,
      from: envelope.from,
      to: envelope.to,
      contractor_base: base,
      ...(result.transactionId ? { intake_payment: paymentLeg(result, config.payment.network) } : {}),
      accepted: {
        issuer: accepted.data.issuer,
        taken: accepted.data.taken,
        declined: accepted.data.declined ?? [],
      },
      ...(anchorLink(anchor, config)),
      artifacts: { mandate: paths.mandate, accepted: paths.accepted },
      next_step: `collect ${mandate.mandate_id} once the contractor has delivered`,
    });
  } catch (error) {
    return toolError(describeError(error));
  }
}

/**
 * Collects a finished order: pays the balance, stores the receipt.
 *
 * @param args - Tool input, validated against {@link CollectInputShape}
 * @param deps - Injected configuration
 * @returns The MCP tool result
 */
export async function runCollectTool(
  args: { mandateId: string; to?: string; out?: string },
  deps: ToolDeps,
): Promise<CallToolResult> {
  try {
    const config = deps.config();
    const base = trimSlash(args.to ?? config.contractorUrl);
    const outDir = args.out ?? config.outDir;

    const paid = createPaidFetch(config.payment);
    const result = await payFor<unknown>(
      paid,
      `${base}/mandates/${args.mandateId}/receipt`,
      { method: "GET" },
      { allowUnpaid: true },
    );

    const receiptEnvelope = parseDeliveredResponse(result.body, args.mandateId);
    const receipt = receiptEnvelope.data;
    const artifact = saveReceiptArtifact(outDir, args.mandateId, receiptEnvelope);
    const anchor = receipt.mandate_anchor;

    return jsonResult({
      mandate_id: args.mandateId,
      payments: {
        intake: paymentLegFromReceipt(receipt.payment.intake, config.payment.network),
        ...(receipt.payment.balance
          ? { balance: paymentLegFromReceipt(receipt.payment.balance, config.payment.network) }
          : {}),
      },
      ...(receipt.result ? { deliverable: receipt.result } : {}),
      ...(anchorLink(anchor, config)),
      artifact,
    });
  } catch (error) {
    return toolError(describeError(error));
  }
}

/**
 * Runs the verifier on a receipt file or a receipt given as JSON.
 *
 * The public-record read is exactly {@link verify} from `verifier/cli.ts` —
 * live by default, and injectable for tests. Inline JSON is written to a
 * scratch file so the same, fully-tested loading and validation path runs for
 * both shapes rather than a second one written here.
 *
 * @param args - Tool input, validated against {@link VerifyInputShape}
 * @param deps - Injected configuration
 * @returns The MCP tool result
 */
export async function runVerifyTool(
  args: {
    topic: string;
    receiptPath?: string;
    receipt?: unknown;
    mandatePath?: string;
    mandate?: unknown;
  },
  deps: ToolDeps,
): Promise<CallToolResult> {
  if ((args.receiptPath === undefined) === (args.receipt === undefined)) {
    return toolError("Provide exactly one of `receiptPath` or `receipt`");
  }
  if (args.mandatePath !== undefined && args.mandate !== undefined) {
    return toolError("Provide at most one of `mandatePath` or `mandate`");
  }

  let scratch: string | undefined;
  try {
    scratch =
      args.receipt !== undefined || args.mandate !== undefined
        ? await mkdtemp(join(tmpdir(), "x402-wr-verify-"))
        : undefined;
    const receiptPath = args.receiptPath ?? (await writeScratch(scratch!, "receipt.json", args.receipt));
    const mandatePath =
      args.mandatePath ?? (args.mandate !== undefined ? await writeScratch(scratch!, "mandate.json", args.mandate) : undefined);

    const outcome = await deps.verify({ topicId: args.topic, receiptPath, mandatePath });
    const verdict = outcome.code === EXIT_OK ? "PASS" : outcome.checks.length > 0 ? "FAIL" : "ERROR";

    return jsonResult({
      verdict,
      exit_code: outcome.code,
      checks: outcome.checks,
      report: outcome.output,
    });
  } catch (error) {
    return toolError(describeError(error));
  } finally {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

/**
 * Builds the MCP server and registers the three tools.
 *
 * @param deps - Dependencies the tools run against; {@link liveDeps} by default
 * @returns The server, not yet connected to a transport
 */
export function createMcpServer(deps: ToolDeps = liveDeps()): McpServer {
  const server = new McpServer({ name: "x402-work-receipts", version: "0.0.1" });

  server.registerTool(
    "order",
    {
      title: "Place a work order",
      description:
        "Sign a mandate.v1 work order, pay the contractor's x402 intake fee on Hedera testnet, " +
        "and store the signed acceptance. Provide the story either inline (`story`) or as a file " +
        "path (`storyPath`).",
      inputSchema: OrderInputShape,
      outputSchema: OrderOutputShape,
    },
    args => runOrderTool(args as { story?: Story; storyPath?: string; to?: string; out?: string }, deps),
  );

  server.registerTool(
    "collect",
    {
      title: "Collect a delivered order",
      description:
        "Pay the x402 balance for a mandate that has been delivered and store the signed " +
        "receipt.v1+payment.v1. Returns 409-shaped guidance (via a tool error) if the contractor " +
        "has not delivered yet.",
      inputSchema: CollectInputShape,
      outputSchema: CollectOutputShape,
    },
    args => runCollectTool(args as { mandateId: string; to?: string; out?: string }, deps),
  );

  server.registerTool(
    "verify",
    {
      title: "Verify a receipt against the public record",
      description:
        "Reconstruct one work order from the public Hedera mirror node and check a receipt " +
        "against it: signature, mandate linkage, anchor sequence, both payments, and the receipt's " +
        "own anchor. Talks to nobody but the mirror node.",
      inputSchema: VerifyInputShape,
      outputSchema: VerifyOutputShape,
    },
    args =>
      runVerifyTool(
        args as {
          topic: string;
          receiptPath?: string;
          receipt?: unknown;
          mandatePath?: string;
          mandate?: unknown;
        },
        deps,
      ),
  );

  return server;
}

/**
 * Reads and parses a story card from disk without the CLI's cwd-relative
 * resolution — an MCP client sends an absolute or its own relative path, and
 * this process's cwd is whatever launched it, not the caller's.
 *
 * @param path - Path to the story JSON
 * @returns The story
 * @throws When the file cannot be read or parsed, or is not a story object
 */
function loadStoryFile(path: string): Story {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
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
 * A settled transaction as the paying client saw it — an id and a link, with
 * no amount (see {@link SettledTransactionShape} for why).
 *
 * @param result - The paid call's result
 * @param network - Network it settled on, for the explorer link
 * @returns The transaction, or throws if the caller did not check `transactionId` first
 */
function paymentLeg(
  result: { transactionId?: string; mirrorTransactionId?: string; hashscanUrl?: string },
  network: CustomerConfig["payment"]["network"],
): { transaction_id: string; mirror_transaction_id: string; hashscan_url: string } {
  const transactionId = result.transactionId;
  if (!transactionId) {
    throw new Error("paymentLeg called without a settled transaction");
  }
  return {
    transaction_id: transactionId,
    mirror_transaction_id: result.mirrorTransactionId ?? toMirrorTxId(transactionId),
    hashscan_url: result.hashscanUrl ?? hashscanTransactionUrl(transactionId, network),
  };
}

/**
 * One payment leg as the receipt itself accounts for it — amount included,
 * because the signed `payment.v1` profile is the source of truth for it, not
 * a client's own record of what it sent.
 *
 * @param leg - The leg from `receipt.payment`
 * @param network - Network it settled on, for the explorer link
 * @returns The leg
 */
function paymentLegFromReceipt(
  leg: { tinybars: number; transaction_id: string },
  network: CustomerConfig["payment"]["network"],
): { tinybars: number; transaction_id: string; mirror_transaction_id: string; hashscan_url: string } {
  return {
    tinybars: leg.tinybars,
    transaction_id: leg.transaction_id,
    mirror_transaction_id: toMirrorTxId(leg.transaction_id),
    hashscan_url: hashscanTransactionUrl(leg.transaction_id, network),
  };
}

/**
 * The anchor topic as a link, when the receipt names one.
 *
 * @param anchor - Anchor pointer from the receipt
 * @param config - Customer configuration, for the network
 * @returns `{ anchor: {...} }`, or `{}` when there is no topic to link
 */
function anchorLink(
  anchor: Anchor | undefined,
  config: CustomerConfig,
): { anchor: { topic: string; hashscan_url: string } } | Record<string, never> {
  if (!anchor?.topic) {
    return {};
  }
  return { anchor: { topic: anchor.topic, hashscan_url: hashscanTopicUrl(anchor.topic, config.payment.network) } };
}

/**
 * Writes one piece of inline JSON to a scratch file, so it can be handed to
 * {@link verify} the same way a file path would be.
 *
 * @param dir - Scratch directory, already created
 * @param name - File name within it
 * @param value - The JSON value to write
 * @returns The path written
 */
async function writeScratch(dir: string, name: string, value: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
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

/**
 * Builds a successful tool result carrying both a JSON text block and
 * structured content, so a client can read either.
 *
 * @param value - The structured payload; must match the tool's `outputSchema`
 * @returns The tool result
 */
function jsonResult(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

/**
 * Builds a tool error — never thrown to the transport, always a normal
 * result with `isError: true`, so a caller sees why the call did not
 * complete instead of the process going down.
 *
 * @param message - What went wrong
 * @returns The tool error result
 */
function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Renders an unknown thrown value as a message — a schema violation, a
 * network failure, a bad receipt file, whatever it was, in one line a caller
 * can act on.
 *
 * @param error - The thrown value
 * @returns Its message, or its string form
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Entry point: connects the server to stdio, the transport any MCP client
 * (Claude Code included) speaks by default.
 */
async function main(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

/**
 * True when this file was started directly rather than imported.
 *
 * @returns Whether the module is the process entry point
 */
function isEntryPoint(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isEntryPoint()) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
