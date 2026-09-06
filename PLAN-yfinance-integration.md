# Plan: Integrasi yfinance ke Kawai

> **Status:** Draft
> **Author:** opencode
> **Date:** 2026-09-06

## 1. Gap Analysis

### Yang sudah ada di kawai

| Category | Tools | Source |
|----------|-------|--------|
| Price/Quote | `get_stock_price`, `get_stock_quote`, `get_stock_detail` | TwelveData + AlphaVantage + StockTwits fallback |
| History | `get_stock_history` | TwelveData |
| Fundamentals | `get_stock_fundamentals` | Tiingo (**Dow 30 only**) |
| Financials | `get_stock_financials` | Tiingo (**Dow 30 only**) |
| TA | `get_rsi`, `get_macd`, `get_sma`, `get_ema`, `get_bbands` | TwelveData |
| Social | `stock_sentiment`, `stock_social_feed`, `trending_stocks` | StockTwits |
| Search | `search_stock` | TwelveData + StockTwits |

### Yang belum ada (dari yfinance)

| Data | TradingAgents | Kawai | Priority |
|------|---------------|-------|----------|
| Balance sheet (quarterly/annual) | ✅ | ❌ | High |
| Cash flow (quarterly/annual) | ✅ | ❌ | High |
| Income statement (quarterly/annual) | ✅ | ❌ | High |
| Insider transactions | ✅ | ❌ | Medium |
| Stock-specific news | ✅ | ❌ | Medium |
| Global/macro news | ✅ | ❌ | Low (webread sudah cover) |

## 2. Strategi

### yfinance sebagai Fallback + Extended Data

**Approach:** Pola yang sama dengan StockTwits (`stocktwits.rs`):

1. yfinance = **fallback kedua** untuk keyed providers (ketika TwelveData/Tiingo + StockTwits semua gagal)
2. yfinance = **primary** untuk data yang tidak ada di provider lain (balance sheet, cash flow, income statement, insider transactions)
3. yfinance = **secondary source** untuk news (webread sudah cover news, tapi yfinance lebih targeted ke stock-specific)

### Fallback Chain

**Current:**
```
TwelveData → StockTwits (fallback)
AlphaVantage → StockTwits (fallback)
Tiingo → StockTwits (fallback)
```

**New:**
```
TwelveData → StockTwits → yfinance (fallback 2)
AlphaVantage → StockTwits → yfinance (fallback 2)
Tiingo → StockTwits → yfinance (fallback 2)
```

## 3. Implementasi

### 3.1 File Baru: `yfinance.rs`

**Path:** `crates/generated-tools/finance/src/yfinance.rs`

**Structure (mengikuti pola `stocktwits.rs`):**

