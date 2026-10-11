import { Icon } from "@/components/shared/icon";
import { useEffect, useState } from "react";

import { ConfirmIconButton } from "@/components/shared/confirm-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Label } from "@/components/ui/label";
import { isRemoteSource, maskSource } from "@/features/analytics/lib/analytics";
import { call, errText, type SqlProfile, type SqlProfileTest } from "@/lib/api";
import { useOp } from "@/hooks/use-op";
import { toast } from "sonner";
import { useI18n } from "@/hooks/use-i18n";

/** Mirror of the backend's name rule: lowercase [a-z0-9_-], 1–32 chars. */
const NAME_OK = /^[a-z0-9_-]{1,32}$/;

interface TestState {
  name: string;
  ok: boolean;
  message: string;
}

export function SqlProfilesSection() {
  const { t } = useI18n();
  const listOp = useOp<SqlProfile[]>("sql_profile_list", undefined, { onError: "log" });
  const profiles = listOp.data ?? [];

  /** null = closed form (add), a profile = edit mode (name locked). */
  const [editing, setEditing] = useState<SqlProfile | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [test, setTest] = useState<TestState | null>(null);
  /** Two-click destructive confirm: the trash arms, a second click inside 3s
   *  deletes — same arm/disarm convention as every other delete in the app. */
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);
  /** The bottom error block used to render the moment the form opened —
   *  scolding an empty form before a single character was typed. It now waits
   *  for a save attempt; the inline per-field hint stays live while typing. */
  const [submitAttempted, setSubmitAttempted] = useState(false);
  useEffect(() => {
    if (confirmDeleteName == null) return;
    const t = setTimeout(() => setConfirmDeleteName(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteName]);

  const pickFile = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        title: t("credentials.databasePickTitle"),
        filters: [
          {
            name: t("credentials.databasePickFilter"),
            extensions: ["db", "sqlite", "sqlite3", "db3"],
          },
        ],
      });
      if (typeof picked === "string") setSource(picked);
    } catch {
      listOp.execute(); // surface error through the op's error state
    }
  };

  const openAdd = () => {
    setEditing(null);
    setName("");
    setSource("");
    setSubmitAttempted(false);
    setFormOpen((v) => !v);
  };

  const openEdit = (profile: SqlProfile) => {
    setEditing(profile);
    setName(profile.name);
    setSource(profile.source);
    setFormOpen(true);
    setTest(null);
    setSubmitAttempted(false);
  };

  const save = async () => {
    const finalName = name.trim().toLowerCase();
    if (!NAME_OK.test(finalName) || !source.trim()) {
      setSubmitAttempted(true);
      return;
    }
    setSaving(true);
    try {
      await call("sql_profile_save", {
        name: finalName,
        source: source.trim(),
      });
      setName("");
      setSource("");
      setEditing(null);
      setFormOpen(false);
      await listOp.execute();
    } catch (err) {
      // A rejected save skips both the form reset and the refetch, so nothing
      // else would ever show the failure — toast it and keep the form open so
      // the typed input isn't lost.
      toast.error(errText(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (profileName: string) => {
    try {
      await call("sql_profile_delete", { name: profileName });
      if (test?.name === profileName) setTest(null);
      await listOp.execute();
    } catch (err) {
      // The delete never succeeded, so `test` and the list stay untouched —
      // report the failure instead of swallowing it.
      toast.error(errText(err));
    }
  };

  const runTest = async (profileName: string) => {
    setTesting(profileName);
    setTest(null);
    try {
      const res = await call<SqlProfileTest>("sql_profile_test", { name: profileName });
      setTest({
        name: profileName,
        ok: res.ok,
        message: res.ok
          ? `${t("credentials.databaseTestOk", { count: res.tables })}${res.sample.length ? `: ${res.sample.join(", ")}` : ""}`
          : (res.error ?? t("credentials.databaseTestFail")),
      });
    } catch (err) {
      setTest({ name: profileName, ok: false, message: errText(err) });
    } finally {
      setTesting(null);
    }
  };

  /** Mirrors the save() guard: name lowercased/trimmed, source trimmed. */
  const nameOk = NAME_OK.test(name.trim().toLowerCase());
  const sourceOk = source.trim().length > 0;
  const saveDisabled = saving || !nameOk || !sourceOk;
  const loaded = !listOp.loading;

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase">
          <Icon name="database" className="size-3" />
          {t("credentials.databasesSection")}
        </span>
        <Button onClick={openAdd} size="xs" variant="ghost">
          <Icon name="plus" className="size-3" />
          {t("credentials.addDatabase")}
        </Button>
      </div>
      <div className="space-y-1 px-1 pb-3">
        <p className="text-muted-foreground text-xs leading-relaxed">{t("credentials.databasesHelp")}</p>
        <p className="text-muted-foreground/80 text-xs leading-relaxed">{t("credentials.databasesHelpHint")}</p>
      </div>
      {formOpen && (
        <div className="mb-2 flex flex-col gap-2 rounded-md border p-2">
          <Label className="text-muted-foreground flex flex-col gap-1 text-xs font-medium" htmlFor="db-profile-name">
            {t("credentials.databaseNameLabel")}
            <Input
              disabled={editing != null}
              id="db-profile-name"
              onChange={(e) => setName(e.target.value)}
              placeholder={t("credentials.databaseName")}
              value={name}
            />
          </Label>
          {name.length > 0 && !NAME_OK.test(name.trim().toLowerCase()) && (
            <p className="text-xs text-warning">{t("credentials.databaseNameError")}</p>
          )}
          <div className="flex items-end gap-2">
            <Label className="text-muted-foreground flex flex-1 flex-col gap-1 text-xs font-medium" htmlFor="db-source">
              {t("credentials.databaseSourceLabel")}
              <Input
                id="db-source"
                onChange={(e) => setSource(e.target.value)}
                placeholder={t("credentials.databaseSource")}
                value={source}
              />
            </Label>
            <Button onClick={pickFile} size="sm" variant="outline">
              <Icon name="folder-open" className="size-3" />
            </Button>
          </div>
          {isRemoteSource(source) && <p className="text-xs text-warning">{t("credentials.databaseRemoteHint")}</p>}
          <div className="flex items-center justify-end gap-2">
            {saving && <Spinner className="size-3" />}
            <Button disabled={saveDisabled} onClick={save} size="sm">
              {t("common.save")}
            </Button>
          </div>
          {submitAttempted && !saving && saveDisabled && (
            <p className="text-xs text-destructive">
              {!nameOk ? t("credentials.databaseNameError") : t("credentials.databaseSourceError")}
            </p>
          )}
        </div>
      )}
      {listOp.error && <p className="px-1 pb-2 text-xs text-destructive">{listOp.error}</p>}
      {!loaded ? (
        <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
          <Spinner className="size-3" /> {t("common.loading")}
        </div>
      ) : profiles.length === 0 ? (
        <p className="text-muted-foreground px-1 text-xs">{t("credentials.databaseEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {profiles.map((p) => (
            <li className="group flex flex-col rounded-md border px-2 py-1.5" key={p.name}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="text-muted-foreground truncate text-xs" title={p.source}>
                    {maskSource(p.source)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    aria-label={`${t("analytics.testConnection")}: ${p.name}`}
                    disabled={testing != null}
                    onClick={() => void runTest(p.name)}
                    size="icon-sm"
                    title={t("analytics.testConnection")}
                    variant="ghost"
                  >
                    {testing === p.name ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <Icon name="database" className="size-3.5" />
                    )}
                  </Button>
                  <Button
                    aria-label={`${t("analytics.editSource")}: ${p.name}`}
                    onClick={() => openEdit(p)}
                    size="icon-sm"
                    title={t("analytics.editSource")}
                    variant="ghost"
                  >
                    <Icon name="pencil" className="size-3.5" />
                  </Button>
                  <ConfirmIconButton
                    armed={confirmDeleteName === p.name}
                    confirmLabel={t("common.confirm")}
                    icon="trash-2"
                    label={t("analytics.deleteSourceAria", { name: p.name })}
                    onClick={() => {
                      if (confirmDeleteName !== p.name) {
                        setConfirmDeleteName(p.name);
                        return;
                      }
                      setConfirmDeleteName(null);
                      void remove(p.name);
                    }}
                  />
                </div>
              </div>
              {test?.name === p.name && (
                <p className={`mt-1 text-xs ${test.ok ? "text-success" : "text-destructive"}`}>{test.message}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
