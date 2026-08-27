import { PlusIcon, WrenchIcon } from "lucide-react";
import { AssetListPanel } from "@/components/asset/asset-list-panel";
import { AssetPageHeader } from "@/components/asset/asset-page-header";
import { AssetSplitLayout } from "@/components/asset/asset-split-layout";
import { Button } from "@/components/ui/button";
import { AssetShell } from "@/panels/assets/asset-shell";

/**
 * Skills asset page — SkillsPanel structure (Tea asset-management UI) over an
 * honest empty state: the skill library (SKILL.md storage, versioning, hybrid
 * search, agent allocation) is the tier this build doesn't have yet. The shell
 * — header with import action, list ↔ detail split — is in place so the tier
 * drops straight in when it's built.
 */
export function SkillsAssetPage({ onBack }: { onBack: () => void }) {
  return (
    <AssetShell onBack={onBack} subtitle="agent skills" title="Skills">
      <AssetPageHeader
        actions={
          <Button disabled size="sm" title="Skill storage & versioning isn't part of this build yet">
            <PlusIcon className="size-3.5" />
            Import skill
          </Button>
        }
        subtitle="0 skills in the library"
        title="Skills"
      />
      <div className="mt-3">
        <AssetSplitLayout
          detail={
            <EmptyPane
              description="A skill is a reusable instruction set (SKILL.md) an agent can discover, version and follow. The storage + versioning + search tier isn't part of this build yet — skills will appear here once it exists."
              icon={<WrenchIcon className="size-5" />}
              label="No skills yet"
            />
          }
          sidebar={
            <AssetListPanel
              count="0"
              emptyText="No skills yet — the skill storage tier isn't part of this build."
              getItemId={(s) => s}
              items={[]}
              onSelect={() => {}}
              renderItem={() => null}
              title="Skills"
            />
          }
          storageKey="kawai:skills:splitWidth"
        />
      </div>
    </AssetShell>
  );
}

export function EmptyPane({ label, description, icon }: { label: string; description: string; icon: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="bg-muted flex size-12 items-center justify-center rounded-lg">{icon}</div>
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">{label}</p>
        <p className="max-w-md text-xs leading-relaxed">{description}</p>
      </div>
    </div>
  );
}