```rust
//! yfinance provider tier: keyless fallback for the keyed stock tools
//! (TwelveData / AlphaVantage / Tiingo) plus extended financial statement
//! tools that no keyed provider covers (balance sheet, cash flow, income
//! statement, insider transactions).
//!
//! Yahoo Finance API is unofficial but stable for personal use. No API key
//! required. Rate limiting handled via retry with backoff.

use kawai_tools::AgentTool;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;

// ── HTTP Client ─────────────────────────────────────────────────────────────

const YF_API_BASE: &str = "https://query1.finance.yahoo.com";
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

fn client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("reqwest client build")
        })
        .clone()
}

async fn fetch_json(url: &str) -> Result<Value, String> {
    let resp = client()
        .get(url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("yfinance request: {e}"))?;
    
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("yfinance body: {e}"))?;
    
    if status.as_u16() >= 400 {
        return Err(format!("yfinance HTTP {}: {}", status.as_u16(), body));
    }
    
    serde_json::from_str(&body).map_err(|e| format!("yfinance decode: {e}"))
}

// ── Fallback Functions ──────────────────────────────────────────────────────

/// Detect failed primary-provider response (sama seperti stocktwits::primary_failed)
pub fn primary_failed(body: &str) -> bool {
    // ... implementation
}

/// Fallback for price/quote tools
pub async fn stock_price(symbol: &str) -> Option<Value> {
    // ... implementation using chart API
}

/// Fallback for search_stock
pub async fn search(query: &str) -> Option<Value> {
    // ... implementation using search API
}

// ── Extended Data Functions (BARU) ──────────────────────────────────────────

/// Get balance sheet data
pub async fn balance_sheet(ticker: &str, freq: &str) -> Result<Value, String> {
    let module = match freq {
        "quarterly" => "balanceSheetHistoryQuarterly",
        _ => "balanceSheetHistory",
    };
    let url = format!(
        "{}/v10/finance/quoteSummary/{}?modules={}",
        YF_API_BASE, ticker, module
    );
    let data = fetch_json(&url).await?;
    // Parse dan normalize ke standard format
    Ok(data)
}

/// Get cash flow data
pub async fn cashflow(ticker: &str, freq: &str) -> Result<Value, String> {
    let module = match freq {
        "quarterly" => "cashflowStatementQuarterly",
        _ => "cashflowStatement",
    };
    let url = format!(
        "{}/v10/finance/quoteSummary/{}?modules={}",
        YF_API_BASE, ticker, module
    );
    let data = fetch_json(&url).await?;
    Ok(data)
}

/// Get income statement data
pub async fn income_statement(ticker: &str, freq: &str) -> Result<Value, String> {
    let module = match freq {
        "quarterly" => "incomeStatementHistoryQuarterly",
        _ => "incomeStatementHistory",
    };
    let url = format!(
        "{}/v10/finance/quoteSummary/{}?modules={}",
        YF_API_BASE, ticker, module
    );
    let data = fetch_json(&url).await?;
    Ok(data)
}

/// Get insider transactions
pub async fn insider_transactions(ticker: &str) -> Result<Value, String> {
    let url = format!(
        "{}/v10/finance/quoteSummary/{}?modules=insiderTransactions",
        YF_API_BASE, ticker
    );
    let data = fetch_json(&url).await?;
    Ok(data)
}

/// Get stock-specific news
pub async fn stock_news(ticker: &str, start: &str, end: &str) -> Result<Value, String> {
    let url = format!(
        "{}/v1/finance/search?q={}&newsCount=10",
        YF_API_BASE, ticker
    );
    let data = fetch_json(&url).await?;
    // Filter by date range
    Ok(data)
}

/// Get global/macro news
pub async fn global_news(date: &str, lookback: i64) -> Result<Value, String> {
    let queries = ["stock market", "economy", "fed", "inflation"];
    let mut all_news = Vec::new();
    
    for query in queries {
        let url = format!(
            "{}/v1/finance/search?q={}&newsCount=5",
            YF_API_BASE, query
        );
        if let Ok(data) = fetch_json(&url).await {
            if let Some(news) = data.get("news").and_then(|n| n.as_array()) {
                all_news.extend(news.clone());
            }
        }
    }
    
    Ok(json!({ "news": all_news }))
}

// ── Agent Tools ─────────────────────────────────────────────────────────────

// Balance Sheet Tool
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GetBalanceSheetArgs {
    pub ticker: String,
    #[serde(default)]
    pub freq: Option<String>,
}

pub struct GetBalanceSheetTool;

impl AgentTool for GetBalanceSheetTool {
    const NAME: &'static str = "get_balance_sheet";
    // ... implementation
}

// Cash Flow Tool
pub struct GetCashflowTool {
    const NAME: &'static str = "get_cashflow";
    // ... implementation
}

// Income Statement Tool
pub struct GetIncomeStatementTool {
    const NAME: &'static str = "get_income_statement";
    // ... implementation
}

// Insider Transactions Tool
pub struct GetInsiderTransactionsTool {
    const NAME: &'static str = "get_insider_transactions";
    // ... implementation
}

// Stock News Tool
pub struct GetStockNewsTool {
    const NAME: &'static str = "get_stock_news";
    // ... implementation
}

// Global News Tool
pub struct GetGlobalNewsTool {
    const NAME: &'static str = "get_global_news";
    // ... implementation
}
```

