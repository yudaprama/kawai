# Product

<!-- impeccable:product-schema 1 -->

## Platform

Desktop (Tauri: macOS/Windows/Linux) + Android; the web build serves the same frontend server-side only.

## Users
People working with documents, spreadsheets, PDFs, market data, and knowledge sources — using specialized AI agents (office, analytics, binance) to draft, analyze, search, and manage persistent work sessions.

## Product Purpose
Kawai is a desktop-first AI agent workspace. A local model (Gemma 4 via LiteRT) orchestrates domain-specific tools while optional cloud subagents handle long-form synthesis. Chat history, knowledge sources, and asset workspaces (Wiki, Wallet, Top Up, Code, Skills, Memory, Connections, Credentials) persist locally in per-user SQLite. Success means users can delegate real document, data, and market-analysis work to a calm, responsive local agent that never leaves their machine by default.

## Positioning
Local-first agent orchestration with domain tools and durable per-user context — not a generic chatbot. The mechanism a neighbor cannot truthfully copy: a local model orchestrating curated per-domain toolsets with knowledge/RAG, artifact persistence, and hybrid cloud subagents, all offline-capable by default.

## Operating Context
Desktop app (Tauri: macOS/Windows/Linux, Android via Play internal track). Users run sessions that may stream for minutes, attach files, bind knowledge sources per session, and switch between agents and asset workspaces mid-conversation.

## Capabilities and Constraints
- Three-pane shell: navigation rail, conversation center, sessions sidebar; the supervisor Workbench drives auto-mode runs (goal composer → plan → per-step progress → deliverable, `frontend/src/features/workbench/`).
- Registry-driven per-agent composition: onboarding and tool surfaces differ per agent.
- Knowledge/RAG: file import, session binding, hybrid search; images go to knowledge, never model context.
- Streaming chat with tool-call cards, thinking mode, cancellation, and retry.
- Asset workspaces (Wiki, Wallet, Top Up, Code, Skills, Memory, Connections, Credentials) swap the center pane without resetting chat state.
- No AI SDK runtime — local type shim + raw Tauri Channel streaming.
- Production auth shipped: worker remote email+password sign-in with a 6-digit email verification code; sessions carry an Ed25519 bearer token (7-day expiry). UI in `frontend/src/features/auth/`, backend `logic::local_auth` (`commands.rs` `auth_sign_in`/`auth_check_account`).

## Brand Commitments
Name: "kawai". Visual foundation: tweakcn neutral-mono palettes (`mono` built-in + `vekis` snapshot) aliased into shadcn semantic variables (`frontend/src/lib/themes.ts`). Dark/light/system theme support.

## Evidence on Hand
Incumbent implementation lives at `frontend/src/` with vendored ai-elements and shadcn ui components.

## Product Principles
1. Conversation-first: the chat surface is the reason to be here; secondary navigation must not compete for horizontal authority.
2. Product-specific composition: agents differ in workflow, not just labels.
3. Calm confidence: local-first means quiet reliability, not visual noise.
4. Progressive disclosure: complex context (knowledge, sessions, sources) appears on demand.

## Accessibility & Inclusion
Responsive drawer pattern below `md`; focus states via `focus-visible:ring`; prefers-reduced-motion respected globally. Icon-only controls rely on titles — labeled states are the current gap.
