import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeVaultPath } from "@palimvo/core";
import { getVaultPermissions, type VaultPermissions as Data } from "../api/admin.ts";
import { describeError } from "../api/errors.ts";
import { FormError, TextField } from "../auth/forms.tsx";
import { FolderPermissionsDialog } from "../roles/FolderPermissionsDialog.tsx";
import { PermissionEditor } from "../roles/PermissionEditor.tsx";
import { Button, Skeleton } from "../ui/index.ts";

/** A vault's "Permissions" page: what its roles and people may do, vault-wide and per folder. */
export function VaultPermissions({ vault }: { vault: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<Data | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [typedProblem, setTypedProblem] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    getVaultPermissions(vault, { signal: controller.signal }).then(
      (loaded) => {
        if (!controller.signal.aborted) setData(loaded);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setProblem(describeError(t, error));
      },
    );
    return () => controller.abort();
  }, [vault]);

  const folders = data
    ? [...new Set(data.overrides.flatMap((o) => (o.folder === undefined ? [] : [o.folder])))].sort()
    : [];

  const openTyped = () => {
    try {
      const path = normalizeVaultPath(typed.trim().replace(/^\/+|\/+$/g, ""));
      setTypedProblem(null);
      setFolder(path);
      setTyped("");
    } catch {
      setTypedProblem(t("permissions.folderInvalid"));
    }
  };

  return (
    <section aria-labelledby="permissions-title" className="settings-stack">
      <div>
        <h2 id="permissions-title">{t("permissions.title")}</h2>
        <p className="muted">{t("permissions.intro")}</p>
      </div>
      {problem && <FormError message={problem} />}
      {!data && !problem && <Skeleton lines={4} />}
      {data && <PermissionEditor vault={vault} data={data} onData={setData} />}
      {data && (
        <section aria-labelledby="folder-overrides-title">
          <h3 id="folder-overrides-title">{t("permissions.foldersTitle")}</h3>
          <p className="muted">{t("permissions.foldersNote")}</p>
          {folders.length === 0 && <p className="muted">{t("permissions.noFolders")}</p>}
          <ul className="rows">
            {folders.map((f) => (
              <li key={f} className="row">
                <div className="row-main">
                  <strong>{f}</strong>
                  <span className="muted">
                    {t("permissions.folderRules", {
                      count: data.overrides.filter((o) => o.folder === f).length,
                    })}
                  </span>
                </div>
                <Button onClick={() => setFolder(f)}>
                  {t("permissions.editFolder", { folder: f })}
                </Button>
              </li>
            ))}
          </ul>
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              openTyped();
            }}
          >
            <TextField
              label={t("permissions.folderPath")}
              hint={t("permissions.folderPathHint")}
              error={typedProblem}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
            <Button type="submit" disabled={typed.trim() === ""}>
              {t("permissions.addFolder")}
            </Button>
          </form>
        </section>
      )}
      <FolderPermissionsDialog
        vault={vault}
        folder={folder}
        onClose={() => {
          setFolder(null);
          // The folder list may have changed.
          void getVaultPermissions(vault).then(setData, () => {});
        }}
      />
    </section>
  );
}