### 3.2 Registry Update

**File:** `crates/generated-tools/finance/src/registry.rs`

Tambahkan ke `native_names()`:
```rust
"get_balance_sheet",
"get_cashflow",
"get_income_statement",
"get_insider_transactions",
"get_stock_news",
"get_global_news",
```

Tambahkan ke `toolset_for()`:
```rust
"get_balance_sheet" => {
    set.add_tool(crate::yfinance::GetBalanceSheetTool::default());
}
"get_cashflow" => {
    set.add_tool(crate::yfinance::GetCashflowTool::default());
}
// ... dst
```

### 3.3 Supervisor Registration

**File:** `src-tauri/src/agent_registry.rs`

Update `finance_tools_for_supervisor`:
```rust
pub fn finance_tools_for_supervisor(
    context: &AgentContext<'_>,
    remote_configured: bool,
) -> Option<kawai_tools::ToolSet> {
    let _ = (context, remote_configured);
    Some(finance::toolset_for(&[
        // Existing
        "get_stock_price",
        "get_stock_quote",
        "get_stock_detail",
        "get_stock_history",
        "get_stock_fundamentals",
        "get_stock_financials",
        "search_stock",
        "stock_sentiment",
        "stock_social_feed",
        "trending_stocks",
        // NEW from yfinance
        "get_balance_sheet",
        "get_cashflow",
        "get_income_statement",
        "get_insider_transactions",
        "get_stock_news",
        "get_global_news",
    ]))
}
```

### 3.4 Fallback Chain Update

**File:** `crates/generated-tools/finance/src/twelvedata.gen.rs`

Update `GetStockDetailTool::call`:
```rust
async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
    let body = self.base.exec(&RequestSpec { ... }, map).await?;
    
    // Fallback 1: StockTwits
    if crate::stocktwits::primary_failed(&body) {
        if let Some(v) = crate::stocktwits::stock_price(&args.symbol).await {
            return Ok(v.to_string());
        }
    }
    
    // Fallback 2: yfinance (BARU)
    if crate::stocktwits::primary_failed(&body) {
        if let Some(v) = crate::yfinance::stock_price(&args.symbol).await {
            return Ok(v.to_string());
        }
    }
    
    Ok(body)
}
```

**Note:** Apply pattern yang sama ke `alphavantage.gen.rs` dan `tiingo.gen.rs`.

## 4. Yahoo Finance API Reference

### Endpoints

| Data | Endpoint | Module |
|------|----------|--------|
| Chart/OHLCV | `/v8/finance/chart/{symbol}` | - |
| Quote Summary | `/v10/finance/quoteSummary/{symbol}` | - |
| Balance Sheet | `/v10/finance/quoteSummary/{symbol}` | `balanceSheetHistory` / `balanceSheetHistoryQuarterly` |
| Cash Flow | `/v10/finance/quoteSummary/{symbol}` | `cashflowStatement` / `cashflowStatementQuarterly` |
| Income Statement | `/v10/finance/quoteSummary/{symbol}` | `incomeStatementHistory` / `incomeStatementHistoryQuarterly` |
| Insider Transactions | `/v10/finance/quoteSummary/{symbol}` | `insiderTransactions` |
| Search | `/v1/finance/search?q={query}` | - |

### Response Format

**Quote Summary (balance sheet example):**
```json
{
  "quoteSummary": {
    "result": [{
      "balanceSheetHistory": {
        "balanceSheetStatements": [{
          "endDate": { "raw": 1672531200, "fmt": "2022-12-31" },
          "totalAssets": { "raw": 352755000000, "fmt": "352.755B" },
          "totalLiabilities": { "raw": 302083000000, "fmt": "302.083B" },
          "totalStockholderEquity": { "raw": 50672000000, "fmt": "50.672B" },
          // ... more fields
        }]
      }
    }]
  }
}
```

### Rate Limiting

- Yahoo Finance tidak punya rate limit resmi
-实践中: ~2000 requests/hour aman
- Mitigation: retry dengan exponential backoff

