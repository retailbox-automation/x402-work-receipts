/**
 * Creating the retainer: the customer authorises a transfer before the work
 * exists, and the ledger holds it.
 *
 * The mechanism is a Hedera Scheduled Transaction wrapping an ordinary HBAR
 * transfer from the customer to the contractor. Two things make it a retainer
 * rather than a payment:
 *
 * 1. The customer signs the `ScheduleCreate`, and that signature counts as the
 *    sender's signature on the inner transfer. The authorisation is fixed on
 *    the ledger, in public, before anybody has done any work.
 * 2. The contractor is named as the scheduled transaction's payer account, and
 *    a scheduled transaction does not execute until its payer has signed. That
 *    is what leaves the release in the contractor's hands: nothing moves until
 *    the contractor submits a `ScheduleSign`, and when it does, the contractor
 *    pays the fee for collecting.
 *
 * Verified on testnet before this module was written: after the create, the
 * mirror node reports one signature and `executed_timestamp: null`; after the
 * contractor's sign, two signatures and an execution timestamp.
 *
 * Nothing here can spend the customer's money by itself — the schedule expires
 * on its own if the contractor never releases it, and the customer keeps the
 * balance.
 */
import {
  AccountId,
  type Client,
  Hbar,
  ScheduleCreateTransaction,
  Timestamp,
  TransferTransaction,
} from "@hiero-ledger/sdk";

/** Shortest retainer window worth creating; below this the contractor cannot realistically release. */
export const MIN_EXPIRY_SECONDS = 60;

/** The network's own ceiling on a scheduled transaction: 62 days. */
export const MAX_EXPIRY_SECONDS = 5_356_800;

/** Window used when the caller names none: half an hour, the classic schedule lifetime. */
export const DEFAULT_EXPIRY_SECONDS = 1_800;

/** What to hold, for whom, and for how long. */
export type RetainerRequest = {
  /** Customer account the transfer will debit; must be the client's operator. */
  customerId: string;
  /** Contractor account it will credit, and which must sign to release it. */
  contractorId: string;
  /** Amount to hold, in tinybars. */
  tinybars: number;
  /** Public schedule memo, at most 100 bytes. */
  memo?: string;
  /** Seconds from now until the authorisation lapses. */
  expiresInSeconds?: number;
};

/** The authorisation, as the ledger now holds it. */
export type ScheduledRetainer = {
  /** Schedule entity id, `0.0.x` — what the contractor signs and the verifier reads. */
  scheduleId: string;
  /** Id the inner transfer will carry when it runs, mirror form. */
  scheduledTransactionId: string;
  /** The `ScheduleCreate` itself, mirror form. */
  createTransactionId: string;
  /** When the authorisation lapses, as `seconds.nanoseconds`. */
  expiresAt: string;
};

/**
 * Creates the retainer.
 *
 * @param client - Hedera client whose **operator is the customer**; its signature is the authorisation
 * @param request - Who, how much, how long
 * @returns The schedule and the transaction ids around it
 * @throws RangeError when the amount or the window is out of bounds
 */
export async function scheduleRetainer(
  client: Client,
  request: RetainerRequest,
): Promise<ScheduledRetainer> {
  const tinybars = assertAmount(request.tinybars);
  const seconds = assertWindow(request.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS);

  const customer = AccountId.fromString(request.customerId);
  const contractor = AccountId.fromString(request.contractorId);
  const amount = Hbar.fromTinybars(tinybars);

  const transfer = new TransferTransaction()
    .addHbarTransfer(customer, amount.negated())
    .addHbarTransfer(contractor, amount);

  // Seconds only: the expiry is a wall-clock deadline a human reads off
  // HashScan, and nanosecond precision on it would be false precision.
  const expiry = new Timestamp(Math.floor(Date.now() / 1000) + seconds, 0);

  const create = new ScheduleCreateTransaction()
    .setScheduledTransaction(transfer)
    .setPayerAccountId(contractor)
    .setExpirationTime(expiry)
    // False, not true: the retainer should move the moment the contractor
    // releases it. Waiting for expiry would pay out on a timer instead, which
    // is the opposite of "released after delivery".
    .setWaitForExpiry(false)
    .setScheduleMemo(assertMemo(request.memo ?? "x402-work-receipts retainer"));

  const response = await create.execute(client);
  const receipt = await response.getReceipt(client);

  if (!receipt.scheduleId || !receipt.scheduledTransactionId) {
    throw new Error("ScheduleCreate receipt carried no schedule id");
  }

  return {
    scheduleId: receipt.scheduleId.toString(),
    scheduledTransactionId: receipt.scheduledTransactionId.toString(),
    createTransactionId: response.transactionId.toString(),
    expiresAt: `${expiry.seconds.toString()}.${expiry.nanos.toString().padStart(9, "0")}`,
  };
}

/**
 * Rejects an amount the ledger or the customer would not accept.
 *
 * @param tinybars - Candidate amount
 * @returns The amount
 * @throws RangeError when it is not a whole positive number of tinybars
 */
function assertAmount(tinybars: number): number {
  if (!Number.isSafeInteger(tinybars) || tinybars <= 0) {
    throw new RangeError(`A retainer must be a whole positive number of tinybars, got ${tinybars}`);
  }
  return tinybars;
}

/**
 * Rejects a window outside what the network allows.
 *
 * @param seconds - Candidate window
 * @returns The window
 * @throws RangeError when it is too short or beyond the network's 62-day ceiling
 */
function assertWindow(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds < MIN_EXPIRY_SECONDS || seconds > MAX_EXPIRY_SECONDS) {
    throw new RangeError(
      `A retainer window must be between ${MIN_EXPIRY_SECONDS} and ${MAX_EXPIRY_SECONDS} seconds, got ${seconds}`,
    );
  }
  return seconds;
}

/**
 * Rejects a memo the network would truncate or refuse.
 *
 * @param memo - Candidate memo
 * @returns The memo
 * @throws RangeError when it is longer than 100 bytes
 */
function assertMemo(memo: string): string {
  if (Buffer.byteLength(memo, "utf8") > 100) {
    throw new RangeError("A schedule memo is at most 100 bytes");
  }
  return memo;
}
