import {
  BarChart3Icon,
  BotIcon,
  BriefcaseIcon,
  CheckIcon,
  PlusIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  Presentation,
  SunIcon,
  TrendingUpIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type Theme, useTheme } from "@/hooks/use-theme";
import { type AssetViewId, ASSET_NAV } from "@/features/assets/components/asset-nav";

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
  "builtin.office": {
    icon: BriefcaseIcon,
    subtitle: "docs · pdf · sheets · chat",
    prompts: ["Summarize this PDF", "Create a weekly report", "Merge these invoices"],
  },
  "builtin.presentation": {
    icon: Presentation,
    subtitle: "slides · decks · storytelling",
    prompts: ["Create a pitch deck", "Turn this report into slides", "Make an executive presentation"],
  },
  "builtin.binance": {
    icon: TrendingUpIcon,
    subtitle: "crypto · market data · TA",
    prompts: ["Analyze BTCUSDT on the daily", "RSI and MACD for ETHUSDT", "Order book depth for SOLUSDT"],
  },
  "builtin.analytics": {
    icon: BarChart3Icon,
    subtitle: "csv · parquet · excel",
    prompts: ["Total sales by category this month", "Average transaction above $500", "Top 10 products by revenue"],
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
      {!collapsed && <span className="text-muted-foreground ml-2 truncate text-xs">Appearance</span>}
    </DropdownMenu>
  );
}

export function AssetsRail({
  assetView,
  collapsed,
  userId,
  onSelectAsset,
  onToggle,
  onLogout,
  onNewTask,
}: {
  /** Open asset workspace (center pane replaces chat); null = chat view. */
  assetView: AssetViewId | null;
  collapsed: boolean;
  userId: string | null;
  onSelectAsset: (id: AssetViewId) => void;
  onToggle: () => void;
  onLogout: () => void;
  onNewTask: () => void;
}) {
  return (
    <aside
      className={`bg-sidebar/40 flex shrink-0 flex-col border-r transition-[width] duration-150 ${
        collapsed ? "w-16" : "w-[190px] lg:w-[190px] xl:w-[210px]"
      }`}
    >
      <div className={`flex h-12 shrink-0 items-center gap-2 px-3 ${collapsed ? "justify-center px-0" : ""}`}>
        {!collapsed && <span className="font-mono text-xs text-muted-foreground">kawai</span>}
        <Button
          aria-expanded={!collapsed}
          aria-label="Toggle agents rail"
          className={collapsed ? "" : "ml-auto"}
          onClick={onToggle}
          size="icon"
          title="Toggle agents rail (⌘1)"
          variant="ghost"
        >
          {collapsed ? <PanelLeftOpenIcon className="size-4" /> : <PanelLeftCloseIcon className="size-4" />}
        </Button>
      </div>

      <div className={`px-2 ${collapsed ? "pt-2 pb-1.5" : "pt-3 pb-2"}`}>
        <Button
          aria-label="New Task"
          className={collapsed ? "w-full" : "w-full justify-start gap-2.5"}
          onClick={onNewTask}
          size={collapsed ? "icon" : "default"}
          title="New Task"
          variant="default"
        >
          <PlusIcon className="size-4" />
          {!collapsed && <span>New Task</span>}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!collapsed && (
          <p className="px-3 pt-4 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            Assets
          </p>
        )}

        <nav className={`flex flex-col gap-1 pb-2 ${collapsed ? "px-1.5" : "px-2"}`}>
          {ASSET_NAV.map((asset) => {
            const Icon = asset.icon;
            const active = assetView === asset.id;
            return (
              <button
                className={`flex w-full items-center rounded-lg text-left transition-colors ${
                  collapsed ? "justify-center p-2" : "gap-2.5 px-2.5 py-2"
                } ${active ? "bg-primary text-primary-foreground" : "hover:bg-[var(--tea-color-bg-secondary-default)]"}`}
                key={asset.id}
                onClick={() => onSelectAsset(asset.id)}
                title={`${asset.label} · ${asset.subtitle}`}
                type="button"
              >
                <span
                  className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${
                    active ? "bg-background/20" : "bg-muted"
                  }`}
                >
                  <Icon className="size-[15px]" />
                </span>
                {!collapsed && (
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm leading-tight font-medium">{asset.label}</span>
                    <span className="text-muted-foreground truncate text-xs leading-tight">{asset.subtitle}</span>
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div className={`mt-auto border-t p-3 ${collapsed ? "flex flex-col items-center gap-1.5 p-1.5" : "space-y-2"}`}>
        <div className={`flex items-center gap-2.5 ${collapsed ? "flex-col" : "w-full"}`}>
          <span
            className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            title={`Signed in as ${userId ?? "demo"}`}
          >
            {(userId ?? "d").charAt(0).toUpperCase()}
          </span>
          {!collapsed && (
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={userId ?? "demo"}>
              {userId ?? "demo"}
            </span>
          )}
        </div>
        {collapsed ? (
          <>
            <ThemeControl collapsed />
            <Button aria-label="Sign out" onClick={onLogout} size="icon" title="Sign out" variant="ghost">
              <LogOutIcon className="size-4" />
            </Button>
          </>
        ) : (
          <div className="flex w-full items-center justify-between gap-2">
            <Button
              className="h-8 flex-1 justify-start gap-2 text-xs"
              onClick={onLogout}
              title={`Sign out ${userId ?? ""}`}
              variant="outline"
            >
              <LogOutIcon className="size-3.5" />
              Sign out
            </Button>
            <ThemeControl collapsed={false} />
          </div>
        )}
      </div>
    </aside>
  );
}
