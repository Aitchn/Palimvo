import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { markdownText } from "@palimvo/core";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { ApiError } from "../api/errors.ts";
import { writeFile } from "../api/files.ts";
import { guestUser } from "../collab/presence.ts";
import type { NoteSession, SaveStatus } from "./useNoteSession.ts";

/** The server's copy has a different history than ours (ADR 0011); merging would duplicate text. */
export const STALE_LINEAGE = 4409;
/** The note was deleted or moved away, or its vault was removed. */
export const GONE = 4404;

function collabUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/collab`;
}

/** `Plan.md` -> `Plan (offline 2026-10-22 0130).md`: where text that cannot be merged is kept. */
function copyPath(path: string): string {
  const dot = path.lastIndexOf(".");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(/[-:]/g, "");
  const at = dot > path.lastIndexOf("/") ? dot : path.length;
  return `${path.slice(0, at)} (offline ${stamp})${path.slice(at)}`;
}

interface Live {
  doc: Y.Doc;
  provider: WebsocketProvider;
  text: Y.Text;
}

/**
 * Keeps a note in sync through the server's live document (T16): typing from every tab, person
 * and AI merges, and the server writes the file. Gives the editor the same shape as the plain
 * HTTP session, so `NoteEditor` does not care which one it has.
 *
 * Reconnects on its own. Text typed while the connection is down stays in the page and merges on
 * return; if the server's copy has meanwhile started a new history (the file was changed outside
 * the app while nobody had it open), the typed text is saved as a separate note instead.
 */
export function useCollabNote(vault: string, path: string): NoteSession {
  const { t } = useTranslation();
  const [live, setLive] = useState<Live | null>(null);
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [peers, setPeers] = useState(1);
  const [notice, setNotice] = useState<NoteSession["notice"]>(null);
  const [error, setError] = useState<unknown>(null);
  const [unsent, setUnsent] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const guestLabel = useMemo(() => (number: number) => t("editor.guestName", { number }), [t]);

  useEffect(() => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(
      collabUrl(),
      encodeURIComponent(`${vault}/${path}`),
      doc,
      {
        params: { vault, path },
        // The server is the one place documents meet; tabs do not shortcut around it.
        disableBc: true,
      },
    );
    provider.awareness.setLocalStateField("user", guestUser(guestLabel));
    const text = markdownText(doc);
    let stopped = false;
    let everSynced = false;
    // Typed here since the server last confirmed the document.
    let pending = false;
    let restarted = false;

    setLive(null);
    setStatus("loading");
    setPeers(1);
    setError(null);
    setUnsent(false);

    const lineage = () => doc.getMap("collab.meta").get("lineage");
    const markPending = (value: boolean) => {
      pending = value;
      setUnsent(value);
    };

    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      // Our own typing, not the server's updates.
      if (origin === provider || stopped) return;
      if (!(provider.wsconnected && provider.synced)) markPending(true);
    });
    provider.on("sync", (synced: boolean) => {
      if (!synced || stopped) return;
      if (!everSynced) {
        everSynced = true;
        setLive({ doc, provider, text });
      }
      // From now on the server checks that a reconnecting copy belongs to its history.
      const id = lineage();
      if (typeof id === "string") provider.params.lineage = id;
      markPending(false);
      setStatus("saved");
    });
    provider.on("status", ({ status: s }: { status: string }) => {
      if (stopped) return;
      if (s === "connected") return; // "sync" decides when the note is ready
      setStatus(everSynced ? "offline" : "loading");
    });
    provider.on("connection-error", () => {
      if (!stopped && !everSynced) setStatus("offline");
    });
    provider.on("connection-close", (event: CloseEvent | null) => {
      if (stopped || !event) return;
      if (event.code === GONE) {
        provider.disconnect();
        setError(new ApiError("not_found", 404, "Not found", { path }));
        setStatus("error");
        setLive(null);
      } else if (event.code === STALE_LINEAGE && !restarted) {
        restarted = true;
        provider.disconnect();
        // Our copy has an older history than the server's: start over from the server's, and keep
        // what was typed meanwhile as its own note.
        const kept = pending ? text.toString() : null;
        const finish = (copied: boolean) => {
          if (stopped) return;
          setAttempt((n) => n + 1);
          setNotice(copied ? "savedCopy" : "reloaded");
        };
        if (kept === null) finish(false);
        else
          void writeFile(vault, copyPath(path), kept, null).then(
            () => finish(true),
            () => finish(false),
          );
      }
    });
    const onAwareness = () => setPeers(Math.max(1, provider.awareness.getStates().size));
    provider.awareness.on("change", onAwareness);

    // Edits made offline are lost if the page closes before the connection returns.
    const warn = (event: BeforeUnloadEvent) => {
      if (pending) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);

    return () => {
      stopped = true;
      window.removeEventListener("beforeunload", warn);
      provider.awareness.off("change", onAwareness);
      provider.destroy();
      doc.destroy();
    };
  }, [vault, path, attempt, guestLabel]);

  // A message belongs to the note it was raised for; a restart of the same note keeps it.
  useEffect(() => setNotice(null), [vault, path]);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);
  const resolve = useCallback(() => undefined, []); // live editing has nothing to choose between

  const source = useMemo(
    () =>
      live
        ? ({ kind: "collab", text: live.text, awareness: live.provider.awareness } as const)
        : null,
    [live],
  );
  return { source, status, peers, notice, error, unsent, resolve, retry };
}
