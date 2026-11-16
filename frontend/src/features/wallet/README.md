# Wallet feature — end-to-end reference

Satu halaman untuk paham fitur wallet Monad di kawai: arsitektur, siapa
memegang key apa, daftar op, dan jaringan. Alamat kontrak: `NETWORKS.md`.

## Model keamanan (yang paling penting dimengerti)

```
Dana USER  (device keychain, monad-wallet/device) → sign di DEVICE (src-tauri)
Dana SERVER (worker secret PRIVATE_KEY)           → sign di WORKER (kawai-server)
```

- Private key user **hanya ada di OS keychain device** (`monad-wallet/device`),
  dibuat via CSPRNG, tidak pernah menyeberang ke frontend/jaringan. Tidak ada
  mnemonic/password — wallet device-scoped, tidak bisa dipulihkan di device lain.
  → transfer milik user HARUS ditandatangani on-device (`logic/monad_wallet.rs`).
- Worker (`POST /transfer`) memakai key server yang BERBEDA — pola payout/faucet
  (cashback, reward), bukan dana user. Jangan pernah pindahkan signing user ke
  worker, dan jangan kirim key user ke mana pun.
- Wallet lifecycle, signing, history, receipts, and fund-moving operations are
  Tauri-only. The multi-user web transport exposes no device-wallet routes.

## Alur data (front → back)

```
SendForm/SmartDepositForm (string desimal, "1.5" — tanpa float math)
  → lib/blockchain-adapter.ts (nama method kanonis)
    → Tauri command (desktop)
      → logic/monad_wallet.rs (orchestration keychain; guard alamat/amount)
        → crates/integrations/monad (pure: parse_units integer math,
          EIP-1559 sign via PrivateKeySigner, eth_sendRawTransaction)
```

## Daftar op

| Op | Fungsi | Transport |
|---|---|---|
| `monad_wallet_address/create/sign_message/delete` | siklus hidup device wallet | Tauri |
| `check_monad_balance`, `monad_chain_status`, `get_token_balance`, `get_token_info`, `estimate_gas` | baca chain | Tauri + web |
| `get_transaction_receipt`, `monad_wallet_history` | receipt dan riwayat device | Tauri |
| `transfer_native`, `transfer_token`, `transfer_usdt`, `deposit_to_vault` | kirim dana user | Tauri |

Frontend: `frontend/src/features/wallet/` — `lib/wallet-adapter.ts` (5 method,
device-wallet), `lib/blockchain-adapter.ts` (baca + transfer), hooks
(`use-wallet/use-network/use-balances`), komponen (send/deposit/setup/home).
Kontrak address hardcoded di `lib/network-config.ts` (mirror `monad_contracts.rs`).

## Jaringan

Aktif: **Monad Testnet** (Round 8, chain 10143) — aman untuk test dana.
Promotion target: mainnet (chain 143). Titik yang harus diubah saat flip:
lihat bagian "Mirror points" di `NETWORKS.md`. Verifikasi cepat baca-chain:
`cargo run -p kawai-monad --example live_read` (dari `crates/integrations/monad`).

## Hal-hal yang sengaja TIDAK ada

- Mnemonic import/export, multi-wallet, keystore — wallet = satu device key.
  (Setup flow pernah ditulis veridium-style dan dihapus: menampilkan mnemonic
  palsu + create yang mengabaikan phrase = janji pemulihan bohong.)
- `contracts/rust/` bindings tidak dipakai (alloy 2.4 vs 1.x) — wallet hanya
  butuh 3 write method yang ditulis manual di `tx.rs` (selector terkunci unit
  test vs `cast sig`).
- Claim mining/cashback/referral (Rewards tab) — butuh distributor ABI; adopsi
  bindings penuh masuk akal saat fitur itu dikerjakan.
