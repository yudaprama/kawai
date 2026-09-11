import type { ReactNode } from "react";

import { cards } from "@/components/ai-elements/tool-renderers/shared";
import { renderKnowledgeSearch } from "@/components/ai-elements/tool-renderers/knowledge";
import { renderWebSearch, renderWebSearchSuggest } from "@/components/ai-elements/tool-renderers/search";
import { renderConnectorTools } from "@/components/ai-elements/tool-renderers/connector";
import {
  renderBibleVerse,
  renderDefinition,
  renderPoem,
  renderQuran,
} from "@/components/ai-elements/tool-renderers/typographic";
import { renderForecast, renderWeather } from "@/components/ai-elements/tool-renderers/weather";
import { renderMedia } from "@/components/ai-elements/tool-renderers/media";
import {
  chart,
  klinesSeries,
  renderCryptoPrice,
  renderCurrency,
  renderTicker24,
  tiingoSeries,
  twelveSeries,
} from "@/components/ai-elements/tool-renderers/finance";
import { renderGeocode, renderIpLocation, renderIss } from "@/components/ai-elements/tool-renderers/geo";
import {
  bookCards,
  drinkCards,
  flightStateCards,
  jikanCards,
  mealCards,
  paperCards,
  quakeCards,
  recentFlightCards,
  renderSpacexLaunch,
  repoCards,
  spacexList,
} from "@/components/ai-elements/tool-renderers/cards";

import { isRecord, parseMaybeJson } from "./format";
import { FallbackView } from "./fallback";
import {
  binanceKlineSeries,
  renderBinanceBalances,
  renderBinanceDepth,
  renderBinanceOpenOrders,
  renderBinanceTa,
} from "@/components/ai-elements/tool-renderers/finance";
import {
  renderDataChart,
  renderDataImport,
  renderDataQuery,
  renderDataSchema,
  renderDataTa,
  renderDataTables,
} from "@/components/ai-elements/tool-renderers/data";

// ── family views — one file per tool family ─────────────────────────────────
import { KeyValueView } from "./atoms";
import { FileCreatedView, FileListView } from "./file-views";
import { BrowserView, CalculationView, CodeGraphView, GenericHumanView } from "./generic-views";
import { MarkdownView, PdfPagesView } from "./markdown-views";
import { MemoryGraphView, MemoryLinesView, SessionStepResultsView } from "./memory-views";
import { NewsListView } from "./news-views";
import {
  CountryView,
  DrawCardsView,
  GithubRepoView,
  PokemonView,
  StockFinancialsView,
  SunTimesView,
  TimeZoneView,
  TopHeadlinesView,
} from "./bespoke-views";
import {
  CryptoMarketView,
  CryptoSearchView,
  FinancialTableView,
  PredictionMarketsView,
  SocialFeedView,
  StockQuoteView,
  TrendingView,
} from "./finance-views";

// ── registry ────────────────────────────────────────────────────────────────

type StepView = (parsed: unknown, raw: string) => ReactNode;

/** Map tool name → human view. Categories serve many tools; anything
 *  unregistered falls through to the heuristic FallbackView. */
