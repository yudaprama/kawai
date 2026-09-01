import { LayersIcon, MergeIcon, PencilIcon, PlusIcon, SearchIcon, SparklesIcon, TrashIcon, XIcon } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
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
import { useMemories } from "@/features/memory/hooks/use-memories";
import { useMemoryTiers } from "@/features/memory/hooks/use-memory-tiers";
import {
  MEMORY_KINDS,
  type ChatMessageInfo,
  type ChatSessionInfo,
  type MemoryGraphExport,
  type MemoryItem,
  call,
  errText,
} from "@/lib/api";
import { AssetShell } from "@/features/assets/components/asset-shell";

type MemoryTab = "l0" | "l1" | "l2" | "l3" | "graph";

// Code-split: the force-graph (d3-force + worker) only loads when the user
// opens the Graph tab.
const MemoryGraph = lazy(() =>
  import("@/components/memory-graph/MemoryGraph").then((m) => ({ default: m.MemoryGraph })),
);

/**
 * Memory asset page — ChatMemoryPanel structure (Tea asset-management UI):
 * page header with an agent filter, session blocks on the left, layer tabs on
 * the right. L0 (raw conversations) and L1 (atomic memories — global, with
 * cloud extraction + manual CRUD) are real; L2/L3 (scenes, persona) have no
 * pipeline tier yet and say so.
 */
