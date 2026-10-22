export type FileKind = "markdown" | "canvas" | "base" | "other";

/** A text file as the server read it. `version` identifies the exact bytes; send it back as `baseVersion` to write safely. */
export interface FileContent {
  /** Normalized vault-relative path. */
  path: string;
  content: string;
  /** Modification time in milliseconds. */
  mtime: number;
  version: string;
}

/** An entry of a vault's file tree. Hidden names (starting with a dot) never appear. */
export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  /** Files only. */
  kind?: FileKind;
  /** Folders only. */
  children?: TreeNode[];
}

export interface VaultInfo {
  id: string;
  name: string;
}

/** A vault moved to the trash by an administrator; it can be restored. */
export interface RemovedVault {
  /** The trash folder name, e.g. `notes-20261021T120000Z`. Pass it to restore. */
  name: string;
  /** The vault id it had, and gets back on restore. */
  id: string;
  removedAt: string;
}
