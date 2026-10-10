import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AssetBadge,
  AssetItemBadges,
  AssetItemHeader,
  AssetItemMeta,
  AssetItemName,
  AssetItemTime,
  AssetListPanel,
} from "@/features/assets/components/asset/asset-list-panel";
import { AssetPageHeader } from "@/features/assets/components/asset/asset-page-header";
import { AssetSplitLayout } from "@/features/assets/components/asset/asset-split-layout";
import { FilterBar } from "@/features/assets/components/filter-bar";
import { Icon } from "@/components/shared/icon";
import { ConfirmIconButton, useArmedConfirm } from "@/components/shared/confirm-action";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { type MemoriesStore, useMemories } from "@/features/memory/hooks/use-memories";
import { useMemoryTiers } from "@/features/memory/hooks/use-memory-tiers";
import { facetStateLabel, kindLabel, namespaceLabel, originLabel, sourceLabel } from "@/features/memory/lib/labels";
import type { TranslationKey } from "@/lib/i18n";
import { call, errText } from "@/lib/api";
import { cn, showErrorToast } from "@/lib/utils";
import {
  MEMORY_KINDS,
  type ChatMessage,
  type ChatSession,
  type ExperienceItem,
  type MemoryGraphExport,
  type MemoryItem,
  type ProfileFacet,
} from "@/lib/api";
import { useOp } from "@/hooks/use-op";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { useI18n } from "@/hooks/use-i18n";

export type MemoryTab = "l0" | "l1" | "l2" | "l3" | "exp" | "profile" | "graph";

/**
 * The seven memory layers, in reading order. `l0` (the verbatim transcript) is
 * the only BLOCK-scoped layer — everything else is derived from the whole
 * store, which is why the tab strip is identical for every selected block.
 */
const LAYER_TABS: readonly { value: MemoryTab; labelKey: TranslationKey }[] = [
  { value: "l0", labelKey: "memory.tabs.l0" },
  { value: "l1", labelKey: "memory.tabs.l1" },
  { value: "l2", labelKey: "memory.tabs.l2" },
  { value: "l3", labelKey: "memory.tabs.l3" },
  { value: "profile", labelKey: "memory.tabs.profile" },
  { value: "exp", labelKey: "memory.tabs.experiences" },
  { value: "graph", labelKey: "memory.graphTab" },
] as const;

// Code-split: the force-graph (d3-force + worker) only loads when the user
// opens the Graph tab.
const MemoryGraph = lazy(() =>
  import("@/components/memory-graph/MemoryGraph").then((m) => ({ default: m.MemoryGraph })),
);

/**
 * Memory asset page — ChatMemoryPanel structure (Tea asset-management UI):
 * page header with a block filter, session blocks on the left, layer tabs on
 * the right. L0 (raw conversations) is per-block; L1 (atomic memories — global,
 * with cloud extraction + manual CRUD), L2/L3 (scenes, persona), the profile
 * facets, per-run experiences and the entity graph are all global.
 */