const registry: Record<string, StepView> = {
  // markdown documents
  office_read_document: (p) => {
    const md = unwrapMarkdown(p);
    return md ? <MarkdownView text={md} /> : null;
  },
  office_create_document: (p) => {
    const md = unwrapMarkdown(p);
    return md ? <MarkdownView text={md} /> : null;
  },
  pdf_create_from_markdown: (p) => {
    const v = unwrapEnvelope(p);
    return v ? <FileCreatedView data={v} /> : null;
  },

  // pdf
  pdf_extract_text: (p) => (isRecord(p) ? <PdfPagesView data={p} /> : null),
  pdf_search_text: (p) =>
    isRecord(p)
      ? genericKv({
          pattern: p.pattern,
          jumlah_hasil: Array.isArray(p.matches) ? p.matches.length : undefined,
          matches: p.matches,
        })
      : null,
  pdf_info: (p) => (isRecord(p) ? genericKv(isRecord(p.metadata) ? p.metadata : p) : null),
  pdf_metadata_get: (p) => (isRecord(p) ? genericKv(isRecord(p.metadata) ? p.metadata : p) : null),
  pdf_page_info: (p) => (isRecord(p) ? genericKv(p) : null),

  // office files
  office_list_files: (p) => (isRecord(p) ? <FileListView data={p} /> : null),
  office_document_info: (p) => (isRecord(p) ? genericKv(p) : null),

  // memory
  memory_search: (_, raw) => <MemoryLinesView text={raw} />,
  memory_graph_search: (_, raw) => <MemoryGraphView text={raw} />,

  // session history — earlier runs' step outputs (cross-run read surface)
  session_step_results: (p) => (isRecord(p) ? <SessionStepResultsView data={p} /> : null),

  // web search — reuse the shared search result renderer
  web_search: (p) => renderWebSearch(p),
  web_search_suggest: (p) => renderWebSearchSuggest(p),

  // knowledge — reuse the vendored renderer (same RagHit shape)
  knowledge_search: (p) => renderKnowledgeSearch(p),

  // finance — quotes & history (StockQuoteView stays kawai-specific; history unified to web chart)
  get_stock_price: (p) => (isRecord(p) ? <StockQuoteView data={p} /> : null),
  get_stock_quote: (p) => (isRecord(p) ? <StockQuoteView data={p} /> : null),
  get_stock_detail: (p) => (isRecord(p) ? <StockQuoteView data={p} /> : null),
  trending_stocks: (p) => (isRecord(p) ? <TrendingView data={p} /> : null),
  stock_social_feed: (p) => <SocialFeedView data={p} />,
  get_stock_news: (p) => <NewsListView data={p} />,
  get_global_news: (p) => <NewsListView data={p} />,
  get_reddit_posts: (p) => <NewsListView data={p} />,

  // finance — statements
  get_balance_sheet: (p) => (isRecord(p) ? <FinancialTableView data={p} /> : null),
  get_income_statement: (p) => (isRecord(p) ? <FinancialTableView data={p} /> : null),
  get_cashflow: (p) => (isRecord(p) ? <FinancialTableView data={p} /> : null),

  // ── Fase 1: promote web 52 renderers → Workbench (reuse tool-renderers) ──
  // connector
  connector_list_tools: (p) => renderConnectorTools(p),
  connector_find_tools: (p) => renderConnectorTools(p),

  // typographic
  get_bible_verse: (p) => renderBibleVerse(p),
  get_quran_ayah: (p) => renderQuran(p),
  get_quran_surah: (p) => renderQuran(p),
  get_quran_juz: (p) => renderQuran(p),
  get_random_poem: (p) => renderPoem(p),
  search_poems_by_title: (p) => renderPoem(p),
  search_poems_by_author: (p) => renderPoem(p),
  define_word: (p) => renderDefinition(p),

  // weather
  get_weather: (p) => renderWeather(p),
  get_weather_forecast: (p) => renderForecast(p),

  // media (Pexels)
  search_photos: (p) => renderMedia(p),
  get_curated_photos: (p) => renderMedia(p),
  search_videos: (p) => renderMedia(p),

  // finance — currency/crypto
  currency_exchange: (p) => renderCurrency(p),
  get_crypto_price: (p) => renderCryptoPrice(p),
  get_crypto_ticker_24hr: (p) => renderTicker24(p),

  // finance — chart series (shared ChartCard)
  get_stock_history: (p) => chart(twelveSeries(p, "close")),
  get_forex_history: (p) => chart(tiingoSeries(p)),
  get_crypto_klines: (p) => chart(klinesSeries(p)),
  get_rsi: (p) => chart(twelveSeries(p, "rsi"), "RSI"),
  get_sma: (p) => chart(twelveSeries(p, "sma"), "SMA"),
  get_ema: (p) => chart(twelveSeries(p, "ema"), "EMA"),
  get_macd: (p) => chart(twelveSeries(p, "macd"), "MACD"),
  get_bbands: (p) => chart(twelveSeries(p, "middle_band"), "BBANDS (mid)"),

  // anime/manga/books/papers
  search_anime: (p) => cards(jikanCards(p)),
  get_top_anime: (p) => cards(jikanCards(p)),
  get_seasonal_anime: (p) => cards(jikanCards(p)),
  search_manga: (p) => cards(jikanCards(p)),
  get_top_manga: (p) => cards(jikanCards(p)),
  search_recipe: (p) => cards(mealCards(p)),
  get_recipes_by_ingredient: (p) => cards(mealCards(p)),
  search_cocktail: (p) => cards(drinkCards(p)),
  get_cocktails_by_ingredient: (p) => cards(drinkCards(p)),
  search_books: (p) => cards(bookCards(p)),
  search_github_repos: (p) => cards(repoCards(p)),
  search_papers: (p) => cards(paperCards(p)),

  // geo / space / quakes / flights
  geocode: (p) => renderGeocode(p),
  get_ip_location: (p) => renderIpLocation(p),
  get_iss_position: (p) => renderIss(p),
  get_recent_earthquakes: (p) => cards(quakeCards(p)),
  get_earthquakes_by_region: (p) => cards(quakeCards(p)),
  get_significant_earthquakes: (p) => cards(quakeCards(p)),
  get_flights_in_area: (p) => cards(flightStateCards(p)),
  get_recent_flights: (p) => cards(recentFlightCards(p)),
  get_spacex_latest_launch: (p) => renderSpacexLaunch(p),
  get_spacex_rockets: (p) => cards(spacexList(p)),
  get_spacex_upcoming_launches: (p) => cards(spacexList(p)),

  // ── Fase 2: eliminate FallbackView — every remaining tool gets a human view ──
  // browser (plain HTTP / webview chain)
  browser_content_extract: (p) => (isRecord(p) ? <BrowserView data={p} /> : <MarkdownView text={String(p)} />),
  browser_json_extract: (p, raw) => (isRecord(p) ? <GenericHumanView data={p} raw={raw} /> : null),
  browser_links_extract: (p) => (isRecord(p) ? <GenericHumanView data={p} raw={JSON.stringify(p)} /> : null),
  browser_markdown_extract: (p) => (isRecord(p) ? <BrowserView data={p} /> : null),
  browser_scrape_elements: (p, raw) => (isRecord(p) ? <GenericHumanView data={p} raw={raw} /> : null),
  web_read: (p) => (isRecord(p) ? <BrowserView data={p} /> : null),

  // codegraph
  codegraph_explore: (p, raw) => <CodeGraphView data={p} raw={raw} />,
  codegraph_status: (p) => (isRecord(p) ? <GenericHumanView data={p} raw={JSON.stringify(p)} /> : null),

  // composio (tool discovery)
  composio_list_toolkits: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  composio_list_tools: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  composio_execute: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  composio_authorize: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  composio_list_connections: (p, raw) => <GenericHumanView data={p} raw={raw} />,

  // calculation
  calculate: (p) => (isRecord(p) ? <CalculationView data={p} /> : null),

  // binance (keyless market + TA)
  binance_price: (p) => renderTicker24(p),
  binance_klines: (p) => chart(binanceKlineSeries(p)),
  binance_depth: (p) => renderBinanceDepth(p),
  binance_ta_analyze: (p) => renderBinanceTa(p),
  binance_balances: (p) => renderBinanceBalances(p),
  binance_open_orders: (p) => renderBinanceOpenOrders(p),

  // analytics — data_* (polars over office store / sql)
  data_schema: (p) => renderDataSchema(p),
  data_query: (p) => renderDataQuery(p),
  data_query_nl: (p) => renderDataQuery(p),
  data_ta: (p) => renderDataTa(p),
  data_chart: (p) => renderDataChart(p),
  data_tables: (p) => renderDataTables(p),
  data_import: (p) => renderDataImport(p),

  // office / pdf remaining
  office_create: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  office_create_deck: (p) => {
    const v = unwrapEnvelope(p);
    return v ? <FileCreatedView data={v} /> : null;
  },
  office_edit: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  office_export_deck: (p) => {
    const v = unwrapEnvelope(p);
    return v ? <FileCreatedView data={v} /> : null;
  },
  office_markdown_read: (p) =>
    isRecord(p) && typeof p.markdown === "string" ? <MarkdownView text={p.markdown} /> : null,
  office_restore_backup: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  convert_document: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  new_deck: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  extract_text: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  pdf_extract_images: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  pdf_merge: (p) => {
    const v = unwrapEnvelope(p);
    return v ? <FileCreatedView data={v} /> : null;
  },
  pdf_split: (p) => (isRecord(p) && isRecord(p.data) ? <FileListView data={p.data} /> : null),
  pdf_metadata_set: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  pdf_replace_text: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  pdf_search_replace: (p, raw) => <GenericHumanView data={p} raw={raw} />,

  // diagrams / graph
  diagram: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  diagram_generate: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  diagram_render: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  graph_list: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  graph_search: (p, raw) => <GenericHumanView data={p} raw={raw} />,

  // generated — gaming / food-drink / knowledge / utility (cards / key-value humanized)
  get_all_fruits: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_anime_detail: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_book_by_isbn: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_chuck_norris_joke: (p) => (isRecord(p) && typeof p.value === "string" ? <MarkdownView text={p.value} /> : null),
  get_competitions: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_competition_matches: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_competition_scorers: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_competition_standings: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  // bespoke top-10 (polish)
  get_country_info: (p) => (isRecord(p) ? <CountryView data={p} /> : null),
  get_crypto_market: (p) => <CryptoMarketView data={p} />,
  get_crypto_orderbook: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_earnings_data: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_food_by_barcode: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_fruit_info: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_github_repo: (p) => (isRecord(p) ? <GithubRepoView data={p} /> : null),
  get_github_user: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_insider_transactions: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_joke: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_macro_indicators: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_match_detail: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_news_sentiment: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_news_sources: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_on_this_day: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_person_info: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_pokemon: (p) => (isRecord(p) ? <PokemonView data={p} /> : null),
  get_pokemon_species: (p) => (isRecord(p) ? <PokemonView data={p} /> : null),
  get_pokemon_type: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_prediction_markets: (p) => <PredictionMarketsView data={p} />,
  get_public_holidays: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_random_cocktail: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_random_recipe: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_recommendations: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_sector_performance: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_star_wars_films: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_star_wars_planet: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_stock_financials: (p) => <StockFinancialsView data={p} />,
  get_stock_fundamentals: (p) => <StockFinancialsView data={p} />,
  get_sun_times: (p) => (isRecord(p) ? <SunTimesView data={p} /> : null),
  get_supported_currencies: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_team_info: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_team_matches: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_time_in_timezone: (p) => (isRecord(p) ? <TimeZoneView data={p} /> : null),
  get_top_news: (p) => <TopHeadlinesView data={p} />,
  get_trivia_categories: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_trivia_questions: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_tv_schedule: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_tv_show_detail: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_tv_show_seasons: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  get_verified_market_snapshot: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  draw_cards: (p) => (isRecord(p) ? <DrawCardsView data={p} /> : null),
  list_recipe_categories: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  search_album: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  office_edit_document: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  search_artist: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  search_crypto: (p) => (isRecord(p) ? <CryptoSearchView data={p} /> : null),
  search_food_products: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  search_star_wars_people: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  search_stock: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  search_tv_show: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  stock_sentiment: (p, raw) => <GenericHumanView data={p} raw={raw} />,
  validate_email: (p, raw) => <GenericHumanView data={p} raw={raw} />,
};

