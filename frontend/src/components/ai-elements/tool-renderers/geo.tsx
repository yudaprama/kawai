import type { ReactNode } from "react";
import { parse, isRecord, str, num, LocationCard } from "./shared";

function extractCoords(
  d: Record<string, unknown>,
  latKey: string,
  lonKey: string
) {
  const lat = num(d[latKey]);
  const lon = num(d[lonKey]);
  if (lat === null || lon === null) return null;
  return { lat, lon };
}

/** Nominatim → [{ lat, lon, display_name }] */
export function renderGeocode(output: unknown): ReactNode {
  const arr = parse(output);
  const first = Array.isArray(arr) ? arr[0] : arr;
  if (!isRecord(first)) return null;
  const coords = extractCoords(first, "lat", "lon");
  if (!coords) return null;
  return (
    <LocationCard
      title={str(first.display_name) ?? "Location"}
      lat={coords.lat}
      lon={coords.lon}
    />
  );
}

/** ipwho.is → { ip, city, region, country, latitude, longitude } */
export function renderIpLocation(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;
  const coords = extractCoords(d, "latitude", "longitude");
  if (!coords) return null;
  const place = [str(d.city), str(d.region), str(d.country)]
    .filter(Boolean)
    .join(", ");
  return (
    <LocationCard
      title={place || "IP Location"}
      subtitle={str(d.ip)}
      lat={coords.lat}
      lon={coords.lon}
    />
  );
}

/** wheretheiss.at → { latitude, longitude, altitude, velocity } */
export function renderIss(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;
  const coords = extractCoords(d, "latitude", "longitude");
  if (!coords) return null;
  const alt = num(d.altitude);
  const vel = num(d.velocity);
  const extra = [
    alt !== null ? `Alt ${Math.round(alt)} km` : null,
    vel !== null ? `Vel ${Math.round(vel)} km/h` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <LocationCard
      title="ISS (International Space Station)"
      lat={coords.lat}
      lon={coords.lon}
      extra={extra || undefined}
    />
  );
}
