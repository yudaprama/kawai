//! Hardcoded Monad contract addresses — single source of truth is
//! `NETWORKS.md` at the repo root (testnet Round 8, 2026-01-24; mainnet
//! deployment 2026-01-23). Keep in sync with
//! `frontend/src/features/wallet/lib/network-config.ts`.

/// Active network for the wallet feature: testnet (safe for fund testing).
pub const TESTNET: bool = true;

/// Default RPC override for the active network — passed explicitly by the
/// wallet ops so the testnet addresses always pair with the testnet RPC.
pub const RPC_URL: &str = "https://testnet-rpc.monad.xyz";

/// Stablecoin on the active network (testnet symbol: MockUSDT, 6 decimals).
pub const USDT: &str = "0x3AE05118C5B75b1B0b860ec4b7Ec5095188D1CCc";
/// KAWAI token (18 decimals).
pub const KAWAI: &str = "0x5eB56dB2203cfbebDa20ef4a7c11C559D4396C60";
/// Payment vault (`deposit(uint256)` pulls the stablecoin via `transferFrom`).
pub const PAYMENT_VAULT: &str = "0x57C13B0fC9B854779cae43469095eAF8cE434276";

// ── Mainnet (deployment 2026-01-23) — inactive, kept for the flip ──────────
pub const MAINNET_RPC_URL: &str = "https://rpc.monad.xyz";
pub const MAINNET_USDT: &str = "0x754704bc059f8c67012fed69bc8a327a5aafb603"; // symbol: USDC
pub const MAINNET_KAWAI: &str = "0xBd95bDB3a6FE48CbC2dE3890B8e67Ef96Af65322";
pub const MAINNET_PAYMENT_VAULT: &str = "0x8381DBC83DdfEc1Ee958BcBdCf5340b406cA9E64";

/// Active-network accessors used by the wallet ops.
pub fn rpc() -> &'static str {
    if TESTNET { RPC_URL } else { MAINNET_RPC_URL }
}
pub fn stablecoin() -> &'static str {
    if TESTNET { USDT } else { MAINNET_USDT }
}
pub fn vault() -> &'static str {
    if TESTNET { PAYMENT_VAULT } else { MAINNET_PAYMENT_VAULT }
}
