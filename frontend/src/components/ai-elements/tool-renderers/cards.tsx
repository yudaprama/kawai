import type { ReactNode } from "react";
import { parse, isRecord, str, cards, type CardItem } from "./shared";

/** Jikan (anime/manga) → { data: [{ title, images.jpg.image_url, score, synopsis }] } */
export function jikanCards(output: unknown): CardItem[] | null {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.data)) return null;
  return d.data.flatMap((e): CardItem[] => {
    if (!isRecord(e)) return [];
    const title = str(e.title) ?? str(e.title_english);
    if (!title) return [];
    const img =
      isRecord(e.images) && isRecord(e.images.jpg)
        ? str(e.images.jpg.image_url)
        : undefined;
    return [
      {
        title,
        image: img,
        subtitle: str(e.synopsis),
        meta:
          typeof e.score === "number" ? `★ ${e.score}` : undefined,
        href: str(e.url),
      },
    ];
  });
}

/** TheMealDB → { meals: [{ strMeal, strMealThumb, strCategory, strArea }] } */
export function mealCards(output: unknown): CardItem[] | null {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.meals)) return null;
  return d.meals.flatMap((m): CardItem[] => {
    if (!isRecord(m)) return [];
    const title = str(m.strMeal);
    if (!title) return [];
    const meta = [str(m.strCategory), str(m.strArea)].filter(Boolean).join(" · ");
    return [{ title, image: str(m.strMealThumb), meta: meta || undefined }];
  });
}

/** TheCocktailDB → { drinks: [{ strDrink, strDrinkThumb, strCategory }] } */
export function drinkCards(output: unknown): CardItem[] | null {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.drinks)) return null;
  return d.drinks.flatMap((m): CardItem[] => {
    if (!isRecord(m)) return [];
    const title = str(m.strDrink);
    if (!title) return [];
    return [{ title, image: str(m.strDrinkThumb), meta: str(m.strCategory) }];
  });
}

/** Open Library → { docs: [{ title, author_name, first_publish_year, cover_i }] } */
export function bookCards(output: unknown): CardItem[] | null {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.docs)) return null;
  return d.docs.flatMap((b): CardItem[] => {
    if (!isRecord(b)) return [];
    const title = str(b.title);
    if (!title) return [];
    const author = Array.isArray(b.author_name)
      ? b.author_name.filter((a): a is string => typeof a === "string").slice(0, 2).join(", ")
      : undefined;
    const year =
      typeof b.first_publish_year === "number"
        ? String(b.first_publish_year)
        : undefined;
    const cover =
      typeof b.cover_i === "number"
        ? `https://covers.openlibrary.org/b/id/${b.cover_i}-M.jpg`
        : undefined;
    return [
      {
        title,
        image: cover,
        subtitle: author,
        meta: year,
      },
    ];
  });
}

/** GitHub search → { items: [{ full_name, description, stargazers_count, html_url, language }] } */
export function repoCards(output: unknown): CardItem[] | null {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.items)) return null;
  return d.items.flatMap((r): CardItem[] => {
    if (!isRecord(r)) return [];
    const title = str(r.full_name);
    if (!title) return [];
    const meta = [
      typeof r.stargazers_count === "number"
        ? `★ ${r.stargazers_count.toLocaleString()}`
        : null,
      str(r.language),
    ]
      .filter(Boolean)
      .join(" · ");
    return [
      {
        title,
        subtitle: str(r.description),
        meta: meta || undefined,
        href: str(r.html_url),
      },
    ];
  });
}

/** OpenAlex → { results: [{ title, publication_year, authorships, doi }] } */
export function paperCards(output: unknown): CardItem[] | null {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.results)) return null;
  return d.results.flatMap((p): CardItem[] => {
    if (!isRecord(p)) return [];
    const title = str(p.title ?? p.display_name);
    if (!title) return [];
    const authors = Array.isArray(p.authorships)
      ? p.authorships
          .flatMap((a) =>
            isRecord(a) && isRecord(a.author) ? [str(a.author.display_name)] : []
          )
          .filter(Boolean)
          .slice(0, 3)
          .join(", ")
      : undefined;
    const year =
      typeof p.publication_year === "number"
        ? String(p.publication_year)
        : undefined;
    return [
      {
        title,
        subtitle: authors,
        meta: year,
        href: str(p.doi),
      },
    ];
  });
}

/** USGS GeoJSON → { features: [{ properties: { mag, place, time, url } }] } */
export function quakeCards(output: unknown): CardItem[] | null {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.features)) return null;
  return d.features.flatMap((f): CardItem[] => {
    if (!isRecord(f) || !isRecord(f.properties)) return [];
    const p = f.properties;
    const place = str(p.place);
    if (!place) return [];
    const mag = typeof p.mag === "number" ? p.mag : null;
    const when =
      typeof p.time === "number"
        ? new Date(p.time).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : undefined;
    const meta = [mag !== null ? `M ${mag.toFixed(1)}` : null, when]
      .filter(Boolean)
      .join(" · ");
    return [{ title: place, meta: meta || undefined, href: str(p.url) }];
  });
}

/** OpenSky states/all → { states: [[icao24, callsign, origin_country, …, lon(5), lat(6), …, vel(9)]] } */
export function flightStateCards(output: unknown): CardItem[] | null {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.states)) return null;
  return d.states.flatMap((s): CardItem[] => {
    if (!Array.isArray(s)) return [];
    const callsign = typeof s[1] === "string" ? s[1].trim() : "";
    const country = typeof s[2] === "string" ? s[2] : undefined;
    if (!callsign && !country) return [];
    return [
      {
        title: callsign || "(no callsign)",
        subtitle: country,
      },
    ];
  });
}

/** OpenSky flights/all → [{ callsign, estDepartureAirport, estArrivalAirport }] */
export function recentFlightCards(output: unknown): CardItem[] | null {
  const d = parse(output);
  if (!Array.isArray(d)) return null;
  return d.flatMap((f): CardItem[] => {
    if (!isRecord(f)) return [];
    const callsign =
      typeof f.callsign === "string" ? f.callsign.trim() : "";
    if (!callsign) return [];
    const dep = str(f.estDepartureAirport) ?? "?";
    const arr = str(f.estArrivalAirport) ?? "?";
    return [{ title: callsign, subtitle: `${dep} → ${arr}` }];
  });
}

/** SpaceX v5 launch → { name, date_utc, details, links: { patch: { small } } } */
export function renderSpacexLaunch(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;
  const name = str(d.name);
  if (!name) return null;
  const patch =
    isRecord(d.links) && isRecord(d.links.patch)
      ? str(d.links.patch.small)
      : undefined;
  const date =
    typeof d.date_utc === "string"
      ? new Date(d.date_utc).toLocaleString(undefined, { dateStyle: "medium" })
      : undefined;
  return cards([{ title: name, image: patch, subtitle: str(d.details), meta: date }]);
}

/** SpaceX rockets / upcoming launches → [{ name, description?, date_utc? }] */
export function spacexList(output: unknown): CardItem[] | null {
  const d = parse(output);
  if (!Array.isArray(d)) return null;
  return d.flatMap((r): CardItem[] => {
    if (!isRecord(r)) return [];
    const name = str(r.name);
    if (!name) return [];
    const date =
      typeof r.date_utc === "string"
        ? new Date(r.date_utc).toLocaleString(undefined, { dateStyle: "medium" })
        : undefined;
    return [
      {
        title: name,
        subtitle: str(r.description),
        meta: date,
      },
    ];
  });
}
