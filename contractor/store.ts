/**
 * The contractor's job store.
 *
 * A work order is accepted in one HTTP request and its receipt released in
 * another — possibly days later, across a restart. Everything needed to issue
 * that second receipt lives here: the mandate exactly as it arrived (so its
 * hash still matches), where it is anchored, and the payment legs settled so
 * far.
 *
 * A JSON file is enough for a service that handles one order at a time in a
 * demo, and it is readable during a run, which a database would not be. Writes
 * go through a temporary file and a rename so a crash mid-write cannot leave a
 * half-written store behind.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Anchor,
  Envelope,
  Mandate,
  Payment,
  PaymentReceipt,
  Receipt,
  ReceiptResult,
} from "../protocol/types.js";

/** Version tag of the store file, checked on open. */
export const STORE_VERSION = "contractor-jobs.v1";

/** One work order and everything proven about it so far. */
export type Job = {
  mandate_id: string;
  /** Envelope thread the exchange runs in; every receipt stays inside it. */
  thread_id: string;
  /** Customer handle, from the mandate envelope's `from`. */
  customer: string;
  /** Contractor handle, from this service's configuration. */
  contractor: string;
  /** The mandate envelope exactly as received; re-hashing it must still match. */
  mandate: Envelope<Mandate>;
  mandate_envelope_hash: string;
  mandate_anchor: Anchor;
  accepted_receipt: Envelope<Receipt>;
  /** Settled payments; `balance` appears when the receipt is collected. */
  payment: Payment;
  /** Delivered links; absent until the contractor marks the order delivered. */
  result?: ReceiptResult;
  delivered_anchor?: Anchor;
  /** The delivery receipt, kept so a repeat collection returns the same bytes. */
  receipt?: Envelope<PaymentReceipt>;
  receipt_anchor?: Anchor;
  created_at: string;
  updated_at: string;
};

/** On-disk shape. */
type StoreFile = {
  v: typeof STORE_VERSION;
  jobs: Record<string, Job>;
};

/**
 * A file-backed map of mandate id to job.
 */
export class JobStore {
  private readonly jobs: Map<string, Job>;

  /**
   * @param path - File the store is persisted to
   * @param jobs - Jobs loaded from that file
   * @param now - Clock, injectable so tests can pin timestamps
   */
  private constructor(
    readonly path: string,
    jobs: Map<string, Job>,
    private readonly now: () => string,
  ) {
    this.jobs = jobs;
  }

  /**
   * Opens a store, creating an empty one when the file does not exist.
   *
   * A file that exists but is not a store is an error rather than something to
   * overwrite: the path is configurable, and a typo must not silently destroy
   * whatever it points at.
   *
   * @param path - File to read and write
   * @param now - Clock returning an ISO timestamp
   * @returns The store
   * @throws When the file exists but is not a `contractor-jobs.v1` store
   */
  static open(path: string, now: () => string = () => new Date().toISOString()): JobStore {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new JobStore(path, new Map(), now);
      }
      throw error;
    }

    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    if (parsed.v !== STORE_VERSION || typeof parsed.jobs !== "object" || parsed.jobs === null) {
      throw new Error(`${path} is not a ${STORE_VERSION} store`);
    }
    return new JobStore(path, new Map(Object.entries(parsed.jobs as Record<string, Job>)), now);
  }

  /**
   * Reads one job.
   *
   * @param mandateId - Mandate id
   * @returns The job, or undefined
   */
  get(mandateId: string): Job | undefined {
    return this.jobs.get(mandateId);
  }

  /**
   * Reports whether a mandate is already known.
   *
   * @param mandateId - Mandate id
   * @returns True when the store holds it
   */
  has(mandateId: string): boolean {
    return this.jobs.has(mandateId);
  }

  /**
   * Writes a job, stamping `updated_at`.
   *
   * @param job - The job to write
   * @returns The job as persisted
   */
  put(job: Job): Job {
    const stamped: Job = { ...job, updated_at: this.now() };
    this.jobs.set(stamped.mandate_id, stamped);
    this.flush();
    return stamped;
  }

  /**
   * Applies a change to an existing job.
   *
   * @param mandateId - Mandate id
   * @param mutate - Returns the new job from the current one
   * @returns The job as persisted
   * @throws When the mandate is unknown
   */
  update(mandateId: string, mutate: (job: Job) => Job): Job {
    const current = this.jobs.get(mandateId);
    if (!current) {
      throw new Error(`No job for mandate ${mandateId}`);
    }
    return this.put(mutate(current));
  }

  /**
   * All jobs, in insertion order.
   *
   * @returns The jobs
   */
  list(): Job[] {
    return [...this.jobs.values()];
  }

  /**
   * Writes the whole store atomically.
   *
   * The temporary file sits in the destination directory so the rename stays
   * within one filesystem, where it is atomic.
   */
  private flush(): void {
    const file: StoreFile = { v: STORE_VERSION, jobs: Object.fromEntries(this.jobs) };
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true });

    const temporary = join(directory, `.${process.pid}-${Date.now()}.jobs.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      renameSync(temporary, this.path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary file may never have been created; the original error matters.
      }
      throw error;
    }
  }
}
