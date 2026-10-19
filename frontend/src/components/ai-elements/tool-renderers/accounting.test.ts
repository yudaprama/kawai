import { describe, expect, it } from "vitest";

import { renderStepReport } from "@/features/workbench/components/tool-views";

import {
  renderBinanceImportTrades,
  renderBooksAutoSync,
  renderInvoiceList,
  renderLedgerBalanceSheet,
  renderLedgerCashFlow,
  renderLedgerIncomeStatement,
  renderLedgerListTransactions,
  renderLedgerTrialBalance,
  renderReconciliationReport,
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
  kind: "integrity",
  ...{
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
  kind: "integrity",
  as_of_date: validIntegrity.as_of_date,
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

  // The regression that cost a week: a renderer that is not reachable from
  // the canvas dispatch is indistinguishable from no renderer at all — the
  // step card silently falls back to raw JSON. These assert the WIRING, by
  // driving renderStepReport exactly as the workbench canvas does (string
  // output → parsed → registry).
  it("every accounting tool dispatches its own card through the canvas path", () => {
    const cases: [string, unknown, string][] = [
      ["binance_import_trades", importPayload, "Ledger import"],
      ["crypto_futures_trade_stats", statsPayload, "Trade statistics"],
      ["trading_pnl_by_symbol", pnlPayload, "Realized PnL by symbol"],
      ["trading_fee_summary", feePayload, "Fee / volume"],
      ["ledger_integrity_check", validIntegrity, "Ledger integrity"],
    ];
    for (const [tool, payload, marker] of cases) {
      const node = renderStepReport(tool, JSON.stringify(payload));
      const t = text(node);
      expect(t, `${tool} must render its own card, not the JSON fallback`).toContain(marker);
      // The fallback view is what a user sees when no view claims a tool.
      expect(t).not.toContain("json");
    }
  });

  it("an imbalanced ledger shows the imbalance, not a pass", () => {
    const t = text(renderStepReport("ledger_integrity_check", JSON.stringify(brokenIntegrity)));
    expect(t).toContain("imbalanced");
  });
});

