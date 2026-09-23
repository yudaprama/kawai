// Read-only smoke for the Monad wallet stack (feature "monad"). Exercises the
// exact logic-layer ops the wallet page calls, against the ACTIVE network from
// `logic::monad_contracts` (source of truth: NETWORKS.md at the repo root).
//
// The default run is CI-safe: public-RPC reads only — no keychain, no tx.
//
// Usage:
//   cargo run --example monad_wallet_smoke --features monad
//   cargo run --example monad_wallet_smoke --features monad -- --with-wallet
//       Keychain lifecycle: address → create (only when none exists) → EIP-191
//       sign roundtrip. A wallet this run created is deleted afterwards; a
//       pre-existing device wallet is NEVER touched or deleted.
//   cargo run --example monad_wallet_smoke --features monad -- --self-transfer
//       + broadcast a 1-wei self-transfer and poll its receipt to success.
//       Implies --with-wallet; needs testnet MON for gas; refuses to run when
//       `monad_contracts::TESTNET` is false (mainnet) regardless of flags.
//
// Transport-skip (binance_smoke precedent): if the very first RPC probe cannot
// reach the endpoint (region block / network outage), exit 0 with a SKIP
// notice — a dead endpoint is not a code regression. Failures AFTER the first
// probe succeeded are real and exit 1.
use kawai_lib::logic::{monad, monad_contracts, monad_wallet};

const USAGE: &str = "usage: monad_wallet_smoke [--with-wallet] [--self-transfer]";

fn die(msg: &str) -> ! {
    println!("[monad_wallet_smoke] FAIL: {msg}");
    std::process::exit(1);
}

fn transportish(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    ["451", "403", "geo", "legal", "connect", "timed out", "timeout", "dns", "unreachable"]
        .iter()
        .any(|m| e.contains(m))
}

