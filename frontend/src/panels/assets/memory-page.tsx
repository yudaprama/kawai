import { LayersIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  AssetBadge,
  AssetItemBadges,
  AssetItemHeader,
  AssetItemMeta,
  AssetItemName,
  AssetItemTime,
  AssetListPanel,
} from "@/components/asset/asset-list-panel";
import { AssetPageHeader } from "@/components/asset/asset-page-header";
import { AssetSplitLayout } from "@/components/asset/asset-split-layout";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type AgentInfo, type ChatMessageInfo, type ChatSessionInfo, call, errText } from "@/lib/api";
import { AssetShell } from "@/panels/assets/asset-shell";

/**
 * Memory asset page — ChatMemoryPanel structure (Tea asset-management UI):
 * page header with an agent filter, session blocks on the left, and the
 * layer tabs L0–L3 on the right. L0 (raw conversations) is fully real;
 * L1–L3 (extracted memories / scenes / persona) are the memory pipeline
 * tiers this build doesn't have — the tabs state that plainly.
 */
export function MemoryAssetPage({
  sessions,
  agents,
  onBack,
}: {
  sessions: ChatSessionInfo[];
  agents: AgentInfo[];
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessageInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentName = useMemo(() => {
    const map = new Map(agents.map((a) => [a.id, a.name]));
    return (id: string) => map.get(id) ?? id;
  }, [agents]);

  const sorted = useMemo(() => [...sessions].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)), [sessions]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((s) => {
      if (agentFilter !== "all" && s.agentId !== agentFilter) return false;
      if (!q) return true;
      return (s.title ?? "untitled").toLowerCase().includes(q) || agentName(s.agentId).toLowerCase().includes(q);
    });
  }, [sorted, query, agentFilter, agentName]);

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
        if (!cancelled) setError(errText(e));
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
        agent={
          <Select onValueChange={setAgentFilter} value={agentFilter}>
            <SelectTrigger className="h-8 w-[190px]" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agents</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
        subtitle={`${filtered.length} memory ${filtered.length === 1 ? "block" : "blocks"} · L0 raw conversations`}
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
            <BlockDetail error={error} loading={loading} messages={messages} session={active} />
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
                <AssetItemBadges>
                  <AssetBadge>{agentName(s.agentId)}</AssetBadge>
                  {s.archived && <AssetBadge>archived</AssetBadge>}
                </AssetItemBadges>
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
}: {
  session: ChatSessionInfo;
  messages: ChatMessageInfo[] | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-3">
        <h3 className="truncate text-sm font-semibold">{session.title ?? "Untitled"}</h3>
        <p className="text-muted-foreground mt-0.5 text-xs">
          block #{session.id} · {new Date((session.createdAt ?? 0) * 1000).toLocaleString()}
        </p>
      </div>
      <Tabs className="flex min-h-0 flex-1 flex-col" value="l0">
        <div className="shrink-0 border-b px-4">
          <TabsList className="h-9">
            <TabsTrigger value="l0">L0 · Conversations</TabsTrigger>
            <TabsTrigger value="l1">L1 · Memories</TabsTrigger>
            <TabsTrigger value="l2">L2 · Scenes</TabsTrigger>
            <TabsTrigger value="l3">L3 · Persona</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="l0">
          <Transcript error={error} loading={loading} messages={messages} />
        </TabsContent>
        <TabsContent value="l1">
          <LayerEmpty
            description="L1 holds atomic memories (preferences, rules, facts, goals) extracted from conversations with dedup and conflict resolution. The extraction pipeline isn't part of this build yet."
            label="No extracted memories"
          />
        </TabsContent>
        <TabsContent value="l2">
          <LayerEmpty
            description="L2 groups memories into scene blocks — contextual situation summaries the agent navigates. Scene extraction isn't part of this build yet."
            label="No scene blocks"
          />
        </TabsContent>
        <TabsContent value="l3">
          <LayerEmpty
            description="L3 is the stable persona synthesized from all scenes — long-term identity and preferences. Persona generation isn't part of this build yet."
            label="No persona"
          />
        </TabsContent>
      </Tabs>
    </div>
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
              <p className="text-sm whitespace-pre-wrap">{m.content}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function LayerEmpty({ label, description }: { label: string; description: string }) {
  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="bg-muted flex size-12 items-center justify-center rounded-lg">
        <LayersIcon className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">{label}</p>
        <p className="max-w-md text-xs leading-relaxed">{description}</p>
      </div>
    </div>
  );
}

function formatTime(createdAtSec: number): string {
  return new Date(createdAtSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
