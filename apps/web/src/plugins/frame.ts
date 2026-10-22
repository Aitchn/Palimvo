import type { PluginManifest } from "@palimvo/plugin-sdk";
import { PluginBridge, type HostActions, type VaultBackend } from "./bridge.ts";
import { MAX_FRAME_HEIGHT, PROTOCOL_VERSION, RpcError, type FrameMode } from "./protocol.ts";
import RUNTIME from "./runtime.js?raw";
import type { PluginSession } from "./session.ts";

/** An approved plugin with the files its frame needs, ready to run. */
export interface LoadedPlugin {
  manifest: PluginManifest;
  /** The hash a person approved; the frame is bound to it. */
  hash: string;
  /** The text of `main.js`. */
  code: string;
  /** Plugin-owned strings by locale (`en` is the fallback). */
  locales: Record<string, Record<string, string>>;
  /** The stylesheet of a `contributes.theme`, when there is one. */
  themeCss?: string;
}

export type StopReason = "navigated" | "revoked";

export interface MountOptions {
  plugin: LoadedPlugin;
  session: PluginSession;
  backend: VaultBackend;
  actions: HostActions;
  mode: FrameMode;
  /** The view id, viewer id, code block language, component type, base view type, widget id. */
  target: string;
  /** Code block frames: the note that holds the block. */
  notePath?: string;
  /** What the contribution draws (note path, source, rows, …). Plain JSON. */
  context?: Record<string, unknown>;
  locale: string;
  theme: "light" | "dark";
  /** The frame drew (or, for a background frame, started). */
  onReady?: () => void;
  /** Frames that grow with what they draw. */
  onResize?: (height: number) => void;
  /** The plugin threw while starting or drawing; its frame shows the message. */
  onError?: (detail: string) => void;
  /** The frame is gone: the plugin left its page or its approval was withdrawn. */
  onStopped?: (reason: StopReason, detail?: string) => void;
}

export interface MountedFrame {
  cleanup: () => void;
  /** New data for the contribution drawn (the YAML changed, or the vault did) without reloading. */
  update: (context: Record<string, unknown>) => void;
  /** Delivers an event the plugin subscribed to with `palimvo.events.on`. */
  emit: (name: string, data: unknown) => void;
  /** Background frames: runs this plugin's handler for `plugin/point`. */
  invoke: (plugin: string, point: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
  /** Background frames: runs or tests a registered slot entry. */
  invokeSlot: (
    slot: string,
    id: string,
    op: "run" | "visible",
    context: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

/** Colour and shape tokens of the app that frames receive, so a plugin looks like part of it. */
const TOKEN_NAMES = [
  "--bg",
  "--bg-side",
  "--bg-elev",
  "--bg-elev-2",
  "--bg-input",
  "--bg-hover",
  "--bg-active",
  "--bg-selected",
  "--fg",
  "--fg-strong",
  "--fg-muted",
  "--fg-subtle",
  "--border",
  "--border-strong",
  "--accent",
  "--accent-hover",
  "--accent-fg",
  "--accent-soft",
  "--accent-text",
  "--danger",
  "--danger-soft",
  "--success",
  "--success-soft",
  "--warning",
  "--warning-soft",
  "--info",
  "--code-bg",
  "--font-sans",
  "--font-mono",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
];

export function frameTokens(): string {
  if (typeof getComputedStyle !== "function") return "";
  const style = getComputedStyle(document.documentElement);
  return TOKEN_NAMES.map((name) => [name, style.getPropertyValue(name).trim()] as const)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}:${value.replace(/[<>;{}]/g, "")};`)
    .join("");
}

const HOST_PATTERN = /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;

/**
 * The frame's content-security policy. Without the `network` permission nothing leaves the
 * frame; with it, only the listed hosts (images, media, fonts and requests). Script comes only
 * from the runtime and the plugin's own approved code, never from the network.
 */
export function contentSecurityPolicy(network: false | readonly string[], nonce: string): string {
  let hosts = "";
  let connect = "'none'";
  if (network !== false) {
    if (network.includes("*")) {
      hosts = " https:";
      connect = "https: wss:";
    } else {
      const valid = network.filter((host) => HOST_PATTERN.test(host));
      hosts = valid.map((host) => ` https://${host}`).join("");
      connect =
        valid.length === 0
          ? "'none'"
          : valid.flatMap((h) => [`https://${h}`, `wss://${h}`]).join(" ");
    }
  }
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' blob:`,
    "style-src 'unsafe-inline'",
    `img-src data: blob:${hosts}`,
    `media-src data: blob:${hosts}`,
    `font-src data:${hosts}`,
    `connect-src ${connect}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ].join("; ");
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function baseCss(theme: "light" | "dark", extra: string): string {
  return `:root{${frameTokens()}color-scheme:${theme};font-family:var(--font-sans,system-ui,sans-serif);}
*{box-sizing:border-box;}
body{margin:0;background:transparent;color:var(--fg,inherit);font-size:14px;-webkit-font-smoothing:antialiased;}
button,select,input,textarea{background:var(--bg-elev);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 10px;font:inherit;}
button{cursor:pointer;}
button:hover{border-color:var(--accent);}
.plugin-error{color:var(--danger);white-space:pre-wrap;padding:8px;margin:0;font:inherit;}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important;}}
${extra}`;
}

/** The page that goes into the iframe. The runtime sits in an inline script that only its nonce allows. */
export function frameDocument(
  plugin: LoadedPlugin,
  theme: "light" | "dark",
  nonce = randomNonce(),
): string {
  const csp = contentSecurityPolicy(plugin.manifest.permissions.network, nonce);
  const script = RUNTIME.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${baseCss(theme, "")}</style></head><body><div id="root"></div><script nonce="${nonce}">${script}</script></body></html>`;
}

