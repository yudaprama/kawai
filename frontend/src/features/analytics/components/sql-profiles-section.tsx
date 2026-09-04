import { DatabaseIcon, FolderOpenIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { isRemoteSource, maskSource } from "@/features/analytics/lib/analytics";
import { call, errText, type SqlProfileTest } from "@/lib/api";

type SqlProfile = { name: string; source: string };

/** Mirror of the backend's name rule: lowercase [a-z0-9_-], 1–32 chars. */
const NAME_OK = /^[a-z0-9_-]{1,32}$/;

interface TestState {
  name: string;
  ok: boolean;
  message: string;
}

export function SqlProfilesSection() {
  const [profiles, setProfiles] = useState<SqlProfile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** null = closed form (add), a profile = edit mode (name locked). */
  const [editing, setEditing] = useState<SqlProfile | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [test, setTest] = useState<TestState | null>(null);

  const load = useCallback(async () => {
    try {
      setProfiles(await call<SqlProfile[]>("sql_profile_list"));
      setError(null);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pickFile = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        title: "Choose a SQLite database file",
        filters: [
          {
            name: "SQLite database",
            extensions: ["db", "sqlite", "sqlite3", "db3"],
          },
        ],
      });
      if (typeof picked === "string") setSource(picked);
    } catch (err) {
      setError(errText(err));
    }
  };

  const openAdd = () => {
    setEditing(null);
    setName("");
    setSource("");
    setFormOpen((v) => !v);
  };

  const openEdit = (profile: SqlProfile) => {
    setEditing(profile);
    setName(profile.name);
    setSource(profile.source);
    setFormOpen(true);
    setTest(null);
  };

  const save = async () => {
    const finalName = name.trim().toLowerCase();
    if (!NAME_OK.test(finalName) || !source.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await call("sql_profile_save", {
        name: finalName,
        source: source.trim(),
      });
      setName("");
      setSource("");
      setEditing(null);
      setFormOpen(false);
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (profileName: string) => {
    try {
      await call("sql_profile_delete", { name: profileName });
      if (test?.name === profileName) setTest(null);
      await load();
    } catch (err) {
      setError(errText(err));
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
          ? `Connected · ${res.tables} table${res.tables === 1 ? "" : "s"}${res.sample.length ? `: ${res.sample.join(", ")}` : ""}`
          : (res.error ?? "Connection failed"),
      });
    } catch (err) {
      setTest({ name: profileName, ok: false, message: errText(err) });
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase">
          <DatabaseIcon className="size-3" />
          Connected databases
        </span>
        <Button onClick={openAdd} size="xs" variant="ghost">
          <PlusIcon className="size-3" />
          Add database
        </Button>
      </div>
      {formOpen && (
        <div className="mb-2 flex flex-col gap-2 rounded-md border p-2">
          <Input
            disabled={editing != null}
            onChange={(e) => setName(e.target.value)}
            placeholder="Profile name, e.g. finance"
            value={name}
          />
          {name.length > 0 && !NAME_OK.test(name.trim().toLowerCase()) && (
            <p className="text-xs text-warning">
              Use lowercase letters, numbers, hyphens, or underscores (max 32 characters).
            </p>
          )}
          <div className="flex gap-2">
            <Input
              onChange={(e) => setSource(e.target.value)}
              placeholder="/path/database.db or postgres://user@host/db"
              value={source}
            />
            <Button onClick={pickFile} size="sm" variant="outline">
              <FolderOpenIcon className="size-3" />
            </Button>
          </div>
          {isRemoteSource(source) && (
            <p className="text-xs text-warning">
              Remote URLs (Postgres/MySQL) require the analytics-sql build feature; the source will still be saved.
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            {saving && <Spinner className="size-3" />}
            <Button disabled={saving} onClick={save} size="sm">
              Save
            </Button>
          </div>
        </div>
      )}
      {error && <p className="px-1 pb-2 text-xs text-destructive">{error}</p>}
      {!loaded ? (
        <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
          <Spinner className="size-3" /> Loading…
        </div>
      ) : profiles.length === 0 ? (
        <p className="text-muted-foreground/70 px-1 text-xs">
          No databases yet. Connect a .db file to let the agent analyze its tables.
        </p>
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
                    aria-label={`Test connection for ${p.name}`}
                    disabled={testing != null}
                    onClick={() => void runTest(p.name)}
                    size="icon-sm"
                    title="Test connection"
                    variant="ghost"
                  >
                    {testing === p.name ? <Spinner className="size-3.5" /> : <DatabaseIcon className="size-3.5" />}
                  </Button>
                  <Button
                    aria-label={`Edit profile ${p.name}`}
                    onClick={() => openEdit(p)}
                    size="icon-sm"
                    title="Edit source"
                    variant="ghost"
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <Button
                    aria-label={`Delete profile ${p.name}`}
                    onClick={() => remove(p.name)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
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
