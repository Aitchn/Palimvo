import { ApiError } from "./errors.ts";
import { csrfHeaders, failure } from "./client.ts";

export interface PutBytesOptions {
  signal?: AbortSignal | undefined;
  /** Bytes of this body that have left the browser. */
  onProgress?: ((sent: number) => void) | undefined;
}

/**
 * Sends `body` with PUT and resolves to the JSON the server answers. `fetch` cannot report how
 * much of a request body has gone out, so this uses XMLHttpRequest, which can.
 */
export function putBytes<T>(url: string, body: Blob, options: PutBytesOptions = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const { signal, onProgress } = options;
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.responseType = "text";
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    for (const [name, value] of Object.entries(csrfHeaders())) xhr.setRequestHeader(name, value);
    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const done = () => signal?.removeEventListener("abort", abort);
    xhr.upload.onprogress = (event) => onProgress?.(event.loaded);
    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(body.size);
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(new ApiError("unknown", xhr.status, "The server sent an unexpected answer."));
        }
        return;
      }
      void failure(
        new Response(xhr.responseText, { status: xhr.status, statusText: xhr.statusText }),
      ).then(reject);
    };
    xhr.onerror = () => {
      done();
      reject(new ApiError("network", 0, "The server could not be reached."));
    };
    xhr.onabort = () => {
      done();
      reject(new DOMException("Aborted", "AbortError"));
    };
    xhr.send(body);
  });
}
