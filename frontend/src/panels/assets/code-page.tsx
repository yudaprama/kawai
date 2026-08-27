import { PlusIcon, GitBranchIcon } from "lucide-react";
import { AssetListPanel } from "@/components/asset/asset-list-panel";
import { AssetPageHeader } from "@/components/asset/asset-page-header";
import { AssetSplitLayout } from "@/components/asset/asset-split-layout";
import { Button } from "@/components/ui/button";
import { AssetShell, EmptyPane } from "@/panels/assets/asset-shell";

/**
 * Code asset page — CodeSourcesPanel structure (Tea asset-management UI) over
 * an honest empty state: the code graph (repo registration, symbol/edge
 * indexing, search/explore) is the tier this build doesn't have yet.
 */
export function CodeAssetPage({ onBack }: { onBack: () => void }) {
  return (
    <AssetShell onBack={onBack} subtitle="code graph" title="Code">
      <AssetPageHeader
        actions={
          <Button disabled size="sm" title="Repository indexing isn't part of this build yet">
            <PlusIcon className="size-3.5" />
            Register repo
          </Button>
        }
        subtitle="0 registered repositories"
        title="Code Graph"
      />
      <div className="mt-3">
        <AssetSplitLayout
          detail={
            <EmptyPane
              description="The code graph indexes a repository's symbols and relationships (calls, imports, extends) for code-aware search and blast-radius exploration. Repository indexing isn't part of this build yet — registered repos and their stats will appear here once it exists."
              icon={<GitBranchIcon className="size-5" />}
              label="No code graphs yet"
            />
          }
          sidebar={
            <AssetListPanel
              count="0"
              emptyText="No registered repositories — repo indexing isn't part of this build."
              getItemId={(s) => s}
              items={[]}
              onSelect={() => {}}
              renderItem={() => null}
              title="Repositories"
            />
          }
          storageKey="kawai:code:splitWidth"
        />
      </div>
    </AssetShell>
  );
}
