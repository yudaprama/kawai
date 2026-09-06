# PLAN: Wire the wallet feature to real Monad chain commands

> **Status:** Phases 0–1 SHIPPED (frontend hardening + read-only commands
> `get_token_balance`/`get_token_info`/`estimate_gas` + adapters on canonical
> names; default RPC switched to Monad mainnet to match the hardcoded
> contract addresses). Phase 2 executed as Option A (mnemonic story removed).
> Phase 3 (fund-moving) NOT started — frontend transfer paths throw a clear
> "not available yet" error pending a green light.

Frontend `features/wallet/` is complete (typecheck + build green) against a
Tauri adapter that targets command names that mostly do not exist yet. This
plan lands the Rust side, fixes two unsafe frontend fallbacks, and shrinks the
adapter surface to what the UI actually calls.

Ground truth already in place:

- `crates/integrations/monad` — `check_balance`, `chain_status`, `validate_address`, `rpc_url` (read-only, alloy).
- `crates/integrations/monad/src/signer.rs` — in-app hot-wallet keygen + EIP-191 `sign_message`; key lives ONLY in the OS keychain (`monad-wallet/device`).
- `src-tauri/src/logic/monad.rs` / `logic/monad_wallet.rs` + existing ops: `check_monad_balance`, `monad_chain_status`, `monad_wallet_{address,create,sign_message,delete}` (both wrappers, wallet routes public by design — SIWE identity).

## Phase 0 — Frontend safety fixes (do first, no backend needed)

1. **Remove the `generateMnemonic` fake fallback** (`wallet-adapter.ts`). The
   hard-coded `abandon … about` list is a real, publicly-known BIP39 phrase.
   Return `null` / throw when the backend command is missing and disable the
   mnemonic import path in `setup-form.tsx` until Phase 1 ships it.
2. **Remove the double-call in `createWallet`** (`wallet-adapter.ts`). kawai's
   `monad_wallet_create` ignores `password`/`mnemonic` and generates a random
   device key — the retry-without-args path silently creates a key unrelated to
   the displayed phrase. Show a real error instead.
3. **Make the `monad` feature gate visible.** `tryCall` swallows everything, so
   on a build without the `monad` feature the UI renders a silent zero-balance
   wallet. `getStatus` should distinguish "command missing" (feature off →
   render a "wallet unavailable in this build" empty state) from "no wallet
   yet". Cheapest probe: one `monad_chain_status` call at mount.
4. **Replace the zero-address contract fallback** (`network-config.ts`):
   `usdt`/`kawai` fall back to `0x000…0`, so a send/deposit without a backend
   config would target the burn address. Hardcode the real veridium testnet
   contract addresses as constants (hardcode-over-env-var rule) and drop the
   `get_backend_config`/`get_config`/`backend_config` candidate loop — one
   canonical name or constant only.
5. **Delete dead adapter surface**: `switchWallet` (impl ignores its args and
   returns the input), `autoClaimTrialIfNeeded` (calls a nonexistent command
   with an ignored `referralCode`), `getAPIKey`, `exportKeystore`,
   `importKeystore`, `importPrivateKey`, `updateWalletDescription`,
   `unlockWallet`/`lockWallet` no-ops. Keep the interface to what the UI calls.
   Anything cut comes back only with a real backend need.

## Phase 1 — Read-only chain commands (fills the Home screen)

All logic in `logic/monad.rs` (pure, alloy via `crates/integrations/monad`),
both wrappers per op, registered in `generate_handler!` + the router. Read
ops go on the **public** router (no secrets, same as `check_monad_balance`).

| Op | Logic | Notes |
|---|---|---|
| `get_current_block` | `chain_status` already returns the height — expose it directly | adapter fallback already uses this; make it the canonical path |
| `get_token_balance` | new `monad::erc20_balance(token, wallet)` — `balanceOf` via alloy, parse `decimals()` | returns `BalanceInfo { raw, formatted, decimals }` |
| `get_token_info` | new `monad::erc20_info(token)` — `symbol()`/`decimals()` | send-form "Found X (N decimals)" path |
| `estimate_gas` | new `monad::gas_estimate()` — `eth_gasPrice` (or fee history) → `GasEstimate` | display only; never feeds tx building |
| `get_vault_balance` | `erc20_balance(paymentVault, wallet)` or vault contract read — matches veridium semantics | needs the hardcoded vault address from Phase 0.4 |
| `get_network_by_id` / `get_supported_networks` | **do NOT add** — the single hardcoded Monad testnet constant in `network-config.ts` is the network list. Delete these adapter methods. | |

