import { useCallback, useEffect, useState } from "react";

import { Icon } from "@/components/shared/icon";
import { useArmedConfirm, ConfirmButton } from "@/components/shared/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/hooks/use-i18n";
import { call, errText } from "@/lib/api";
import type { TranslationKey } from "@/lib/i18n";

import type { CredentialProvider, CredentialSource, CredentialStatus } from "./types";

const SOURCE_LABEL: Record<CredentialSource, TranslationKey> = {
  user: "credentials.sourceUser",
  baked: "credentials.sourceBaked",
  none: "credentials.sourceNone",
};

const SOURCE_TONE: Record<CredentialSource, string> = {
  user: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  baked: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  none: "bg-muted text-muted-foreground",
};

/**
 * One credential's card: status badge, guide, key fields, save/remove. Reads
 * and writes through the provider's own ops, so the backend contract stays
 * per-credential while the page stays generic.
 *
 * Secrets live in the user's LOCAL database only (never synced, never sent
 * anywhere), and removal is a two-step arm — losing the only key pair for a
 * provider falls tools back to the built-in one, or stops them entirely.
 */
export function CredentialCard({ provider }: { provider: CredentialProvider }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await call<CredentialStatus>(provider.statusOp));
    } catch (e) {
      setError(errText(e));
    }
  }, [provider.statusOp]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const args: Record<string, unknown> = {};
      for (const field of provider.fields) args[field.arg] = (values[field.arg] ?? "").trim();
      await call(provider.setOp, args);
      setValues({});
      setNotice(t("credentials.saved"));
      await refresh();
      // Companion cards (e.g. Binance futures-trading consent) re-read their
      // own status when the stored pair changes.
      window.dispatchEvent(new CustomEvent("kawai-credentials-changed", { detail: { id: provider.id } }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await call(provider.deleteOp);
      setNotice(t("credentials.removed"));
      await refresh();
      window.dispatchEvent(new CustomEvent("kawai-credentials-changed", { detail: { id: provider.id } }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const { isArmed, click } = useArmedConfirm(remove);
  const canSave = !busy && provider.fields.every((field) => (values[field.arg] ?? "").trim().length > 0);

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Icon name={provider.icon} className="text-muted-foreground size-4" />
          <span className="text-sm font-medium min-w-0 break-words">{t(provider.titleKey)}</span>
          <span className="text-muted-foreground text-xs min-w-0 break-words">{t(provider.subtitleKey)}</span>
          <span className="ml-auto flex items-center gap-2">
            {status === null ? (
              <Spinner className="size-4" />
            ) : (
              // Always name the state: an empty key form with no badge reads as
              // a broken card rather than "not configured yet".
              <Badge className={SOURCE_TONE[status.source]} variant="secondary">
                {t(SOURCE_LABEL[status.source])}
              </Badge>
            )}
            {status?.keyPreview && <span className="text-muted-foreground font-mono text-xs">{status.keyPreview}</span>}
          </span>
        </div>

        <p className="text-muted-foreground text-xs leading-relaxed">{t(provider.guideKey)}</p>
        {provider.guideDetailKey && (
          <div className="space-y-1">
            <Button aria-expanded={detailOpen} onClick={() => setDetailOpen((v) => !v)} size="xs" variant="ghost">
              <Icon aria-hidden name={detailOpen ? "chevron-down" : "chevron-right"} className="size-3" />
              {detailOpen ? t("credentials.guideDetailsHide") : t("credentials.guideDetailsShow")}
            </Button>
            {detailOpen && (
              <p className="text-muted-foreground text-xs leading-relaxed">{t(provider.guideDetailKey)}</p>
            )}
          </div>
        )}

        <div className="space-y-2">
          {provider.fields.map((field) => (
            <Label
              className="text-muted-foreground flex flex-col gap-1 text-xs font-medium"
              htmlFor={`${provider.id}-${field.arg}`}
              key={field.arg}
            >
              {t(field.labelKey)}
              <Input
                autoComplete={field.autoComplete}
                id={`${provider.id}-${field.arg}`}
                onChange={(e) => setValues((v) => ({ ...v, [field.arg]: e.target.value }))}
                type="password"
                value={values[field.arg] ?? ""}
              />
            </Label>
          ))}
        </div>

        {error && (
          <p className="text-destructive text-xs" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>}

        <div className="flex gap-2">
          <Button size="sm" disabled={!canSave} onClick={() => void save()}>
            {busy ? <Spinner className="size-4" /> : t("credentials.save")}
          </Button>
          {status?.source === "user" && (
            <ConfirmButton
              armed={isArmed(provider.id)}
              confirmLabel={t("credentials.confirmRemove")}
              label={t("credentials.remove")}
              onClick={() => void click(provider.id)}
              size="sm"
              variant="outline"
            />
          )}
        </div>

        {/* Provider settings sit BELOW the actions: the key form is the one
            thing a first-time visitor came here to do. */}
        {provider.extra}
      </CardContent>
    </Card>
  );
}
