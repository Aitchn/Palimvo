import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveLocalized } from "@palimvo/plugin-sdk";
import type { FrameMode } from "./protocol.ts";
import { usePluginRuntime } from "./PluginsProvider.tsx";

interface Props {
  pluginId: string;
  mode: Exclude<FrameMode, "background">;
  /** The view id, viewer id, code block language, component type, base view type or widget id. */
  target: string;
  /** What the contribution draws; a new value redraws the same frame without reloading it. */
  context?: Record<string, unknown>;
  /** The frame grows with its content (code blocks, widgets) instead of filling its parent. */
  autoHeight?: boolean;
  /** Code blocks: replaces the block's source in the note. */
  updateSource?: (source: string) => Promise<void>;
  className?: string;
}

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; detail: string }
  | { kind: "stopped"; reason: "navigated" | "revoked" };

/** Draws one contribution of a running plugin in its sandboxed frame. */
export function PluginFrame({
  pluginId,
  mode,
  target,
  context,
  autoHeight = false,
  updateSource,
  className,
}: Props) {
  const { t, i18n } = useTranslation();
  const runtime = usePluginRuntime();
  const hosted = runtime?.host.get(pluginId);
  const session = hosted?.session;
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<ReturnType<NonNullable<typeof runtime>["host"]["mount"]> | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [height, setHeight] = useState(0);
  const contextKey = JSON.stringify(context ?? {});
  const latestContext = useRef(context);
  latestContext.current = context;
  const latestUpdate = useRef(updateSource);
  latestUpdate.current = updateSource;

  // A new session (the plugin changed or the person's rights did) starts a new frame.
  useEffect(() => {
    const host = runtime?.host;
    const holder = container.current;
    if (!host || !holder || !session?.active) return;
    setStatus({ kind: "loading" });
    let mounted: ReturnType<typeof host.mount>;
    try {
      mounted = host.mount(holder, {
        pluginId,
        mode,
        target,
        context: latestContext.current,
        ...(latestUpdate.current
          ? {
              updateSource: (source: string) => latestUpdate.current?.(source) ?? Promise.resolve(),
            }
          : {}),
        onReady: () => setStatus((s) => (s.kind === "error" ? s : { kind: "ready" })),
        onResize: autoHeight ? setHeight : undefined,
        onError: (detail) => setStatus({ kind: "error", detail }),
        onStopped: (reason) => setStatus({ kind: "stopped", reason: reason }),
      });
    } catch {
      setStatus({ kind: "stopped", reason: "revoked" });
      return;
    }
    frame.current = mounted;
    return () => {
      mounted.cleanup();
      frame.current = null;
    };
    // `context` changes go through `update` below; everything else starts over.
  }, [runtime?.host, session, pluginId, mode, target, autoHeight]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    frame.current?.update(latestContext.current ?? {});
  }, [contextKey]);

  if (!hosted) {
    return (
      <p className="muted plugin-note" role="status">
        {t("plugins.unavailable", { plugin: pluginId })}
      </p>
    );
  }
  const name = resolveLocalized(hosted.plugin.manifest.name, i18n.language);
  return (
    <div
      className={["plugin-host", autoHeight ? "plugin-host-auto" : "", className ?? ""]
        .join(" ")
        .trim()}
      data-plugin={pluginId}
      data-status={status.kind}
      style={autoHeight ? { height: Math.max(height, 24) } : undefined}
    >
      <div ref={container} className="plugin-slot" />
      {status.kind === "loading" && (
        <p className="muted plugin-note plugin-overlay" role="status">
          {t("plugins.loading")}
        </p>
      )}
      {status.kind === "stopped" && (
        <p className="plugin-note plugin-stopped" role="alert">
          {t(`plugins.stopped.${status.reason}`, { name })}
        </p>
      )}
      {status.kind === "error" && (
        <p className="plugin-note plugin-failed" role="alert">
          {t("plugins.error", { name, detail: status.detail })}
        </p>
      )}
    </div>
  );
}
