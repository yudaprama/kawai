---
target: src/features/chat/components/conversation-panel.tsx
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-09-04T15-10-59Z
slug: rc-features-chat-components-conversation-panel-tsx
---
# Critique — conversation-panel.tsx

## Design Health Score

| Heuristic | Score |
|---|---:|
| Visibility of System Status | 3/4 |
| Match System / Real World | 3/4 |
| User Control and Freedom | 3/4 |
| Consistency and Standards | 3/4 |
| Error Prevention | 3/4 |
| Recognition Rather Than Recall | 3/4 |
| Flexibility and Efficiency | 3/4 |
| Aesthetic and Minimalist Design | 3/4 |
| Error Recovery | 3/4 |
| Help and Documentation | 2/4 |
| **Total** | **29/40** |

## Design Specificity Verdict

The panel is product-specific: it combines supervisor execution, conversational work, tool output, optional canvas, knowledge onboarding, and session controls. It is stronger than a generic chat screen. The remaining risk is that the panel exposes several concepts at once and still relies on internal terms such as Canvas, Thinking, and agent.

The deterministic detector returned zero findings for the target. Browser visualization was unavailable because no browser automation tool was exposed.

## What's Working

- Empty state now has a concise data-source path and contextual actions.
- Error surfaces use alert semantics and provide retry actions where available.
- Desktop/mobile header controls are labeled and keyboard-oriented behavior is present.

## Priority Issues

### [P1] The empty state still teaches the data path, not the product path
Users learn how to import or connect data, but not that Kawai accepts a goal, creates a plan, and requests approval for sensitive steps.

**Fix:** Add one concise sentence beneath the agent description: “Describe the result you want. Kawai will plan the steps and ask before sensitive actions.” Keep it inline, not modal. Suggested: `$impeccable onboard`.

### [P1] “Canvas” is an implementation label
The control and layout expose a concept users may not understand, while the panel actually contains generated work and previews.

**Fix:** Label it “Work” or “Output” in visible UI, retaining Canvas internally. Suggested: `$impeccable clarify`.

### [P2] Error recovery is asymmetric
Model and history failures have Retry controls, while chat failures are message-only. A failed supervisor plan needs an obvious retry/edit path close to the plan.

**Fix:** Add contextual “Retry” / “Edit request” actions for failed plans and chat requests without discarding the original input. Suggested: `$impeccable harden`.

### [P2] Status hierarchy is crowded
Model loading, chat errors, plan progress, history errors, thinking state, confirmation, and canvas all occupy the same vertical path.

**Fix:** Establish one persistent activity region for current plan status; keep model/history notices secondary and collapse completed notices. Suggested: `$impeccable layout`.

## Cognitive Load

Moderate: the basic empty state is clear, but an active run requires tracking conversation, plan progress, tool output, canvas, confirmation, and status notices. Grouping is good; progressive disclosure is only partial.

## Persona Red Flags

- **Jordan (first-timer):** “Canvas,” “Thinking,” and “agent” require explanation; the next result location is not always explicit.
- **Alex (power user):** Retry/edit actions are not consistently available at the point of failure; shortcut discovery is limited.
- **Sam (accessibility):** Alert semantics are good, but streaming/plan status should be announced through a dedicated live region and confirmation focus management should be verified.

## Minor Observations

- The loading state before the agent catalog arrives is visually blank in `App.tsx`.
- “Thinking…” describes a state but not the operation; “Preparing your response…” is clearer for general users.
- The confirmation title should name the actual affected action rather than always saying “Import confirmation.”

## Questions

- Should the visible canvas label become **Work**, **Output**, or remain **Canvas**?
- Should the next pass prioritize the first-run explanation, failure recovery, or status consolidation?
- Should this panel remain English while surrounding product copy is mixed-language, or should terminology be standardized?
