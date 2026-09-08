/**
 * The deliverable.
 *
 * In a production contractor this module would ask the pipeline what it built.
 * For the demo it derives links from the mandate id, deterministically: the
 * same order always produces the same links, so a run can be replayed and a
 * recorded demo keeps matching what the code does. Nothing here pretends to be
 * real work — the links point at `example.com` hosts on purpose.
 *
 * The links end up inside a signed receipt, so they are checked here rather
 * than discovered to be invalid two paid calls later.
 */
import { canonicalize, sha256Hex } from "../protocol/canonical.js";
import type { ReceiptResult } from "../protocol/types.js";

/** Fields a contractor may supply when its own pipeline produced the work. */
export const DELIVERY_FIELDS = ["pr_url", "staging_url", "notion_status"] as const;

/** Synthetic hosts for the demo; both parties are fictional (Agency X, Client Y). */
const REVIEW_HOST = "https://git.example.com/agency-x/client-y-web/-/merge_requests";
const STAGING_HOST = "https://staging.example-client.app/preview";

/** Story status the customer's tracker moves to after a delivery. */
const DEFAULT_STATUS = "Testing";

/**
 * Builds the deliverable links for one mandate.
 *
 * @param mandateId - Mandate the work belongs to
 * @param overrides - Links supplied by the contractor's own pipeline
 * @returns The result block of a `delivered` receipt
 */
export function synthesizeResult(
  mandateId: string,
  overrides: Partial<ReceiptResult> = {},
): ReceiptResult {
  const digest = sha256Hex(`work:${mandateId}`);
  // A three-digit merge-request number and a short slug: recognisably synthetic,
  // stable for a given mandate, and different for different mandates.
  const mergeRequest = 100 + (Number.parseInt(digest.slice(0, 6), 16) % 900);
  const result: ReceiptResult = {
    pr_url: `${REVIEW_HOST}/${mergeRequest}`,
    staging_url: `${STAGING_HOST}/${digest.slice(0, 7)}`,
    notion_status: DEFAULT_STATUS,
    ...overrides,
  };
  assertDeliverableLinks(result);
  return result;
}

/**
 * Reads the optional body of the delivery route.
 *
 * Unknown fields are refused rather than ignored: a typo in `staging_url` that
 * is silently dropped would put a synthetic link into a signed receipt while
 * the caller believes it sent a real one.
 *
 * @param body - Parsed request body
 * @returns The supplied links, possibly empty
 * @throws When the body is not an object of known string fields
 */
export function parseDeliveryRequest(body: unknown): Partial<ReceiptResult> {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("Delivery body must be a JSON object");
  }

  const supplied: Partial<ReceiptResult> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!(DELIVERY_FIELDS as readonly string[]).includes(key)) {
      throw new TypeError(`Unexpected field "${key}" in the delivery body`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(`Field "${key}" must be a non-empty string`);
    }
    supplied[key as (typeof DELIVERY_FIELDS)[number]] = value;
  }
  return supplied;
}

/**
 * Throws unless the links can go into a `receipt.v1` result.
 *
 * The receipt schema is the real gate; this check exists so a bad link is
 * refused at delivery time, by the contractor, instead of at collection time,
 * after the customer has paid the balance.
 *
 * @param result - Candidate result block
 */
export function assertDeliverableLinks(result: ReceiptResult): void {
  for (const field of ["pr_url", "staging_url"] as const) {
    const value = result[field];
    if (!value.startsWith("https://") || value.length > 2048 || !isUrl(value)) {
      throw new TypeError(`Field "${field}" must be an https URL`);
    }
  }
  if (result.notion_status.trim() === "" || result.notion_status.length > 64) {
    throw new TypeError('Field "notion_status" must be 1 to 64 characters');
  }
}

/**
 * Canonical hash of a delivery, anchored under the `delivered` kind.
 *
 * @param result - The delivered links
 * @returns Lowercase sha-256 hex
 */
export function deliveryHash(result: ReceiptResult): string {
  return sha256Hex(canonicalize(result));
}

/**
 * Reports whether a string parses as a URL.
 *
 * @param value - Candidate URL
 * @returns True when it parses
 */
function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
