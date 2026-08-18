import type { AnimationPlan } from "./transform";

export interface AnimationControllerConfig {
  /**
   * Max segments animated in a single active chunk. When more animatable
   * content is waiting than this, the oldest overflow snaps straight to
   * settled so the cascade can't grow a multi-second tail.
   */
  coalesceCap: number;
  /** Per-segment fade duration (ms). */
  duration: number;
  /** Delay between successive segments within a chunk (ms). */
  stagger: number;
}

/**
 * Stateful scheduler for the streaming animation. Pure with respect to time —
 * every method takes `now` explicitly, so it's fully testable without timers.
 *
 * It tracks two frontiers over the global segment ordinal space:
 *   settled `[0, settledEnd)` | active `[settledEnd, activeEnd)` | pending rest
 * Exactly one chunk animates at a time; when it completes, the next eligible
 * range becomes active (coalescing the backlog, capped). `gateAt` caps how far
 * the animation may advance — used to hold back atomic segments (code/img/math)
 * whose markdown isn't complete yet.
 */
export class AnimationController {
  private settledEnd = 0;
  private activeEnd = 0;
  private activeCompletesAt = 0;
  private total = 0;
  private gateAt = Number.POSITIVE_INFINITY;
  private readonly config: AnimationControllerConfig;

  constructor(config: AnimationControllerConfig) {
    this.config = config;
  }

  update(total: number, gateAt: number, now: number): void {
    this.total = total;
    this.gateAt = gateAt;
    // Re-parsing during streaming can transiently shrink the segment count;
    // clamp the frontiers so they never point past what exists.
    this.settledEnd = Math.min(this.settledEnd, total);
    this.activeEnd = Math.min(Math.max(this.activeEnd, this.settledEnd), total);
    this.advance(now);
  }

  get plan(): AnimationPlan {
    return { settledEnd: this.settledEnd, activeEnd: this.activeEnd };
  }

  /** When the active chunk finishes, or null if nothing is animating. */
  get nextWakeup(): number | null {
    return this.activeEnd > this.settledEnd ? this.activeCompletesAt : null;
  }

  get isAnimating(): boolean {
    return this.activeEnd > this.settledEnd;
  }

  private animatableEnd(): number {
    return Math.max(this.settledEnd, Math.min(this.total, this.gateAt));
  }

  private advance(now: number): void {
    if (this.activeEnd > this.settledEnd && now >= this.activeCompletesAt) {
      this.settledEnd = this.activeEnd;
    }
    if (this.activeEnd !== this.settledEnd) {
      return;
    }
    const end = this.animatableEnd();
    if (end <= this.settledEnd) {
      return;
    }
    if (end - this.settledEnd > this.config.coalesceCap) {
      this.settledEnd = end - this.config.coalesceCap;
    }
    this.activeEnd = end;
    const size = this.activeEnd - this.settledEnd;
    this.activeCompletesAt =
      now + this.config.stagger * Math.max(0, size - 1) + this.config.duration;
  }
}
