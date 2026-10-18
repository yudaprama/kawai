import { describe, expect, it } from "vitest";

import {
  renderBinanceImportTrades,
  renderCryptoFuturesTradeStats,
  renderLedgerIntegrityCheck,
  renderTradingFeeSummary,
  renderTradingPnlBySymbol,
} from "./accounting";

// Exact decimal strings — the ledger stores money as TEXT (BigDecimal), and
// these fixtures mirror what the Rust tools actually emit.
const importPayload = {
  scanned: 4,
  posted: 2,
  skipped_already_imported: 1,
  skipped_no_ledger_effect: 1,
  pnl_total: "15.25",
  fees_total: "0.8",
  posted_ids: ["bns_fapi_1", "bns_fapi_2"],
  posted_ids_truncated: false,
  wallet_account_id: "binance-wallet",
};

const statsPayload = {
  market: "USDM",
  statistics: {
    trades: 3,
    wins: 2,
    losses: 1,
    breakevens: 0,
    winRate: 0.6666666666666666,
    avgWin: 40,
    avgLoss: -25,
    expectancy: 18.33,
    profitFactor: 1.6,
    largestWin: 50,
    totalRealizedPnl: 55.5,
    settlementCurrency: "USDT",
  },
  sync: "2 new fills",
};

const pnlPayload = {
  rows: [
    { symbol: "BTCUSDT", realized_pnl: "25.5", commission: "0.5", volume: "500", fills: 1 },
    { symbol: "ETHUSDT", realized_pnl: "-10.25", commission: "0.3", volume: "500", fills: 1 },
  ],
  totals: { realized_pnl: "15.25", commission: "0.8", volume: "1000", fills: 2 },
};

const feePayload = {
  commission_total: "0.8",
  volume_total: "1000",
  rows: [{ symbol: "BTCUSDT", commission: "0.5", volume: "500" }],
  fills: 2,
};

const validIntegrity = {
  report: {
    as_of_date: "2026-10-31",
    is_valid: true,
    issues: [],
    trial_balance_total_debits: "1500.5",
    trial_balance_total_credits: "1500.5",
    balance_sheet_total_assets: "1500.5",
    balance_sheet_total_liabilities_equity: "1500.5",
  },
  is_valid: true,
  issues: [],
};

const brokenIntegrity = {
  report: validIntegrity.report,
  is_valid: false,
  issues: ["Trial balance is not balanced: debits = 1500.5, credits = 1400.5"],
};

const text = (node: unknown): string => (node == null ? "" : JSON.stringify(node));

describe("accounting tool renderers", () => {
  it("renderBinanceImportTrades surfaces the idempotence counters and exact amounts", () => {
    const out = renderBinanceImportTrades(importPayload);
    const t = text(out);
    expect(t).toContain("Ledger import");
    expect(t).toContain("15.25"); // exact decimal string, not 15.249999
    expect(t).toContain("binance-wallet");
    expect(t).toContain("Fills scanned");
  });

  it("renderBinanceImportTrades returns null for junk payloads", () => {
    expect(renderBinanceImportTrades(null)).toBeNull();
    expect(renderBinanceImportTrades("not json")).toBeNull();
    expect(renderBinanceImportTrades({})).toBeNull();
  });

  it("renderCryptoFuturesTradeStats scales the win-rate fraction to a percentage", () => {
    const out = renderCryptoFuturesTradeStats(statsPayload);
    const t = text(out);
    expect(t).toContain("Trade statistics");
    // 0.6666 as a fraction must render as ~66.67%, never 0.67%.
    expect(t).toContain("66.67%");
    expect(t).toContain("Expectancy");
    expect(t).toContain("USDT");
  });

  it("renderCryptoFuturesTradeStats requires the statistics envelope", () => {
    expect(renderCryptoFuturesTradeStats({ market: "USDM" })).toBeNull();
  });

  it("renderTradingPnlBySymbol keeps exact decimals per row and totals", () => {
    const out = renderTradingPnlBySymbol(pnlPayload);
    const t = text(out);
    expect(t).toContain("Realized PnL by symbol");
    expect(t).toContain("BTCUSDT");
    expect(t).toContain("25.5");
    expect(t).toContain("-10.25");
    expect(t).toContain("total");
  });

  it("renderTradingPnlBySymbol returns null when there are no rows", () => {
    expect(renderTradingPnlBySymbol({ rows: [], totals: {} })).toBeNull();
  });

  it("renderTradingFeeSummary shows the fee-to-volume ratio", () => {
    const out = renderTradingFeeSummary(feePayload);
    const t = text(out);
    expect(t).toContain("Fees");
    // 0.8 / 1000 = 0.080% — the drag the whole workflow exists to surface.
    expect(t).toContain("0.080%");
  });

  it("renderLedgerIntegrityCheck states a balanced ledger plainly", () => {
    const out = renderLedgerIntegrityCheck(validIntegrity);
    const t = text(out);
    expect(t).toContain("balanced");
    expect(t).not.toContain("imbalanced");
    expect(t).toContain("2026-10-31");
  });

  it("renderLedgerIntegrityCheck lists the imbalance when the books do not balance", () => {
    const out = renderLedgerIntegrityCheck(brokenIntegrity);
    const t = text(out);
    expect(t).toContain("imbalanced");
    expect(t).toContain("Trial balance is not balanced");
  });
});