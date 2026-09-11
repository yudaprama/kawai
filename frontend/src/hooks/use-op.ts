import { useCallback, useEffect, useRef, useState } from "react";
import { call, errText } from "@/lib/api";
import { logWarn } from "@/lib/logger";
import { showErrorToast } from "@/lib/utils";

export interface UseOpOptions {
  /** Auto-execute on mount. Set to `false` to defer (call `execute` manually). Default: `true`. */
  enabled?: boolean;
  /** How to surface errors. Default: `"log"` (warn-level, no toast). */
  onError?: "toast" | "log" | "silent";
}

export interface UseOpResult<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  /** Execute the command. Returns the result or `undefined` on error. Pass `overrideArgs` to change the payload. */
  execute: (overrideArgs?: Record<string, unknown>) => Promise<T | undefined>;
  /** Direct state setter for optimistic patches. */
  setData: React.Dispatch<React.SetStateAction<T | undefined>>;
}

/**
 * Standardized hook for single backend operations — replaces the repeated
 * `useState`/`useEffect`/`useCallback`/`call`/`errText`/feature-gate
 * boilerplate across knowledge, skills, memory, and analytics hooks.
 *
 * ```ts
 * const { data, loading, execute } = useOp<SkillInfo[]>("skill_list");
 * const { execute: save } = useOp("skill_save", undefined, { enabled: false, onError: "toast" });
 * ```
 */
export function useOp<T>(command: string, args?: Record<string, unknown>, opts?: UseOpOptions): UseOpResult<T> {
  const enabled = opts?.enabled ?? true;
  const onError = opts?.onError ?? "log";

  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const execute = useCallback(
    async (overrideArgs?: Record<string, unknown>): Promise<T | undefined> => {
      setLoading(true);
      setError(null);
      try {
        const result = await call<T>(command, overrideArgs ?? args);
        if (mountedRef.current) {
          setData(result);
          setUnavailable(false);
        }
        return result;
      } catch (err) {
        const msg = errText(err);
        if (mountedRef.current) {
          setError(msg);
          setUnavailable(true);
        }
        if (onError === "toast") {
          showErrorToast(err);
        } else if (onError === "log") {
          logWarn(command, err);
        }
        return undefined;
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [command, args, onError],
  );

  useEffect(() => {
    if (enabled) void execute();
  }, [enabled, execute]);

  return { data, loading, error, unavailable, execute, setData };
}
