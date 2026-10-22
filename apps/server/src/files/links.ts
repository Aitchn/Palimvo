import { createHash, randomBytes } from "node:crypto";
import { AppError, type Author } from "@palimvo/core";
import { KeyedMutex } from "../vault/mutex.ts";
import type { Store } from "../store/index.ts";
import type { FileTransfers } from "./transfers.ts";
import { UPLOAD_PART_BYTES, type UploadStatus } from "./sessions.ts";

/** How long an upload link works. */
export const UPLOAD_LINK_TTL_MS = 24 * 60 * 60 * 1000;
/** Unused links one vault may have at once. */
export const MAX_LINKS_PER_VAULT = 50;
const TOKEN = /^[a-f0-9]{64}$/;

export interface UploadLinkInfo {
  path: string;
  expiresAt: string;
  partBytes: number;
  /** Set once the upload has begun: how big the file is and how much has arrived. */
  size?: number;
  received?: number;
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const gone = () =>
  new AppError(
    "not_found",
    undefined,
    {},
    { message: "This upload link does not exist, was already used or has expired." },
  );

/**
 * Links that let a program or a browser upload one file without signing in, so an AI can hand the
 * transfer to a command it runs (or to a person) instead of writing the bytes into a tool call.
 * A link is made by someone who may upload there, names one path, works for a day and is used up
 * once the file is saved. Only a hash of the token is stored.
 */
export class UploadLinks {
  /** Serializes requests on one link, so two `begin` calls cannot start two uploads. */
  private readonly lock = new KeyedMutex();

  constructor(
    private readonly store: Store,
    private readonly transfers: FileTransfers,
    private readonly now: () => number = Date.now,
  ) {}

  /** Makes a link for `path` after checking that a file of that type may go there. Returns the secret token. */
  async create(
    vault: string,
    path: string,
    options: { create: boolean; author: Author; reason?: string },
  ): Promise<{ token: string; path: string; expiresAt: string }> {
    const rel = await this.transfers.policy.check(vault, path, 0, {
      create: options.create,
      chunked: true,
    });
    const live = this.store.uploadLinks.countForVault(vault);
    if (live >= MAX_LINKS_PER_VAULT) throw new AppError("upload_limit", undefined, { open: live });
    const token = randomBytes(32).toString("hex");
    const expiresAt = this.now() + UPLOAD_LINK_TTL_MS;
    this.store.uploadLinks.create({
      tokenHash: hashOf(token),
      vaultId: vault,
      path: rel,
      createOnly: options.create,
      author: options.author,
      ...(options.reason ? { reason: options.reason } : {}),
      expiresAt,
    });
    return { token, path: rel, expiresAt: new Date(expiresAt).toISOString() };
  }

  async info(token: string): Promise<UploadLinkInfo> {
    const link = this.load(token);
    const upload = link.uploadId
      ? await this.transfers.sessions.status(link.vaultId, link.uploadId).catch(() => null)
      : null;
    return {
      path: link.path,
      expiresAt: new Date(link.expiresAt).toISOString(),
      partBytes: UPLOAD_PART_BYTES,
      ...(upload ? { size: upload.size, received: upload.received } : {}),
    };
  }

  /** Starts the upload with the file's real size, or picks up the one already started at that size. */
  begin(token: string, size: number): Promise<UploadStatus> {
    return this.lock.run(token, async () => {
      const link = this.load(token);
      if (link.uploadId) {
        const current = await this.transfers.sessions
          .status(link.vaultId, link.uploadId)
          .catch(() => null);
        if (current && current.size === size) return current;
        if (current)
          await this.transfers.sessions.cancel(link.vaultId, link.uploadId).catch(() => undefined);
      }
      const started = await this.transfers.begin(link.vaultId, link.path, size, {
        create: link.createOnly,
      });
      this.store.uploadLinks.setUpload(hashOf(token), started.id);
      return started;
    });
  }

  part(
    token: string,
    offset: number,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<UploadStatus> {
    const link = this.load(token);
    if (!link.uploadId)
      throw new AppError(
        "invalid_request",
        undefined,
        {},
        { message: "Start the upload first (POST …/begin with the file's size)." },
      );
    return this.transfers.sessions.part(link.vaultId, link.uploadId, offset, body);
  }

  /** Saves the file in the name of whoever made the link, then retires the link. */
  finish(token: string): Promise<{ path: string; size: number }> {
    return this.lock.run(token, async () => {
      const link = this.load(token);
      if (!link.uploadId)
        throw new AppError(
          "invalid_request",
          undefined,
          {},
          { message: "Nothing has been uploaded with this link yet." },
        );
      const saved = await this.transfers.finish(link.vaultId, link.uploadId, {
        author: link.author,
        note: { reason: link.reason },
      });
      this.store.uploadLinks.delete(hashOf(token));
      return { path: saved.path, size: saved.size };
    });
  }

  private load(token: string) {
    if (!TOKEN.test(token)) throw gone();
    const link = this.store.uploadLinks.get(hashOf(token));
    if (!link) throw gone();
    return link;
  }
}
