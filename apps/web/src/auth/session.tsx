import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getMe, getMyPermissions, logout as logoutCall, type Account } from "../api/auth.ts";
import { SESSION_LOST_EVENT, setCsrfToken } from "../api/client.ts";
import { Skeleton } from "../ui/index.ts";
import { useTranslation } from "react-i18next";
import { ApiError, describeError } from "../api/errors.ts";
import { Button } from "../ui/index.ts";

/** Who is using the page, as `GET /api/auth/me` and `GET /api/me/permissions` describe them. */
export type Session =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "setup" | "open" | "guest" | "offline" }
  | { status: "account"; account: Account; server: ReadonlySet<string> };

interface Api {
  session: Session;
  /** Records a fresh sign-in (login, invite, setup) without another round trip for the account. */
  signedIn: (account: Account) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Context = createContext<Api | null>(null);

export function useSession(): Api {
  const api = useContext(Context);
  if (!api) throw new Error("useSession needs a <SessionProvider>");
  return api;
}

/** Whether the signed-in person holds a server-level permission (`open` mode may do everything). */
export function useServerCan(permission: string): boolean {
  const { session } = useSession();
  if (session.status === "open") return true;
  return session.status === "account" && session.server.has(permission);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ status: "loading" });

  const load = useCallback(async () => {
    try {
      const me = await getMe();
      if (me.state !== "account") {
        setCsrfToken(null);
        setSession({ status: me.state });
        return;
      }
      setCsrfToken(me.csrfToken);
      const permissions = await getMyPermissions().catch(() => ({ server: [] as string[] }));
      setSession({
        status: "account",
        account: me.account,
        server: new Set(permissions.server),
      });
    } catch (error) {
      // No connection: the app shell still opens (and says it is offline); who is using it is unknown.
      setSession(
        error instanceof ApiError && error.code === "network"
          ? { status: "offline" }
          : { status: "error", error },
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Back online: find out who is using the app now.
  useEffect(() => {
    const onOnline = () => void load();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [load]);

  // A request answered "sign in": find out whether the session ended.
  useEffect(() => {
    const onLost = () => void load();
    window.addEventListener(SESSION_LOST_EVENT, onLost);
    return () => window.removeEventListener(SESSION_LOST_EVENT, onLost);
  }, [load]);

  const api = useMemo<Api>(
    () => ({
      session,
      refresh: load,
      signedIn: async (account) => {
        const permissions = await getMyPermissions().catch(() => ({ server: [] as string[] }));
        setSession({ status: "account", account, server: new Set(permissions.server) });
      },
      signOut: async () => {
        await logoutCall();
        await load();
      },
    }),
    [session, load],
  );

  return <Context.Provider value={api}>{children}</Context.Provider>;
}

/** Holds back the app until the first answer about who is using it. */
export function SessionBoundary({ children }: { children: ReactNode }) {
  const { session, refresh } = useSession();
  const { t } = useTranslation();
  if (session.status === "loading")
    return (
      <div className="page">
        <main className="page-main">
          <Skeleton lines={3} />
        </main>
      </div>
    );
  if (session.status === "error")
    return (
      <div className="page">
        <main className="page-main state" role="alert">
          <p>{describeError(t, session.error)}</p>
          <Button onClick={() => void refresh()}>{t("common.retry")}</Button>
        </main>
      </div>
    );
  return <>{children}</>;
}
