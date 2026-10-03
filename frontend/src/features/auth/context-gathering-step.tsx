import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { call, errText } from "@/lib/api";
import { useOnboardingContext } from "@/features/auth/onboarding-provider";
import { useI18n } from "@/hooks/use-i18n";
import type { OnboardingEvent } from "@/hooks/use-onboarding";

const QUICK_QUESTIONS = [
  { key: "name", questionKey: "onboarding.question.name" },
  { key: "role", questionKey: "onboarding.question.role" },
  { key: "goal", questionKey: "onboarding.question.goal" },
] as const;

/**
 * Post-auth context gathering (PLAN-personal-context §2.3): a one-time,
 * fully skippable opt-in step. Three quick questions + an optional public
 * GitHub username → the agent starts with usable identity context. Rendered
 * between the auth gate and the app; never shown again after finish/skip.
 */
export function ContextGatheringStep({ children }: { children: React.ReactNode }) {
  const onboarding = useOnboardingContext();
  const { t } = useI18n();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [github, setGithub] = useState("");
  const [gmailOptIn, setGmailOptIn] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [importingDoc, setImportingDoc] = useState(false);
  const [docResult, setDocResult] = useState<string | null>(null);

  // Not yet known → render children rather than flashing the step. If the
  // status op FAILED (command missing / backend error), surface it instead
  // of silently entering the app — a silent skip would hide onboarding
  // forever with no way to tell why.
  if (onboarding.status == null) {
    if (!onboarding.loading) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-background p-6">
          <div className="w-full max-w-md space-y-4 text-center">
            <p className="text-muted-foreground text-sm">
              {t("onboarding.statusReadFailed", { error: onboarding.error ?? "unknown error" })}
            </p>
            <div className="flex justify-center gap-2">
              <Button onClick={() => void onboarding.refresh()} size="sm" variant="outline">
                {t("common.retry")}
              </Button>
              <Button onClick={() => setDismissed(true)} size="sm" variant="ghost">
                {t("onboarding.enterAnyway")}
              </Button>
            </div>
          </div>
        </main>
      );
    }
    return <>{children}</>;
  }
  // Completed, skipped, running-in-background, or user closed it → straight in.
  if (onboarding.status.completed || onboarding.done || dismissed || onboarding.entered)
    return (
      <>
        {children}
        <BackgroundProgress />
      </>
    );

  const importDocument = async (file: File) => {
    setImportingDoc(true);
    setDocResult(null);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result ?? "");
          resolve(result.slice(result.indexOf(",") + 1));
        };
        reader.onerror = () => reject(new Error("failed to read file"));
        reader.readAsDataURL(file);
      });
      const imported = await call<{ id: string }>("office_import_file", {
        name: file.name,
        dataBase64,
      });
      const stored = await call<number>("onboarding_import_document", { fileId: imported.id });
      setDocResult(
        stored > 0
          ? t("onboarding.docFactsSaved", { file: file.name, count: stored })
          : t("onboarding.docNothingNew", { file: file.name }),
      );
    } catch (err) {
      setDocResult(`✗ ${errText(err)}`);
    } finally {
      setImportingDoc(false);
    }
  };

  const start = async () => {
    await onboarding.run({
      questions: QUICK_QUESTIONS.map(({ questionKey, key }) => ({
        question: t(questionKey),
        answer: (answers[key] ?? "").trim(),
      })).filter((qa) => qa.answer.length > 0),
      githubUsername: github.trim() || undefined,
      gmail: gmailOptIn,
    });
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg space-y-6">
        <div className="space-y-1.5 text-center">
          <h1 className="text-2xl font-semibold text-foreground">{t("onboarding.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("onboarding.subtitle")}</p>
        </div>

        {!onboarding.running && onboarding.events.length === 0 ? (
          <div className="space-y-3 rounded-lg border p-4">
            {QUICK_QUESTIONS.map(({ key, questionKey }) => (
              <div key={key} className="grid gap-1">
                <label className="text-sm font-medium" htmlFor={`ob-${key}`}>
                  {t(questionKey)}
                </label>
                <Input
                  id={`ob-${key}`}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [key]: e.target.value }))}
                  value={answers[key] ?? ""}
                />
              </div>
            ))}
            <label className="flex items-start gap-2 text-sm" htmlFor="ob-gmail">
              <input
                checked={gmailOptIn}
                className="mt-0.5"
                id="ob-gmail"
                onChange={(e) => setGmailOptIn(e.target.checked)}
                type="checkbox"
              />
              <span>
                {t("onboarding.gmailScan")}
                <span className="text-muted-foreground"> {t("onboarding.gmailNote")}</span>
              </span>
            </label>
            <div className="grid gap-1">
              <p className="text-sm font-medium">
                {t("onboarding.resumeExportLabel")}{" "}
                <span className="text-muted-foreground font-normal">{t("onboarding.optional")}</span>
              </p>
              <input
                accept=".zip,.pdf,.html,.htm,.csv,.docx,.md,.txt"
                className="text-muted-foreground block w-full cursor-pointer text-xs file:mr-2 file:cursor-pointer file:rounded-md file:border file:border-input file:bg-transparent file:px-2 file:py-1 file:text-xs"
                disabled={importingDoc}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importDocument(f);
                  e.target.value = "";
                }}
                type="file"
              />
              {importingDoc && (
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Spinner className="size-3" /> {t("onboarding.extracting")}
                </span>
              )}
              {docResult && <span className="text-xs">{docResult}</span>}
            </div>
            <div className="grid gap-1">
              <label className="text-sm font-medium" htmlFor="ob-github">
                {t("onboarding.githubLabel")}{" "}
                <span className="text-muted-foreground font-normal">{t("onboarding.optional")}</span>
              </label>
              <Input
                id="ob-github"
                onChange={(e) => setGithub(e.target.value)}
                placeholder={t("onboarding.githubPlaceholder")}
                value={github}
              />
            </div>
          </div>
        ) : (
          <RunLog events={onboarding.events} running={onboarding.running} />
        )}

        <div className="flex items-center justify-center gap-2">
          {onboarding.running ? (
            <Button disabled size="sm">
              <Spinner className="size-3" /> {t("onboarding.working")}
            </Button>
          ) : (
            !onboarding.done && (
              <>
                <Button onClick={() => void start()} size="sm">
                  {t("onboarding.continue")}
                </Button>
                <Button onClick={() => void onboarding.skip()} size="sm" variant="ghost">
                  {t("onboarding.skipForNow")}
                </Button>
              </>
            )
          )}
          {(onboarding.done || onboarding.events.some((e) => e.type === "onboardingError")) && (
            <Button onClick={() => setDismissed(true)} size="sm" variant="outline">
              {t("onboarding.enterKawai")}
            </Button>
          )}
        </div>
      </div>
    </main>
  );
}

