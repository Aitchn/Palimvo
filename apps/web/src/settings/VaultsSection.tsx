import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { isValidVaultId } from "@palimvo/core";
import { describeError } from "../api/errors.ts";
import {
  createVault,
  listRemovedVaults,
  listVaults,
  removeVault,
  restoreVault,
} from "../api/vaults.ts";
import { useAsync } from "../app/useAsync.ts";
import { FormError, TextField } from "../auth/forms.tsx";
import { useServerCan } from "../auth/session.tsx";
import { Button, Icon, Skeleton, useToast } from "../ui/index.ts";
import { Confirm } from "./Confirm.tsx";
import { formatTime } from "./format.ts";

function NewVault({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = id.trim();
    if (!isValidVaultId(trimmed)) {
      setProblem(t("setup.vaultInvalid"));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await createVault(trimmed);
      setId("");
      onDone();
    } catch (error) {
      setProblem(describeError(t, error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={submit} noValidate>
      <TextField
        label={t("vaults.newVault")}
        hint={t("setup.vaultHint")}
        error={problem}
        value={id}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setId(event.target.value);
          setProblem(null);
        }}
      />
      <Button variant="primary" type="submit" loading={busy}>
        {t("vaults.create")}
      </Button>
    </form>
  );
}

export function VaultsSection() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const canCreate = useServerCan("vaults.create");
  const canManage = useServerCan("server.manage");
  const vaults = useAsync((signal) => listVaults({ signal }), "settings-vaults");
  const removed = useAsync(
    (signal) => (canManage ? listRemovedVaults({ signal }) : Promise.resolve([])),
    `removed:${canManage}`,
  );
  const [doomed, setDoomed] = useState<string | null>(null);

  const refresh = () => {
    vaults.reload();
    removed.reload();
  };

  return (
    <div className="settings-stack">
      <section aria-labelledby="vaults-title">
        <h2 id="vaults-title">{t("vaults.title")}</h2>
        {vaults.status === "loading" && <Skeleton lines={3} />}
        {vaults.status === "error" && <FormError message={describeError(t, vaults.error)} />}
        {vaults.status === "ready" &&
          (vaults.data.length === 0 ? (
            <p className="muted">{t("shell.vaultsEmpty")}</p>
          ) : (
            <ul className="rows">
              {vaults.data.map((vault) => (
                <li key={vault.id} className="row">
                  <div className="row-main">
                    <Link to={`/v/${encodeURIComponent(vault.id)}`}>
                      <Icon name="files" /> {vault.name}
                    </Link>
                  </div>
                  <Link
                    className="btn btn-secondary"
                    to={`/settings/vaults/${encodeURIComponent(vault.id)}`}
                    aria-label={t("vaults.settingsFor", { name: vault.name })}
                  >
                    {t("nav.settings")}
                  </Link>
                  {canManage && (
                    <Button
                      variant="ghost"
                      icon="trash"
                      aria-label={t("vaults.removeNamed", { name: vault.name })}
                      onClick={() => setDoomed(vault.id)}
                    />
                  )}
                </li>
              ))}
            </ul>
          ))}
        {canCreate && <NewVault onDone={refresh} />}
      </section>

      {canManage && removed.status === "ready" && removed.data.length > 0 && (
        <section aria-labelledby="removed-title">
          <h2 id="removed-title">{t("vaults.removedTitle")}</h2>
          <p className="muted">{t("vaults.removedNote")}</p>
          <ul className="rows">
            {removed.data.map((item) => (
              <li key={item.name} className="row">
                <div className="row-main">
                  <strong>{item.id}</strong>
                  <span className="muted">
                    {t("vaults.removedAt", {
                      time: formatTime(Date.parse(item.removedAt), i18n.language),
                    })}
                  </span>
                </div>
                <Button
                  onClick={() => {
                    restoreVault(item.name).then(refresh, (error: unknown) =>
                      toast.push({ message: describeError(t, error), kind: "error" }),
                    );
                  }}
                >
                  {t("vaults.restore")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Confirm
        open={doomed !== null}
        danger
        title={t("vaults.removeTitle", { name: doomed ?? "" })}
        body={t("vaults.removeBody")}
        confirmLabel={t("vaults.remove")}
        onClose={() => setDoomed(null)}
        onConfirm={async () => {
          if (doomed === null) return;
          await removeVault(doomed);
          refresh();
        }}
      />
    </div>
  );
}