/** What the frame needs to know about the manifest: the ids it may register, nothing about permissions. */
function declared(manifest: PluginManifest) {
  const c = manifest.contributes;
  return {
    views: c.views.map((v) => v.id),
    codeBlocks: c.codeBlocks.map((b) => b.language),
    components: c.components.map((x) => x.type),
    viewers: c.viewers.map((v) => v.id),
    baseViews: c.baseViews.map((v) => v.type),
    homeWidgets: c.homeWidgets.map((w) => w.id),
    slots: c.slots.map((s) => `${s.slot}/${s.id}`),
    app: c.app !== undefined,
    extensions: c.extensions.map((e) => `${e.plugin}/${e.point}`),
  };
}

function stringsFor(plugin: LoadedPlugin, locale: string) {
  const language = locale.split("-")[0] ?? locale;
  return {
    current: plugin.locales[locale] ?? plugin.locales[language] ?? plugin.locales.en ?? {},
    en: plugin.locales.en ?? {},
  };
}

/** The strings a locale change sends to a running frame. */
export function localeEvent(plugin: LoadedPlugin, locale: string) {
  return { locale, strings: stringsFor(plugin, locale) };
}

type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/**
 * Runs a plugin in an opaque-origin iframe (`sandbox="allow-scripts"` only: no same-origin, no
 * forms, popups or top navigation) and wires it to the app. Cleaning up cancels every call and
 * removes the frame; so does revoking the session.
 */
