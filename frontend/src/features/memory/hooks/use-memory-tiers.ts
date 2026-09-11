import { useCallback, useEffect, useRef, useState } from "react";
import type { SceneHit } from "@/lib/api";
import { useOp } from "@/hooks/use-op";

/**
 * The Memory page's L2 (scenes) and L3 (persona) state. Both derived tiers
 * need the hybrid vault for generation; reading works offline.
 */
export function useMemoryTiers(enabled: boolean) {
  const scenesOp = useOp<SceneHit[]>("memory_scene_list", {}, { enabled, onError: "toast" });
  const personaOp = useOp<string | null>("memory_persona_get", {}, { enabled, onError: "toast" });
  const extractOp = useOp<SceneHit[]>("memory_scene_extract", {}, { enabled: false, onError: "toast" });
  const generateOp = useOp<string>("memory_persona_generate", {}, { enabled: false, onError: "toast" });

  const [extracting, setExtracting] = useState(false);
  const [generating, setGenerating] = useState(false);

  const scenes = scenesOp.data ?? [];
  const scenesLoaded = !scenesOp.loading || scenes.length > 0;
  const persona = personaOp.data ?? null;
  const personaLoaded = !personaOp.loading || persona != null;

  /** Regenerate ALL scenes from current memories (cloud LLM naming). */
  const extractScenes = useCallback(async (): Promise<SceneHit[]> => {
    setExtracting(true);
    try {
      const list = await extractOp.execute();
      if (list) scenesOp.setData(list);
      return list ?? [];
    } finally {
      setExtracting(false);
    }
  }, [extractOp.execute, scenesOp.setData]);

  /** (Re)generate the persona from all memories (cloud LLM). */
  const generatePersona = useCallback(async (): Promise<string | null> => {
    setGenerating(true);
    try {
      const text = await generateOp.execute();
      if (text) personaOp.setData(text);
      return text ?? null;
    } finally {
      setGenerating(false);
    }
  }, [generateOp.execute, personaOp.setData]);

  // Lazy kick-off on first enable (tab activation) — exactly once.
  const kickedOff = useRef(false);
  useEffect(() => {
    if (enabled && !kickedOff.current) {
      kickedOff.current = true;
      void scenesOp.execute();
      void personaOp.execute();
    }
  }, [enabled, scenesOp.execute, personaOp.execute]);

  return {
    scenes,
    scenesLoaded,
    persona,
    personaLoaded,
    extracting,
    generating,
    extractScenes,
    generatePersona,
    refreshScenes: scenesOp.execute,
    refreshPersona: personaOp.execute,
  };
}
