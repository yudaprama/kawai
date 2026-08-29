import type { ComponentType, ReactNode } from "react";

import {
  BarChart3Icon,
  BookMarkedIcon,
  BookOpenIcon,
  ClapperboardIcon,
  CloudSunIcon,
  DollarSignIcon,
  Gamepad2Icon,
  GlobeIcon,
  NewspaperIcon,
  SatelliteIcon,
  SearchIcon,
  SparklesIcon,
  TrophyIcon,
  UtensilsCrossedIcon,
  WandSparklesIcon,
  WrenchIcon,
} from "lucide-react";

import { cards } from "./shared";
import { renderBibleVerse, renderQuran, renderPoem, renderDefinition } from "./typographic";
import { renderWeather, renderForecast } from "./weather";
import { renderMedia } from "./media";
import { renderCurrency, renderCryptoPrice, renderStockQuote, renderTicker24, chart, twelveSeries, klinesSeries, tiingoSeries, binanceKlineSeries, renderBinanceDepth, renderBinanceTa, renderBinanceBalances, renderBinanceOpenOrders } from "./finance";
import { jikanCards, mealCards, drinkCards, bookCards, repoCards, paperCards, quakeCards, flightStateCards, recentFlightCards, renderSpacexLaunch, spacexList } from "./cards";
import { renderGeocode, renderIpLocation, renderIss } from "./geo";
import { renderConnectorTools } from "./connector";
import { renderWebSearch, renderWebSearchSuggest } from "./search";
import { renderDataSchema, renderDataQuery, renderDataTa, renderDataChart, renderDataTables, renderDataImport } from "./data";
import { renderKnowledgeSearch } from "./knowledge";
import { renderOfficeDocument } from "./artifacts";

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

type ToolRenderer = (output: unknown) => ReactNode;

const registry: Record<string, ToolRenderer> = {
  web_search: renderWebSearch,
  web_search_suggest: renderWebSearchSuggest,
  data_schema: renderDataSchema,
  data_query: renderDataQuery,
  data_ta: renderDataTa,
  data_chart: renderDataChart,
  data_tables: renderDataTables,
  data_import: renderDataImport,
  knowledge_search: renderKnowledgeSearch,
  office_create_document: renderOfficeDocument,
  office_edit_document: renderOfficeDocument,
  connector_list_tools: renderConnectorTools,
  connector_find_tools: renderConnectorTools,
  get_bible_verse: renderBibleVerse,
  get_quran_ayah: renderQuran,
  get_quran_surah: renderQuran,
  get_quran_juz: renderQuran,
  get_random_poem: renderPoem,
  search_poems_by_title: renderPoem,
  search_poems_by_author: renderPoem,
  define_word: renderDefinition,
  get_weather: renderWeather,
  get_weather_forecast: renderForecast,
  search_photos: renderMedia,
  get_curated_photos: renderMedia,
  search_videos: renderMedia,
  currency_exchange: renderCurrency,
  get_crypto_price: renderCryptoPrice,
  get_stock_quote: renderStockQuote,
  search_anime: (o) => cards(jikanCards(o)),
  get_top_anime: (o) => cards(jikanCards(o)),
  get_seasonal_anime: (o) => cards(jikanCards(o)),
  search_manga: (o) => cards(jikanCards(o)),
  get_top_manga: (o) => cards(jikanCards(o)),
  search_recipe: (o) => cards(mealCards(o)),
  get_recipes_by_ingredient: (o) => cards(mealCards(o)),
  search_cocktail: (o) => cards(drinkCards(o)),
  get_cocktails_by_ingredient: (o) => cards(drinkCards(o)),
  search_books: (o) => cards(bookCards(o)),
  search_github_repos: (o) => cards(repoCards(o)),
  search_papers: (o) => cards(paperCards(o)),
  get_stock_history: (o) => chart(twelveSeries(o, "close")),
  get_forex_history: (o) => chart(tiingoSeries(o)),
  get_crypto_klines: (o) => chart(klinesSeries(o)),
  get_rsi: (o) => chart(twelveSeries(o, "rsi"), "RSI"),
  get_sma: (o) => chart(twelveSeries(o, "sma"), "SMA"),
  get_ema: (o) => chart(twelveSeries(o, "ema"), "EMA"),
  get_macd: (o) => chart(twelveSeries(o, "macd"), "MACD"),
  get_bbands: (o) => chart(twelveSeries(o, "middle_band"), "BBANDS (mid)"),
  get_crypto_ticker_24hr: renderTicker24,
  binance_price: renderTicker24,
  binance_depth: renderBinanceDepth,
  binance_klines: (o) => chart(binanceKlineSeries(o)),
  binance_ta_analyze: renderBinanceTa,
  binance_balances: renderBinanceBalances,
  binance_open_orders: renderBinanceOpenOrders,
  geocode: renderGeocode,
  get_ip_location: renderIpLocation,
  get_iss_position: renderIss,
  get_recent_earthquakes: (o) => cards(quakeCards(o)),
  get_earthquakes_by_region: (o) => cards(quakeCards(o)),
  get_significant_earthquakes: (o) => cards(quakeCards(o)),
  get_flights_in_area: (o) => cards(flightStateCards(o)),
  get_recent_flights: (o) => cards(recentFlightCards(o)),
  get_spacex_latest_launch: renderSpacexLaunch,
  get_spacex_rockets: (o) => cards(spacexList(o)),
  get_spacex_upcoming_launches: (o) => cards(spacexList(o)),
};