export function mountPlugin(container: HTMLElement, options: MountOptions): MountedFrame {
  const { plugin, session, mode } = options;
  const { manifest } = plugin;
  session.assert();

  const iframe = document.createElement("iframe");
  iframe.className = "plugin-frame";
  iframe.title = typeof manifest.name === "string" ? manifest.name : manifest.name.en;
  // allow-scripts only: an opaque origin with no access to the app, its storage or cookies.
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.srcdoc = frameDocument(plugin, options.theme);

  const bridge = new PluginBridge(
    session,
    options.backend,
    options.actions,
    undefined,
    options.notePath,
  );
  // Everything after the handshake goes over a private channel handed to the frame once. A page
  // the frame navigates to has no port, and its "hello" is ignored.
  const channel = new MessageChannel();
  const port = channel.port1;
  let introduced = false;
  let cleaned = false;
  let ready = false;
  let failure: string | undefined;
  const post = (message: Record<string, unknown>) => {
    if (!cleaned) port.postMessage({ schemaVersion: PROTOCOL_VERSION, ...message });
  };

  // Calls into the frame wait until the plugin has started; a failed start fails them all.
  const waiting: Array<() => void> = [];
  const replies = new Map<string, Waiter>();
  let nextCall = 1;
  const settle = (error?: string) => {
    if (error) failure ??= error;
    else ready = true;
    for (const run of waiting.splice(0)) run();
    if (error) {
      for (const [id, waiter] of replies) {
        replies.delete(id);
        waiter.reject(new Error(error));
      }
    }
  };
  const callFrame = (
    build: (requestId: string) => Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const start = () => {
        if (cleaned || failure) return reject(new Error(failure ?? "The plugin was stopped"));
        if (signal?.aborted) return reject(new Error("The call was cancelled"));
        const requestId = `h${nextCall++}`;
        replies.set(requestId, { resolve, reject });
        signal?.addEventListener(
          "abort",
          () => {
            if (replies.delete(requestId)) reject(new Error("The call was cancelled"));
          },
          { once: true },
        );
        post(build(requestId));
      };
      if (ready || failure || cleaned) start();
      else waiting.push(start);
    });

  port.onmessage = (event: MessageEvent) => {
    const message = (event.data ?? {}) as Record<string, unknown>;
    if (message.schemaVersion !== PROTOCOL_VERSION) return;
    switch (message.type) {
      case "rpc":
        bridge.request({ ...message, type: "rpc" }).then(
          (result) => post({ type: "rpc-result", requestId: message.requestId, result }),
          (error: unknown) =>
            post({
              type: "rpc-result",
              requestId: message.requestId,
              error: {
                code: error instanceof RpcError ? error.code : "unavailable",
                message: error instanceof Error ? error.message : String(error),
              },
            }),
        );
        break;
      case "cancel":
        if (typeof message.requestId === "string") bridge.cancel(message.requestId);
        break;
      case "resize":
        if (
          typeof message.height === "number" &&
          Number.isFinite(message.height) &&
          message.height >= 0 &&
          message.height <= MAX_FRAME_HEIGHT
        )
          options.onResize?.(message.height);
        break;
      case "ready":
        settle();
        options.onReady?.();
        break;
      case "error":
        if (!ready) settle(`${iframe.title} failed to start`);
        options.onError?.(String(message.message ?? ""));
        break;
      case "invoke-result":
      case "slot-result": {
        const waiter =
          typeof message.requestId === "string" ? replies.get(message.requestId) : undefined;
        if (!waiter) break;
        replies.delete(message.requestId as string);
        if (message.error !== undefined) waiter.reject(new Error(String(message.error)));
        else waiter.resolve(message.result);
        break;
      }
    }
  };

  const onHello = (event: MessageEvent) => {
    if (cleaned || introduced || event.source !== iframe.contentWindow) return;
    if ((event.data as { type?: string } | null)?.type !== "hello") return;
    introduced = true;
    iframe.contentWindow?.postMessage(
      {
        type: "init",
        schemaVersion: PROTOCOL_VERSION,
        code: plugin.code,
        plugin: { id: manifest.id, version: manifest.version },
        mode,
        target: options.target,
        context: options.context ?? {},
        locale: options.locale,
        theme: options.theme,
        strings: stringsFor(plugin, options.locale),
        declared: declared(manifest),
      },
      "*",
      [channel.port2],
    );
  };
  window.addEventListener("message", onHello);

  // CSP cannot stop a page from navigating itself, so a plugin that leaves its sandbox page is
  // stopped at once. A request may already have gone out: approving a plugin means trusting its
  // code with what it may read.
  let loads = 0;
  const onLoad = () => {
    if (++loads === 1) return;
    stop();
    options.onStopped?.("navigated");
  };
  iframe.addEventListener("load", onLoad);

  const stop = () => {
    if (cleaned) return;
    cleaned = true;
    bridge.dispose();
    unlisten();
    window.removeEventListener("message", onHello);
    iframe.removeEventListener("load", onLoad);
    port.close();
    channel.port2.close();
    iframe.remove();
    settle("The plugin was stopped");
  };
  const unlisten = session.onRevoke((reason) => {
    stop();
    options.onStopped?.("revoked", reason);
  });

  container.append(iframe);
  return {
    cleanup: stop,
    update: (context) => post({ type: "update", context }),
    emit: (name, data) => post({ type: "event", name, data }),
    invoke: (plugin, point, input, signal) =>
      callFrame((requestId) => ({ type: "invoke", requestId, plugin, point, input }), signal),
    invokeSlot: (slot, id, op, context, signal) =>
      callFrame((requestId) => ({ type: "slot", requestId, slot, id, op, context }), signal),
  };
}
