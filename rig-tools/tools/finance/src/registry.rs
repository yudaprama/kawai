//! Registry: name → typed tool constructor.

use rig::tool::ToolSet;

/// Reports whether `name` has a native implementation in this crate.
pub fn is_native(name: &str) -> bool {
    matches!(
        name,
        "currency_exchange"
            | "get_bbands"
            | "get_crypto_klines"
            | "get_crypto_market"
            | "get_crypto_orderbook"
            | "get_crypto_price"
            | "get_crypto_ticker_24hr"
            | "get_ema"
            | "get_forex_history"
            | "get_macd"
            | "get_rsi"
            | "get_sma"
            | "get_stock_detail"
            | "get_stock_financials"
            | "get_stock_fundamentals"
            | "get_stock_history"
            | "get_stock_price"
            | "get_stock_quote"
            | "get_supported_currencies"
            | "search_crypto"
            | "search_stock"
    )
}

/// All native tool names in this crate, sorted.
pub fn native_names() -> Vec<&'static str> {
    vec![
        "currency_exchange",
        "get_bbands",
        "get_crypto_klines",
        "get_crypto_market",
        "get_crypto_orderbook",
        "get_crypto_price",
        "get_crypto_ticker_24hr",
        "get_ema",
        "get_forex_history",
        "get_macd",
        "get_rsi",
        "get_sma",
        "get_stock_detail",
        "get_stock_financials",
        "get_stock_fundamentals",
        "get_stock_history",
        "get_stock_price",
        "get_stock_quote",
        "get_supported_currencies",
        "search_crypto",
        "search_stock",
    ]
}

/// Build a `ToolSet` containing every native tool.
pub fn all_tools() -> ToolSet {
    toolset_for(&native_names())
}

/// Build a `ToolSet` for the given subset of native tool names.
/// Panics on unknown names (validate with [`is_native`] first).
pub fn toolset_for(names: &[&str]) -> ToolSet {
    use crate::generated::*;
    let mut set = ToolSet::default();
    for name in names {
        match *name {
            "currency_exchange" => {
                set.add_tool(CurrencyExchangeTool::default());
            }
            "get_bbands" => {
                set.add_tool(GetBbandsTool::default());
            }
            "get_crypto_klines" => {
                set.add_tool(GetCryptoKlinesTool::default());
            }
            "get_crypto_market" => {
                set.add_tool(GetCryptoMarketTool::default());
            }
            "get_crypto_orderbook" => {
                set.add_tool(GetCryptoOrderbookTool::default());
            }
            "get_crypto_price" => {
                set.add_tool(GetCryptoPriceTool::default());
            }
            "get_crypto_ticker_24hr" => {
                set.add_tool(GetCryptoTicker24hrTool::default());
            }
            "get_ema" => {
                set.add_tool(GetEmaTool::default());
            }
            "get_forex_history" => {
                set.add_tool(GetForexHistoryTool::default());
            }
            "get_macd" => {
                set.add_tool(GetMacdTool::default());
            }
            "get_rsi" => {
                set.add_tool(GetRsiTool::default());
            }
            "get_sma" => {
                set.add_tool(GetSmaTool::default());
            }
            "get_stock_detail" => {
                set.add_tool(GetStockDetailTool::default());
            }
            "get_stock_financials" => {
                set.add_tool(GetStockFinancialsTool::default());
            }
            "get_stock_fundamentals" => {
                set.add_tool(GetStockFundamentalsTool::default());
            }
            "get_stock_history" => {
                set.add_tool(GetStockHistoryTool::default());
            }
            "get_stock_price" => {
                set.add_tool(GetStockPriceTool::default());
            }
            "get_stock_quote" => {
                set.add_tool(GetStockQuoteTool::default());
            }
            "get_supported_currencies" => {
                set.add_tool(GetSupportedCurrenciesTool::default());
            }
            "search_crypto" => {
                set.add_tool(SearchCryptoTool::default());
            }
            "search_stock" => {
                set.add_tool(SearchStockTool::default());
            }
            other => panic!("rig-tools: unknown native tool {other:?}"),
        }
    }
    set
}