function RunLog({ events, running }: { events: OnboardingEvent[]; running: boolean }) {
  const { t } = useI18n();
  return (
    <ol className="space-y-1.5 rounded-lg border p-4 font-mono text-xs">
      {events.map((e, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only event log, no stable IDs
        <li className="text-muted-foreground" key={`${e.type}-${i}`}>
          {e.type === "sourceStarted" && <>{t("onboarding.runLog.gathering", { source: e.source })}</>}
          {e.type === "sourceProgress" && (
            <>
              {" "}
              {e.source}: {e.note}
            </>
          )}
          {e.type === "sourceCompleted" && <>✓ {e.source}</>}
          {e.type === "compressStarted" && <>{t("onboarding.runLog.distilling")}</>}
          {e.type === "profileReady" &&
            t("onboarding.runLog.profileReady", { profile: e.profile, people: e.people, goals: e.goals })}
          {e.type === "onboardingFinished" && <>{t("onboarding.runLog.finished", { count: e.totalItems })}</>}
          {e.type === "onboardingError" && <span className="text-destructive">✗ {e.message}</span>}
        </li>
      ))}
      {running && (
        <li className="flex items-center gap-1.5">
          <Spinner className="size-3" />
        </li>
      )}
    </ol>
  );
}

/** Compact bottom-right progress card for a background onboarding run. */
function BackgroundProgress() {
  const onboarding = useOnboardingContext();
  const { t } = useI18n();
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    if (!onboarding.done) return;
    setShowDone(true);
    const timer = setTimeout(() => setShowDone(false), 6000);
    return () => clearTimeout(timer);
  }, [onboarding.done]);

  if (!onboarding.running && !showDone) return null;

  const completed = onboarding.events.filter((e) => e.type === "sourceCompleted").length;
  const last = [...onboarding.events].reverse().find((e) => e.type === "sourceProgress" || e.type === "sourceStarted");
  const note =
    last?.type === "sourceProgress"
      ? last.note
      : last?.type === "sourceStarted"
        ? t("onboarding.progress.gathering", { source: last.source })
        : t("onboarding.progress.distilling");

  return (
    <div className="fixed right-4 bottom-4 z-50 w-72 rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-3 shadow-lg">
      {onboarding.running ? (
        <>
          <p className="flex items-center gap-2 text-sm font-medium">
            <Spinner className="size-3.5" /> {t("onboarding.progress.settingUp")}
          </p>
          <p className="text-muted-foreground mt-1 truncate text-xs" title={note}>
            {note}
          </p>
          <p className="text-muted-foreground mt-1 text-[11px]">
            {t("onboarding.progress.sourcesDone", { count: completed })}
          </p>
        </>
      ) : (
        <p className="text-sm font-medium">{t("onboarding.progress.profileReady")}</p>
      )}
    </div>
  );
}