export function MemoryAssetPage({
  sessions,
  sessionsLoading,
  sessionsError,
  onRetrySessions,
}: {
  sessions: ChatSession[];
  /** In-flight `list_chat_sessions` read (App's chat state). */
  sessionsLoading?: boolean;
  /** Last sessions read failure — replaces the empty state, never a false "no memory blocks". */
  sessionsError?: string | null;
  /** Re-reads the session list (App's `loadSessions` / `refreshSessions`). */
  onRetrySessions?: () => void;
}) {
  const { t, fmtDate, fmtRelative } = useI18n();
  // Opens on L1, the global memory list: it is the layer with content on a
  // first visit and the one this page is named for. L0 needs a block picked
  // in the sidebar, so defaulting there would greet every user with an empty
  // "select a block" prompt.
  const [tab, setTab] = useState<MemoryTab>("l1");

  const memories = useMemories(true);

  // Settled failure only — while a refetch is in flight the skeleton owns
  // the pane (mirrors session-history-dialog.tsx).
  const sessionsFailed = sessionsError != null && !sessionsLoading;

  const sorted = useMemo(() => [...sessions].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)), [sessions]);

  const filterFn = useCallback((s: ChatSession, q: string) => (s.title ?? "").toLowerCase().includes(q), []);
  const { query, setQuery, setSelectedId, filtered, active, activeId } = useAssetPage<ChatSession, number>({
    items: sorted,
    filterFn,
  });

  const messagesOp = useOp<ChatMessage[]>(
    "list_chat_messages",
    activeId != null ? { sessionId: activeId } : undefined,
    { enabled: activeId != null, onError: "log" },
  );
  const messages = messagesOp.data ?? null;
  const loading = messagesOp.loading;
  const error = messagesOp.error;

  return (
    <AssetShell>
      <AssetPageHeader
        subtitle={`${t("memory.blocksCount", { count: filtered.length })} · ${t("memory.l1Count", { count: memories.memories.length })}`}
        title={t("memory.chatMemoryTitle")}
      />
      <FilterBar
        filteredCount={filtered.length}
        onChange={setQuery}
        placeholder={t("memory.filterBlocks")}
        totalCount={sessions.length}
        value={query}
      />
      <AssetSplitLayout
        detail={
          <BlockDetail
            error={error}
            loading={loading}
            memories={memories}
            messages={messages}
            session={active}
            tab={tab}
            onTabChange={setTab}
          />
        }
        sidebar={
          <AssetListPanel
            count={`${filtered.length}`}
            emptyText={
              sessionsFailed ? (
                <span className="flex flex-col items-center gap-2">
                  <span className="text-muted-foreground" role="alert">
                    {t("memory.sessionLoadError", { error: sessionsError ?? "" })}
                  </span>
                  {onRetrySessions != null && (
                    <Button onClick={onRetrySessions} size="xs" variant="outline">
                      {t("common.retry")}
                    </Button>
                  )}
                </span>
              ) : (
                t("memory.noBlocks")
              )
            }
            getItemId={(s) => String(s.id)}
            items={filtered}
            loading={!!sessionsLoading && sessions.length === 0}
            onSelect={(s) => setSelectedId(s.id)}
            renderItem={(s) => (
              <>
                <AssetItemHeader>
                  <AssetItemName title={s.title ?? undefined}>{s.title ?? t("memory.untitled")}</AssetItemName>
                </AssetItemHeader>
                <AssetItemBadges>{s.archived && <AssetBadge>{t("memory.archived")}</AssetBadge>}</AssetItemBadges>
                <AssetItemMeta>
                  {/* Left: when the block was opened (absolute, so it stays
                      stable while scanning). Right: last activity (relative,
                      so the block most likely wanted sits nearest). */}
                  <span>{fmtDate((s.createdAt ?? 0) * 1000)}</span>
                  <AssetItemTime>{fmtRelative((s.updatedAt ?? s.createdAt ?? 0) * 1000)}</AssetItemTime>
                </AssetItemMeta>
              </>
            )}
            selectedId={active != null ? String(active.id) : null}
            title={t("memory.blocks")}
          />
        }
        storageKey="kawai:memory:splitWidth"
      />
    </AssetShell>
  );
}

/**
 * The layer tabs over the selected block.
 *
 * `session` is null until the user picks a block, and the pane still mounts:
 * only L0 (the transcript) and L1's per-block extract are block-scoped, so
 * gating the whole pane on a selection left six GLOBAL layers — profile
 * facets, experiences, scenes, persona, memories, the graph — unreachable
 * until a chat existed. With no chats at all the page was a dead end.
 */
