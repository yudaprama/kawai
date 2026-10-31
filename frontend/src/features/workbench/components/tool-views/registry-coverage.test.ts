import { describe, expect, it } from "vitest";

import { renderStepReport } from "@/features/workbench/components/tool-views";

import { renderMexcFuturesFillSync, renderVenueFillsImport } from "@/components/ai-elements/tool-renderers/accounting";
import { renderDataFetch } from "@/components/ai-elements/tool-renderers/data";
import { renderSecurityScan } from "@/components/ai-elements/tool-renderers/security";
import { renderMarketStructure, renderMexcFuturesPositions } from "@/components/ai-elements/tool-renderers/finance";

/**
 * The registry gate: every tool kawai can dispatch in a plan must CLAIM its
 * output.
 *
 * Why this exists. A step whose output nobody renders falls back to
 * FallbackView — a flattened key/value block. That is invisible in CI unless
 * someone remembers to look, and it shipped three times: the tool existed, the
 * renderer existed, the unit tests passed, and the app still showed raw
 * output. So the check is deliberately structural — name in, card out — with
 * real tool payloads, rather than a count of registered views.
 *
 * `renderStepReport` returns null when no view claims the tool; FallbackView
 * then returns a KeyValueView, so "not null" means "something rendered it".
 * This cannot prove the card is pretty — it proves the pipeline is wired,
 * which is the failure that actually repeated.
 */

// Tool output shapes, verbatim from the Rust side.
const IMPORT_TRADES = {
  venue: "binance",
  scanned: 4,
  posted: 2,
  skipped_already_imported: 1,
  skipped_no_ledger_effect: 1,
  pnl_total: "15.25",
  fees_total: "0.8",
  posted_ids: ["bns_fapi_1"],
  posted_ids_truncated: false,
  wallet_account_ids: ["binance-wallet"],
};

const BOOKS_SYNC = {
  venue: "binance",
  books_sync: "ok",
  window_days: 30,
  scanned: 6,
  posted: 3,
  skipped_already_imported: 3,
  skipped_no_ledger_effect: 0,
  pnl_total: "15.25",
  fees_total: "0.8",
  posted_ids: ["bns_fapi_7"],
  wallet_account_ids: ["binance-wallet"],
};

const MEXC_FILL_SYNC = {
  kind: "mexc_fill_sync",
  venue: "mexc",
  window_days: 7,
  fetched: 12,
  written: 10,
  skipped_known: 2,
  symbols: ["BTC_USDT"],
  from_ms: 1735689600000,
  to_ms: 1736294400000,
};

const MEXC_FUTURES_POSITIONS = {
  kind: "futures_positions",
  venue: "mexc",
  market: "USDTM",
  synced: 2,
  totalUnrealizedPnl: 123.45,
  positions: [
    {
      venue: "mexc",
      market: "USDTM",
      symbol: "BTCUSDT",
      positionSide: "LONG",
      positionAmt: 0.5,
      entryPrice: 98000,
      markPrice: 98246.9,
      unRealizedProfit: 123.45,
      liquidationPrice: 91000,
      notional: 49123.45,
      marginAsset: "USDT",
      isolatedWallet: 0,
      adl: 2,
      updatedAt: "2026-10-19T00:00:00Z",
    },
  ],
  orders: [],
};

