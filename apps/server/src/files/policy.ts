import { stat } from "node:fs/promises";
import {
  AppError,
  DEFAULT_MAX_FILE_BYTES,
  MAX_CHUNKED_FILE_BYTES,
  declaredFileType,
  fileKind,
  supportedFileType,
  type VaultFileType,
} from "@palimvo/core";
import type { VaultService } from "../vault/service.ts";

/** The file types that enabled plugins add to a vault's built-in list. */
export interface FileTypeSource {
  forVault(vaultId: string): readonly VaultFileType[];
}

export const NO_PLUGIN_FILE_TYPES: FileTypeSource = { forVault: () => [] };

export interface UploadLimits {
  /** Largest file one request may carry. */
  single: number;
  /** Largest file a resumable upload may build. */
  chunked: number;
}

/**
 * Which files a vault accepts as uploads and how big they may be: built-in media and documents,
 * plus the types enabled plugins declare (each with its own size limit). Notes, canvases and
 * databases are text and go through the note routes.
 */
export class UploadPolicy {
  constructor(
    private readonly vaults: VaultService,
    private readonly types: FileTypeSource = NO_PLUGIN_FILE_TYPES,
  ) {}

  pluginTypes(vaultId: string): readonly VaultFileType[] {
    return this.types.forVault(vaultId);
  }

  /** The size limits for a path; a plugin type's own limit applies when it is lower. */
  limitsFor(vaultId: string, path: string): UploadLimits {
    const declared = declaredFileType(path, this.pluginTypes(vaultId));
    const builtIn = supportedFileType(path)?.source !== undefined;
    const cap = declared && !builtIn ? declared.maxBytes : Infinity;
    return {
      single: Math.min(DEFAULT_MAX_FILE_BYTES, cap),
      chunked: Math.min(MAX_CHUNKED_FILE_BYTES, cap),
    };
  }

  /**
   * Checks that `path` may receive a file of `size` bytes and returns the normalized path.
   * With `create` the file must not exist yet.
   */
  async check(
    vaultId: string,
    path: string,
    size: number,
    options: { create: boolean; chunked: boolean },
  ): Promise<string> {
    const { abs, rel } = await this.vaults.locateFile(vaultId, path);
    if (fileKind(rel) !== "other") {
      throw new AppError(
        "invalid_request",
        undefined,
        { path: rel },
        { message: `${rel} is a note, canvas or database: write it as text.` },
      );
    }
    if (!supportedFileType(rel, this.pluginTypes(vaultId))) {
      throw new AppError(
        "unsupported_type",
        undefined,
        { path: rel },
        { message: `This vault does not accept files like ${rel}. Plugins can add file types.` },
      );
    }
    const limits = this.limitsFor(vaultId, rel);
    const limit = options.chunked ? limits.chunked : limits.single;
    if (size > limit) throw new AppError("payload_too_large", undefined, { path: rel, limit });
    const info = await stat(abs).catch(() => null);
    if (info?.isDirectory() || (options.create && info))
      throw new AppError("already_exists", undefined, { path: rel });
    return rel;
  }
}
