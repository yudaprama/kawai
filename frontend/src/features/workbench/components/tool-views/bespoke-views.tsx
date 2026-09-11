import type { ReactNode } from "react";

import { fmtDate, fmtNumber, isRecord, pick, toNum } from "./format";
import { KeyValueView, Pill, SectionLabel } from "./atoms";
import { GenericHumanView } from "./generic-views";
import { NewsListView } from "./news-views";
import { FinancialTableView } from "./finance-views";

// ── Bespoke top-10 (Fase 2 polish) ──────────────────────────────────────────

export function PokemonView({ data }: { data: Record<string, unknown> }) {
  const name = pick<string>(data, "name") ?? "Unknown";
  const id = toNum(pick(data, "id"));
  const height = toNum(pick(data, "height"));
  const weight = toNum(pick(data, "weight"));
  const sprite =
    (isRecord(data.sprites) && typeof data.sprites.front_default === "string" ? data.sprites.front_default : null) ??
    (isRecord(data.sprites) &&
    isRecord(data.sprites.other) &&
    isRecord((data.sprites.other as Record<string, unknown>)["official-artwork"])
      ? (((data.sprites.other as Record<string, unknown>)["official-artwork"] as Record<string, unknown>)
          .front_default as string | undefined)
      : undefined);
  const types = Array.isArray(data.types)
    ? data.types
        .map((t) => (isRecord(t) && isRecord(t.type) ? pick<string>(t.type as Record<string, unknown>, "name") : null))
        .filter(Boolean)
        .join(" · ")
    : null;
  const abilities = Array.isArray(data.abilities)
    ? data.abilities
        .map((a) =>
          isRecord(a) && isRecord(a.ability) ? pick<string>(a.ability as Record<string, unknown>, "name") : null,
        )
        .filter(Boolean)
        .slice(0, 4)
        .join(", ")
    : null;
  const stats = Array.isArray(data.stats)
    ? data.stats
        .map((s) => {
          if (!isRecord(s) || !isRecord(s.stat)) return null;
          const n = pick<string>(s.stat as Record<string, unknown>, "name");
          const v = toNum(s.base_stat);
          return n && v != null ? `${n}: ${v}` : null;
        })
        .filter(Boolean)
        .join(" · ")
    : null;
  return (
    <div className="space-y-3">
      <div className="flex gap-4 items-start">
        {sprite && <img src={sprite} alt={name} className="size-20 rounded-lg border bg-muted object-contain p-1" />}
        <div className="space-y-1">
          <h4 className="font-semibold text-base capitalize">
            {name} {id != null && <span className="text-muted-foreground font-mono text-xs">#{id}</span>}
          </h4>
          {types && <div className="text-sm text-muted-foreground capitalize">{types}</div>}
          {abilities && <div className="text-xs text-muted-foreground">Abilities: {abilities}</div>}
        </div>
      </div>
      <KeyValueView
        entries={
          [
            ["Tinggi", height != null ? `${height / 10} m` : null],
            ["Berat", weight != null ? `${weight / 10} kg` : null],
            ["Stats", stats],
          ].filter(([, v]) => v != null) as Array<[string, ReactNode]>
        }
      />
    </div>
  );
}

export function CountryView({ data }: { data: Record<string, unknown> }) {
  const rec = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : data;
  const d = isRecord(rec) ? rec : data;
  const name = isRecord(d.name)
    ? (pick<string>(d.name as Record<string, unknown>, "common") ?? pick<string>(d, "name"))
    : pick<string>(d, "name");
  const capital = Array.isArray(d.capital) ? (d.capital as string[]).join(", ") : pick<string>(d, "capital");
  const region = pick<string>(d, "region");
  const subregion = pick<string>(d, "subregion");
  const pop = toNum(pick(d, "population"));
  const area = toNum(pick(d, "area"));
  const flag = isRecord(d.flags)
    ? pick<string>(d.flags as Record<string, unknown>, "png", "svg")
    : pick<string>(d, "flag");
  const currencies = isRecord(d.currencies)
    ? Object.entries(d.currencies as Record<string, unknown>)
        .map(([code, cur]) =>
          isRecord(cur) ? `${code} (${pick<string>(cur as Record<string, unknown>, "name") ?? ""})` : code,
        )
        .join(", ")
    : null;
  const langs = isRecord(d.languages)
    ? Object.values(d.languages as Record<string, unknown>)
        .filter((v): v is string => typeof v === "string")
        .join(", ")
    : null;
  return (
    <div className="space-y-3">
      <div className="flex gap-3 items-center">
        {flag && <img src={flag} alt={name ?? "flag"} className="h-10 w-16 rounded border object-cover" />}
        <h4 className="font-semibold text-base">{name ?? "Country"}</h4>
        {region && <Pill>{[region, subregion].filter(Boolean).join(" · ")}</Pill>}
      </div>
      <KeyValueView
        entries={
          [
            ["Ibu kota", capital],
            ["Populasi", pop != null ? fmtNumber(pop) : null],
            ["Luas", area != null ? `${fmtNumber(area)} km²` : null],
            ["Mata uang", currencies],
            ["Bahasa", langs],
          ].filter(([, v]) => v != null) as Array<[string, ReactNode]>
        }
      />
    </div>
  );
}

export function GithubRepoView({ data }: { data: Record<string, unknown> }) {
  const full =
    pick<string>(data, "full_name", "fullName") ??
    (pick<string>(data, "name") ? `${pick<string>(data, "owner") ?? ""}/${pick<string>(data, "name")}` : null);
  const desc = pick<string>(data, "description");
  const stars = toNum(pick(data, "stargazers_count", "stars"));
  const forks = toNum(pick(data, "forks_count", "forks"));
  const issues = toNum(pick(data, "open_issues_count", "open_issues"));
  const lang = pick<string>(data, "language");
  const license = isRecord(data.license)
    ? pick<string>(data.license as Record<string, unknown>, "name", "spdx_id")
    : pick<string>(data, "license");
  const updated = fmtDate(pick(data, "updated_at", "pushed_at"));
  const url = pick<string>(data, "html_url", "url");
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2 flex-wrap">
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="font-mono font-semibold text-sm hover:underline">
            {full ?? "repo"}
          </a>
        ) : (
          <span className="font-mono font-semibold text-sm">{full ?? "repo"}</span>
        )}
        {lang && <Pill>{lang}</Pill>}
        {license && <span className="text-muted-foreground text-xs">{license}</span>}
      </div>
      {desc && <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>}
      <KeyValueView
        entries={
          [
            ["Stars", stars != null ? fmtNumber(stars) : null],
            ["Forks", forks != null ? fmtNumber(forks) : null],
            ["Open issues", issues != null ? fmtNumber(issues) : null],
            ["Updated", updated],
          ].filter(([, v]) => v != null) as Array<[string, ReactNode]>
        }
      />
    </div>
  );
}

