import { SqlProfilesSection } from "@/features/analytics/components/sql-profiles-section";
import { Icon } from "@/components/shared/icon";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { AssetPageHeader } from "@/features/assets/components/asset/asset-page-header";
import { useI18n } from "@/hooks/use-i18n";

import { CredentialCard } from "./credential-card";
import { CREDENTIAL_PROVIDERS } from "./providers";

/**
 * Credentials asset page — the connected databases (sql_profiles) and one
 * card per key provider from the registry. Everything here lives in the
 * user's LOCAL database only: never synced, never sent anywhere.
 */
export function CredentialsPage() {
  const { t } = useI18n();
  return (
    <AssetShell>
      <AssetPageHeader title={t("credentials.title")} subtitle={t("credentials.subtitle")} />
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <SqlProfilesSection />
        <div className="space-y-4">
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase">
            <Icon name="key" className="size-3" />
            {t("credentials.apiKeysSection")}
          </span>
          {CREDENTIAL_PROVIDERS.map((provider) => (
            <CredentialCard key={provider.id} provider={provider} />
          ))}
        </div>
      </div>
    </AssetShell>
  );
}
