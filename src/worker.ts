import { UNSAFE_CHARS } from "./classifier";
import { ModelError } from "./model";
import type { Classification, NewTicket, Ticket, TicketRepo } from "./tickets";

const MAX_BACKOFF_MS = 5 * 60_000;
/** A broken Retry-After must not park a ticket for years, or overflow a Date and stall bookkeeping. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;
const UNSAFE = new RegExp(UNSAFE_CHARS, "gu");

export type WorkerOptions = {
  concurrency: number;
  maxAttempts: number;
  /** Base delay; attempt n waits about backoffMs * 2^(n-1), jittered by ±50%. */
  backoffMs: number;
  pollMs: number;
};

/**
 * N loops share one queue (the `tickets` table). Each loop claims a ticket, classifies it,
 * and writes the outcome. `stop()` lets in-flight work finish; nothing is lost or duplicated
 * because the claim itself lives in the database.
 */
export class Worker {
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(
    private repo: TicketRepo,
    private classify: (ticket: NewTicket) => Promise<Classification>,
    private opts: WorkerOptions,
  ) {}

  start(): void {
    this.running = true;
    this.loops = Array.from({ length: this.opts.concurrency }, () => this.loop());
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.loops);
  }

  /** Process one ticket if one is due. Returns false when the queue is empty. Exposed for tests. */
  async tick(): Promise<boolean> {
    const ticket = this.repo.claimNext();
    if (!ticket) return false;
    try {
      await this.process(ticket);
    } catch (err) {
      // Bookkeeping itself failed (e.g. the database file is locked). Hand the ticket back
      // rather than leave it orphaned in `classifying`; if even that fails, restart recovers it.
      console.error(`could not record outcome for ${ticket.id}:`, err);
      this.repo.requeueInFlight(ticket.id);
    }
    return true;
  }

  /** A thrown tick costs one poll interval, not the loop. */
  private async loop(): Promise<void> {
    while (this.running) {
      const didWork = await this.tick().catch((err) => {
        console.error("worker loop error:", err);
        return false;
      });
      if (!didWork) await Bun.sleep(this.opts.pollMs);
    }
  }

  /**
   * Any failure, from the model or from the store's own checks, counts as one attempt. A permanent
   * provider error (bad key, bad request) fails the ticket at once; otherwise the next attempt waits
   * for the jittered, capped backoff or for what the provider asked in Retry-After, whichever is
   * longer. The provider's ask is honoured up to a day: retrying sooner is a guaranteed failure.
   */
  private async process(ticket: Ticket): Promise<void> {
    try {
      this.repo.storeClassification(ticket.id, await this.classify(ticket));
      console.log(`classified ${ticket.id}`);
    } catch (err) {
      const attempt = ticket.attempts + 1;
      const permanent = err instanceof ModelError && err.permanent;
      const asked = Math.min(err instanceof ModelError ? err.retryAfterMs : 0, MAX_RETRY_AFTER_MS);
      const backoff = this.opts.backoffMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      const delay = Math.max(Math.min(backoff, MAX_BACKOFF_MS), asked);
      const retryAt =
        !permanent && attempt < this.opts.maxAttempts ? new Date(Date.now() + delay) : null;
      // Provider text is untrusted: flatten anything that could forge or reshape a log line.
      const message = (err instanceof Error ? err.message : String(err))
        .replace(UNSAFE, " ")
        .slice(0, 500)
        .replace(/\p{Cs}$/u, ""); // never end on half a surrogate pair
      this.repo.recordFailure(ticket.id, message, retryAt);
      const outcome = retryAt ? `retry at ${retryAt.toISOString()}` : "giving up";
      console.warn(`attempt ${attempt} failed for ${ticket.id} (${message}), ${outcome}`);
    }
  }
}
