import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme, type Theme } from "@/hooks/use-theme";
import type { AgentInfo } from "@/lib/api";
import {
  BotIcon,
  BriefcaseIcon,
  CheckIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SparklesIcon,
  SunIcon,
} from "lucide-react";

interface AgentPresentation {
  icon: typeof BriefcaseIcon;
  subtitle: string;
  prompts: string[];
}

const GENERIC_AGENT: AgentPresentation = {
  icon: BotIcon,
  subtitle: "agent",
  prompts: [],
};

const AGENT_META: Record<string, AgentPresentation> = {
  "builtin.chat": {
    icon: SparklesIcon,
    subtitle: "on-device assistant",
    prompts: ["How are you?", "Summarize my day", "Help me write an email"],
  },
  "builtin.office": {
    icon: BriefcaseIcon,
    subtitle: "docs · pdf · sheets",
    prompts: ["Summarize this PDF", "Create a weekly report", "Merge these invoices"],
  },
};

export const agentPresentation = (id: string): AgentPresentation => AGENT_META[id] ?? GENERIC_AGENT;

function ThemeControl({ collapsed }: { collapsed: boolean }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const TriggerIcon = resolvedTheme === "dark" ? MoonIcon : SunIcon;
  const options: { value: Theme; label: string; icon: typeof SunIcon }[] = [
    { value: "light", label: "Light", icon: SunIcon },
    { value: "dark", label: "Dark", icon: MoonIcon },
    { value: "system", label: "System", icon: MonitorIcon },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="Change theme" size="icon" title="Appearance" variant="ghost">
          <TriggerIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-36">
        {options.map((opt) => (
          <DropdownMenuItem key={opt.value} onClick={() => setTheme(opt.value)} className="gap-2">
            <opt.icon className="size-4 text-muted-foreground" />
            <span className="flex-1">{opt.label}</span>
            {theme === opt.value && <CheckIcon className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
      {!collapsed && (
        <span className="text-muted-foreground ml-2 truncate text-xs">Appearance</span>
      )}
    </DropdownMenu>
  );
}

export function AgentsRail({
  agents,
  activeAgentId,
  collapsed,
  userId,
  onSelectAgent,
  onToggle,
}: {
  agents: AgentInfo[];
  activeAgentId: string | null;
  collapsed: boolean;
  userId: string | null;
  onSelectAgent: (id: string) => void;
  onToggle: () => void;
}) {
  return (
    <aside
      className={`bg-sidebar/40 hidden shrink-0 flex-col border-r transition-[width] duration-150 md:flex ${
        collapsed ? "w-16" : "w-[210px]"
      }`}
    >
      <div
        className={`flex h-12 shrink-0 items-center gap-2 px-3 ${collapsed ? "justify-center px-0" : ""}`}
      >
        {!collapsed && <span className="font-mono text-xs text-muted-foreground">kawai</span>}
        <Button
          className={collapsed ? "" : "ml-auto"}
          onClick={onToggle}
          size="icon"
          title="Toggle agents rail (⌘1)"
          variant="ghost"
        >
          {collapsed ? <PanelLeftOpenIcon className="size-4" /> : <PanelLeftCloseIcon className="size-4" />}
        </Button>
      </div>

      {!collapsed && (
        <p className="px-3 pt-2 pb-1.5 text-[11px] tracking-wider text-muted-foreground uppercase">
          Agents
        </p>
      )}

      <nav className={`flex flex-col gap-1 ${collapsed ? "px-1.5" : "px-2"}`}>
        {agents.map((a) => {
          const meta = agentPresentation(a.id);
          const Icon = meta.icon;
          const active = a.id === activeAgentId;
          return (
            <button
              className={`flex w-full items-center rounded-lg text-left transition-colors ${
                collapsed ? "justify-center p-2" : "gap-2.5 px-2.5 py-2"
              } ${active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
              key={a.id}
              onClick={() => onSelectAgent(a.id)}
              title={`${a.name} · ${meta.subtitle}`}
            >
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${
                  active ? "bg-background/60" : "bg-muted"
                }`}
              >
                <Icon className="size-[15px]" />
              </span>
              {!collapsed && (
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm leading-tight font-medium">{a.name}</span>
                  <span className="text-muted-foreground truncate text-xs leading-tight">
                    {meta.subtitle}
                  </span>
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div
        className={`mt-auto flex items-center gap-2.5 border-t p-3 ${collapsed ? "flex-col p-1.5" : ""}`}
      >
        <span className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
          {(userId ?? "d").charAt(0).toUpperCase()}
        </span>
        {collapsed ? (
          <ThemeControl collapsed />
        ) : (
          <div className="flex w-full items-center justify-between gap-2">
            <span className="truncate font-mono text-xs text-muted-foreground">
              {userId ?? "demo"}
            </span>
            <ThemeControl collapsed={false} />
          </div>
        )}
      </div>
    </aside>
  );
}