function BlockDetail({
  session,
  messages,
  loading,
  error,
  memories,
  tab,
  onTabChange,
}: {
  /** The selected block, or null when none is selected yet. */
  session: ChatSession | null;
  messages: ChatMessage[] | null;
  loading: boolean;
  error: string | null;
  memories: MemoriesStore;
  tab: MemoryTab;
  onTabChange: (t: MemoryTab) => void;
}) {
  const { t, fmtDate } = useI18n();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-3">
        <h3 className="truncate text-sm font-semibold">
          {session ? (session.title ?? t("memory.untitled")) : t("memory.allBlocks")}
        </h3>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {session
            ? `${t("memory.blockLabel", { id: session.id })} · ${fmtDate((session.createdAt ?? 0) * 1000)}`
            : t("memory.allBlocksHint")}
        </p>
      </div>
      <Tabs className="flex min-h-0 flex-1 flex-col" onValueChange={(v) => onTabChange(v as MemoryTab)} value={tab}>
        <MemoryLayerTabs tab={tab} />
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="l0">
          {session ? (
            <Transcript error={error} loading={loading} messages={messages} />
          ) : (
            <div className="_alp-detail-empty">{t("memory.selectBlock")}</div>
          )}
        </TabsContent>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="l1">
          <L1Pane memories={memories} session={session} />
        </TabsContent>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="l2">
          <ScenePane />
        </TabsContent>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="l3">
          <PersonaPane />
        </TabsContent>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="exp">
          <ExperiencesPane />
        </TabsContent>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="profile">
          <ProfilePane />
        </TabsContent>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="graph">
          <GraphPane />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * The layer strip. Seven labels never fit a narrow split pane, so the row
 * scrolls horizontally instead of clipping — a clipped layer is a layer the
 * user cannot discover, and the graph sits last, exactly where an overflow
 * would hide it. The active trigger is scrolled into view on every change so
 * keyboard and click navigation agree on what's on screen.
 */
export function MemoryLayerTabs({ tab }: { tab: MemoryTab }) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tab` is the TRIGGER — a new selection is what must scroll the strip, and the effect body reaches the DOM rather than the value
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-state="active"]');
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);

  return (
    <div
      className="flex shrink-0 overflow-x-auto border-b px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      ref={listRef}
    >
      <TabsList className="h-9 w-max min-w-full justify-start">
        {LAYER_TABS.map(({ value, labelKey }) => (
          <TabsTrigger className="flex-none" key={value} value={value}>
            {t(labelKey)}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  );
}

/** Graph — the whole entity-memory graph, lazily code-split. */
function GraphPane() {
  const { t } = useI18n();
  const op = useOp<MemoryGraphExport>("memory_graph_export", {}, { onError: "toast" });
  const data = op.data ?? null;
  const loading = op.loading && !data;
  const error = op.error;

  if (loading && !data) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center gap-2 p-4 text-sm">
        <Spinner className="size-4" /> {t("memory.graphBuilding")}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-1 flex-col items-start gap-2 p-4 text-sm">
        <p className="text-muted-foreground">{t("memory.graphBuildError", { error })}</p>
        <Button onClick={() => void op.execute()} size="xs" variant="outline">
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  // Backend only emits these two kind values; specta Option<string> arrives
  // as `string | null`, normalized to `undefined` for the graph node type.
  const nodes = (data?.nodes ?? []).map((n) => ({
    ...n,
    kind: n.kind as "memory" | "entity",
    content: n.content ?? undefined,
  }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Pane
        toolbar={
          <>
            <RefreshButton loading={op.loading} onClick={() => void op.execute()} />
            <span className="text-muted-foreground ml-auto text-xs">{t("memory.graphNote")}</span>
          </>
        }
      >
        <Suspense
          fallback={
            <div className="text-muted-foreground flex h-[640px] items-center justify-center text-sm">
              <Spinner className="mr-2 size-4" /> {t("memory.graphLoading")}
            </div>
          }
        >
          <MemoryGraph edges={data?.edges ?? []} emptyHint={t("memory.graphEmpty")} fill nodes={nodes} showLabels />
        </Suspense>
      </Pane>
    </div>
  );
}

/** Shared pane scaffolding: toolbar row on top, scrollable content below. */
function Pane({ toolbar, children }: { toolbar: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2">{toolbar}</div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </div>
  );
}

/** The re-read affordance every global pane shares. */
function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  const { t } = useI18n();
  return (
    <Button disabled={loading} onClick={onClick} size="xs" variant="outline">
      {loading ? <Spinner className="size-3" /> : <Icon name="search" className="size-3" />}
      {t("memory.refresh")}
    </Button>
  );
}

/** Shared list-pane chrome: Refresh (+ optional extra actions) and the count
 *  label in the toolbar, then the loading / empty / list tricolumn both list
 *  panes render. `list` is a prop (not children) so call sites keep their
 *  exact list-body indentation. */
function ListPane({
  loading,
  total,
  note,
  extra,
  empty,
  onRefresh,
  list,
}: {
  loading: boolean;
  total: number;
  note: ReactNode;
  extra?: ReactNode;
  empty: string;
  onRefresh: () => void;
  list: ReactNode;
}) {
  return (
    <Pane
      toolbar={
        <>
          <RefreshButton loading={loading} onClick={onRefresh} />
          {extra}
          {total > 0 && <span className="text-muted-foreground ml-auto text-xs">{note}</span>}
        </>
      }
    >
      {loading && total === 0 ? (
        <LoadingRow />
      ) : total === 0 ? (
        <p className="text-muted-foreground text-sm">{empty}</p>
      ) : (
        list
      )}
    </Pane>
  );
}

/** The app's one "a read is in flight" row. */
function LoadingRow() {
  const { t } = useI18n();
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-sm">
      <Spinner className="size-4" /> {t("common.loading")}
    </div>
  );
}
/** Experiences — one distilled row per completed supervisor run (read-only
 *  list + delete; written by the supervisor, consumed by the planner). */
function ExperiencesPane() {
  const { t, fmtDate } = useI18n();
  const op = useOp<ExperienceItem[]>("experience_list", {}, { onError: "toast" });

  const remove = useCallback(
    async (id: string) => {
      try {
        await call<boolean>("experience_delete", { experienceId: id });
        await op.execute();
      } catch (err) {
        showErrorToast(errText(err));
      }
    },
    [op],
  );
  const { armedId, click } = useArmedConfirm(remove);

  const items = op.data ?? [];
  return (
    <ListPane
      empty={t("memory.noExperiences")}
      loading={op.loading}
      note={t("memory.experiencesNote")}
      onRefresh={() => void op.execute()}
      total={items.length}
      list={
        <ol className="flex flex-col gap-2">
          {items.map((e) => (
            <li className="rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-3" key={e.id}>
              <div className="flex items-start gap-2">
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] uppercase",
                    e.outcome === "success"
                      ? "bg-[var(--tea-color-bg-secondary-default)]"
                      : "text-destructive bg-[var(--tea-color-bg-secondary-default)]",
                  )}
                >
                  {e.outcome}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium" title={e.taskSummary}>
                    {e.taskSummary}
                  </p>
                  {e.lesson && <p className="mt-1 text-xs">💡 {e.lesson}</p>}
                  <p className="text-muted-foreground mt-1.5 text-[11px]">
                    {t("memory.experienceMeta", {
                      session: e.sessionId,
                      tools: e.toolSequence.join(", ") || "—",
                      time: fmtDate(e.createdAt * 1000),
                    })}
                  </p>
                </div>
                <ConfirmIconButton
                  armed={armedId === e.id}
                  confirmLabel={t("memory.confirmAgain")}
                  icon="trash"
                  label={t("memory.deleteExperience")}
                  onClick={() => void click(e.id)}
                />
              </div>
            </li>
          ))}
        </ol>
      }
    />
  );
}

/** Profile — stable facets distilled from profile memories (kawai's
 *  PROFILE.md as a table): pin/forget, reset non-pinned, re-distill via
 *  memory extraction. */
function ProfilePane() {
  const { t } = useI18n();
  const op = useOp<ProfileFacet[]>("facet_list", {}, { onError: "toast" });
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (!confirmReset) return;
    const timer = setTimeout(() => setConfirmReset(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmReset]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        await op.execute();
      } catch (err) {
        showErrorToast(errText(err));
      }
    },
    [op],
  );

  const items = op.data ?? [];
  return (
    <ListPane
      empty={t("memory.noFacets")}
      extra={
        <Button
          disabled={items.length === 0}
          onClick={async () => {
            if (!confirmReset) {
              setConfirmReset(true);
              return;
            }
            setConfirmReset(false);
            await act(() => call("facet_reset_non_pinned"));
          }}
          size="xs"
          title={confirmReset ? t("memory.confirmAgain") : t("memory.resetNonPinnedTitle")}
          variant="outline"
        >
          {confirmReset ? t("memory.confirmReset") : t("memory.resetNonPinned")}
        </Button>
      }
      loading={op.loading}
      note={t("memory.profileNote")}
      onRefresh={() => void op.execute()}
      total={items.length}
      list={
        <ol className="flex flex-col gap-2">
          {items.map((f) => (
            <FacetRow facet={f} key={f.key} onAct={act} />
          ))}
        </ol>
      }
    />
  );
}

/** One profile facet: namespaced key, value, stability, pin + forget. */
function FacetRow({ facet, onAct }: { facet: ProfileFacet; onAct: (fn: () => Promise<unknown>) => Promise<void> }) {
  const { t } = useI18n();
  const forget = useCallback((id: string) => onAct(() => call("facet_forget", { key: id })), [onAct]);
  const { armedId, click } = useArmedConfirm(forget);
  const pinned = facet.userState === "pinned";

  return (
    <li className="rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-3">
      <div className="flex items-start gap-2">
        <span className="text-muted-foreground shrink-0 rounded bg-[var(--tea-color-bg-secondary-default)] px-1.5 py-0.5 font-mono text-[11px]">
          {facet.key}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm">{facet.value}</p>
          <p className="text-muted-foreground mt-1 text-[11px]">
            {t("memory.stability", {
              value: ((facet.stability ?? 0) * 100).toFixed(0),
              state: facetStateLabel(t, facet.userState),
            })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            aria-label={pinned ? t("memory.unpinAria", { key: facet.key }) : t("memory.pinAria", { key: facet.key })}
            className={cn("rounded p-1", pinned ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
            onClick={() => void onAct(() => call("facet_pin", { key: facet.key, pinned: !pinned }))}
            title={pinned ? t("memory.pinned") : t("memory.pinTitle")}
            type="button"
          >
            <Icon className="size-3.5" name="star" />
          </button>
          <ConfirmIconButton
            armed={armedId === facet.key}
            confirmLabel={t("memory.confirmAgain")}
            icon="trash"
            label={t("memory.forgetAria", { key: facet.key })}
            onClick={() => void click(facet.key)}
          />
        </div>
      </div>
    </li>
  );
}

/** L2 — scenes: named clusters of related memories (regenerated wholesale). */
function ScenePane() {
  const { t } = useI18n();
  const tiers = useMemoryTiers(true);

  return (
    <Pane
      toolbar={
        <Button
          disabled={tiers.extracting}
          onClick={() => void tiers.extractScenes()}
          size="xs"
          title={t("memory.sceneExtractTitle")}
          variant="outline"
        >
          {tiers.extracting ? <Spinner className="size-3" /> : <Icon name="layers" className="size-3" />}
          {tiers.extracting ? t("memory.extractingScenes") : t("memory.sceneExtractButton")}
        </Button>
      }
    >
      {!tiers.scenesLoaded ? (
        <LoadingRow />
      ) : tiers.scenes.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("memory.noScenes")}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {tiers.scenes.map((s) => (
            <li className="rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-3" key={s.id}>
              <p className="text-sm font-medium">{s.title}</p>
              {s.summary && <p className="text-muted-foreground mt-0.5 text-xs">{s.summary}</p>}
              <ul className="mt-2 flex flex-wrap gap-1">
                {s.memories.map((m) => (
                  <li
                    className="rounded bg-[var(--tea-color-bg-secondary-default)] px-1.5 py-0.5 text-[11px]"
                    key={m.id}
                    title={m.content}
                  >
                    {m.title}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </Pane>
  );
}

/** L3 — persona: one synthesized user model, regenerated wholesale. */
function PersonaPane() {
  const { t } = useI18n();
  const tiers = useMemoryTiers(true);

  return (
    <Pane
      toolbar={
        <>
          <Button
            disabled={tiers.generating}
            onClick={() => void tiers.generatePersona()}
            size="xs"
            title={t("memory.personaGenerateTitle")}
            variant="outline"
          >
            {tiers.generating ? <Spinner className="size-3" /> : <Icon name="sparkles" className="size-3" />}
            {tiers.generating ? t("memory.generatingPersona") : t("memory.personaGenerateButton")}
          </Button>
          {/* The persona op returns the text alone — no write time — so the
              toolbar states what the row IS instead of dating it wrongly. */}
          {tiers.persona && <span className="text-muted-foreground text-xs">{t("memory.regenerated")}</span>}
        </>
      }
    >
      {!tiers.personaLoaded ? (
        <LoadingRow />
      ) : !tiers.persona ? (
        <p className="text-muted-foreground text-sm">{t("memory.noPersona")}</p>
      ) : (
        <div className="streamdown rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-3 text-sm">
          <MessageResponse mode="static">{tiers.persona}</MessageResponse>
        </div>
      )}
    </Pane>
  );
}

/**
 * L1 — atomic memories. The list is GLOBAL; only "Extract" is block-scoped,
 * so it is the one control here that reports WHY it is unavailable (no block
 * selected) rather than greying out silently.
 */
function L1Pane({ memories, session }: { memories: MemoriesStore; session: ChatSession | null }) {
  const { t } = useI18n();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MemoryItem[] | null>(null);
  const [searching, setSearching] = useState(false);

  const remove = useCallback((id: string) => memories.remove(id), [memories]);
  const { armedId, click } = useArmedConfirm(remove);

  const displayList = searchResults ?? memories.memories;

  const runSearch = useCallback(
    (query: string) => {
      const q = query.trim();
      if (!q) {
        setSearchResults(null);
        return;
      }
      setSearching(true);
      void memories.search(q).then((r) => {
        setSearchResults(r);
        setSearching(false);
      });
    },
    [memories],
  );

  const clearSearch = useCallback(() => {
    setSearchResults(null);
    setSearchQuery("");
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2">
        <Button
          disabled={memories.extracting || session == null}
          onClick={() => {
            if (session != null) void memories.extract(session.id);
          }}
          size="xs"
          title={session == null ? t("memory.selectBlockToExtract") : t("memory.facetDistillTitle")}
          variant="outline"
        >
          {memories.extracting ? <Spinner className="size-3" /> : <Icon name="sparkles" className="size-3" />}
          {memories.extracting ? t("memory.extracting") : t("memory.extractButton")}
        </Button>
        <Button
          onClick={() => {
            setEditing(null);
            setEditorOpen(true);
          }}
          size="xs"
          variant="outline"
        >
          <Icon name="plus" className="size-3" />
          {t("memory.createMemory")}
        </Button>
        <Button
          disabled={memories.consolidating || memories.memories.length < 2}
          onClick={() => void memories.consolidate()}
          size="xs"
          title={t("memory.consolidateTitle")}
          variant="outline"
        >
          {memories.consolidating ? <Spinner className="size-3" /> : <Icon name="merge" className="size-3" />}
          {memories.consolidating ? t("memory.consolidating") : t("memory.consolidateButton")}
        </Button>
        <div className="flex items-center gap-1">
          <Input
            aria-label={t("memory.semanticSearch")}
            className="h-7 w-48 text-xs"
            disabled={searching}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch(searchQuery);
            }}
            placeholder={t("memory.semanticSearch")}
            value={searchQuery}
          />
          {searchResults != null ? (
            <Button
              aria-label={t("common.clearSearch")}
              onClick={clearSearch}
              size="xs"
              title={t("common.clearSearch")}
              variant="ghost"
            >
              <Icon name="x" className="size-3" />
            </Button>
          ) : (
            <Button
              aria-label={t("memory.searchSemantic")}
              disabled={!searchQuery.trim() || searching}
              onClick={() => runSearch(searchQuery)}
              size="xs"
              title={t("memory.searchSemantic")}
              variant="ghost"
            >
              {searching ? <Spinner className="size-3" /> : <Icon name="search" className="size-3" />}
            </Button>
          )}
        </div>
        <span className="text-muted-foreground ml-auto text-xs">
          {searchResults != null
            ? t("memory.matchCount", { count: searchResults.length })
            : t("memory.globalMemories", { count: memories.memories.length })}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!memories.loaded ? (
          <LoadingRow />
        ) : displayList.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {searchResults != null ? t("memory.noMatches") : t("memory.noMemoriesHint")}
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {displayList.map((m) => (
              <MemoryRow
                item={m}
                key={m.id}
                onDelete={() => void click(m.id)}
                onEdit={() => {
                  setEditing(m);
                  setEditorOpen(true);
                }}
                armed={armedId === m.id}
              />
            ))}
          </ol>
        )}
      </div>
      {editorOpen && (
        <MemoryEditorDialog
          initial={editing}
          onClose={() => setEditorOpen(false)}
          onSave={async (kind, title, content) => {
            const saved =
              editing != null
                ? await memories.update(editing.id, { kind, title, content })
                : await memories.create(kind, title, content);
            if (saved) setEditorOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * One L1 memory.
 *
 * The badges are not decoration — `pinned`, `namespace` and `source` are
 * exactly the three fields that decide whether an agent will actually be told
 * this fact (pinned rows sort first and survive the prompt-block cap;
 * `profile`-namespace rows become facets), and until now the row showed only
 * the raw `kind` plus a timestamp, so a user auditing "what does Kawai know
 * about me" had nothing to audit against. `origin` answers the separate
 * question of HOW the row was written (hand-written vs distilled from a
 * transcript vs the product of a consolidate pass).
 */
export function MemoryRow({
  item,
  armed,
  onEdit,
  onDelete,
}: {
  item: MemoryItem;
  /** Whether this row's delete is armed and waiting for a second click. */
  armed: boolean;
  onEdit: () => void;
  onDelete: () => void | Promise<void>;
}) {
  const { t, fmtRelative } = useI18n();
  return (
    <li className="rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1">
            <Chip>{kindLabel(t, item.kind)}</Chip>
            <Chip>{namespaceLabel(t, item.namespace)}</Chip>
            <Chip>{sourceLabel(t, item.source)}</Chip>
            {item.pinned && (
              <Chip icon="star" title={t("memory.pinTitle")}>
                {t("memory.pinned")}
              </Chip>
            )}
          </div>
          <p className="text-sm font-medium" title={item.title}>
            {item.title}
          </p>
          <div className="streamdown mt-1 text-xs">
            <MessageResponse mode="static">{item.content}</MessageResponse>
          </div>
          <p className="text-muted-foreground mt-1.5 text-[11px]">
            {originLabel(t, item.origin)} · {fmtRelative(item.updatedAt * 1000)}
            {item.sourceSessionId != null && ` · ${t("memory.blockLabel", { id: item.sourceSessionId })}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            aria-label={t("memory.editMemoryAria", { title: item.title })}
            className="text-muted-foreground hover:text-foreground rounded p-1"
            onClick={onEdit}
            title={t("memory.editMemory")}
            type="button"
          >
            <Icon className="size-3.5" name="pencil" />
          </button>
          <ConfirmIconButton
            armed={armed}
            confirmLabel={t("memory.confirmAgain")}
            icon="trash"
            label={t("memory.deleteMemoryAria", { title: item.title })}
            onClick={onDelete}
          />
        </div>
      </div>
    </li>
  );
}

