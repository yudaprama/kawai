import { PencilIcon, PlusIcon, TrashIcon, WrenchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  AssetBadge,
  AssetItemBadges,
  AssetItemDesc,
  AssetItemHeader,
  AssetItemId,
  AssetItemName,
  AssetItemTime,
  AssetListPanel,
} from "@/components/asset/asset-list-panel";
import { AssetPageHeader } from "@/components/asset/asset-page-header";
import { AssetSplitLayout } from "@/components/asset/asset-split-layout";
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
import { useSkills } from "@/hooks/use-skills";
import type { SkillInfo } from "@/lib/api";
import { AssetShell } from "@/panels/assets/asset-shell";

/**
 * Skills asset page — SkillsPanel structure (Tea asset-management UI) over
 * the real skills tier: list ↔ detail split, create/edit dialog (SKILL.md
 * body), delete with two-click confirm, markdown-rendered body. The version
 * counter bumps server-side on every update.
 */
export function SkillsAssetPage({ onBack }: { onBack: () => void }) {
  const store = useSkills(true);
  const { skills, loaded } = store;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<SkillInfo | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SkillInfo | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [skills, query]);

  const active = filtered.find((s) => s.id === selectedId) ?? skills.find((s) => s.id === selectedId) ?? null;
  const activeId = active?.id ?? null;
  const { get } = store;

  // Load the selected skill's body.
  useEffect(() => {
    if (activeId == null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    void get(activeId)
      .then((skill) => {
        if (!cancelled) setDetail(skill);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, get]);

  useEffect(() => {
    if (confirmDeleteId == null) return;
    const t = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);

  return (
    <AssetShell onBack={onBack} subtitle="agent skills" title="Skills">
      <AssetPageHeader
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
            size="sm"
          >
            <PlusIcon className="size-3.5" />
            New skill
          </Button>
        }
        subtitle={`${skills.length} ${skills.length === 1 ? "skill" : "skills"} in the library`}
        title="Skills"
      />
      <div className="mb-3 mt-3 flex shrink-0 items-center">
        <Input
          className="max-w-xs"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter skills…"
          type="search"
          value={query}
        />
        <span className="text-muted-foreground ml-3 text-xs">
          {filtered.length}/{skills.length}
        </span>
      </div>
      <AssetSplitLayout
        detail={
          active ? (
            <SkillDetail
              confirmDelete={confirmDeleteId === active.id}
              detail={detail}
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
            />
          ) : (
            <div className="_alp-detail-empty">Select a skill to read its instructions</div>
          )
        }
        sidebar={
          <AssetListPanel
            count={`${filtered.length}`}
            emptyText="No skills yet — create one with “New skill”."
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
                  <AssetBadge title="Updated on every save">v{s.version}</AssetBadge>
                  <AssetItemTime>{new Date(s.updatedAt * 1000).toLocaleString()}</AssetItemTime>
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
  confirmDelete,
  onEdit,
  onDelete,
}: {
  summary: { id: string; name: string; version: number; updatedAt: number };
  detail: SkillInfo | null;
  loading: boolean;
  confirmDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
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
              updated {new Date((detail?.updatedAt ?? summary.updatedAt) * 1000).toLocaleString()}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button disabled={detail == null} onClick={onEdit} size="xs" variant="outline">
            <PencilIcon className="size-3" />
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
                <TrashIcon className="size-3" />
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
        ) : (
          <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="bg-muted flex size-12 items-center justify-center rounded-lg">
              <WrenchIcon className="size-5" />
            </div>
            <p className="text-foreground text-sm font-medium">Couldn&apos;t load this skill</p>
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
