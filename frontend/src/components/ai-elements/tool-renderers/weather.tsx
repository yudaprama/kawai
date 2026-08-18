import type { ReactNode } from "react";
import { parse, isRecord } from "./shared";

function wmo(code: number): [string, string] {
  if (code === 0) return ["☀️", "Clear"];
  if (code <= 3) return ["⛅", "Partly cloudy"];
  if (code <= 48) return ["🌫️", "Fog"];
  if (code <= 57) return ["🌦️", "Drizzle"];
  if (code <= 67) return ["🌧️", "Rain"];
  if (code <= 77) return ["❄️", "Snow"];
  if (code <= 82) return ["🌧️", "Showers"];
  if (code <= 86) return ["🌨️", "Snow showers"];
  return ["⛈️", "Thunderstorm"];
}

function firstValue(v: unknown): string | null {
  if (Array.isArray(v) && isRecord(v[0]) && typeof v[0].value === "string") {
    return v[0].value;
  }
  return null;
}

/** wttr.in ?format=j1 → { current_condition, nearest_area, weather } */
export function renderWeather(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;
  const cur =
    Array.isArray(d.current_condition) && isRecord(d.current_condition[0])
      ? d.current_condition[0]
      : null;
  if (!cur) return null;
  const tempC = typeof cur.temp_C === "string" ? cur.temp_C : null;
  if (tempC === null) return null;
  const desc = firstValue(cur.weatherDesc);
  const feels = typeof cur.FeelsLikeC === "string" ? cur.FeelsLikeC : null;
  const humidity = typeof cur.humidity === "string" ? cur.humidity : null;
  const wind = typeof cur.windspeedKmph === "string" ? cur.windspeedKmph : null;

  const area = Array.isArray(d.nearest_area) ? d.nearest_area[0] : null;
  const place = isRecord(area)
    ? [firstValue(area.areaName), firstValue(area.country)]
        .filter(Boolean)
        .join(", ")
    : null;

  const days = Array.isArray(d.weather) ? d.weather.slice(0, 5) : [];

  return (
    <div className="not-prose space-y-3">
      <div className="flex items-baseline gap-3">
        <span className="font-semibold text-3xl tabular-nums text-foreground">
          {tempC}°C
        </span>
        <div className="space-y-0.5">
          {desc && <p className="text-sm text-foreground">{desc}</p>}
          {place && <p className="text-muted-foreground text-xs">{place}</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
        {feels && <span>Feels like {feels}°C</span>}
        {humidity && <span>Humidity {humidity}%</span>}
        {wind && <span>Wind {wind} km/h</span>}
      </div>
      {days.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pt-1">
          {days.map((w, i) => {
            const day = isRecord(w) ? w : {};
            const date = typeof day.date === "string" ? day.date : null;
            const max = typeof day.maxtempC === "string" ? day.maxtempC : null;
            const min = typeof day.mintempC === "string" ? day.mintempC : null;
            return (
              <div
                key={i}
                className="min-w-[64px] rounded-md border bg-muted/40 px-2 py-1.5 text-center"
              >
                {date && (
                  <div className="text-muted-foreground text-[11px]">
                    {new Date(date).toLocaleDateString(undefined, {
                      weekday: "short",
                    })}
                  </div>
                )}
                <div className="text-xs text-foreground tabular-nums">
                  {max}° <span className="text-muted-foreground">{min}°</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** open-meteo → { daily: { time, temperature_2m_max, temperature_2m_min, weathercode } } */
export function renderForecast(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !isRecord(d.daily)) return null;
  const daily = d.daily;
  const time = Array.isArray(daily.time) ? daily.time : null;
  const max = Array.isArray(daily.temperature_2m_max)
    ? daily.temperature_2m_max
    : null;
  const min = Array.isArray(daily.temperature_2m_min)
    ? daily.temperature_2m_min
    : null;
  if (!time || !max || !min) return null;
  const codes = Array.isArray(daily.weathercode) ? daily.weathercode : [];

  return (
    <div className="not-prose flex gap-2 overflow-x-auto">
      {time.map((t, i) => {
        const [emoji, label] =
          typeof codes[i] === "number" ? wmo(codes[i] as number) : ["", ""];
        const dateStr = typeof t === "string" ? t : null;
        return (
          <div
            key={i}
            className="min-w-[76px] rounded-md border bg-muted/40 px-2 py-2 text-center"
            title={label}
          >
            {dateStr && (
              <div className="text-muted-foreground text-[11px]">
                {new Date(dateStr).toLocaleDateString(undefined, {
                  weekday: "short",
                })}
              </div>
            )}
            <div className="text-lg leading-tight">{emoji}</div>
            <div className="text-xs text-foreground tabular-nums">
              {Math.round(Number(max[i]))}°{" "}
              <span className="text-muted-foreground">
                {Math.round(Number(min[i]))}°
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
