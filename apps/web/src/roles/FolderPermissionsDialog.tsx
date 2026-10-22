import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVaultPermissions, type VaultPermissions } from "../api/admin.ts";
import { describeError } from "../api/errors.ts";
import { FormError } from "../auth/forms.tsx";
import { Button, Dialog, Skeleton } from "../ui/index.ts";
import { PermissionEditor } from "./PermissionEditor.tsx";

/** The folder's right-click "Permissions…": write-type overrides for roles and people. */
export function FolderPermissionsDialog({
  vault,
  folder,
  onClose,
}: {
  vault: string;
  /** The folder to edit; the dialog is closed while this is `null`. */
  folder: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<VaultPermissions | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (folder === null) return;
    const controller = new AbortController();
    setData(null);
    setProblem(null);
    getVaultPermissions(vault, { signal: controller.signal }).then(
      (loaded) => {
        if (!controller.signal.aborted) setData(loaded);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setProblem(describeError(t, error));
      },
    );
    return () => controller.abort();
  }, [vault, folder]);

  return (
    <Dialog
      open={folder !== null}
      onClose={onClose}
      title={t("permissions.folderTitle", { folder: folder ?? "" })}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("common.close")}
        </Button>
      }
    >
      {problem && <FormError message={problem} />}
      {!data && !problem && <Skeleton lines={4} />}
      {data && folder !== null && (
        <PermissionEditor vault={vault} folder={folder} data={data} onData={setData} />
      )}
    </Dialog>
  );
}
