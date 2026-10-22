import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";

export type ToastKind = "info" | "success" | "error";

export interface ToastOptions {
  /** Already translated text. */
  message: string;
  kind?: ToastKind;
  /** Milliseconds before it goes away; 0 keeps it until dismissed. Errors stay longer. */
  duration?: number;
}

interface Item extends Required<Pick<ToastOptions, "message" | "kind">> {
  id: number;
}

interface Api {
  push: (toast: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const Context = createContext<Api | null>(null);

export function useToast(): Api {
  const api = useContext(Context);
  if (!api) throw new Error("useToast needs a <ToastProvider>");
  return api;
}

function ToastView({ item, onDismiss }: { item: Item; onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={`toast toast-${item.kind}`} role={item.kind === "error" ? "alert" : "status"}>
      <Icon name={item.kind === "error" ? "warning" : item.kind === "success" ? "check" : "info"} />
      <span className="toast-message">{item.message}</span>
      <Button variant="ghost" icon="close" aria-label={t("toast.dismiss")} onClick={onDismiss} />
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<Item[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setItems((all) => all.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    ({ message, kind = "info", duration }: ToastOptions) => {
      const id = next.current++;
      setItems((all) => [...all.slice(-3), { id, message, kind }]);
      const ms = duration ?? (kind === "error" ? 8000 : 4000);
      if (ms > 0)
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), ms),
        );
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <Context.Provider value={api}>
      {children}
      {createPortal(
        <div className="toast-region" role="region" aria-label={t("toast.region")}>
          {items.map((item) => (
            <ToastView key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
          ))}
        </div>,
        document.body,
      )}
    </Context.Provider>
  );
}