/** A small metadata pill — the L1 row's kind / namespace / source / pin. */
function Chip({ children, icon, title }: { children: ReactNode; icon?: string; title?: string }) {
  return (
    <span
      className="text-muted-foreground inline-flex items-center gap-1 rounded bg-[var(--tea-color-bg-secondary-default)] px-1.5 py-0.5 text-[11px]"
      title={title}
    >
      {icon && <Icon className="size-2.5" name={icon} />}
      {children}
    </span>
  );
}

function MemoryEditorDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: MemoryItem | null;
  onClose: () => void;
  onSave: (kind: MemoryItem["kind"], title: string, content: string) => void;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<MemoryItem["kind"]>(initial?.kind ?? "fact");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const valid = title.trim().length > 0 && content.trim().length > 0;

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {initial ? t("memory.editMemoryTitle", { title: initial.title }) : t("memory.newMemory")}
          </DialogTitle>
          <DialogDescription>{t("memory.factDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="memory-kind">
              {t("memory.kindLabel")}
            </label>
            <Select onValueChange={(v) => setKind(v as MemoryItem["kind"])} value={kind}>
              <SelectTrigger className="w-full" id="memory-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEMORY_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {kindLabel(t, k)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="memory-title">
              {t("memory.titleLabel")}
            </label>
            <Input
              id="memory-title"
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("memory.factPlaceholder")}
              value={title}
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="memory-content">
              {t("memory.contentLabel")}
            </label>
            <Textarea
              className="min-h-[100px]"
              id="memory-content"
              onChange={(e) => setContent(e.target.value)}
              placeholder={t("memory.factDescriptionPlaceholder")}
              value={content}
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t("common.cancel")}</Button>
          </DialogClose>
          <Button disabled={!valid} onClick={() => onSave(kind, title, content)}>
            {initial ? t("common.save") : t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** L0 — the stored conversation, verbatim (including tool frames). */
function Transcript({
  messages,
  loading,
  error,
}: {
  messages: ChatMessage[] | null;
  loading: boolean;
  error: string | null;
}) {
  const { t, fmtDate } = useI18n();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {loading ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Spinner className="size-4" /> {t("memory.loadingTranscript")}
        </div>
      ) : error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : messages == null || messages.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("memory.noMessages")}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {messages.map((m) => (
            <li
              className={
                m.role === "user"
                  ? "ml-8 rounded-lg border bg-[var(--tea-color-bg-brand-lighten-default)] p-3"
                  : "mr-8 rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-3"
              }
              key={m.id}
            >
              <div className="text-muted-foreground mb-1.5 flex items-center gap-2 text-[11px] uppercase">
                <span className="font-semibold">{m.role}</span>
                {m.createdAt != null && <span>{fmtDate(m.createdAt * 1000, { timeStyle: "short" })}</span>}
              </div>
              {m.role === "assistant" ? (
                <div className="streamdown text-sm">
                  <MessageResponse mode="static">{m.content}</MessageResponse>
                </div>
              ) : (
                <p className="text-sm whitespace-pre-wrap">{m.content}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