Verification: `cargo check` (desktop) + `cargo check --features web` + the two
monad feature checks (`--features monad`, `--features full`); smoke with
`src-tauri/examples/` — extend `binance_smoke`-style pattern with a
`monad_wallet_smoke` (read-only: chain status, native balance, token balance of
the vault USDT; no key required).

## Phase 2 — Wallet identity honesty (mnemonic path decision)

kawai's hot wallet is a device-keychain key, not mnemonic-derived. Pick one:

- **Option A (recommended): drop the mnemonic story.** Delete the mnemonic
  display/import step from `setup-form.tsx`; the setup flow becomes
  "create device wallet → show address". `monad_wallet_create` stays as-is.
  No new Rust surface, no false recovery promise.
- **Option B: real mnemonic import.** New `logic::monad_wallet::import_mnemonic`
  deriving the key via alloy's BIP39 → stored in the keychain slot;
  `generate_mnemonic` returns a fresh phrase from the same crate. Larger
  surface, and the keychain slot then holds a phrase-derived key — document
  that recovery = phrase + device slot, not the phrase alone.

Either way: `exportKeystore`/`importKeystore` stay unimplemented (throws) —
do not fake them.

## Phase 3 — Fund-moving commands (highest care)

New logic in `logic/monad_wallet.rs` (signing) + `logic/monad.rs` (contract
calls), built on `signer.rs`'s keychain secret + alloy.

1. **Amount parsing in Rust, not TS.** Replace the float
   `BigInt(Math.round((amount % 1) * 10**dec))` path in `wallet-page.tsx` with
   a string amount passed to Rust; parse with `U256`/`parse_units`-style
   decimal handling (`decimals` from `get_token_info`, 18 for native,
   6 for the vault USDT). The `*1_000_000` TS math goes away.
2. Ops (both wrappers each):
   - `transfer_native(to, amount_string)` — EIP-1559 tx signed by the device key; return tx hash.
   - `transfer_token(token_address, to, amount_string)` — generic ERC-20 `transfer`.
   - `transfer_usdt(to, amount_string)` — thin wrapper over `transfer_token` with the hardcoded USDT address (keep for the UI's stablecoin path).
   - `deposit_to_vault(amount_string)` — approve + deposit against the payment vault (veridium contract semantics).
   - `sync_deposit(tx_hash)` — poll/verify the deposit tx, return `{ success, newBalance }`; the 15×2s poll loop stays frontend-side.
3. **Auth boundary:** on web these ride the **protected** router (they move
   funds; identity = session email). Desktop has no session for wallet ops by
   design — keep the Tauri commands session-free, matching existing
   `monad_wallet_*` ops.
4. **Guards in the logic layer** (not the wrapper): `validate_address` on every
   recipient, amount > 0, token != zero address, and a self-transfer
   short-circuit. Errors are strings (existing convention) but must be
   actionable ("insufficient MON for gas", not "contract error").
5. **Confirmation UX unchanged:** send-form's confirmation step already gates
   the call; the Rust side must not add its own interactive prompt.

## Phase 4 — Verification gate

1. `bun run typecheck && bun run build` after every frontend phase.
2. `cargo check` + `cargo check --features web` + `cargo check --features full`
   + `cargo check --features monad` green.
3. New `monad_wallet_smoke` example: create → address → native balance →
   token balance → (testnet-only, gated by an explicit flag) self-transfer of
   the smallest unit → delete. CI-safe without the flag.
4. `TROUBLESHOT.md` not affected; docs: one Architecture bullet replacing the
   "read-only public RPC" description of the monad crate with the tx-sending
   reality, and AGENTS.md Roadmap entry collapse per the docs-hygiene rule.

## Ordering & blast radius

Phase 0 (frontend-only) → Phase 1 (read-only, low risk) → Phase 2 (decision
gated on user) → Phase 3 (fund-moving, behind Phase 0/1 sanity) → Phase 4.
Phases 0–1 ship independently; nothing in 1–3 is reachable from the UI until
its adapter method stops being a stub, so partial landing is safe.
