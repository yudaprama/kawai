import { SqlProfilesSection } from "@/features/analytics/components/sql-profiles-section";
import { AssetShell } from "@/features/assets/components/asset-shell";

/**
 * SQL data sources asset page — the analytics agent's named database
 * connections (sql_profiles). Formerly the "Databases" tab of the chat-side
 * context pane; the pane now shows tool results, so source management lives
 * here.
 */
export function SqlSourcesAssetPage() {
  return (
    <AssetShell>
      <div className="mx-auto w-full max-w-2xl p-4">
        <SqlProfilesSection />
      </div>
    </AssetShell>
  );
}
