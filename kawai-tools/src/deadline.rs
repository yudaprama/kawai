//! Step-deadline awareness for tools that run internal retry loops.
//!
//! The scheduler enforces each step's `timeoutMs` by hard-cancelling the
//! dispatch future — but a tool that is killed that way can only ever
//! surface "timed out", never WHY. Tools wrapped in `scope` (the supervisor
//! dispatch closure does this) can instead ask [`remaining`] for the time
//! still available and finish cooperatively with a structured error that
//! names the actual last failure.

use std::time::{Duration, Instant};

tokio::task_local! {
    static STEP_DEADLINE: Option<Instant>;
}

/// Run `fut` with the given step deadline attached (None = no deadline —
/// e.g. direct RPC calls outside the supervisor).
pub async fn scope<F: std::future::Future>(deadline: Option<Instant>, fut: F) -> F::Output {
    STEP_DEADLINE.scope(deadline, fut).await
}

/// Effective retry budget for an internal loop: the caller's default,
/// clamped to the remaining step time (minus a small margin so the tool
/// returns BEFORE the scheduler's hard kill, not in the same instant).
/// Returns None when no budget is left at all.
pub fn effective_budget(default: Duration) -> Option<Duration> {
    const MARGIN: Duration = Duration::from_secs(5);
    STEP_DEADLINE
        .try_with(|d| *d)
        .unwrap_or(None)
        .map(|deadline| {
            let remaining = deadline.saturating_duration_since(Instant::now());
            remaining
                .checked_sub(MARGIN)
                .filter(|r| !r.is_zero())
                .unwrap_or(Duration::ZERO)
                .min(default)
        })
        .filter(|d| !d.is_zero())
}
