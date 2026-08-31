import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { ensureNotificationPermission, showNativeNotification } from "@/lib/native-notifications/tauriBridge";

export type NotificationCategory = "messages" | "agents" | "skills" | "system";

export interface NotificationItem {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  timestamp: number;
  read: boolean;
  deepLink?: string;
}

export interface NotificationPreferences {
  messages: boolean;
  agents: boolean;
  skills: boolean;
  system: boolean;
}

const MAX_ITEMS = 200;

const DEFAULT_PREFERENCES: NotificationPreferences = {
  messages: true,
  agents: true,
  skills: true,
  system: true,
};

function loadPreferences(): NotificationPreferences {
  try {
    const raw = localStorage.getItem("kawai-notification-prefs");
    if (raw) return { ...DEFAULT_PREFERENCES, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { ...DEFAULT_PREFERENCES };
}

function savePreferences(prefs: NotificationPreferences): void {
  try {
    localStorage.setItem("kawai-notification-prefs", JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

interface NotificationContextValue {
  items: NotificationItem[];
  unreadCount: number;
  preferences: NotificationPreferences;
  dispatch: (item: Omit<NotificationItem, "timestamp" | "read">) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
  setPreference: (category: NotificationCategory, enabled: boolean) => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be inside NotificationProvider");
  return ctx;
}

/**
 * Dispatch a notification: adds it to the in-app list, and fires a native
 * OS banner when the window is NOT focused (to avoid redundant toasts).
 */
function dispatchWithNativeBanner(
  _items: NotificationItem[],
  preferences: NotificationPreferences,
  item: NotificationItem,
  setItems: React.Dispatch<React.SetStateAction<NotificationItem[]>>,
): void {
  if (!preferences[item.category]) return;

  setItems((prev) => {
    // Dedup by id — replace existing if same id
    const filtered = prev.filter((i) => i.id !== item.id);
    return [item, ...filtered].slice(0, MAX_ITEMS);
  });

  // Only fire native banner when window is not focused
  if (typeof document !== "undefined" && !document.hasFocus()) {
    void showNativeNotification({ title: item.title, body: item.body });
  }
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [preferences, setPreferences] = useState<NotificationPreferences>(loadPreferences);
  const prefsRef = useRef(preferences);
  prefsRef.current = preferences;

  const dispatch = useCallback(
    (item: Omit<NotificationItem, "timestamp" | "read">) => {
      const full: NotificationItem = {
        ...item,
        timestamp: Date.now(),
        read: false,
      };
      dispatchWithNativeBanner(items, prefsRef.current, full, setItems);
    },
    [items],
  );

  const markRead = useCallback((id: string) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, read: true } : i)));
  }, []);

  const markAllRead = useCallback(() => {
    setItems((prev) => prev.map((i) => ({ ...i, read: true })));
  }, []);

  const clearAll = useCallback(() => {
    setItems([]);
  }, []);

  const setPreference = useCallback((category: NotificationCategory, enabled: boolean) => {
    setPreferences((prev) => {
      const next = { ...prev, [category]: enabled };
      savePreferences(next);
      return next;
    });
  }, []);

  const unreadCount = useMemo(() => items.filter((i) => !i.read).length, [items]);

  const value = useMemo<NotificationContextValue>(
    () => ({
      items,
      unreadCount,
      preferences,
      dispatch,
      markRead,
      markAllRead,
      clearAll,
      setPreference,
    }),
    [items, unreadCount, preferences, dispatch, markRead, markAllRead, clearAll, setPreference],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

/**
 * Request notification permission on mount. Call once at app boot.
 */
export function useNotificationPermission(): void {
  // Fire-and-forget — permission state is logged for diagnostics.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useMemo(() => {
    void ensureNotificationPermission();
  }, []);
}
