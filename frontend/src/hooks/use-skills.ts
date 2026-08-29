import { useCallback, useState } from "react";
import { type SkillInfo, type SkillSummary, call, errText } from "@/lib/api";
import { logError } from "@/lib/logger";
import { showErrorToast } from "@/lib/utils";
import { useLoadOnce } from "./use-load-once";

/**
 * The Skills asset page state: the skill list plus CRUD mutations with
 * optimistic patches (create prepends, update replaces in place, delete
 * drops) — the backend's `version` counter is the source of truth.
 */
export function useSkills(enabled: boolean) {
  const { items: skills, setItems: setSkills, loaded, refresh } = useLoadOnce<SkillSummary>("skill_list", enabled);
  const [busy, setBusy] = useState(false);

  const create = useCallback(
    async (name: string, description: string, content: string): Promise<SkillInfo | null> => {
      setBusy(true);
      try {
        const skill = await call<SkillInfo>("skill_create", { name, description, content });
        setSkills((prev) => [skill, ...prev]);
        return skill;
      } catch (err) {
        showErrorToast(`Couldn't create the skill — ${errText(err)}`);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [setSkills],
  );

  const get = useCallback(async (skillId: string): Promise<SkillInfo | null> => {
    try {
      return await call<SkillInfo | null>("skill_get", { skillId });
    } catch (err) {
      logError("skill_get", err);
      return null;
    }
  }, []);

  const update = useCallback(
    async (
      skillId: string,
      patch: { name?: string; description?: string; content?: string },
    ): Promise<SkillInfo | null> => {
      setBusy(true);
      try {
        const skill = await call<SkillInfo | null>("skill_update", { skillId, ...patch });
        if (skill) setSkills((prev) => prev.map((s) => (s.id === skillId ? skill : s)));
        return skill;
      } catch (err) {
        showErrorToast(`Couldn't update the skill — ${errText(err)}`);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [setSkills],
  );

  const remove = useCallback(
    async (skillId: string): Promise<boolean> => {
      try {
        const removed = await call<boolean>("skill_delete", { skillId });
        if (removed) setSkills((prev) => prev.filter((s) => s.id !== skillId));
        return removed;
      } catch (err) {
        showErrorToast(`Couldn't delete the skill — ${errText(err)}`);
        return false;
      }
    },
    [setSkills],
  );

  return { skills, loaded, busy, refresh, create, get, update, remove };
}