/**
 * Render a custom body for a tool's output, or `null` if the tool has no
 * custom renderer or the output shape doesn't match (caller falls back to the
 * generic JSON <ToolOutput>). `toolName` is the bare name without the `tool-`
 * prefix (e.g. "get_bible_verse").
 */
export function renderToolOutput(toolName: string, output: unknown): ReactNode {
  const fn = registry[toolName];
  if (!fn) return null;
  try {
    return fn(output);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// category icons
// ---------------------------------------------------------------------------

type IconComponent = ComponentType<{ className?: string }>;

/** Ordered [predicate, icon] — first match wins. Keeps new tools covered. */
const iconRules: Array<[(name: string) => boolean, IconComponent]> = [
  [(n) => /^data_/.test(n), BarChart3Icon],
  [(n) => /web_search|^search$/.test(n), SearchIcon],
  [(n) => n.startsWith("browser_"), GlobeIcon],
  [
    (n) =>
      /crypto|stock|forex|currency|binance|_rsi|_macd|_sma|_ema|bbands|financials|fundamentals/.test(
        n
      ),
    DollarSignIcon,
  ],
  [(n) => /weather|geocode|sun_times|ip_location|iss_|time_in/.test(n), CloudSunIcon],
  [(n) => /news|headlines/.test(n), NewspaperIcon],
  [(n) => /competition|team|match|scorers|person_info/.test(n), TrophyIcon],
  [
    (n) =>
      /anime|manga|artist|album|photos|videos|tv_show|tv_schedule|book|poem|recommendations/.test(
        n
      ),
    ClapperboardIcon,
  ],
  [(n) => /food|recipe|cocktail/.test(n), UtensilsCrossedIcon],
  [(n) => /pokemon/.test(n), Gamepad2Icon],
  [(n) => /earthquake|flights|spacex/.test(n), SatelliteIcon],
  [(n) => /bible|quran|on_this_day/.test(n), BookMarkedIcon],
  [
    (n) =>
      /wikipedia|country|define_word|papers|holidays|fruit|github|calculate/.test(n),
    BookOpenIcon,
  ],
  [
    (n) => /joke|email|trivia|star_wars|deck|cards|chuck/.test(n),
    SparklesIcon,
  ],
  [(n) => /ocr|translate|summariz|sentiment|speech|sql|detect|generate_image/.test(n), WandSparklesIcon],
];

/**
 * Pick a lucide icon for a tool by category, for use as the `icon` prop of
 * <ToolHeader>. Falls back to a wrench for unknown tools.
 */
export function toolIcon({
  toolName,
  className,
}: {
  toolName: string;
  className?: string;
}): ReactNode {
  const Icon = iconRules.find(([test]) => test(toolName))?.[1] ?? WrenchIcon;
  return <Icon className={className} />;
}
