import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { renderBinanceFuturesPositions, renderMexcFuturesPositions } from "./finance";

/**
 * Render-level pins for the futures-positions card.
 *
 * Both venues share one presentational core, so the rows are asserted once per
 * venue: MEXC for the new payload, and Binance for every detail its card shows
 * today (labels, columns, the USDⓈ-M total, the COIN-M per-asset rollup) —
 * the regression guard on the extraction.
 */

const position = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});

const mexc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "futures_positions",
    venue: "mexc",
    market: "USDTM",
    synced: 2,
    totalUnrealizedPnl: 123.45,
    positions: [position(), position({ symbol: "ETHUSDT", positionSide: "SHORT", positionAmt: -2 })],
    orders: [],
    ...over,
  });

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

describe("mexc futures positions card", () => {
  it("renders the venue, the aggregate PnL and every position row", () => {
    const out = html(renderMexcFuturesPositions(mexc()));
    expect(out).toContain("MEXC positions");
    expect(out).toContain("USDTM");
    expect(out).toContain("Unrealized PnL");
    expect(out).toContain("123.45");
    expect(out).toContain("BTCUSDT LONG");
    expect(out).toContain("0.5 @ 98,000");
    expect(out).toContain("mark 98,246.9");
    expect(out).toContain("liq 91,000");
    expect(out).toContain("ETHUSDT SHORT");
    expect(out).toContain("-2 @");
  });

  it("says so when MEXC mirrors no resting orders, instead of an empty table", () => {
    const out = html(renderMexcFuturesPositions(mexc()));
    expect(out).toContain("Resting orders");
    expect(out).toContain("No resting orders mirrored.");
  });

  it("renders the resting orders when MEXC reports any", () => {
    const out = html(
      renderMexcFuturesPositions(
        mexc({
          orders: [
            {
              venue: "mexc",
              market: "USDTM",
              orderId: "77",
              symbol: "BTCUSDT",
              positionSide: "BOTH",
              side: "SELL",
              orderType: "LIMIT",
              origQty: 0.5,
              price: 100000,
              stopPrice: 0,
              executedQty: 0,
              intent: "take_profit",
              reduceOnly: true,
              closePosition: false,
              timeInForce: "GTC",
              status: "NEW",
              createdAt: "2026-10-19T00:00:00Z",
              updatedAt: "2026-10-19T00:00:00Z",
            },
          ],
        }),
      ),
    );
    expect(out).toContain("BTCUSDT TAKE_PROFIT");
    expect(out).toContain("0.5 @ 100,000");
    expect(out).toContain("reduce-only");
    expect(out).not.toContain("No resting orders mirrored.");
  });

  it("refuses junk and a wrong-kind payload so the raw-JSON card stands in", () => {
    expect(renderMexcFuturesPositions("not json at all")).toBeNull();
    expect(renderMexcFuturesPositions(JSON.stringify({ positions: [] }))).toBeNull();
    expect(renderMexcFuturesPositions(mexc({ kind: "futures_risk_audit" }))).toBeNull();
  });
});

describe("binance futures positions card still renders after the extraction", () => {
  const binance = JSON.stringify({
    synced: 3,
    totalUnrealizedPnl: 42.5,
    positions: [
      {
        symbol: "ETHUSDT",
        positionSide: "SHORT",
        positionAmt: -3,
        entryPrice: 3000,
        markPrice: 2950,
        unRealizedProfit: 150,
        liquidationPrice: 3600,
        notional: -8850,
        margin: "USDM",
      },
    ],
    openOrders: [
      {
        orderId: "5",
        symbol: "BTCUSDT",
        side: "BUY",
        type: "STOP_MARKET",
        intent: "stop_loss",
        origQty: 0.2,
        price: 0,
        stopPrice: 95000,
        reduceOnly: true,
        margin: "USDM",
      },
    ],
    coinmUnrealizedPnlByAsset: { BTC: -7.25, ETH: 0 },
  });

  it("keeps its rows, its orders, its USDⓈ-M total and its COIN-M rollup", () => {
    const out = html(renderBinanceFuturesPositions(binance));
    expect(out).toContain("ETHUSDT SHORT");
    expect(out).toContain("-3 @ 3,000");
    expect(out).toContain("mark 2,950");
    expect(out).toContain("liq 3,600");
    expect(out).toContain("Open orders");
    expect(out).toContain("BTCUSDT STOP_LOSS");
    expect(out).toContain("0.2 @ 95,000");
    expect(out).toContain("Total unrealized PnL (USDⓈ-M) 42.5");
    // Zero legs never render, and MEXC's note never leaks into the Binance card.
    expect(out).toContain("COIN-M unrealized PnL (BTC) -7.25");
    expect(out).not.toContain("COIN-M unrealized PnL (ETH)");
    expect(out).not.toContain("No resting orders mirrored.");
  });

  it("renders its empty state", () => {
    const out = html(renderBinanceFuturesPositions(JSON.stringify({ positions: [], openOrders: [] })));
    expect(out).toContain("No open Binance futures positions or orders.");
  });
});