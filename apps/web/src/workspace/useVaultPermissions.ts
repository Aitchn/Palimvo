import { useEffect, useState } from "react";
import { getMyPermissions } from "../api/auth.ts";
import { useSession } from "../auth/session.tsx";

export interface VaultCan {
  /** Create, edit, rename and move notes and folders. */
  write: boolean;
  delete: boolean;
  upload: boolean;
}

const NOTHING: VaultCan = { write: false, delete: false, upload: false };
const EVERYTHING: VaultCan = { write: true, delete: true, upload: true };

/**
 * What the signed-in person may do in a vault, for deciding which buttons to show. The server
 * checks every request again; this only keeps the screen from offering what would be refused.
 * Until the answer arrives nothing is offered.
 */
export function useVaultPermissions(vault: string): VaultCan {
  const { session } = useSession();
  const [names, setNames] = useState<ReadonlySet<string> | null>(null);
  const isAccount = session.status === "account";

  useEffect(() => {
    if (!isAccount) return;
    const controller = new AbortController();
    setNames(null);
    getMyPermissions(vault, { signal: controller.signal }).then(
      (result) => {
        if (!controller.signal.aborted) setNames(new Set(result.vault ?? []));
      },
      () => {
        if (!controller.signal.aborted) setNames(new Set());
      },
    );
    return () => controller.abort();
  }, [vault, isAccount]);

  if (session.status === "open") return EVERYTHING;
  if (!isAccount || names === null) return NOTHING;
  return {
    write: names.has("note.write"),
    delete: names.has("note.delete"),
    upload: names.has("file.upload"),
  };
}
