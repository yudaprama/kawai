import { useCallback, useEffect, useRef, useState } from "react";
import { type SceneHit, call, errText } from "@/lib/api";
import { showErrorToast } from "@/lib/utils";

/**
 * The Memory page's L2 (scenes) and L3 (persona) state. Both derived tiers
 * need the hybrid vault for generation; reading works offline.
 */
export function useMemoryTiers(enabled: boolean) {
  const [scenes, setScenes] = useState<SceneHit[] | null>(null);
  const [persona, setPersona] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [generating, setGenerating] = useState(false);

  const refreshScenes = useCallback(async (): Promise<SceneHit[]> => {
    try {
      const list = await call<SceneHit[]>("memory_scene_list", {});
      setScenes(list);
      return list;
    } catch (err) {
      showErrorToast(`Couldn't load scenes — ${errText(err)}`);
      setScenes([]);
      return [];
    }
  }, []);

  /** Regenerate ALL scenes from current memories (cloud LLM naming). */
  const extractScenes = useCallback(async (): Promise<SceneHit[]> => {
    setExtracting(true);
    try {
      const list = await call<SceneHit[]>("memory_scene_extract", {});
      setScenes(list);
      return list;
    } catch (err) {
      showErrorToast(`Scene extraction failed — ${errText(err)}`);
      return [];
    } finally {
      setExtracting(false);
    }
  }, []);

  const refreshPersona = useCallback(async (): Promise<string | null> => {
    try {
      const text = await call<string | null>("memory_persona_get", {});
      setPersona(text);
      return text;
    } catch (err) {
      showErrorToast(`Couldn't load persona — ${errText(err)}`);
      setPersona(null);
      return null;
    }
  }, []);

  /** (Re)generate the persona from all memories (cloud LLM). */
  const generatePersona = useCallback(async (): Promise<string | null> => {
    setGenerating(true);
    try {
      const text = await call<string>("memory_persona_generate", {});
      setPersona(text);
      return text;
    } catch (err) {
      showErrorToast(`Persona generation failed — ${errText(err)}`);
      return null;
    } finally {
      setGenerating(false);
    }
  }, []);

  // Lazy kick-off on first enable (tab activation) — exactly once.
  const kickedOff = useRef(false);
  useEffect(() => {
    if (enabled && !kickedOff.current) {
      kickedOff.current = true;
      void refreshScenes();
      void refreshPersona();
    }
  }, [enabled, refreshScenes, refreshPersona]);

  return {
    scenes: scenes ?? [],
    scenesLoaded: scenes != null,
    persona,
    personaLoaded: persona != null,
    extracting,
    generating,
    extractScenes,
    generatePersona,
    refreshScenes,
    refreshPersona,
  };
}
