import { SqlProfilesSection } from "@/features/analytics/components/sql-profiles-section";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { useI18n } from "@/hooks/use-i18n";

/**
 * SQL data sources asset page — the analytics agent's named database
 * connections (sql_profiles). Formerly the "Databases" tab of the chat-side
 * context pane; the pane now shows tool results, so source management lives
 * here.
 */
export function SqlSourcesAssetPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  return (
    <AssetShell onBack={onBack} subtitle="SQL sources" title={t("assetNav.databases")}>
      <div className="mx-auto w-full max-w-2xl p-4">
        <SqlProfilesSection />
      </div>
    </AssetShell>
  );
}
