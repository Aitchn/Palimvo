import { useEffect, useState } from "react";
import { getMyPermissions } from "../api/auth.ts";
import { useSession } from "../auth/session.tsx";

export interface VaultCan {
  /** Create, edit, rename and move notes and folders. */
  write: boolean;
  delete: boolean;
  upload: boolean;
  /** Open the permissions of a folder. */
  managePermissions: boolean;
  /** Browse earlier versions and see who made them. */
  viewHistory: boolean;
  /** Put an earlier version of a file back. */
  restore: boolean;
  /** Save a checkpoint of the whole vault. */
  checkpoint: boolean;
  /** See the vault's edit proposals and make new ones. */
  propose: boolean;
  /** Accept or reject proposed changes (each folder may still say no). */
  review: boolean;
  /** Change the vault's settings, including its home page. */
  settings: boolean;
}

const NOTHING: VaultCan = {
  write: false,
  delete: false,
  upload: false,
  managePermissions: false,
  viewHistory: false,
  restore: false,
  checkpoint: false,
  propose: false,
  review: false,
  settings: false,
};
const EVERYTHING: VaultCan = {
  write: true,
  delete: true,
  upload: true,
  managePermissions: true,
  viewHistory: true,
  restore: true,
  checkpoint: true,
  propose: true,
  review: true,
  settings: true,
};

/**
 * What the signed-in person may do in a vault, for deciding which buttons to show. The server
 * checks every request again; this only keeps the screen from offering what would be refused.
 * Until the answer arrives nothing is offered.
 */
export function useVaultPermissions(vault: string, folder = ""): VaultCan {
  const { session } = useSession();
  const [names, setNames] = useState<ReadonlySet<string> | null>(null);
  const isAccount = session.status === "account";

  useEffect(() => {
    if (!isAccount) return;
    const controller = new AbortController();
    setNames(null);
    getMyPermissions(vault, { signal: controller.signal, folder }).then(
      (result) => {
        if (!controller.signal.aborted) setNames(new Set(result.vault ?? []));
      },
      () => {
        if (!controller.signal.aborted) setNames(new Set());
      },
    );
    return () => controller.abort();
  }, [vault, folder, isAccount]);

  if (session.status === "open") return EVERYTHING;
  if (!isAccount || names === null) return NOTHING;
  return {
    write: names.has("note.write"),
    delete: names.has("note.delete"),
    // Importing writes the files one by one, so it needs both permissions.
    upload: names.has("file.upload") && names.has("note.write"),
    managePermissions: names.has("permissions.manage"),
    viewHistory: names.has("history.view"),
    // Restoring rewrites the file, so it needs the right to write as well.
    restore: names.has("history.restore") && names.has("note.write"),
    checkpoint: names.has("history.view") && names.has("note.write"),
    propose: names.has("proposal.create") || names.has("proposal.review"),
    review: names.has("proposal.review"),
    settings: names.has("vault.settings"),
  };
}
