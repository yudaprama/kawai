/**
 * Curated music prompt starters — shown alongside the community gallery in
 * the Generator panel's music lane.
 *
 * ## Why these exist
 *
 * The community pool is thin and unevenly spread: measured over civitai's
 * four pinned music models, 24 of 53 prompts are genuine music prompts, and
 * they are distributed 19 (yue2) / 3 (ace) / 2 (minimax-music3) / **0
 * (sonilo)**. A lane whose gallery is empty for a whole engine reads as
 * broken — the same failure the image lane had. These rows are local, so
 * they cover every engine unconditionally.
 *
 * ## Why hand-written
 *
 * Because the community prompts are the scarce resource, not the knowledge.
 * What a first-time user cannot guess is *structure*: the MiniMax Music 3
 * and ACE `caption` fields want a written brief (BPM, key, scale, mood
 * arc, vocal style), and YuE2's `caption` is really a style descriptor. Each
 * starter below is written to that shape, which is why they are shipped
 * rather than scraped.
 */

export interface MusicStarter {
  id: string;
  label: string;
  /** One line on the mood — the starter card's caption. */
  note: string;
  /** Goes into the form's `caption` field (YuE2 aliases this as `style`). */
  caption: string;
  /** Only set where the starter carries real lyrics (the lyrics field). */
  lyrics?: string;
}

/** Keyed by the panel's music ecosystem id. */
export const MUSIC_STARTERS: Record<string, MusicStarter[]> = {
  "minimax-music3": [
    {
      id: "mm-synthwave",
      label: "Synthwave drive",
      note: "Structured brief: BPM, key, scale, then the emotional arc.",
      caption:
        "Global Metadata\nBasic Attributes: bpm is 110. key is A minor, scale is natural minor. Synthwave / Dream Pop.\n\n" +
        "Global Emotional Progression: Starts sparse and cold — a lone analog pad and a soft heartbeat kick. " +
        "Builds through the middle section with a pulsing bass line and wide detuned arpeggios, " +
        "then opens into a bright, saturated final section with layered lead melody and shimmering pads.\n\n" +
        "Vocal Style: Clean female vocal, slightly breathy, centred and intimate. No heavy vibrato.\n\n" +
        "Harmony/Backing Vocals: Wide stereo pad swells, no harmony doubles.\n\n" +
        "Vocal FX: Light plate reverb, a touch of tape saturation.",
    },
    {
      id: "mm-lofi",
      label: "Lo-fi study",
      note: "Low energy, deliberately imperfect — good for long sessions.",
      caption:
        "Global Metadata\nBasic Attributes: bpm is 78. key is D major, scale is major. Lo-fi / Chillhop.\n\n" +
        "Global Emotional Progression: Steady and unhurried throughout. A warm electric piano motif " +
        "repeats with slight variation while the drums stay dusty and behind the beat.\n\n" +
        "Vocal Style: None — instrumental only.\n\n" +
        "Instrumentation: Rhodes-style keys, round upright bass, brushed snare, soft vinyl crackle.",
    },
  ],
  yue2: [
    {
      id: "yue-guitar",
      label: "Fingerstyle guitar",
      note: "YuE2 reads `caption` as a style — describe the performance, not a scene.",
      caption:
        "Intimate fingerstyle acoustic guitar, single close-miked instrument. Warm wood, " +
        "natural room reverb, light fingerpicking pattern in a steady 6/8 feel. " +
        "No percussion, no vocals, no layering.",
    },
    {
      id: "yue-piano",
      label: "Solo piano",
      note: "Sparse and dynamic — YuE2 responds to restraint.",
      caption:
        "Solo felt piano, close perspective, expressive rubato. Sparse arrangement with long " +
        "silences between phrases. Natural sustain, no reverb tail, no percussion, no vocals.",
    },
    {
      id: "yue-lyric",
      label: "Vocal + lyric",
      note: "Carries lyrics too — the only starter that fills both fields.",
      caption:
        "Warm indie-folk vocal, one voice, close mic with slight room ambience. Gentle acoustic " +
        "guitar and soft brushed drums underneath, keeping out of the vocal's way.",
      lyrics:
        "[Verse]\nStreetlight on an empty road\nCoffee going cold\n\n[Chorus]\nStill I walk, still I carry on\n" +
        "Everything I left is where it belongs\n\n[Verse]\nMorning comes without a sound\nNobody home\n\n" +
        "[Chorus]\nStill I walk, still I carry on\nEverything I left is where it belongs",
    },
  ],
  sonilo: [
    {
      id: "son-rumble",
      label: "Low rumble",
      note: "Sound effect, not music — Sonilo's other half.",
      caption: "Deep sustained low-frequency rumble with a slow swell, like distant thunder under a floor.",
    },
    {
      id: "son-door",
      label: "Door + steps",
      note: "A concrete everyday sound, useful for a video edit.",
      caption:
        "A wooden door creaking open followed by several footsteps on a hard floor, close perspective, dry room.",
    },
  ],
  ace: [
    {
      id: "ace-bpm",
      label: "120 BPM anthem",
      note: "ACE reads tempo and key directly from the description.",
      caption:
        "Genre: Indie Pop / Alternative. Tempo: 120 BPM, steady four-on-the-floor. " +
        "Key: C major, bright and optimistic. Instrumentation: driving drums, chiming guitars, " +
        "clapping percussion, wide stereo pads. Vocal: confident lead, layered doubles in the chorus. " +
        "Arc: builds from a sparse intro to a full, anthemic chorus.",
    },
    {
      id: "ace-jazz",
      label: "Late-night jazz",
      note: "Slower, sparse, and heavily instrument-led.",
      caption:
        "Genre: Late-night Jazz / Lounge. Tempo: 84 BPM, laid-back swing. Key: F minor, moody and warm. " +
        "Instrumentation: upright bass walking, brushed drums, mellow Rhodes chords, occasional muted trumpet. " +
        "Vocal: none. Arc: unhurried throughout, with the bass and drums trading phrases.",
    },
  ],
};
