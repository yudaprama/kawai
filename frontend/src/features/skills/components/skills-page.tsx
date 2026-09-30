import { Icon } from "@/components/shared/icon";
import { useCallback, useEffect, useState } from "react";
import {
  AssetBadge,
  AssetItemBadges,
  AssetItemDesc,
  AssetItemHeader,
  AssetItemId,
  AssetItemName,
  AssetItemTime,
  AssetListPanel,
} from "@/features/assets/components/asset/asset-list-panel";
import { AssetPageHeader } from "@/features/assets/components/asset/asset-page-header";
import { AssetSplitLayout } from "@/features/assets/components/asset/asset-split-layout";
import { FilterBar } from "@/features/assets/components/filter-bar";
import { useAssetPage } from "@/features/assets/hooks/use-asset-page";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useSkills } from "@/features/skills/hooks/use-skills";
import { fmtTimestamp } from "@/features/workbench/components/tool-views/format";
import type { SkillInfo, SkillSummary } from "@/generated/api-types";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { useI18n } from "@/hooks/use-i18n";

/**
 * Skills asset page — SkillsPanel structure (Tea asset-management UI) over
 * the real skills tier: list ↔ detail split, create/edit dialog (SKILL.md
 * body), delete with two-click confirm, markdown-rendered body. The version
 * counter bumps server-side on every update.
 */
