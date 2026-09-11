import { useCallback, useState } from "react";
import { type SkillInfo, type SkillSummary, call, errText } from "@/lib/api";
import { logError } from "@/lib/logger";
import { showErrorToast } from "@/lib/utils";
import { useOp } from "@/hooks/use-op";

/**
 * The Skills asset page state: the skill list plus CRUD mutations with
 * optimistic patches (create prepends, update replaces in place, delete
 * drops) — the backend's `version` counter is the source of truth.
 */
export function useSkills(enabled: boolean) {
  const listOp = useOp<SkillSummary[]>("skill_list", undefined, { enabled });
  const skills = listOp.data ?? [];
  const [busy, setBusy] = useState(false);

  const create = useCallback(
    async (name: string, description: string, content: string): Promise<SkillInfo | null> => {
      setBusy(true);
      try {
        const skill = await call<SkillInfo>("skill_create", { name, description, content });
        listOp.setData((prev) => [skill, ...(prev ?? [])]);
        return skill;
      } catch (err) {
        showErrorToast(`Couldn't create the skill — ${errText(err)}`);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [listOp.setData],
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
        if (skill) listOp.setData((prev) => (prev ?? []).map((s) => (s.id === skillId ? skill : s)));
        return skill;
      } catch (err) {
        showErrorToast(`Couldn't update the skill — ${errText(err)}`);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [listOp.setData],
  );

  const remove = useCallback(
    async (skillId: string): Promise<boolean> => {
      try {
        const removed = await call<boolean>("skill_delete", { skillId });
        if (removed) listOp.setData((prev) => (prev ?? []).filter((s) => s.id !== skillId));
        return removed;
      } catch (err) {
        showErrorToast(`Couldn't delete the skill — ${errText(err)}`);
        return false;
      }
    },
    [listOp.setData],
  );

  return {
    skills,
    loaded: !listOp.loading || skills.length > 0,
    busy,
    refresh: listOp.execute,
    create,
    get,
    update,
    remove,
  };
}
