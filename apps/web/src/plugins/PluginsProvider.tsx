import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/errors.ts";
import { SESSION_LOST_EVENT } from "../api/client.ts";
import { useSession } from "../auth/session.tsx";
import { useTheme } from "../theme/theme.ts";
import { useToast } from "../ui/index.ts";
import type { VaultCan } from "../workspace/useVaultPermissions.ts";
import type { LoadedPlugin } from "./frame.ts";
import { PluginHost } from "./host.ts";
import { loadPlugins, type LoadFailure } from "./load.ts";
import { ContributionRegistry } from "./registry.ts";

/** How often the approved set is asked for again, besides when the page regains focus. */
export const PLUGIN_REFRESH_MS = 30_000;

export interface PluginRuntime {
  host: PluginHost;
  registry: ContributionRegistry;
  /** Changes whenever the approved set or a session changed; use as an effect dependency. */
  revision: number;
  failures: readonly LoadFailure[];
  /** The first answer from the server has arrived. */
  loaded: boolean;
  reload: () => void;
}

export const PluginRuntimeContext = createContext<PluginRuntime | null>(null);
const Context = PluginRuntimeContext;

/** The plugin runtime of the open vault, or null outside a `PluginsProvider` (and for guests). */
export function usePluginRuntime(): PluginRuntime | null {
  return useContext(Context);
}

interface Props {
  vault: string;
  can: Pick<VaultCan, "write" | "propose">;
  openFile: (path: string) => void;
  children: ReactNode;
}

/**
 * Starts the plugin host of a vault and keeps it in step with the server: the approved set is
 * fetched on mount, every 30 seconds and when the page becomes visible again. Mount it with
 * `key={vault}` so plugins of two vaults never share a frame.
 */
export function PluginsProvider({ vault, can, openFile, children }: Props) {
  const { i18n } = useTranslation();
  const { theme } = useTheme();
  const toast = useToast();
  const { session } = useSession();
  const allowed = session.status === "account" || session.status === "open";

  const latest = useRef({ locale: i18n.language, theme, openFile, toast });
  latest.current = { locale: i18n.language, theme, openFile, toast };

  const host = useMemo(
    () =>
      new PluginHost({
        vault,
        actor: { read: true, write: can.write, propose: can.propose },
        locale: () => latest.current.locale,
        theme: () => latest.current.theme,
        openFile: (path) => latest.current.openFile(path),
        showNotice: (message, kind) => latest.current.toast.push({ message, kind }),
      }),
    // The host is per vault; rights are pushed in below.
    [vault],
  );
  useEffect(() => () => host.dispose(), [host]);
  useEffect(() => {
    host.setActor({ read: true, write: can.write, propose: can.propose });
  }, [host, can.write, can.propose]);

  const [failures, setFailures] = useState<readonly LoadFailure[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!allowed) {
      host.setPlugins([]);
      return;
    }
    const controller = new AbortController();
    const known = new Map<string, LoadedPlugin>(
      host.list().map((entry) => [entry.plugin.manifest.id, entry.plugin]),
    );
    loadPlugins(vault, known, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        host.setPlugins(result.plugins);
        setFailures(result.failures);
        setLoaded(true);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        // Losing access stops the plugins at once; a network blip keeps what is running.
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          host.setPlugins([]);
        }
        setLoaded(true);
      },
    );
    return () => controller.abort();
  }, [host, vault, allowed, tick]);

  useEffect(() => {
    if (!allowed) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    const timer = setInterval(reload, PLUGIN_REFRESH_MS);
    const onLost = () => host.setPlugins([]);
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(SESSION_LOST_EVENT, onLost);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(SESSION_LOST_EVENT, onLost);
    };
  }, [host, allowed, reload]);

  // Plugins learn about theme and language changes.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    host.emit("theme:changed", { theme });
  }, [host, theme]);
  useEffect(() => {
    host.emit("locale:changed", { locale: i18n.language });
  }, [host, i18n.language]);

  const revision = useSyncExternalStore(host.subscribe, () => host.revision);
  const value = useMemo<PluginRuntime>(
    () => ({
      host,
      registry: new ContributionRegistry(host.list()),
      revision,
      failures,
      loaded,
      reload,
    }),
    [host, revision, failures, loaded, reload],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