const TRADE_STATS = {
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

const PNL_BY_SYMBOL = {
  rows: [
    { symbol: "BTCUSDT", realized_pnl: "25.5", commission: "0.5", volume: "500", fills: 1 },
    { symbol: "ETHUSDT", realized_pnl: "-10.25", commission: "0.3", volume: "500", fills: 1 },
  ],
  totals: { realized_pnl: "15.25", commission: "0.8", volume: "1000", fills: 2 },
};

const FEE_SUMMARY = {
  commission_total: "0.8",
  volume_total: "1000",
  rows: [{ symbol: "BTCUSDT", commission: "0.5", volume: "500" }],
  fills: 2,
};

const TRIAL_BALANCE = {
  kind: "trial_balance",
  as_of_date: "2026-10-31",
  balances: {
    cash: { account: { id: "cash", name: "Cash" }, debit_balance: "1500.5", credit_balance: null },
    sales: { account: { id: "sales", name: "Sales" }, debit_balance: null, credit_balance: "1500.5" },
  },
  total_debits: "1500.5",
  total_credits: "1500.5",
  is_balanced: true,
};

const BALANCE_SHEET = {
  kind: "balance_sheet",
  as_of_date: "2026-10-31",
  assets: [{ account: { id: "cash", name: "Cash" }, debit_balance: "1500.5" }],
  liabilities: [],
  equity: [{ account: { id: "net_income", name: "net_income" }, credit_balance: "1500.5" }],
  total_assets: "1500.5",
  total_liabilities: "0",
  total_equity: "1500.5",
  is_balanced: true,
};

const INCOME_STATEMENT = {
  kind: "income_statement",
  start_date: "2026-10-01",
  end_date: "2026-10-31",
  revenue: [{ account: { id: "sales", name: "Sales" }, credit_balance: "5000" }],
  expenses: [{ account: { id: "rent", name: "Rent" }, debit_balance: "2000" }],
  total_revenue: "5000",
  total_expenses: "2000",
  net_income: "3000",
};

const CASH_FLOW = {
  kind: "cash_flow",
  start_date: "2026-10-01",
  end_date: "2026-10-31",
  operating_activities: [{ description: "Cash sale", amount: "1500.50" }],
  investing_activities: [],
  financing_activities: [],
  net_operating_cash_flow: "1500.50",
  net_investing_cash_flow: "0",
  net_financing_cash_flow: "0",
};

const INTEGRITY = {
  kind: "integrity",
  as_of_date: "2026-10-31",
  is_valid: true,
  issues: [],
  trial_balance_total_debits: "1500.5",
  trial_balance_total_credits: "1500.5",
  balance_sheet_total_assets: "1500.5",
  balance_sheet_total_liabilities_equity: "1500.5",
};

const TRANSACTIONS = {
  count: 1,
  items: [
    {
      id: "bns_fapi_1",
      date: "2026-10-10",
      description: "Binance fapi BTCUSDT SELL fill",
      reference: null,
      entries: [
        { account_id: "binance-wallet", entry_type: "debit", amount: "25.5" },
        { account_id: "trading-gains", entry_type: "credit", amount: "25.5" },
      ],
    },
  ],
  pagination: { page: 1, page_size: 50, total_count: 1, total_pages: 1 },
};

const INVOICES = {
  count: 1,
  items: [
    {
      invoice_number: "INV/03/001",
      issue_date: "2026-10-10",
      taxable_value: "15000",
      cgst: "1350",
      sgst: "1350",
      igst: null,
      total: "17700",
    },
  ],
};

const RECONCILIATION = {
  kind: "reconciliation",
  period_start: "2026-10-01",
  period_end: "2026-10-31",
  external_source: { type: "bank", bank_name: "BCA" },
  account_ids: ["cash"],
  total_ledger_transactions: 12,
  total_external_transactions: 14,
  matched_count: 11,
  reconciliation_items: [{ status: "matched", ledger_id: "txn_1", external_id: "stmt-1", match_score: 1 }],
  summary: {
    ledger_balance: "1500.5",
    external_balance: "1498",
    difference: "2.5",
    match_rate: 0.78,
    confidence_score: 0.71,
  },
};

/** Every tool a plan can dispatch in the accounting wedge. */
const DISPATCHABLE: [string, unknown][] = [
  ["venue_fills_import", IMPORT_TRADES],
  ["books_auto_sync", BOOKS_SYNC],
  ["crypto_futures_trade_stats", TRADE_STATS],
  ["trading_pnl_by_symbol", PNL_BY_SYMBOL],
  ["trading_fee_summary", FEE_SUMMARY],
  ["ledger_trial_balance", TRIAL_BALANCE],
  ["ledger_balance_sheet", BALANCE_SHEET],
  ["ledger_income_statement", INCOME_STATEMENT],
  ["ledger_cash_flow", CASH_FLOW],
  ["ledger_integrity_check", INTEGRITY],
  ["ledger_list_transactions", TRANSACTIONS],
  ["invoice_list", INVOICES],
  ["mexc_futures_fill_sync", MEXC_FILL_SYNC],
  ["mexc_futures_positions", MEXC_FUTURES_POSITIONS],
  ["reconcile_run", RECONCILIATION],
  ["reconcile_csv", RECONCILIATION],
];

describe("dispatch gate: every accounting tool claims its output", () => {
  it.each(DISPATCHABLE)("%s renders a card, never the fallback", (tool, payload) => {
    const node = renderStepReport(tool, JSON.stringify(payload));
    expect(node, `${tool} fell through to the generic fallback`).not.toBeNull();
  });

  it("no envelope: a wrapped report payload is refused, not half-rendered", () => {
    // Guards the regression that motivated the flat-kind standard — an
    // enveloped payload used to render as a key/value block instead of a card.
    const node = renderStepReport("ledger_trial_balance", JSON.stringify({ report: TRIAL_BALANCE }));
    expect(JSON.stringify(node)).not.toContain("Trial balance");
  });

  it("venue_fills_import renders through the chat registry too", () => {
    // The tool-renderers registry (chat inspector) must not drift from the
    // canvas registry; importing the renderer directly keeps both honest.
    expect(renderVenueFillsImport(IMPORT_TRADES)).not.toBeNull();
  });

  it("mexc_futures_fill_sync renders through the chat registry too", () => {
    // Same anti-drift check as the ledger import: the chat inspector registry
    // and the canvas registry must both claim the tool.
    expect(renderMexcFuturesFillSync(MEXC_FILL_SYNC)).not.toBeNull();
  });

  it("mexc_futures_positions renders through the chat registry too", () => {
    // Same anti-drift check as the fill sync: the chat inspector registry and
    // the canvas registry must both claim the tool.
    expect(renderMexcFuturesPositions(MEXC_FUTURES_POSITIONS)).not.toBeNull();
  });
});

/** crypto_market_structure output, verbatim from the Rust tool's payload
 * builder (a 9-bar fixture: ATR/ER still in warmup, so both are null). */
const MARKET_STRUCTURE = {
  atr: null,
  candles: 9,
  er: null,
  kind: "market_structure",
  last_break: { bars_ago: 2, direction: "up", level: 12.0 },
  last_close: 12.25,
  levels: [
    { distance_pct: -26.53, last_touch_age: 3, price: 9.0, side: "support", touches: 2 },
    { distance_pct: -2.04, last_touch_age: 4, price: 12.0, side: "resistance", touches: 2 },
    { distance_pct: -18.37, last_touch_age: 1, price: 10.0, side: "support", touches: 1 },
    { distance_pct: 10.2, last_touch_age: 2, price: 13.5, side: "resistance", touches: 1 },
  ],
  skipped: [
    { have: 9, name: "atr", need: 15 },
    { have: 9, name: "er", need: 15 },
  ],
  swings: [
    { age: 1, bar: 7, kind: "low", price: 10.0 },
    { age: 2, bar: 6, kind: "high", price: 13.5 },
  ],
  symbol: { half_width: 1, interval: "4h", symbol: "BTCUSDT" },
  trend: "bullish",
};

describe("dispatch gate: market structure claims its output", () => {
  it("renders a card through the step registry", () => {
    const node = renderStepReport("crypto_market_structure", JSON.stringify(MARKET_STRUCTURE));
    expect(node).not.toBeNull();
    expect(JSON.stringify(node)).toContain("Last break");
  });

  it("renders through the chat registry too", () => {
    expect(renderMarketStructure(MARKET_STRUCTURE)).not.toBeNull();
  });

  it("refuses a foreign payload instead of half-rendering it", () => {
    expect(renderMarketStructure({ kind: "audit_data", last_close: 1 })).toBeNull();
  });
});

/** security_scan output, verbatim from the security-tools envelope builder
 * (findings are the Rust tool's camelCase projection of lonkero's
 * Vulnerability). */
const SECURITY_SCAN = {
  kind: "security_scan",
  target: "https://example.com/search",
  categories: ["xss"],
  modules: ["proof_xss_scanner", "reflection_xss_scanner", "xss_scanner", "dom_xss_scanner"],
  findings: [
    {
      vulnType: "Cross-Site Scripting (XSS)",
      severity: "HIGH",
      confidence: "HIGH",
      category: "Injection",
      url: "https://example.com/search",
      parameter: "q",
      payload: "<img src=x onerror=alert(1)>",
      description: "Payload reflected in HTML body without encoding.",
      evidence: "<img src=x onerror=alert(1)>",
      cwe: "CWE-79",
      cvss: 7.1,
      verified: true,
      falsePositive: false,
      remediation: "Context-encode user input before reflection.",
    },
  ],
  testsRun: 12,
  durationSeconds: 3.2,
  earlyTerminated: false,
  terminationReason: null,
  scannerVersion: "3.7.3",
};

const SECURITY_MODULES = {
  kind: "security_modules",
  categories: [
    {
      id: "xss",
      description: "Cross-site scripting: proof-based, reflection, DOM XSS",
      modules: ["proof_xss_scanner", "reflection_xss_scanner", "xss_scanner", "dom_xss_scanner"],
      forceMaximumIntensity: false,
    },
    {
      id: "waf_bypass",
      description: "WAF bypass probing (always runs at maximum intensity)",
      modules: ["waf_bypass"],
      forceMaximumIntensity: true,
    },
  ],
  reconModules: ["http_headers", "ssl_checker"],
  crawlModules: ["endpoint_discovery"],
  subdomainModules: ["dns_enum"],
  frameworkNote: 'category "framework" takes a framework arg',
};

describe("dispatch gate: security tools claim their output", () => {
  it.each([
    ["security_scan", SECURITY_SCAN],
    ["security_recon", { ...SECURITY_SCAN, kind: "security_recon", categories: [] }],
    ["security_subdomains", { ...SECURITY_SCAN, kind: "security_subdomains", categories: [] }],
  ])("%s renders a card, never the fallback", (tool, payload) => {
    const node = renderStepReport(tool, JSON.stringify(payload));
    expect(node, `${tool} fell through to the generic fallback`).not.toBeNull();
  });

  it("security_modules renders the category catalog", () => {
    const node = renderStepReport("security_modules", JSON.stringify(SECURITY_MODULES));
    expect(node).not.toBeNull();
    expect(JSON.stringify(node)).toContain("waf_bypass");
  });

  it("security_scan renders through the chat registry too", () => {
    expect(renderSecurityScan(SECURITY_SCAN)).not.toBeNull();
  });

  it("refuses a foreign payload instead of half-rendering it", () => {
    expect(renderSecurityScan({ kind: "audit_data", target: "x" })).toBeNull();
  });
});

/** data_fetch output, verbatim from `DataFetchTool::call` — the crypto TA
 * chain entry whose step output used to fall through to the generic fallback. */
const DATA_FETCH = {
  kind: "data",
  fileId: "doc3",
  filename: "btcusdt-1d-1735689600.csv",
  symbol: "BTCUSDT",
  interval: "1d",
  periodsPerYear: 365,
  rows: 200,
  bytes: 21504,
  columns: ["timestamp", "open", "high", "low", "close", "volume"],
  nextStep: 'run data_ta on fileId (timestamp="timestamp", close="close")',
};

describe("dispatch gate: data_fetch claims its output", () => {
  it("data_fetch renders a card, never the fallback", () => {
    const node = renderStepReport("data_fetch", JSON.stringify(DATA_FETCH));
    expect(node, "data_fetch fell through to the generic fallback").not.toBeNull();
    expect(JSON.stringify(node)).toContain("BTCUSDT");
  });

  it("refuses a foreign kind instead of half-rendering it", () => {
    expect(renderDataFetch({ ...DATA_FETCH, kind: "ta" })).toBeNull();
  });
});
