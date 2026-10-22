import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/errors.ts";
import { readFile, writeFile } from "../api/files.ts";
import type { SurfaceSource } from "./MarkdownSurface.tsx";

/**
 * - loading: the note has not arrived yet
 * - saved: the server has the text on screen
 * - saving: a save is on its way
 * - unsaved: typed, waiting for the short pause before saving
 * - offline: the server could not be reached; the text is kept here and sent when it returns
 * - conflict: someone else saved the note first (see `resolve`)
 * - error: the note could not be read
 */
export type SaveStatus =
  "loading" | "saved" | "saving" | "unsaved" | "offline" | "conflict" | "error";

/**
 * What the editor needs from whatever keeps a note in sync. Live editing (Yjs, T16) provides the
 * same shape with a `collab` source and real `peers`; until then this REST session stands in.
 */
export interface NoteSession {
  source: SurfaceSource | null;
  status: SaveStatus;
  /** People and AIs with the note open, including this tab. */
  peers: number;
  /** A message about something that happened on its own, e.g. unsent text that was recovered. */
  notice: "recovered" | "reloaded" | null;
  error: unknown;
  /** Text typed here that the server does not have yet. */
  unsent: boolean;
  /** Settles a conflict: take the other version, or save this text over it. */
  resolve(choice: "theirs" | "mine"): void;
  /** Tries the read or the save again. */
  retry(): void;
}

export const SAVE_DELAY_MS = 800;
const RETRY_MS = 4000;
const backupKey = (vault: string, path: string) => `palimvo.unsent:${vault}:${path}`;

function readBackup(vault: string, path: string): string | null {
  try {
    return localStorage.getItem(backupKey(vault, path));
  } catch {
    return null;
  }
}
function writeBackup(vault: string, path: string, text: string | null): void {
  try {
    if (text === null) localStorage.removeItem(backupKey(vault, path));
    else localStorage.setItem(backupKey(vault, path), text);
  } catch {
    /* storage full or blocked: the text is still in memory */
  }
}

/** Reads a note and saves what is typed after a short pause, never overwriting a newer version. */
export function useNoteSession(vault: string, path: string): NoteSession {
  const [text, setText] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [notice, setNotice] = useState<NoteSession["notice"]>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  /** The newest text typed (what a save sends) and the version of the server copy it builds on. */
  const draft = useRef<string>("");
  const version = useRef<string | null>(null);
  const sent = useRef<string | null>(null);
  const dirty = useRef(false);
  const saving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const conflicted = useRef(false);

  const save = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current);
    if (saving.current || conflicted.current || !dirty.current || version.current === null) return;
    saving.current = true;
    const body = draft.current;
    setStatus("saving");
    try {
      const result = await writeFile(vault, path, body, version.current);
      version.current = result.version;
      sent.current = body;
      if (draft.current === body) {
        dirty.current = false;
        writeBackup(vault, path, null);
      }
      if (alive.current) setStatus(dirty.current ? "unsaved" : "saved");
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof ApiError && cause.code === "version_conflict") {
        conflicted.current = true;
        setStatus("conflict");
      } else {
        setStatus("offline");
        timer.current = setTimeout(() => void save(), RETRY_MS);
      }
    } finally {
      saving.current = false;
    }
    // Typing went on during the request.
    if (alive.current && dirty.current && !conflicted.current) schedule();
  }, [vault, path]);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DELAY_MS);
  }, [save]);

  const onChange = useCallback(
    (value: string) => {
      draft.current = value;
      dirty.current = value !== sent.current;
      if (!dirty.current) return;
      writeBackup(vault, path, value);
      setText(value);
      setStatus((s) => (s === "conflict" || s === "offline" ? s : "unsaved"));
      if (!saving.current) schedule();
    },
    [vault, path, schedule],
  );

  // Load the note; text kept from a closed tab or a lost connection is offered back first.
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    setStatus("loading");
    setText(null);
    setNotice(null);
    setError(null);
    dirty.current = false;
    conflicted.current = false;
    readFile(vault, path, { signal: controller.signal }).then(
      (file) => {
        if (controller.signal.aborted) return;
        version.current = file.version;
        sent.current = file.content;
        const backup = readBackup(vault, path);
        if (backup !== null && backup !== file.content) {
          draft.current = backup;
          dirty.current = true;
          setText(backup);
          setNotice("recovered");
          setStatus("unsaved");
          schedule();
        } else {
          writeBackup(vault, path, null);
          draft.current = file.content;
          setText(file.content);
          setStatus("saved");
        }
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause);
        setStatus("error");
      },
    );
    return () => {
      alive.current = false;
      controller.abort();
      clearTimeout(timer.current);
      // Leaving the note: send what is still waiting (the backup covers a failure).
      if (dirty.current && version.current !== null && !saving.current) {
        void writeFile(vault, path, draft.current, version.current)
          .then(() => writeBackup(vault, path, null))
          .catch(() => undefined);
      }
    };
  }, [vault, path, attempt]);

  // Coming back to a tab: pick up what changed elsewhere, unless there is unsent text.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || dirty.current || saving.current) return;
      if (version.current === null) return;
      readFile(vault, path).then(
        (file) => {
          if (!alive.current || dirty.current || file.version === version.current) return;
          version.current = file.version;
          sent.current = file.content;
          draft.current = file.content;
          setText(file.content);
          setNotice("reloaded");
        },
        () => undefined,
      );
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [vault, path]);

  // Closing the page with text the server does not have asks first.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const resolve = useCallback(
    (choice: "theirs" | "mine") => {
      void readFile(vault, path).then(
        (file) => {
          version.current = file.version;
          sent.current = file.content;
          conflicted.current = false;
          if (choice === "theirs") {
            dirty.current = false;
            draft.current = file.content;
            writeBackup(vault, path, null);
            setText(file.content);
            setStatus("saved");
          } else {
            setStatus("unsaved");
            void save();
          }
        },
        () => setStatus("offline"),
      );
    },
    [vault, path, save],
  );

  const retry = useCallback(() => {
    if (status === "error") setAttempt((n) => n + 1);
    else void save();
  }, [status, save]);

  const source: SurfaceSource | null =
    text === null ? null : { kind: "text", value: text, onChange };
  return { source, status, peers: 1, notice, error, unsent: dirty.current, resolve, retry };
}