export function TimeZoneView({ data }: { data: Record<string, unknown> }) {
  const dt = pick<string>(data, "dateTime", "datetime", "currentLocalTime", "time");
  const zone = pick<string>(data, "timeZone", "timezone", "zone");
  const dst = data.dstActive ?? data.isDst ?? data.dst;
  return (
    <KeyValueView
      entries={
        [
          ["Waktu lokal", dt ? (fmtDate(dt) ?? dt) : null],
          ["Zona", zone],
          ["DST", typeof dst === "boolean" ? (dst ? "aktif" : "tidak") : dst != null ? String(dst) : null],
        ].filter(([, v]) => v != null) as Array<[string, ReactNode]>
      }
    />
  );
}

export function TopHeadlinesView({ data }: { data: unknown }) {
  return <NewsListView data={data} />;
}

export function DrawCardsView({ data }: { data: Record<string, unknown> }) {
  const cardsArr = Array.isArray(data.cards) ? data.cards.filter(isRecord) : [];
  const remaining = toNum(pick(data, "remaining"));
  if (cardsArr.length === 0) return <GenericHumanView data={data} raw={JSON.stringify(data)} />;
  return (
    <div className="space-y-2">
      <SectionLabel>
        {cardsArr.length} kartu ditarik {remaining != null ? `· sisa ${remaining} kartu` : ""}
      </SectionLabel>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {cardsArr.slice(0, 12).map((c, i) => {
          const code = pick<string>(c, "code", "value");
          const suit = pick<string>(c, "suit");
          const img = pick<string>(c, "image", "images");
          const label = `${pick<string>(c, "value") ?? code ?? "?"} ${suit ?? ""}`.trim();
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: draw results may legitimately contain duplicate codes
            <div key={i} className="bg-card rounded-lg border p-2 text-center">
              {img ? <img src={img} alt={label} className="w-full h-auto rounded" loading="lazy" /> : null}
              <div className="font-mono text-xs mt-1">{label}</div>
              {code && <div className="text-muted-foreground font-mono text-[10px]">{code}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SunTimesView({ data }: { data: Record<string, unknown> }) {
  const res = isRecord(data.results) ? (data.results as Record<string, unknown>) : data;
  const sunrise = pick<string>(res, "sunrise");
  const sunset = pick<string>(res, "sunset");
  const noon = pick<string>(res, "solar_noon");
  const len = pick<string>(res, "day_length");
  const twilightBegin = pick<string>(res, "civil_twilight_begin");
  const twilightEnd = pick<string>(res, "civil_twilight_end");
  return (
    <KeyValueView
      entries={
        [
          ["Sunrise", sunrise ? (fmtDate(sunrise) ?? sunrise) : null],
          ["Sunset", sunset ? (fmtDate(sunset) ?? sunset) : null],
          ["Solar noon", noon ? (fmtDate(noon) ?? noon) : null],
          [
            "Day length",
            len != null && /^\d+$/.test(len)
              ? `${Math.floor(Number(len) / 3600)}j ${Math.floor((Number(len) % 3600) / 60)}m`
              : len,
          ],
          ["Civil twilight", twilightBegin && twilightEnd ? `${twilightBegin} → ${twilightEnd}` : null],
        ].filter(([, v]) => v != null) as Array<[string, ReactNode]>
      }
    />
  );
}

export function StockFinancialsView({ data }: { data: unknown }) {
  if (isRecord(data) && Array.isArray((data as Record<string, unknown>).statements))
    return <FinancialTableView data={data as Record<string, unknown>} />;
  return <GenericHumanView data={data} raw={typeof data === "string" ? data : JSON.stringify(data)} />;
}
