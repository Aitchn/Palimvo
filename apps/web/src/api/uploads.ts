import { DEFAULT_MAX_FILE_BYTES, MAX_CHUNKED_FILE_BYTES } from "@palimvo/core";
import { ApiError } from "./errors.ts";
import { encodePath, request } from "./client.ts";
import { putBytes } from "./putBytes.ts";

const base = (vault: string) => `/api/vaults/${encodeURIComponent(vault)}`;

export interface UploadedFile {
  path: string;
  size: number;
  version: string;
}

interface UploadStatus {
  id: string;
  path: string;
  size: number;
  received: number;
  partBytes: number;
}

export interface UploadOptions {
  /** Fail with `already_exists` instead of replacing a file with that name. */
  create?: boolean;
  signal?: AbortSignal | undefined;
  /** Bytes of the whole file that have left the browser. */
  onProgress?: ((sent: number, total: number) => void) | undefined;
  /** Pause before trying a failed part again, in milliseconds (tests set 0). */
  retryDelay?: (attempt: number) => number;
}

/** What a vault accepts as uploads: limits, and the file types plugins add. */
export interface VaultFileTypes {
  maxBytes: number;
  maxBytesChunked: number;
  partBytes: number;
  plugins: { extension: string; mime: string; maxBytes: number; description: string | null }[];
}

export function vaultFileTypes(vault: string, signal?: AbortSignal): Promise<VaultFileTypes> {
  return request<VaultFileTypes>(`${base(vault)}/file-types`, signal ? { signal } : {});
}

const MAX_PART_TRIES = 6;
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

/** A failure worth trying the same part again for: the connection broke or the server hiccuped. */
function transient(error: unknown): boolean {
  if (error instanceof DOMException) return false;
  if (!(error instanceof ApiError)) return false;
  // A proxy in front of the server answers 502-504 while it restarts; a full disk (507) will not fix itself.
  return (
    ["network", "internal", "unavailable"].includes(error.code) ||
    (error.code === "unknown" && [502, 503, 504].includes(error.status))
  );
}

/**
 * Uploads one file. A file that fits in a request goes in one go; bigger ones are sent in parts
 * that the server assembles, and a part that fails is sent again from the byte the server says it
 * has. The new file is credited to the signed-in person.
 */
export async function uploadFile(
  vault: string,
  path: string,
  file: Blob,
  options: UploadOptions = {},
): Promise<UploadedFile> {
  const { signal, onProgress } = options;
  const create = options.create ?? true;
  if (file.size > MAX_CHUNKED_FILE_BYTES)
    throw new ApiError("payload_too_large", 413, "The file is too large.", {
      limit: MAX_CHUNKED_FILE_BYTES,
    });
  const report = (sent: number) => onProgress?.(sent, file.size);

  if (file.size <= DEFAULT_MAX_FILE_BYTES) {
    report(0);
    return putBytes<UploadedFile>(
      `${base(vault)}/raw/${encodePath(path)}${create ? "?create=1" : ""}`,
      file,
      { signal, onProgress: report },
    );
  }

  const started = await request<UploadStatus>(`${base(vault)}/uploads`, {
    method: "POST",
    body: { path, size: file.size, create },
    ...(signal ? { signal } : {}),
  });
  const url = `${base(vault)}/uploads/${started.id}`;
  try {
    let received = started.received;
    let tries = 0;
    while (received < file.size) {
      report(received);
      const end = Math.min(file.size, received + started.partBytes);
      try {
        const status = await putBytes<UploadStatus>(
          `${url}?offset=${received}`,
          file.slice(received, end),
          { signal, onProgress: (sent) => report(received + sent) },
        );
        received = status.received;
        tries = 0;
      } catch (error) {
        if (!transient(error) || ++tries > MAX_PART_TRIES) throw error;
        await wait(options.retryDelay?.(tries) ?? tries * 3000, signal);
        // The part may have arrived even though the answer did not; ask where the server is.
        received = (await request<UploadStatus>(url, signal ? { signal } : {})).received;
      }
    }
    report(file.size);
    return await request<UploadedFile>(`${url}/finish`, {
      method: "POST",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // Do not leave gigabytes staged on the server for a file nobody is sending any more.
    void request(url, { method: "DELETE" }).catch(() => undefined);
    throw error;
  }
}
