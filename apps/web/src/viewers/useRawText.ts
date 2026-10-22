import { useCallback, useEffect, useState } from "react";
import { errorFromResponse, ApiError } from "../api/errors.ts";
import { rawUrl } from "../api/files.ts";
import { MAX_TEXT_VIEW_BYTES } from "./kinds.ts";

export type RawText =
  | { status: "loading" }
  | { status: "ready"; text: string; bytes: number }
  | { status: "too-big"; bytes: number }
  | { status: "error"; error: unknown };

/** A text file's content, fetched from the raw route; files over the viewing limit are not read. */
export function useRawText(vault: string, path: string): RawText & { reload: () => void } {
  const [state, setState] = useState<RawText>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const abort = new AbortController();
    setState({ status: "loading" });
    (async () => {
      const res = await fetch(rawUrl(vault, path), {
        signal: abort.signal,
        credentials: "same-origin",
      });
      if (!res.ok) throw await errorFromResponse(res);
      const bytes = Number(res.headers.get("content-length") ?? 0);
      if (bytes > MAX_TEXT_VIEW_BYTES) {
        abort.abort();
        setState({ status: "too-big", bytes });
        return;
      }
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > MAX_TEXT_VIEW_BYTES) {
        setState({ status: "too-big", bytes: buffer.byteLength });
        return;
      }
      setState({
        status: "ready",
        text: new TextDecoder("utf-8").decode(buffer),
        bytes: buffer.byteLength,
      });
    })().catch((error: unknown) => {
      if (abort.signal.aborted) return;
      setState({
        status: "error",
        error:
          error instanceof ApiError ? error : new ApiError("network", 0, "Could not be reached."),
      });
    });
    return () => abort.abort();
  }, [vault, path, attempt]);

  return { ...state, reload };
}
