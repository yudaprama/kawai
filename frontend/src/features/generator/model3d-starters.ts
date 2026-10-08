/**
 * Curated prompt starters for the Generator panel's 3D lane.
 *
 * ## Why curated and not scraped
 *
 * There is no community 3D feed to scrape. Measured 2026-10-08: the v1 feed
 * carries only `image` and `video` post types (600-row sweep, zero 3D), the
 * 3D models Civitai does host are `type: "Workflows"` (Hunyuan3D, Trellis2,
 * Pixal3D), and the ~21 posts across five of those models yield 4 with meta
 * — all of them `type: "image"` renders/textures posted by the workflow's own
 * author ("ppstorybook, ((game asset)) of an 80's style robot…"), not mesh
 * generations. That text is the author's own SDXL texture prompt, so it is
 * not a 3D input.
 *
 * ## Why the starters are worth shipping
 *
 * Because the scarce resource here is knowledge, not samples. A 3D engine
 * rejects a vague description: the prompt has to state subject, framing,
 * pose, background and camera or the mesh comes back as an unusable blob.
 * None of that is guessable from the form, which only shows a textarea and a
 * few toggles.
 *
 * ## Coverage is deliberately uneven
 *
 * Only `meshy` generates from text alone. `tripo`, `trellis2` and `pixal3d`
 * are image-to-3D ONLY and their config sets `promptMax: 0` — they have no
 * prompt field at all, so no starter can exist for them. `hunyuan3d` takes an
 * optional texture prompt, but still requires a source image. `MODEL3D_NO_PROMPT`
 * marks the first group so the panel can say so plainly instead of rendering
 * cards that could not do anything.
 */

export interface Model3dStarter {
  id: string;
  label: string;
  /** One line on what the prompt is teaching — the card's caption. */
  note: string;
  /** Goes into the form's `prompt` field. */
  prompt: string;
  /** Hunyuan3D only: the optional texture hint that rides with a source image. */
  texturePrompt?: string;
}

/** Engines whose form has no prompt field — they need a source image. */
export const MODEL3D_NO_PROMPT: readonly string[] = ["tripo", "trellis2", "pixal3d"];

export const MODEL3D_STARTERS: Record<string, Model3dStarter[]> = {
  meshy: [
    {
      id: "meshy-fullbody",
      label: "Full body, neutral pose",
      note: "The shape 3D engines actually want: framing, pose and background stated.",
      prompt:
        "A full-body 3D model of a weathered lighthouse keeper in a heavy wool coat, " +
        "standing in a neutral A-pose with arms slightly away from the body, " +
        "facing the camera. Centered in frame, the whole figure visible head to boots " +
        "with margin on all sides. Plain white background, even soft studio lighting, " +
        "orthographic front view, no perspective distortion.",
    },
    {
      id: "meshy-prop",
      label: "Single prop",
      note: "Objects work better stated as one object on a flat surface.",
      prompt:
        "A single 3D model of a battered leather satchel with a brass buckle and one " +
        "worn strap, standing upright on a flat surface. Centered, whole object visible " +
        "with margin. Plain white background, even studio lighting, three-quarter front view. " +
        "Clean silhouette, no clutter, no text.",
    },
    {
      id: "meshy-creature",
      label: "Stylised creature",
      note: "Low-poly friendly creatures score best when the style is named.",
      prompt:
        "A stylised low-poly 3D model of a small round fox with oversized ears and a " +
        "bushy tail, sitting upright and facing the camera. Centered, whole creature " +
        "visible with margin. Plain white background, even soft lighting, front three-quarter " +
        "view, clean low-poly facets.",
    },
  ],
  hunyuan3d: [
    {
      id: "huny-texture",
      label: "Texture prompt",
      note: "Hunyuan3D needs a source image — this rides alongside it.",
      prompt: "",
      texturePrompt:
        "Weathered galvanised metal with rust streaks along the seams, chipped industrial " +
        "paint in faded safety yellow, fine scratch marks, grime settled in the crevices. " +
        "Even, neutral lighting, no strong colour cast.",
    },
    {
      id: "huny-organic",
      label: "Organic texture",
      note: "Same — the texture fields are what Hunyuan3D reads.",
      prompt: "",
      texturePrompt:
        "Dense short grass with varied green tones and a few dry yellow blades, " +
        "matte surface, slight clumping at the base, soft natural daylight, " +
        "no specular highlights.",
    },
  ],
};
