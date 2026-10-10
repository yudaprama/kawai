import { AssetShell } from "@/features/assets/components/asset-shell";
import { AssetPageHeader } from "@/features/assets/components/asset/asset-page-header";
import { useI18n } from "@/hooks/use-i18n";

import { CredentialCard } from "./credential-card";
import { CREDENTIAL_PROVIDERS } from "./providers";

/**
 * Credentials asset page — one card per provider from the registry. Keys are
 * stored in the user's LOCAL database only: never synced, never sent anywhere.
 */
export function CredentialsPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  return (
    <AssetShell title={t("credentials.title")} subtitle={t("credentials.subtitle")} onBack={onBack}>
      <AssetPageHeader title={t("credentials.title")} subtitle={t("credentials.subtitle")} />
      <div className="mx-auto w-full max-w-2xl space-y-4">
        {CREDENTIAL_PROVIDERS.map((provider) => (
          <CredentialCard key={provider.id} provider={provider} />
        ))}
      </div>
    </AssetShell>
  );
}