export function SkillsAssetPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const store = useSkills(true);
  const { skills, loaded, error } = store;
  const [detail, setDetail] = useState<SkillInfo | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  // Bumped by the detail Retry button — re-keys the fetch effect below.
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SkillInfo | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const filterFn = useCallback(
    (s: SkillSummary, q: string) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    [],
  );
  const { query, setQuery, setSelectedId, filtered, active, activeId } = useAssetPage<SkillSummary, string>({
    items: skills,
    filterFn,
  });
  const { get } = store;

  // Load the selected skill's body. `skill_get` resolves `null` on failure
  // (it logs internally), so that counts as an error too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: detailAttempt is the Retry TRIGGER — bumping it re-runs the fetch
  useEffect(() => {
    if (activeId == null) {
      setDetail(null);
      setDetailError(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetail(null);
    setDetailError(false);
    void get(activeId)
      .then((skill) => {
        if (cancelled) return;
        if (skill) setDetail(skill);
        else setDetailError(true);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, get, detailAttempt]);

  useEffect(() => {
    if (confirmDeleteId == null) return;
    const t = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);

  return (
    <AssetShell onBack={onBack} subtitle={t("skills.agentSkills")} title={t("skills.title")}>
      <AssetPageHeader
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
            size="sm"
          >
            <Icon name="plus" className="size-3.5" />
            New skill
          </Button>
        }
        subtitle={`${skills.length} ${skills.length === 1 ? "skill" : "skills"} in the library`}
        title="Skills"
      />
      <FilterBar
        filteredCount={filtered.length}
        onChange={setQuery}
        placeholder={t("skills.filterSkills")}
        totalCount={skills.length}
        value={query}
      />
      <AssetSplitLayout
        detail={
          active ? (
            <SkillDetail
              confirmDelete={confirmDeleteId === active.id}
              detail={detail}
              error={detailError}
              loading={detailLoading}
              summary={active}
              onDelete={async () => {
                if (confirmDeleteId !== active.id) {
                  setConfirmDeleteId(active.id);
                  return;
                }
                setConfirmDeleteId(null);
                const ok = await store.remove(active.id);
                if (ok) setSelectedId(null);
              }}
              onEdit={() => {
                if (detail == null) return;
                setEditing(detail);
                setEditorOpen(true);
              }}
              onRetry={() => setDetailAttempt((n) => n + 1)}
            />
          ) : (
            <div className="_alp-detail-empty">{t("skills.selectSkill")}</div>
          )
        }
        sidebar={
          <AssetListPanel
            count={`${filtered.length}`}
            emptyText={
              error != null ? (
                <span className="flex flex-col items-center gap-2">
                  <span className="text-muted-foreground" role="alert">
                    Couldn&apos;t load skills — {error}
                  </span>
                  <Button onClick={() => void store.refresh()} size="xs" variant="outline">
                    Retry
                  </Button>
                </span>
              ) : (
                "No skills yet — create one with “New skill”."
              )
            }
            getItemId={(s) => s.id}
            items={filtered}
            loading={!loaded}
            onSelect={(s) => setSelectedId(s.id)}
            renderItem={(s) => (
              <>
                <AssetItemHeader>
                  <AssetItemName title={s.name}>{s.name}</AssetItemName>
                </AssetItemHeader>
                <AssetItemId>{s.id}</AssetItemId>
                {s.description && <AssetItemDesc>{s.description}</AssetItemDesc>}
                <AssetItemBadges>
                  <AssetBadge title={t("skills.updatedOnSave")}>v{s.version}</AssetBadge>
                  <AssetItemTime>{fmtTimestamp(new Date(s.updatedAt * 1000))}</AssetItemTime>
                </AssetItemBadges>
              </>
            )}
            selectedId={active?.id ?? null}
            title="Skills"
          />
        }
        storageKey="kawai:skills:splitWidth"
      />
      {editorOpen && (
        <SkillEditorDialog
          initial={editing}
          busy={store.busy}
          onClose={() => setEditorOpen(false)}
          onSave={async (name, description, content) => {
            const saved =
              editing != null
                ? await store.update(editing.id, { name, description, content })
                : await store.create(name, description, content);
            if (saved) {
              setEditorOpen(false);
              setSelectedId(saved.id);
            }
          }}
        />
      )}
    </AssetShell>
  );
}

function SkillDetail({
  summary,
  detail,
  loading,
  error,
  confirmDelete,
  onEdit,
  onDelete,
  onRetry,
}: {
  summary: { id: string; name: string; version: number; updatedAt: number };
  detail: SkillInfo | null;
  loading: boolean;
  /** The `skill_get` read failed — show the failure instead of a bare dead end. */
  error: boolean;
  confirmDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
  /** Re-fetches this skill's body. */
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start gap-2.5 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{summary.name}</h3>
          <AssetItemId>{summary.id}</AssetItemId>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
            <AssetBadge title="Updated on every save">v{detail?.version ?? summary.version}</AssetBadge>
            <span className="text-muted-foreground">
              updated {fmtTimestamp(new Date((detail?.updatedAt ?? summary.updatedAt) * 1000))}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button disabled={detail == null} onClick={onEdit} size="xs" variant="outline">
            <Icon name="pencil" className="size-3" />
            Edit
          </Button>
          <Button
            className={confirmDelete ? "" : "text-destructive hover:text-destructive"}
            onClick={onDelete}
            size="xs"
            title={confirmDelete ? "Click again to confirm — deletes the skill" : "Delete skill"}
            variant="outline"
          >
            {confirmDelete ? (
              "Confirm"
            ) : (
              <>
                <Icon name="trash" className="size-3" />
                Delete
              </>
            )}
          </Button>
        </div>
      </div>
      <div className="streamdown min-h-0 flex-1 overflow-auto p-4">
        {loading ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner className="size-4" /> Loading…
          </div>
        ) : detail ? (
          <MessageResponse mode="static">{detail.content}</MessageResponse>
        ) : error ? (
          <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="bg-muted flex size-12 items-center justify-center rounded-lg">
              <Icon name="wrench" className="size-5" />
            </div>
            <p className="text-foreground text-sm font-medium">Couldn&apos;t load this skill</p>
            <Button onClick={onRetry} size="xs" variant="outline">
              Retry
            </Button>
          </div>
        ) : (
          /* Selection just changed and the fetch effect hasn't run yet. */
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner className="size-4" /> Loading…
          </div>
        )}
      </div>
    </div>
  );
}

function SkillEditorDialog({
  initial,
  busy,
  onClose,
  onSave,
}: {
  initial: SkillInfo | null;
  busy: boolean;
  onClose: () => void;
  onSave: (name: string, description: string, content: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const valid = name.trim().length > 0 && content.trim().length > 0;

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial ? `Edit “${initial.name}”` : "New skill"}</DialogTitle>
          <DialogDescription>
            A skill is a reusable markdown instruction set (SKILL.md). Save bumps the version.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="skill-name">
              Name
            </label>
            <Input id="skill-name" onChange={(e) => setName(e.target.value)} placeholder="pdf-flow" value={name} />
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="skill-desc">
              Description
            </label>
            <Input
              id="skill-desc"
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this skill does (shown in lists)"
              value={description}
            />
          </div>
          <div className="grid min-h-0 flex-1 gap-1.5">
            <label className="text-sm font-medium" htmlFor="skill-content">
              SKILL.md body
            </label>
            <Textarea
              className="min-h-[220px] font-mono text-xs"
              id="skill-content"
              onChange={(e) => setContent(e.target.value)}
              placeholder={"# Instructions\n\nWrite the agent guidance here (markdown)."}
              value={content}
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={busy} variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button disabled={busy || !valid} onClick={() => onSave(name, description, content)}>
            {busy ? <Spinner className="size-3" /> : initial ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
