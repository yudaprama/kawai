import { SqlProfilesSection } from "@/features/analytics/components/sql-profiles-section";
import { Icon } from "@/components/shared/icon";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { AssetPageHeader } from "@/features/assets/components/asset/asset-page-header";
import { useI18n } from "@/hooks/use-i18n";

import { CredentialCard } from "./credential-card";
import { GitProviderCard } from "./git-provider-card";
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
      {/* Header + body share ONE centered column: a full-bleed header above a
          narrow body leaves a dead gap and reads as a broken layout. */}
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <AssetPageHeader title={t("credentials.title")} subtitle={t("credentials.subtitle")} />
        <SqlProfilesSection />
        <section className="space-y-4">
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase">
            <Icon name="key" className="size-3" />
            {t("credentials.apiKeysSection")}
          </span>
          {CREDENTIAL_PROVIDERS.map((provider) => (
            <CredentialCard key={provider.id} provider={provider} />
          ))}
        </section>
        {/* A connected account is not an API-key pair: it can be multiple rows
            (host + label) and its delete op takes arguments, so it owns its
            card instead of bending the CredentialProvider contract. */}
        <section className="space-y-4">
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase">
            <Icon name="github" className="size-3" />
            {t("credentials.connectedAccountsSection")}
          </span>
          <GitProviderCard />
        </section>
      </div>
    </AssetShell>
  );
}
