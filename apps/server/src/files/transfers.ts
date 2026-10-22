import { type Author } from "@palimvo/core";
import type { ChangeNote, VaultHistory } from "../history/history.ts";
import type { VaultService, WriteResult } from "../vault/service.ts";
import { UploadPolicy } from "./policy.ts";
import { UploadSessions, type UploadStatus } from "./sessions.ts";

/** Who is making a change and why, as the history wants it. */
export interface Actor {
  author: Author;
  note: ChangeNote;
}

/**
 * Putting binary files into a vault: one request for small files, resumable parts for big ones.
 * Both check the policy, write while the vault's queue is held and tell the history who did it.
 */
export class FileTransfers {
  constructor(
    readonly vaults: VaultService,
    readonly history: VaultHistory,
    readonly policy: UploadPolicy,
    readonly sessions: UploadSessions,
  ) {}

  /** Stores a whole file. With `create` the file must not exist yet. */
  async upload(
    vault: string,
    path: string,
    bytes: Uint8Array,
    options: { create: boolean; actor: Actor },
  ): Promise<WriteResult> {
    const rel = await this.policy.check(vault, path, bytes.byteLength, {
      create: options.create,
      chunked: false,
    });
    return this.vaults.writeBytes(vault, rel, bytes, {
      ...(options.create ? { baseVersion: null } : {}),
      onWritten: (w) =>
        this.history.record(vault, [w.path], options.actor.author, options.actor.note),
    });
  }

  /** Starts a resumable upload after checking the type, size and room. */
  async begin(
    vault: string,
    path: string,
    size: number,
    options: { create: boolean },
  ): Promise<UploadStatus> {
    const rel = await this.policy.check(vault, path, size, {
      create: options.create,
      chunked: true,
    });
    return this.sessions.begin(vault, rel, size, options.create);
  }

  /** Moves the finished upload into the vault and records who uploaded it. */
  async finish(vault: string, id: string, actor: Actor): Promise<WriteResult> {
    return this.sessions.finish(vault, id, async (source, meta) => {
      // The vault may have changed since the upload began (a plugin disabled, the name taken).
      await this.policy.check(vault, meta.path, meta.size, {
        create: meta.create,
        chunked: true,
      });
      return this.vaults.placeUpload(vault, meta.path, source, {
        create: meta.create,
        onWritten: (w) => this.history.record(vault, [w.path], actor.author, actor.note),
      });
    });
  }
}