/// Wallet lifecycle over the OS keychain. `created_here` means the caller
/// found no wallet before this run and will delete it during cleanup.
async fn wallet_checks(created_here: bool, self_transfer: bool) -> Result<(), String> {
    let addr = if created_here {
        let w = monad_wallet::create()?;
        println!("[monad_wallet_smoke] created device wallet {}", w.address);
        w.address
    } else {
        monad_wallet::address()?
            .map(|w| w.address)
            .ok_or_else(|| "no wallet present although the pre-run probe found one".to_string())?
    };

    let sig = monad_wallet::sign_message("kawai wallet smoke").await?;
    if !sig.starts_with("0x") || sig.len() != 132 || !sig[2..].chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("EIP-191 signature malformed: {sig}"));
    }
    println!("[monad_wallet_smoke] EIP-191 sign roundtrip ok ({sig})");

    if self_transfer {
        println!("[monad_wallet_smoke] broadcasting 1-wei self-transfer on testnet…");
        let tx = monad_wallet::transfer_native(&addr, "0.000000000000000001")
            .await
            .map_err(|e| format!("self-transfer failed (wallet needs testnet MON for gas): {e}"))?;
        println!("[monad_wallet_smoke] broadcast {}", tx.tx_hash);
        let mut receipt = None;
        for _ in 0..15 {
            receipt = monad_wallet::transaction_receipt(&tx.tx_hash).await?;
            if receipt.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        match receipt {
            Some(r) if r.success => {
                println!("[monad_wallet_smoke] mined in block {} (success)", r.block_number);
            }
            Some(r) => return Err(format!("tx {} reverted on-chain", r.tx_hash)),
            None => return Err(format!("tx {} not mined after 30s", tx.tx_hash)),
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(u) = args.iter().find(|a| !matches!(a.as_str(), "--with-wallet" | "--self-transfer")) {
        eprintln!("[monad_wallet_smoke] unknown flag: {u} — {USAGE}");
        std::process::exit(2);
    }
    let self_transfer = args.iter().any(|a| a == "--self-transfer");
    let with_wallet = self_transfer || args.iter().any(|a| a == "--with-wallet");

    if self_transfer && !monad_contracts::TESTNET {
        die("--self-transfer refuses to run: active network is mainnet (monad_contracts::TESTNET = false)");
    }

    let rpc = monad_contracts::rpc().to_string();
    let mut checks = 0usize;

    // ── Read-only probes (always) — same URLs the wallet ops pass ──────
    let st = match monad::chain_status(Some(&rpc)).await {
        Ok(st) => st,
        Err(e) if transportish(&e) => {
            println!(
                "[monad_wallet_smoke] SKIP: Monad RPC unreachable from this host ({e}) — \
                 transport/geo block, not a code regression."
            );
            std::process::exit(0);
        }
        Err(e) => die(&e),
    };
    // NETWORKS.md: testnet = 10143, mainnet = 143.
    let want_chain: u64 = if monad_contracts::TESTNET { 10143 } else { 143 };
    if st.chain_id != want_chain {
        die(&format!(
            "chain id {} — expected {want_chain} (TESTNET={}); the active-network constants \
             disagree with the RPC they point at",
            st.chain_id,
            monad_contracts::TESTNET
        ));
    }
    println!(
        "[monad_wallet_smoke] chain {} @ block {} ({})",
        st.chain_id, st.block_number, st.rpc_url
    );
    checks += 1;

    let stable =
        match monad::erc20_info(Some(&rpc), monad_contracts::stablecoin()).await {
            Ok(v) => v,
            Err(e) => die(&format!("stablecoin erc20_info: {e}")),
        };
    if stable.decimals != 6 || stable.symbol.is_empty() {
        die(&format!(
            "stablecoin {} — expected 6 decimals and a symbol, got symbol={} decimals={}",
            stable.address, stable.symbol, stable.decimals
        ));
    }
    println!(
        "[monad_wallet_smoke] stablecoin {} = {} ({} decimals)",
        stable.address, stable.symbol, stable.decimals
    );
    checks += 1;

    let kawai_token = match monad::erc20_info(Some(&rpc), monad_contracts::KAWAI).await {
        Ok(v) => v,
        Err(e) => die(&format!("KAWAI erc20_info: {e}")),
    };
    if kawai_token.decimals != 18 || kawai_token.symbol != "KAWAI" {
        die(&format!(
            "KAWAI token {} — expected symbol KAWAI / 18 decimals, got {} / {}",
            kawai_token.address, kawai_token.symbol, kawai_token.decimals
        ));
    }
    println!(
        "[monad_wallet_smoke] KAWAI {} = {} ({} decimals)",
        kawai_token.address, kawai_token.symbol, kawai_token.decimals
    );
    checks += 1;

    let vault_bal = match monad::erc20_balance(
        Some(&rpc),
        monad_contracts::stablecoin(),
        monad_contracts::vault(),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => die(&format!("vault stablecoin balance: {e}")),
    };
    println!(
        "[monad_wallet_smoke] vault {} stablecoin balance: {} (raw {})",
        vault_bal.wallet, vault_bal.formatted, vault_bal.raw
    );
    checks += 1;

    let gas = match monad::gas_estimate(Some(&rpc)).await {
        Ok(v) => v,
        Err(e) => die(&format!("gas_estimate: {e}")),
    };
    if gas.gas_price_gwei.parse::<f64>().unwrap_or(0.0) <= 0.0 {
        die(&format!("gas price unusable: {}", gas.gas_price_gwei));
    }
    println!(
        "[monad_wallet_smoke] gas {} gwei (dynamic={})",
        gas.gas_price_gwei, gas.is_dynamic_fee
    );
    checks += 1;

    let native = match monad::check_balance(Some(&rpc), monad_contracts::vault()).await {
        Ok(v) => v,
        Err(e) => die(&format!("check_balance: {e}")),
    };
    println!(
        "[monad_wallet_smoke] vault {} native balance: {} MON",
        native.address, native.balance_mon
    );
    checks += 1;

    // ── Optional device-wallet lifecycle (local-only flags) ────────────
    if with_wallet {
        let pre = match monad_wallet::address() {
            Ok(v) => v,
            Err(e) => die(&format!("keychain read failed: {e}")),
        };
        let created_here = pre.is_none();
        let outcome = wallet_checks(created_here, self_transfer).await;
        // Cleanup BEFORE surfacing an error so a failing run still restores
        // the device to its pre-run state — and only when this run created
        // the wallet; an existing wallet is never deleted.
        if created_here {
            match monad_wallet::delete() {
                Ok(()) => println!(
                    "[monad_wallet_smoke] deleted the wallet this run created (device restored)"
                ),
                Err(e) => println!(
                    "[monad_wallet_smoke] WARNING: could not delete the wallet this run \
                     created — remove keychain entry 'monad-wallet/device' manually: {e}"
                ),
            }
        } else if let Some(p) = &pre {
            println!(
                "[monad_wallet_smoke] pre-existing device wallet {} left untouched",
                p.address
            );
        }
        if let Err(e) = outcome {
            die(&e);
        }
        checks += if self_transfer { 3 } else { 2 };
    }

    if with_wallet {
        println!(
            "[monad_wallet_smoke] PASS ({checks} checks incl. device-wallet lifecycle)"
        );
    } else {
        println!("[monad_wallet_smoke] PASS ({checks} read-only checks)");
    }
}
