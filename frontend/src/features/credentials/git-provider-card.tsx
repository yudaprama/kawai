import { useCallback, useEffect, useState } from "react";

import { Icon } from "@/components/shared/icon";
import { ConfirmButton, useArmedConfirm } from "@/components/shared/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/hooks/use-i18n";
import { call, errText } from "@/lib/api";

/** One row of `git_token_status` (Rust `GitTokenStatus`, camelCase serde). */
interface GitTokenStatus {
  provider: string;
  host: string;
  account: string;
  scopes: string | null;
  tokenPreview: string;
  createdAt: number;
}

/** Stable row id for the two-step disconnect arm. */
function keyOf(s: GitTokenStatus): string {
  return `${s.provider}\u0000${s.host}\u0000${s.account}`;
}

/**
 * GitHub / GitLab personal access tokens — a CONNECTED ACCOUNT, not an API key
 * pair, so it does not ride the `CredentialProvider` card contract (that one
 * assumes a single status and a single no-arg delete op).
 *
 * The token is sent to the backend once and never comes back: every op here
 * renders a masked preview. Revoke at the provider before disconnecting —
 * `git_disconnect` only forgets the local row.
 */
export function GitProviderCard() {
  const { t } = useI18n();
  const [statuses, setStatuses] = useState<GitTokenStatus[] | null>(null);
  const [provider, setProvider] = useState<"github" | "gitlab">("github");
  const [token, setToken] = useState("");
  const [host, setHost] = useState("");
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatuses(await call<GitTokenStatus[]>("git_token_status"));
    } catch (e) {
      setError(errText(e));
      setStatuses([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await call("git_connect_pat", {
        provider,
        host: host.trim() || undefined,
        account: account.trim() || undefined,
        token: token.trim(),
      });
      setToken("");
      setNotice(t("credentials.git.connected"));
      await refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const { isArmed, click } = useArmedConfirm(async (id: string) => {
    const match = (statuses ?? []).find((s) => keyOf(s) === id);
    if (!match) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await call("git_disconnect", {
        provider: match.provider,
        host: match.host,
        account: match.account,
      });
      setNotice(t("credentials.git.disconnected"));
      await refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  });

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Icon name="github" className="text-muted-foreground size-4" />
          <span className="text-sm font-medium">{t("credentials.git.title")}</span>
          <span className="text-muted-foreground text-xs">{t("credentials.git.subtitle")}</span>
          {statuses === null && (
            <span className="ml-auto">
              <Spinner className="size-4" />
            </span>
          )}
          {statuses !== null && statuses.length > 0 && (
            <span className="text-muted-foreground ml-auto text-xs">
              {t("credentials.git.count", { count: statuses.length })}
            </span>
          )}
        </div>

        <p className="text-muted-foreground text-xs leading-relaxed">{t("credentials.git.guide")}</p>
        <div className="space-y-1">
          <Button aria-expanded={detailOpen} onClick={() => setDetailOpen((v) => !v)} size="xs" variant="ghost">
            <Icon aria-hidden name={detailOpen ? "chevron-down" : "chevron-right"} className="size-3" />
            {detailOpen ? t("credentials.guideDetailsHide") : t("credentials.guideDetailsShow")}
          </Button>
          {detailOpen && (
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs leading-relaxed">{t("credentials.git.guideDetail")}</p>
              <p className="text-muted-foreground text-xs leading-relaxed">{t("credentials.git.revokeHint")}</p>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {(["github", "gitlab"] as const).map((p) => (
              <Button key={p} onClick={() => setProvider(p)} size="xs" variant={provider === p ? "secondary" : "ghost"}>
                <Icon name={p} className="size-3" />
                {p}
              </Button>
            ))}
          </div>
          <Label className="text-muted-foreground flex flex-col gap-1 text-xs font-medium" htmlFor="git-token">
            {t("credentials.git.tokenLabel")}
            <Input
              autoComplete="new-password"
              id="git-token"
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_…"
              type="password"
              value={token}
            />
          </Label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Label className="text-muted-foreground flex flex-col gap-1 text-xs font-medium" htmlFor="git-host">
              {t("credentials.git.hostLabel")}
              <Input
                id="git-host"
                onChange={(e) => setHost(e.target.value)}
                placeholder={t("credentials.git.hostPlaceholder")}
                type="text"
                value={host}
              />
            </Label>
            <Label className="text-muted-foreground flex flex-col gap-1 text-xs font-medium" htmlFor="git-account">
              {t("credentials.git.accountLabel")}
              <Input
                id="git-account"
                onChange={(e) => setAccount(e.target.value)}
                placeholder={t("credentials.git.accountPlaceholder")}
                type="text"
                value={account}
              />
            </Label>
          </div>
          <p className="text-muted-foreground text-xs">{t("credentials.git.storedLocally")}</p>
        </div>

        {error && (
          <p className="text-destructive text-xs" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>}

        <div className="flex items-center gap-2">
          <Button disabled={busy || token.trim().length === 0} onClick={() => void connect()} size="sm">
            {busy ? <Spinner className="size-4" /> : t("credentials.git.connect")}
          </Button>
        </div>

        {statuses !== null && (
          <div className="space-y-2">
            {statuses.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t("credentials.git.empty")}</p>
            ) : (
              statuses.map((s) => {
                const id = keyOf(s);
                return (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border p-2 text-xs" key={id}>
                    <Icon name={s.provider} className="text-muted-foreground size-4" />
                    <span className="font-medium">{s.provider}</span>
                    <span className="text-muted-foreground break-all">{s.host}</span>
                    {s.account !== "default" && <Badge variant="secondary">{s.account}</Badge>}
                    <span className="ml-auto flex items-center gap-2">
                      <span className="font-mono">{s.tokenPreview}</span>
                      <ConfirmButton
                        armed={isArmed(id)}
                        confirmLabel={t("credentials.git.confirmRemove")}
                        label={t("credentials.git.remove")}
                        onClick={() => void click(id)}
                        size="xs"
                        variant="outline"
                      />
                    </span>
                    {s.scopes && (
                      <span className="text-muted-foreground w-full break-all">
                        {t("credentials.git.scopesLabel")}: {s.scopes}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