export function MemoryAssetPage({ sessions, onBack }: { sessions: ChatSessionInfo[]; onBack: () => void }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessageInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<MemoryTab>("l0");

  const memories = useMemories(true);

  const sorted = useMemo(() => [...sessions].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)), [sessions]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((s) => {
      if (!q) return true;
      return (s.title ?? "untitled").toLowerCase().includes(q);
    });
  }, [sorted, query]);

  const active = filtered.find((s) => s.id === selectedId) ?? sorted.find((s) => s.id === selectedId) ?? null;
  const activeId = active?.id ?? null;

  // Load the transcript whenever a new session is selected.
  useEffect(() => {
    if (activeId == null) {
      setMessages(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    call<ChatMessageInfo[]>("list_chat_messages", { sessionId: activeId })
      .then((rows) => {
        if (!cancelled) setMessages(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  return (
    <AssetShell onBack={onBack} subtitle="chat memory" title="Memory">
      <AssetPageHeader
        subtitle={`${filtered.length} memory ${filtered.length === 1 ? "block" : "blocks"} · ${memories.memories.length} L1 ${memories.memories.length === 1 ? "memory" : "memories"}`}
        title="Chat Memory"
      />
      <div className="mb-3 mt-3 flex shrink-0 items-center">
        <Input
          className="max-w-xs"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter blocks…"
          type="search"
          value={query}
        />
        <span className="text-muted-foreground ml-3 text-xs">
          {filtered.length}/{sessions.length}
        </span>
      </div>
      <AssetSplitLayout
        detail={
          active ? (
            <BlockDetail
              error={error}
              loading={loading}
              memories={memories}
              messages={messages}
              session={active}
              tab={tab}
              onTabChange={setTab}
            />
          ) : (
            <div className="_alp-detail-empty">Select a memory block to inspect its layers</div>
          )
        }
        sidebar={
          <AssetListPanel
            count={`${filtered.length}`}
            emptyText="No memory blocks yet — start a chat with an agent first."
            getItemId={(s) => String(s.id)}
            items={filtered}
            onSelect={(s) => setSelectedId(s.id)}
            renderItem={(s) => (
              <>
                <AssetItemHeader>
                  <AssetItemName title={s.title ?? undefined}>{s.title ?? "Untitled"}</AssetItemName>
                </AssetItemHeader>
                <AssetItemBadges>{s.archived && <AssetBadge>archived</AssetBadge>}</AssetItemBadges>
                <AssetItemMeta>
                  <span>{s.createdAt != null ? new Date(s.createdAt * 1000).toLocaleDateString() : ""}</span>
                  <AssetItemTime>{s.createdAt != null ? formatTime(s.createdAt) : ""}</AssetItemTime>
                </AssetItemMeta>
              </>
            )}
            selectedId={active != null ? String(active.id) : null}
            title="Blocks"
          />
        }
        storageKey="kawai:memory:splitWidth"
      />
    </AssetShell>
  );
}

/** Layer tabs over one session's memory. */
function BlockDetail({
  session,
  messages,
  loading,
  error,
  memories,
  tab,
  onTabChange,
}: {
  session: ChatSessionInfo;
  messages: ChatMessageInfo[] | null;
  loading: boolean;
  error: string | null;
  memories: ReturnType<typeof useMemories>;
  tab: MemoryTab;
  onTabChange: (t: MemoryTab) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-3">
        <h3 className="truncate text-sm font-semibold">{session.title ?? "Untitled"}</h3>
        <p className="text-muted-foreground mt-0.5 text-xs">
          block #{session.id} · {new Date((session.createdAt ?? 0) * 1000).toLocaleString()}
        </p>
      </div>
      <Tabs className="flex min-h-0 flex-1 flex-col" onValueChange={(v) => onTabChange(v as MemoryTab)} value={tab}>
        <div className="shrink-0 border-b px-4">
          <TabsList className="h-9">
            <TabsTrigger value="l0">L0 · Conversations</TabsTrigger>
            <TabsTrigger value="l1">L1 · Memories</TabsTrigger>
            <TabsTrigger value="l2">L2 · Scenes</TabsTrigger>
            <TabsTrigger value="l3">L3 · Persona</TabsTrigger>
            <TabsTrigger value="graph">Graph</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="l0">
          <Transcript error={error} loading={loading} messages={messages} />
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
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="graph">
          <GraphPane />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Graph — the whole entity-memory graph, lazily code-split. */
function GraphPane() {
  const [data, setData] = useState<MemoryGraphExport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await call<MemoryGraphExport>("memory_graph_export", {}));
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading && !data) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center gap-2 p-4 text-sm">
        <Spinner className="size-4" /> Building graph…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-1 flex-col items-start gap-2 p-4 text-sm">
        <p className="text-muted-foreground">Couldn't build the graph — {error}</p>
        <Button onClick={() => void refresh()} size="xs" variant="outline">
          Retry
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
      <div className="flex shrink-0 items-center gap-1.5 border-b px-4 py-2">
        <Button disabled={loading} onClick={() => void refresh()} size="xs" variant="outline">
          {loading ? <Spinner className="size-3" /> : <SearchIcon className="size-3" />}
          Refresh
        </Button>
        <span className="text-muted-foreground ml-auto text-xs">memories (newest 200) + the entities they mention</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <Suspense
          fallback={
            <div className="text-muted-foreground flex h-[640px] items-center justify-center text-sm">
              <Spinner className="mr-2 size-4" /> Loading graph…
            </div>
          }
        >
          <MemoryGraph
            edges={data?.edges ?? []}
            emptyHint="No memories to graph yet — add or extract memories first."
            fill
            nodes={nodes}
            showLabels
          />
        </Suspense>
      </div>
    </div>
  );
}

/** L2 — scenes: named clusters of related memories (regenerated wholesale). */
function ScenePane() {
  const tiers = useMemoryTiers(true);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2">
        <Button
          disabled={tiers.extracting}
          onClick={() => void tiers.extractScenes()}
          size="xs"
          title="Cluster related memories and name each scene via the cloud tier (needs a configured vault). Replaces all existing scenes."
          variant="outline"
        >
          {tiers.extracting ? <Spinner className="size-3" /> : <LayersIcon className="size-3" />}
          {tiers.extracting ? "Extracting scenes…" : "Extract scenes"}
        </Button>
        <span className="text-muted-foreground ml-auto text-xs">
          {tiers.scenes.length} {tiers.scenes.length === 1 ? "scene" : "scenes"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!tiers.scenesLoaded ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner className="size-4" /> Loading…
          </div>
        ) : tiers.scenes.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No scenes yet — extract them from your memories above (needs at least a couple of related memories).
          </p>
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
      </div>
    </div>
  );
}

/** L3 — persona: one synthesized user model, regenerated wholesale. */
function PersonaPane() {
  const tiers = useMemoryTiers(true);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2">
        <Button
          disabled={tiers.generating}
          onClick={() => void tiers.generatePersona()}
          size="xs"
          title="Synthesize the persona from all memories via the cloud tier (needs a configured vault). Replaces the stored persona."
          variant="outline"
        >
          {tiers.generating ? <Spinner className="size-3" /> : <SparklesIcon className="size-3" />}
          {tiers.generating ? "Generating…" : "Generate persona"}
        </Button>
        {tiers.persona && (
          <span className="text-muted-foreground text-xs">updated {new Date().toLocaleDateString()}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!tiers.personaLoaded ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner className="size-4" /> Loading…
          </div>
        ) : !tiers.persona ? (
          <p className="text-muted-foreground text-sm">
            No persona yet — generate one from your memories (needs at least one memory).
          </p>
        ) : (
          <div className="streamdown rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-3 text-sm">
            <MessageResponse mode="static">{tiers.persona}</MessageResponse>
          </div>
        )}
      </div>
    </div>
  );
}

/** L1 — atomic memories. Global list; extraction pulls from the selected block. */
function L1Pane({ memories, session }: { memories: ReturnType<typeof useMemories>; session: ChatSessionInfo }) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MemoryItem[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (confirmDeleteId == null) return;
    const t = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);

  const displayList = searchResults ?? memories.memories;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2">
        <Button
          disabled={memories.extracting}
          onClick={() => void memories.extract(session.id)}
          size="xs"
          title="Distill durable facts from this block's transcript via the cloud tier (needs a configured vault)"
          variant="outline"
        >
          {memories.extracting ? <Spinner className="size-3" /> : <SparklesIcon className="size-3" />}
          {memories.extracting ? "Extracting…" : "Extract from this block"}
        </Button>
        <Button
          onClick={() => {
            setEditing(null);
            setEditorOpen(true);
          }}
          size="xs"
          variant="outline"
        >
          <PlusIcon className="size-3" />
          Add memory
        </Button>
        <Button
          disabled={memories.consolidating || memories.memories.length < 2}
          onClick={() => void memories.consolidate()}
          size="xs"
          title="Merge redundant memories into single items (embedding clustering + cloud LLM; needs a configured vault)"
          variant="outline"
        >
          {memories.consolidating ? <Spinner className="size-3" /> : <MergeIcon className="size-3" />}
          {memories.consolidating ? "Consolidating…" : "Consolidate"}
        </Button>
        <div className="flex items-center gap-1">
          <Input
            className="h-7 w-48 text-xs"
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (!searchQuery.trim()) {
                  setSearchResults(null);
                  return;
                }
                setSearching(true);
                void memories.search(searchQuery).then((r) => {
                  setSearchResults(r);
                  setSearching(false);
                });
              }
            }}
            placeholder="Semantic search…"
            value={searchQuery}
          />
          {searchResults != null ? (
            <Button
              onClick={() => {
                setSearchResults(null);
                setSearchQuery("");
              }}
              size="xs"
              title="Clear search"
              variant="ghost"
            >
              <XIcon className="size-3" />
            </Button>
          ) : (
            <Button
              disabled={!searchQuery.trim() || searching}
              onClick={() => {
                if (!searchQuery.trim()) return;
                setSearching(true);
                void memories.search(searchQuery).then((r) => {
                  setSearchResults(r);
                  setSearching(false);
                });
              }}
              size="xs"
              title="Search by semantic similarity"
              variant="ghost"
            >
              {searching ? <Spinner className="size-3" /> : <SearchIcon className="size-3" />}
            </Button>
          )}
        </div>
        <span className="text-muted-foreground ml-auto text-xs">
          {searchResults != null
            ? `${searchResults.length} ${searchResults.length === 1 ? "match" : "matches"}`
            : `${memories.memories.length} global ${memories.memories.length === 1 ? "memory" : "memories"}`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!memories.loaded ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner className="size-4" /> Loading…
          </div>
        ) : displayList.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {searchResults != null
              ? "No memories match your search."
              : "No memories yet — extract them from a block above, or add one manually."}
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {displayList.map((m) => (
              <li className="rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-3" key={m.id}>
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0 rounded bg-[var(--tea-color-bg-secondary-default)] px-1.5 py-0.5 font-mono text-[10px] uppercase">
                    {m.kind}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={m.title}>
                      {m.title}
                    </p>
                    <div className="streamdown mt-1 text-xs">
                      <MessageResponse mode="static">{m.content}</MessageResponse>
                    </div>
                    <p className="text-muted-foreground mt-1.5 text-[11px]">
                      {m.origin === "extracted" && m.sourceSessionId != null
                        ? `extracted · block #${m.sourceSessionId} · `
                        : `${m.origin} · `}
                      {new Date(m.updatedAt * 1000).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      aria-label={`Edit ${m.title}`}
                      className="text-muted-foreground hover:text-foreground rounded p-1"
                      onClick={() => {
                        setEditing(m);
                        setEditorOpen(true);
                      }}
                      title="Edit memory"
                      type="button"
                    >
                      <PencilIcon className="size-3.5" />
                    </button>
                    <button
                      aria-label={`Delete ${m.title}`}
                      className={`rounded p-1 ${confirmDeleteId === m.id ? "text-destructive" : "text-muted-foreground hover:text-destructive"}`}
                      onClick={async () => {
                        if (confirmDeleteId !== m.id) {
                          setConfirmDeleteId(m.id);
                          return;
                        }
                        setConfirmDeleteId(null);
                        await memories.remove(m.id);
                      }}
                      title={confirmDeleteId === m.id ? "Click again to confirm" : "Delete memory"}
                      type="button"
                    >
                      <TrashIcon className="size-3.5" />
                    </button>
                  </div>
                </div>
              </li>
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

function MemoryEditorDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: MemoryItem | null;
  onClose: () => void;
  onSave: (kind: MemoryItem["kind"], title: string, content: string) => void;
}) {
  const [kind, setKind] = useState<MemoryItem["kind"]>(initial?.kind ?? "fact");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const valid = title.trim().length > 0 && content.trim().length > 0;

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? `Edit “${initial.title}”` : "New memory"}</DialogTitle>
          <DialogDescription>An atomic, durable fact about the user the agents should remember.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="memory-kind">
              Kind
            </label>
            <Select onValueChange={(v) => setKind(v as MemoryItem["kind"])} value={kind}>
              <SelectTrigger className="w-full" id="memory-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEMORY_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="memory-title">
              Title
            </label>
            <Input
              id="memory-title"
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Prefers dark UIs"
              value={title}
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="memory-content">
              Content
            </label>
            <Textarea
              className="min-h-[100px]"
              id="memory-content"
              onChange={(e) => setContent(e.target.value)}
              placeholder="Always ships dark-mode-first interfaces; light mode only on request."
              value={content}
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button disabled={!valid} onClick={() => onSave(kind, title, content)}>
            {initial ? "Save" : "Create"}
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
  messages: ChatMessageInfo[] | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {loading ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Spinner className="size-4" /> Loading transcript…
        </div>
      ) : error ? (
        <p className="text-destructive text-sm">{error}</p>
      ) : messages != null && messages.length === 0 ? (
        <p className="text-muted-foreground text-sm">No messages stored for this block.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {messages?.map((m) => (
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
                {m.createdAt != null && <span>{formatTime(m.createdAt)}</span>}
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

function formatTime(createdAtSec: number): string {
  return new Date(createdAtSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