## 5. Testing Plan

### 5.1 Unit Tests

```rust
#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn detects_yfinance_failures() {
        assert!(primary_failed("<html>...</html>"));
        assert!(primary_failed(""));
        assert!(!primary_failed("{\"chart\":{...}}"));
    }
    
    #[tokio::test]
    async fn test_balance_sheet() {
        let result = balance_sheet("AAPL", "quarterly").await;
        assert!(result.is_ok());
    }
    
    #[tokio::test]
    async fn test_stock_news() {
        let result = stock_news("AAPL", "2026-01-01", "2026-09-06").await;
        assert!(result.is_ok());
    }
}
```

### 5.2 Integration Test

**File:** `src-tauri/examples/yfinance_check.rs`

```rust
//! Quick smoke test for yfinance integration.
//! Run: cargo run --example yfinance_check --features litert

#[tokio::main]
async fn main() {
    // Test balance sheet
    println!("Testing balance sheet...");
    let bs = yfinance::balance_sheet("AAPL", "quarterly").await;
    println!("Balance sheet: {:?}", bs);
    
    // Test cash flow
    println!("Testing cash flow...");
    let cf = yfinance::cashflow("AAPL", "quarterly").await;
    println!("Cash flow: {:?}", cf);
    
    // Test income statement
    println!("Testing income statement...");
    let is = yfinance::income_statement("AAPL", "quarterly").await;
    println!("Income statement: {:?}", is);
    
    // Test insider transactions
    println!("Testing insider transactions...");
    let it = yfinance::insider_transactions("AAPL").await;
    println!("Insider transactions: {:?}", it);
    
    // Test stock news
    println!("Testing stock news...");
    let news = yfinance::stock_news("AAPL", "2026-09-01", "2026-09-06").await;
    println!("Stock news: {:?}", news);
}
```

### 5.3 Fallback Chain Test

Verify that when TwelveData/StockTwits fail, yfinance is tried:
1. Set invalid API keys untuk TwelveData
2. Mock StockTwits to return error
3. Verify yfinance fallback works

## 6. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Yahoo Finance rate limiting | Tool calls fail | Retry dengan backoff + StockTwits sebagai primary fallback |
| API changes/breaking | Tools stop working | Modular design, mudah switch provider; defensive parsing |
| Response format changes | Parse errors | Fallback ke guidance error, tidak crash |
| Legal/TOS | Account ban | Personal use only, tidak reselling; Yahoo toleran untuk reasonable usage |
| Yahoo Finance downtime | Semua fallback gagal | Existing tools (TwelveData, Tiingo) masih work dengan StockTwits |

## 7. Checklist

- [ ] Buat `crates/generated-tools/finance/src/yfinance.rs`
- [ ] Implement `primary_failed()` detection
- [ ] Implement `stock_price()` fallback
- [ ] Implement `search()` fallback
- [ ] Implement `balance_sheet()` tool
- [ ] Implement `cashflow()` tool
- [ ] Implement `income_statement()` tool
- [ ] Implement `insider_transactions()` tool
- [ ] Implement `stock_news()` tool
- [ ] Implement `global_news()` tool
- [ ] Update `registry.rs` dengan tools baru
- [ ] Update `agent_registry.rs` untuk register tools
- [ ] Update fallback chain di `twelvedata.gen.rs`, `alphavantage.gen.rs`, `tiingo.gen.rs`
- [ ] Buat unit tests
- [ ] Buat integration test (`yfinance_check.rs`)
- [ ] Update `TOOL-MAP.md`
- [ ] Update `AGENTS.md` (jika perlu)

## 8. References

- [TradingAgents yfinance implementation](TradingAgents/tradingagents/dataflows/y_finance.py)
- [TradingAgents yfinance news](TradingAgents/tradingagents/dataflows/yfinance_news.py)
- [Yahoo Finance API (unofficial)](https://github.com/gadicc/node-yahoo-finance2)
- [StockTwits implementation pattern](crates/generated-tools/finance/src/stocktwits.rs)