function genericKv(o: Record<string, unknown>): ReactNode {
  const entries: Array<[string, ReactNode]> = [];
  for (const [k, v] of Object.entries(o)) {
    if (v == null) continue;
    const label = k.replace(/_/g, " ");
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      entries.push([label, String(v)]);
    } else if (Array.isArray(v)) {
      entries.push([
        label,
        v.length === 0 ? (
          "—"
        ) : (
          <code className="font-mono text-xs" key={label}>
            {JSON.stringify(v).slice(0, 300)}
          </code>
        ),
      ]);
    } else if (isRecord(v)) {
      entries.push([
        label,
        <code className="font-mono text-xs" key={label}>
          {JSON.stringify(v).slice(0, 300)}
        </code>,
      ]);
    }
  }
  return entries.length > 0 ? <KeyValueView entries={entries} /> : null;
}

// ── public API ──────────────────────────────────────────────────────────────

/** Render a supervisor step's ≤2000-char output preview for humans. Always
 *  returns something readable — dedicated view → heuristic fallback. */
function unwrapEnvelope(p: unknown): Record<string, unknown> | null {
  if (!isRecord(p)) return null;
  if (isRecord(p.data) && isRecord(p.data.file)) {
    return p.data as Record<string, unknown>;
  }
  return p;
}

function unwrapMarkdown(p: unknown): string | null {
  if (!isRecord(p)) return null;
  if (typeof p.markdown === "string") return p.markdown;
  if (isRecord(p.data) && typeof p.data.markdown === "string") return p.data.markdown;
  return null;
}

export function renderStepReport(tool: string, output: string): ReactNode {
  const parsed = parseMaybeJson(output);
  const fn = registry[tool];
  if (fn) {
    try {
      const view = fn(parsed, output);
      if (view != null) return view;
    } catch {
      // fall through to the heuristic view
    }
  }
  return <FallbackView output={output} />;
}