// Engine DTO fixtures — exact shapes from accounting-core's report types and
// the transaction log envelope the tools emit.
const trialBalancePayload = {
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


const balanceSheetPayload = {
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


const incomePayload = {
  kind: "income_statement",
  start_date: "2026-10-01",
  end_date: "2026-10-31",
  revenue: [{ account: { id: "sales", name: "Sales" }, credit_balance: "5000" }],
  expenses: [{ account: { id: "rent", name: "Rent" }, debit_balance: "2000" }],
  total_revenue: "5000",
  total_expenses: "2000",
  net_income: "3000",
};


const cashFlowPayload = {
  kind: "cash_flow",
  start_date: "2026-10-01",
  end_date: "2026-10-31",
  operating_activities: [{ description: "Fees paid", amount: "-0.8" }],
  investing_activities: [],
  financing_activities: [{ description: "Owner investment", amount: "1000" }],
  net_operating_cash_flow: "-0.8",
  net_investing_cash_flow: "0",
  net_financing_cash_flow: "1000",
};


const transactionsPayload = {
  count: 2,
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
    { id: "txn_rent", date: "2026-10-02", description: "Rent", reference: null, entries: [] },
  ],
  pagination: { page: 1, page_size: 50, total_count: 2, total_pages: 1 },
};

const invoicesPayload = {
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

describe("ledger report and list renderers", () => {
  it("trial balance flattens the balance map and keeps both totals", () => {
    const t = text(renderLedgerTrialBalance(trialBalancePayload));
    expect(t).toContain("Trial balance");
    expect(t).toContain("balanced");
    expect(t).toContain("Cash"); // account NAME, not the raw map key only
    expect(t).toContain("1500.5");
  });

  it("balance sheet groups assets, liabilities and equity and shows the net_income row", () => {
    const t = text(renderLedgerBalanceSheet(balanceSheetPayload));
    expect(t).toContain("Balance sheet");
    expect(t).toContain("assets");
    expect(t).toContain("equity");
    expect(t).toContain("net_income");
  });

  it("income statement leads with net income and colours a loss as a loss", () => {
    const t = text(renderLedgerIncomeStatement(incomePayload));
    expect(t).toContain("Income statement");
    expect(t).toContain("3000");
    expect(t).toContain("2026-10-01");
  });

  it("cash flow lists the three nets and the activity rows", () => {
    const t = text(renderLedgerCashFlow(cashFlowPayload));
    expect(t).toContain("Cash flow");
    expect(t).toContain("Operating");
    expect(t).toContain("Owner investment");
    expect(t).toContain("-0.8");
  });

  it("transactions collapse each journal entry into debit/credit legs", () => {
    const t = text(renderLedgerListTransactions(transactionsPayload));
    expect(t).toContain("Transactions");
    expect(t).toContain("D binance-wallet 25.5");
    expect(t).toContain("C trading-gains 25.5");
    expect(t).toContain("page 1 of 1");
  });

  it("invoice list prints the GST breakdown columns", () => {
    const t = text(renderInvoiceList(invoicesPayload));
    expect(t).toContain("Invoices");
    expect(t).toContain("INV/03/001");
    expect(t).toContain("17700");
  });

  it("every report returns null for a non-report payload so the JSON fallback stands", () => {
    for (const render of [
      renderLedgerTrialBalance,
      renderLedgerBalanceSheet,
      renderLedgerIncomeStatement,
      renderLedgerCashFlow,
    ]) {
      expect(render(null)).toBeNull();
      expect(render({ not: "a report" })).toBeNull();
    }
    expect(renderLedgerListTransactions({ count: 0, items: [] })).toBeNull();
    expect(renderInvoiceList({ count: 0, items: [] })).toBeNull();
  });

  // The wiring regression again: a renderer that no dispatch path reaches is
  // indistinguishable from no renderer at all.
  it("all six dispatch their own card through the canvas path", () => {
    const cases: [string, unknown, string][] = [
      ["ledger_list_transactions", transactionsPayload, "Transactions"],
      ["ledger_trial_balance", trialBalancePayload, "Trial balance"],
      ["ledger_balance_sheet", balanceSheetPayload, "Balance sheet"],
      ["ledger_income_statement", incomePayload, "Income statement"],
      ["ledger_cash_flow", cashFlowPayload, "Cash flow"],
      ["invoice_list", invoicesPayload, "Invoices"],
    ];
    for (const [tool, payload, marker] of cases) {
      expect(text(renderStepReport(tool, JSON.stringify(payload))), tool).toContain(marker);
    }
  });
});

const booksSyncPayload = {
  books_sync: "ok",
  window_days: 30,
  scanned: 6,
  posted: 3,
  skipped_already_imported: 3,
  skipped_no_ledger_effect: 0,
  pnl_total: "15.25",
  fees_total: "0.8",
  posted_ids: ["bns_fapi_7"],
  wallet_account_id: "binance-wallet",
};

const reconciliationPayload = {
  kind: "reconciliation",
  ...{
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    external_source: { type: "bank", bank_name: "BCA" },
    account_ids: ["cash"],
    total_ledger_transactions: 12,
    total_external_transactions: 14,
    matched_count: 11,
    unmatched_ledger_count: 1,
    unmatched_external_count: 2,
    partial_match_count: 1,
    reconciliation_items: [
      { status: "matched", ledger_id: "txn_1", external_id: "stmt-1", match_score: 1 },
      { status: "matched", ledger_id: "txn_2", external_id: "stmt-2", match_score: 1 },
      {
        status: "unmatched_external",
        external_id: "stmt-9",
        possible_matches: [
          { ledger_id: "txn_7", external_id: "stmt-9", match_score: 0.82, differences: [{ type: "amount_difference" }] },
        ],
      },
    ],
    summary: {
      ledger_balance: "1500.5",
      external_balance: "1498",
      difference: "2.5",
      match_rate: 0.78,
      confidence_score: 0.71,
    },
  },
};

describe("audit books-sync and reconciliation renderers", () => {
  it("books_auto_sync reports the window and the posted counters", () => {
    const t = text(renderBooksAutoSync(booksSyncPayload));
    expect(t).toContain("Books synced");
    expect(t).toContain("last 30 days");
    expect(t).toContain("Newly posted");
    expect(t).toContain("15.25");
  });

  it("books_auto_sync says nothing-to-do when every fill was already recorded", () => {
    const t = text(renderBooksAutoSync({ ...booksSyncPayload, posted: 0, pnl_total: "0" }));
    expect(t).toContain("nothing to post");
  });

  it("books_auto_sync ignores a non-ok envelope", () => {
    expect(renderBooksAutoSync({ books_sync: "disabled" })).toBeNull();
    expect(renderBooksAutoSync(null)).toBeNull();
  });

  it("reconciliation leads with match rate and the balance difference", () => {
    const t = text(renderReconciliationReport(reconciliationPayload));
    expect(t).toContain("Reconciliation");
    expect(t).toContain("78.00%");
    expect(t).toContain("2.5");
    expect(t).toContain("BCA");
  });

  it("reconciliation collapses matched pairs and surfaces the unresolved rows", () => {
    const t = text(renderReconciliationReport(reconciliationPayload));
    expect(t).toContain("unresolved");
    expect(t).toContain("unmatched_external");
    expect(t).toContain("stmt-9");
    // The best-candidate score is shown as a percentage.
    expect(t).toContain("82.00%");
    // Matched pairs are counted, not listed.
    expect(t).not.toContain("txn_2");
  });

  it("reconciliation returns null without a report envelope", () => {
    expect(renderReconciliationReport({ items: [] })).toBeNull();
    expect(renderReconciliationReport(null)).toBeNull();
  });

  it("books_auto_sync and both reconcile tools dispatch through the canvas", () => {
    const cases: [string, unknown, string][] = [
      ["books_auto_sync", booksSyncPayload, "Books synced"],
      ["reconcile_run", reconciliationPayload, "Reconciliation"],
      ["reconcile_csv", reconciliationPayload, "Reconciliation"],
    ];
    for (const [tool, payload, marker] of cases) {
      expect(text(renderStepReport(tool, JSON.stringify(payload))), tool).toContain(marker);
    }
  });
});

// ── The server's own bytes ──────────────────────────────────────────────────
// Captured by running the four report TOOLS against a seeded ledger
// (crates/toolsets/accounting/examples/dump_reports.rs) and dumping their
// output. Hand-written fixtures are how a renderer "passes" while the app
// shows JSON: these are what the server actually emits, verbatim.
const REAL_REPORTS = {
  "TRIAL": {
    "as_of_date": "2026-10-31",
    "balances": {
      "cash": {
        "account": {
          "account_type": "Asset",
          "balance": "1500.50",
          "created_at": "2026-10-19T00:49:48.331943",
          "id": "cash",
          "metadata": {},
          "name": "Cash",
          "parent_id": null,
          "updated_at": "2026-10-19T00:49:48.366372"
        },
        "credit_balance": null,
        "debit_balance": "1500.50"
      },
      "rent": {
        "account": {
          "account_type": "Expense",
          "balance": "0",
          "created_at": "2026-10-19T00:49:48.361060",
          "id": "rent",
          "metadata": {},
          "name": "Rent",
          "parent_id": null,
          "updated_at": "2026-10-19T00:49:48.361060"
        },
        "credit_balance": null,
        "debit_balance": "0"
      },
      "sales": {
        "account": {
          "account_type": "Income",
          "balance": "1500.50",
          "created_at": "2026-10-19T00:49:48.359445",
          "id": "sales",
          "metadata": {},
          "name": "Sales",
          "parent_id": null,
          "updated_at": "2026-10-19T00:49:48.369112"
        },
        "credit_balance": "1500.50",
        "debit_balance": null
      }
    },
    "is_balanced": true,
    "kind": "trial_balance",
    "total_credits": "1500.50",
    "total_debits": "1500.50"
  },
  "SHEET": {
    "as_of_date": "2026-10-31",
    "assets": [
      {
        "account": {
          "account_type": "Asset",
          "balance": "1500.50",
          "created_at": "2026-10-19T00:49:48.331943",
          "id": "cash",
          "metadata": {},
          "name": "Cash",
          "parent_id": null,
          "updated_at": "2026-10-19T00:49:48.366372"
        },
        "credit_balance": null,
        "debit_balance": "1500.50"
      }
    ],
    "equity": [
      {
        "account": {
          "account_type": "Equity",
          "balance": "0",
          "created_at": "2026-10-19T00:49:48.373617",
          "id": "net_income",
          "metadata": {},
          "name": "Net Income",
          "parent_id": null,
          "updated_at": "2026-10-19T00:49:48.373617"
        },
        "credit_balance": "1500.50",
        "debit_balance": null
      }
    ],
    "is_balanced": true,
    "kind": "balance_sheet",
    "liabilities": [],
    "total_assets": "1500.50",
    "total_equity": "1500.50",
    "total_liabilities": "0"
  },
  "INCOME": {
    "end_date": "2026-10-31",
    "expenses": [
      {
        "account": {
          "account_type": "Expense",
          "balance": "0",
          "created_at": "2026-10-19T00:49:48.361060",
          "id": "rent",
          "metadata": {},
          "name": "Rent",
          "parent_id": null,
          "updated_at": "2026-10-19T00:49:48.361060"
        },
        "credit_balance": null,
        "debit_balance": "0"
      }
    ],
    "kind": "income_statement",
    "net_income": "1500.50",
    "revenue": [
      {
        "account": {
          "account_type": "Income",
          "balance": "1500.50",
          "created_at": "2026-10-19T00:49:48.359445",
          "id": "sales",
          "metadata": {},
          "name": "Sales",
          "parent_id": null,
          "updated_at": "2026-10-19T00:49:48.369112"
        },
        "credit_balance": "1500.50",
        "debit_balance": null
      }
    ],
    "start_date": "2026-10-01",
    "total_expenses": "0",
    "total_revenue": "1500.50"
  },
  "CASHFLOW": {
    "end_date": "2026-10-31",
    "financing_activities": [],
    "investing_activities": [],
    "kind": "cash_flow",
    "net_cash_flow": "1500.50",
    "net_financing_cash_flow": "0",
    "net_investing_cash_flow": "0",
    "net_operating_cash_flow": "1500.50",
    "operating_activities": [
      {
        "amount": "1500.50",
        "description": "Cash sale"
      }
    ],
    "start_date": "2026-10-01"
  }
} as const;

describe("report renderers against the server's real payloads", () => {
  it("trial balance renders the engine's exact payload", () => {
    expect(text(renderStepReport("ledger_trial_balance", JSON.stringify(REAL_REPORTS.TRIAL)))).toContain(
      "Trial balance",
    );
  });

  it("balance sheet renders the engine's exact payload", () => {
    expect(text(renderStepReport("ledger_balance_sheet", JSON.stringify(REAL_REPORTS.SHEET)))).toContain(
      "Balance sheet",
    );
  });

  it("income statement renders the engine's exact payload", () => {
    expect(text(renderStepReport("ledger_income_statement", JSON.stringify(REAL_REPORTS.INCOME)))).toContain(
      "Income statement",
    );
  });

  it("cash flow renders the engine's exact payload", () => {
    expect(
      text(renderStepReport("ledger_cash_flow", JSON.stringify(REAL_REPORTS.CASHFLOW))),
    ).toContain("Cash flow");
  });
});

// One shape only: flat + `kind`. A payload of another kind is refused so the
// generic fallback stands — the renderer never renders a foreign payload.
describe("report renderers are kind-guarded", () => {
  it("refuses a payload whose kind belongs to another view", () => {
    expect(renderLedgerTrialBalance(balanceSheetPayload)).toBeNull();
    expect(renderLedgerBalanceSheet(incomePayload)).toBeNull();
    expect(renderLedgerCashFlow(trialBalancePayload)).toBeNull();
    expect(renderReconciliationReport(incomePayload)).toBeNull();
    expect(renderLedgerIntegrityCheck(incomePayload)).toBeNull();
  });

  it("refuses the legacy enveloped shape outright", () => {
    const enveloped = { report: REAL_REPORTS.TRIAL };
    expect(renderLedgerTrialBalance(enveloped)).toBeNull();
  });
});
