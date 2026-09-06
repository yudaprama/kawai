# NETWORKS.md — KAWAI contract deployments & wallet network reference

Source of truth for the two Monad deployments the kawai wallet talks to.
Status: **testnet is the ACTIVE network** (safe for fund testing). Keep every
file listed in "Mirror points" in sync when anything changes.

## Active network — Monad Testnet

- RPC: `https://testnet-rpc.monad.xyz` · chain id `10143` · explorer `https://testnet.monadexplorer.com`
- Deployment: **Testnet Round 8** (2026-01-24, solc 0.8.33 — from veridium `.env.testnet`)
- Verified live (2026-02, `cargo run -p kawai-monad --example live_read`): chain id, stablecoin `USDT` 6 decimals, `KAWAI` 18 decimals.

| Contract | Address |
|---|---|
| Stablecoin (USDT, 6 dec) | `0x3AE05118C5B75b1B0b860ec4b7Ec5095188D1CCc` |
| KAWAI token (18 dec) | `0x5eB56dB2203cfbebDa20ef4a7c11C559D4396C60` |
| PaymentVault | `0x57C13B0fC9B854779cae43469095eAF8cE434276` |
| OTC Market | `0x9c4a679cE79BB3334D82EeBA3e80C034a0Ad9863` |
| Mining Distributor | `0xD2D1CAC75976a0438aF0Ab2bC0741cE86857953f` |
| Cashback Distributor | `0x585FBD1dC3806bE0A5b047c1c4616DAF3eAe5114` |
| Referral Distributor | `0x081b6b3cb53bb0c220d6808d775ee7517d41e08a` |
| Revenue Distributor | `0x3C714F875809dD9444dA8D4711aeFC2ee6570733` |

## Promotion target — Monad Mainnet

- RPC: `https://rpc.monad.xyz` · chain id `143` · explorer `https://monadexplorer.com`
- Deployment: 2026-01-23 (mirror of `kawai/contracts/blockchain.go`; cross-checked against veridium `.env.mainnet`)
- Verified live: chain id, `KAWAI` 18 decimals; stablecoin on-chain symbol is **USDC** (6 decimals) despite the `StablecoinAddress` name.

| Contract | Address |
|---|---|
| Stablecoin (USDC, 6 dec) | `0x754704bc059f8c67012fed69bc8a327a5aafb603` |
| KAWAI token (18 dec) | `0xBd95bDB3a6FE48CbC2dE3890B8e67Ef96Af65322` |
| PaymentVault | `0x8381DBC83DdfEc1Ee958BcBdCf5340b406cA9E64` |
| OTC Market | `0x75d1A6CC51035D7E5Cbe88aEc6DCfd6ABEB22bfE` |
| Mining Distributor | `0x6326F97DAf97e51fc7480Df5A5D0DB08bCDed4c8` |
| Cashback Distributor | `0x646A1724E7375eFDBd6Ed5073cBb50569c4C15A1` |
| Referral Distributor | `0x018942E0e4a645a92660547DF307a4869510EF56` |
| Revenue Distributor | `0x409A95D5c39d485697918a534C21E9ADDFb6edEc` |

## Mirror points (keep in sync)

1. `src-tauri/src/logic/monad_contracts.rs` — Rust constants; flip `TESTNET = false` + swap the active constants.
2. `crates/integrations/monad/src/lib.rs` — `DEFAULT_RPC_URL`.
3. `frontend/src/features/wallet/lib/network-config.ts` — `DEFAULT_NETWORK` (chain id, explorer, isTestnet, stablecoin labels) + `CONTRACTS`.
4. `frontend/src/features/wallet/lib/blockchain-adapter.ts` — `HARDCODED_NETWORK`.
5. `kawai-server/worker/wrangler.toml` — `MONAD_RPC_URL`, `KAWAI_TOKEN_ADDRESS` (⚠️ currently `0x9cbd…f64c`, matches NEITHER deployment — confirm before relying on `/transfer`).

## Wallet ops → contract usage

| Op (both wrappers) | Contract interaction |
|---|---|
| `get_token_balance` / `get_token_info` | `balanceOf` / `symbol()` / `decimals()` via `eth_call` |
| `transfer_native` | plain value tx (no contract) |
| `transfer_usdt` / `transfer_token` | ERC-20 `transfer(address,uint256)` |
| `deposit_to_vault` | `approve(vault, amount)` then `PaymentVault.deposit(uint256)` |
| `get_transaction_receipt` | `eth_getTransactionReceipt` |
| `transfer_native/…` on the worker (`POST /transfer`) | signs with the SERVER hot wallet (payout/faucet) — separate key from the user's device wallet |

## Open item

`contracts/rust/` (`kawai-contracts`, alloy 2.4 full bindings) is not consumed
by the kawai app — candidates for adoption if claim/mining/cashback ops land in
the wallet; requires aligning alloy versions first.
