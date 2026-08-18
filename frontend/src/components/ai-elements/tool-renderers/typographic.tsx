import type { ReactNode } from "react";
import { parse, isRecord, TextCard, Verse, Footnote } from "./shared";

/** bible-api.com → { reference, text, translation_name } */
export function renderBibleVerse(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;
  const text = typeof d.text === "string" ? d.text.trim() : null;
  if (!text) return null;
  const reference = typeof d.reference === "string" ? d.reference : null;
  const translation =
    typeof d.translation_name === "string" ? d.translation_name : null;
  return (
    <TextCard>
      {reference && <h4 className="font-semibold text-sm">{reference}</h4>}
      <Verse>{text}</Verse>
      {translation && <Footnote>{translation}</Footnote>}
    </TextCard>
  );
}

/** alquran.cloud → { data: { text, ayahs?, surah?, englishName?, ... } } */
export function renderQuran(output: unknown): ReactNode {
  const root = parse(output);
  if (!isRecord(root) || !isRecord(root.data)) return null;
  const data = root.data;

  if (Array.isArray(data.ayahs)) {
    const title =
      (typeof data.englishName === "string" && data.englishName) ||
      (typeof data.name === "string" && data.name) ||
      null;
    const translation =
      typeof data.englishNameTranslation === "string"
        ? data.englishNameTranslation
        : null;
    return (
      <TextCard>
        {title && (
          <h4 className="font-semibold text-sm">
            {title}
            {translation && (
              <span className="text-muted-foreground font-normal"> · {translation}</span>
            )}
          </h4>
        )}
        <div className="space-y-1.5">
          {data.ayahs.map((a, i) => {
            const ayah = isRecord(a) ? a : {};
            const n =
              typeof ayah.numberInSurah === "number" ? ayah.numberInSurah : i + 1;
            const t = typeof ayah.text === "string" ? ayah.text : "";
            if (!t) return null;
            return (
              <p key={i} className="text-[15px] leading-relaxed text-foreground">
                <span className="text-muted-foreground text-xs mr-1.5">{n}.</span>
                {t}
              </p>
            );
          })}
        </div>
      </TextCard>
    );
  }

  const text = typeof data.text === "string" ? data.text.trim() : null;
  if (!text) return null;
  const surah = isRecord(data.surah) ? data.surah : null;
  const ref =
    surah && typeof surah.englishName === "string"
      ? `${surah.englishName}${
          typeof data.numberInSurah === "number" ? ` : ${data.numberInSurah}` : ""
        }`
      : null;
  return (
    <TextCard>
      {ref && <h4 className="font-semibold text-sm">{ref}</h4>}
      <Verse>{text}</Verse>
    </TextCard>
  );
}

/** PoetryDB → [{ title, author, lines: [] }] */
export function renderPoem(output: unknown): ReactNode {
  const arr = parse(output);
  const first = Array.isArray(arr) ? arr[0] : arr;
  if (!isRecord(first) || !Array.isArray(first.lines)) return null;
  const lines = first.lines.filter((l): l is string => typeof l === "string");
  if (lines.length === 0) return null;
  const title = typeof first.title === "string" ? first.title : null;
  const author = typeof first.author === "string" ? first.author : null;
  return (
    <TextCard>
      {title && <h4 className="font-semibold text-sm">{title}</h4>}
      {author && <Footnote>by {author}</Footnote>}
      <div className="text-[15px] leading-relaxed text-foreground whitespace-pre-line">
        {lines.join("\n")}
      </div>
    </TextCard>
  );
}

/** dictionaryapi.dev → [{ word, phonetic, meanings: [{ partOfSpeech, definitions }] }] */
export function renderDefinition(output: unknown): ReactNode {
  const arr = parse(output);
  const entry = Array.isArray(arr) ? arr[0] : arr;
  if (!isRecord(entry) || typeof entry.word !== "string") return null;
  const meanings = Array.isArray(entry.meanings) ? entry.meanings : [];
  if (meanings.length === 0) return null;
  const phonetic =
    typeof entry.phonetic === "string" ? entry.phonetic : null;
  return (
    <TextCard className="space-y-3">
      <h4 className="font-semibold text-sm">
        {entry.word}
        {phonetic && (
          <span className="text-muted-foreground font-normal ml-2">{phonetic}</span>
        )}
      </h4>
      {meanings.map((m, i) => {
        const meaning = isRecord(m) ? m : {};
        const pos =
          typeof meaning.partOfSpeech === "string" ? meaning.partOfSpeech : null;
        const defs = Array.isArray(meaning.definitions)
          ? meaning.definitions
          : [];
        if (defs.length === 0) return null;
        return (
          <div key={i} className="space-y-1">
            {pos && (
              <p className="italic text-muted-foreground text-xs">{pos}</p>
            )}
            <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground">
              {defs.slice(0, 5).map((d, j) => {
                const def = isRecord(d) ? d : {};
                const text =
                  typeof def.definition === "string" ? def.definition : null;
                if (!text) return null;
                const example =
                  typeof def.example === "string" ? def.example : null;
                return (
                  <li key={j}>
                    {text}
                    {example && (
                      <span className="block text-muted-foreground text-xs italic">
                        \u201c{example}\u201d
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })}
    </TextCard>
  );
}
