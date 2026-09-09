/**
 * Releasing the retainer: the contractor signs, and only then does the money
 * move.
 *
 * The contractor adds the one signature the scheduled transfer is still missing
 * — its own, as the scheduled transaction's payer — and the network executes
 * the transfer immediately. The contractor cannot change the amount, the
 * recipient or anything else about it: those were fixed by the customer when
 * the schedule was created, and a `ScheduleSign` carries nothing but a
 * signature.
 *
 * Reading back is done through the public mirror node, deliberately with the
 * same reader the verifier uses, so "released" means the same thing to the
 * contractor and to a stranger.
 */
import { type Client, ScheduleId, ScheduleSignTransaction } from "@hiero-ledger/sdk";
import {
  type MirrorSchedule,
  type MirrorTransaction,
  readSchedule,
  readTransactionAtTimestamp,
} from "../verifier/mirror.js";
import { toMirrorScheduledTxId } from "./records.js";

/** How long to wait for the mirror node to show the execution before giving up. */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;

/** Pause between mirror-node polls while waiting. */
const POLL_MS = 2_000;

/** What the `ScheduleSign` did. */
export type ReleaseResult = {
  scheduleId: string;
  /** Status the network returned for the signature, e.g. `SUCCESS`. */
  status: string;
  /** The `ScheduleSign` transaction itself, mirror form. */
  signTransactionId: string;
};

/** The retainer as the public record now shows it. */
export type RetainerStatus = {
  scheduleId: string;
  /** Null while the schedule is still waiting for the contractor. */
  schedule: MirrorSchedule | null;
  /** The executed transfer, once there is one. */
  transfer: MirrorTransaction | null;
  /** Consensus time of the execution, or null while it is pending. */
  executedAt: string | null;
};

/**
 * Signs a pending retainer as the contractor.
 *
 * @param client - Hedera client whose **operator is the contractor**
 * @param scheduleId - Schedule entity id, `0.0.x`
 * @returns What the network said
 * @throws When the schedule is unknown, already executed, deleted or expired
 */
export async function releaseRetainer(client: Client, scheduleId: string): Promise<ReleaseResult> {
  const response = await new ScheduleSignTransaction()
    .setScheduleId(ScheduleId.fromString(scheduleId))
    .execute(client);
  const receipt = await response.getReceipt(client);

  return {
    scheduleId,
    status: receipt.status.toString(),
    signTransactionId: toMirrorScheduledTxId(response.transactionId.toString()),
  };
}

/**
 * Reads what the public record says about a retainer.
 *
 * The transfer is looked up only once the schedule reports an execution: before
 * that there is no transfer to find, and asking for one would turn "still
 * pending" into "not on the ledger". It is addressed by that execution
 * timestamp rather than by an id, because a schedule does not publish the
 * transaction id of the transfer it runs — the transfer inherits the id of the
 * `ScheduleCreate`, whose own consensus timestamp is a different instant.
 *
 * @param scheduleId - Schedule entity id, `0.0.x`
 * @returns The schedule, the executed transfer if any, and the execution time
 */
export async function retainerStatus(scheduleId: string): Promise<RetainerStatus> {
  const schedule = await readSchedule(scheduleId);
  const executedAt = schedule?.executed_timestamp ?? null;
  const transfer = executedAt ? await readTransactionAtTimestamp(executedAt) : null;
  return { scheduleId, schedule, transfer, executedAt };
}

/**
 * Waits until the mirror node reports the execution.
 *
 * The network executes a released schedule at once, but the mirror node indexes
 * it a second or two later; without this wait the contractor would anchor a
 * release it cannot yet prove.
 *
 * @param scheduleId - Schedule entity id, `0.0.x`
 * @param timeoutMs - How long to keep asking
 * @returns The status, once the transfer is visible
 * @throws When the transfer is still not visible when the time runs out
 */
export async function waitForExecution(
  scheduleId: string,
  timeoutMs: number = DEFAULT_EXECUTION_TIMEOUT_MS,
): Promise<RetainerStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await retainerStatus(scheduleId);
    if (status.executedAt && status.transfer) {
      return status;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `The mirror node still shows no executed transfer for schedule ${scheduleId} after ${Math.round(timeoutMs / 1000)} s`,
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * Waits.
 *
 * @param ms - Milliseconds to wait
 * @returns A promise resolving after the delay
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
