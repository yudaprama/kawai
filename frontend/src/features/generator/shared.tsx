import type { ComponentType } from "react";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/hooks/use-i18n";
import { KeyStatusNotices, useEcoGroups, type LaneStatusView, type WorkflowLane } from "./civitai-shared";
import { ChoiceChip, EcoPicker, ResultsPaneTabs, useResultsPaneTab, type PaneTab } from "./generator-shell";
import type { PickerGroup } from "./picker-menu";

/**
 * The post-lane wiring every media generator repeats verbatim: the lane
 * fields its footer/header render, the results-pane tab that keeps results
 * and templates both reachable, and the ecosystem-menu groups the form's
 * `EcoPicker` shows.
 */
export function useGeneratorResultsPane<
  Snapshot,
  Status extends LaneStatusView,
  Entry,
  E extends { id: string; label: string; note?: string; gradient: string },
>(lane: WorkflowLane<Snapshot, Status, Entry>, ecosystems: E[], ecoId: string, switchEcosystem: (id: E["id"]) => void) {
  const { cancel, cost, costError, elapsed, job, removeEntry, results, status, submit, submitting } = lane;
  const pane = useResultsPaneTab({ busy: job != null, count: results.length });
  const { groups: ecoGroups, open: ecoOpen, setOpen: setEcoOpen } = useEcoGroups(ecosystems, ecoId, switchEcosystem);
  return {
    cancel,
    cost,
    costError,
    elapsed,
    job,
    removeEntry,
    results,
    status,
    submit,
    submitting,
    pane,
    ecoGroups,
    ecoOpen,
    setEcoOpen,
  };
}

/** The tab state the results ↔ templates header is driven by. */
interface Pane {
  active: PaneTab;
  set: (tab: PaneTab) => void;
}

/** Header above the form pane: results ↔ templates tabs. */
export function ResultsPaneHeader({
  count,
  pane,
  templatesLabel,
}: {
  count: number;
  pane: Pane;
  templatesLabel: string;
}) {
  const { t } = useI18n();
  return (
    <ResultsPaneTabs
      active={pane.active}
      onChange={pane.set}
      resultsLabel={t("generator.resultsCount", { count })}
      templatesLabel={templatesLabel}
    />
  );
}

/** The form's first rows: the ecosystem dropdown and the API-key notices. */
export function EcoFormLead({
  configured,
  ecoGroups,
  ecoLabel,
  ecoOpen,
  onEcoOpenChange,
}: {
  configured: boolean | null;
  ecoGroups: PickerGroup[];
  ecoLabel: string;
  ecoOpen: boolean;
  onEcoOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <EcoPicker
        ecoAriaLabel={t("videoGenerator.ecosystem")}
        ecoGroups={ecoGroups}
        ecoLabel={ecoLabel}
        ecoOpen={ecoOpen}
        onEcoOpenChange={onEcoOpenChange}
      />
      <KeyStatusNotices configured={configured} />
    </>
  );
}

/** "Model" label + wrap of choice chips for an ecosystem's pinned models. */
export function ModelChoiceChips({
  activeKey,
  models,
  onSelect,
}: {
  activeKey: string;
  models: Array<{ key: string; label: string }>;
  onSelect: (key: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Label className="text-muted-foreground text-[0.8125rem] font-medium">{t("generator.model")}</Label>
      <div className="flex flex-wrap gap-1.5">
        {models.map((m) => (
          <ChoiceChip
            active={activeKey === m.key}
            className="px-3"
            key={m.key || "default"}
            onClick={() => onSelect(m.key)}
          >
            {m.label}
          </ChoiceChip>
        ))}
      </div>
    </>
  );
}

/** The results grid under the templates pane: one card per result entry. */
export function ResultsGrid<Entry extends { fileId: string }>({
  Card,
  className,
  entries,
  onRemove,
  onReuse,
}: {
  Card: ComponentType<{ entry: Entry; onRemove: () => void; onReuse: () => void }>;
  className: string;
  entries: Entry[];
  onRemove: (entry: Entry) => void;
  onReuse: (entry: Entry) => void;
}) {
  return (
    <div className={className}>
      {entries.map((entry) => (
        <Card entry={entry} key={entry.fileId} onRemove={() => onRemove(entry)} onReuse={() => onReuse(entry)} />
      ))}
    </div>
  );
}
