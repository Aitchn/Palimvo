import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import {
  getPublicPaths,
  listMembers,
  listUsers,
  removeMember,
  setMember,
  setPublicPaths,
  type MemberRow,
} from "../api/admin.ts";
import { getMyPermissions } from "../api/auth.ts";
import { describeError } from "../api/errors.ts";
import { useAsync } from "../app/useAsync.ts";
import { FormError } from "../auth/forms.tsx";
import { useSession } from "../auth/session.tsx";
import { Button, Skeleton, useToast } from "../ui/index.ts";
import { Confirm } from "./Confirm.tsx";

function Members({ vault }: { vault: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { session } = useSession();
  const members = useAsync((signal) => listMembers(vault, { signal }), `members:${vault}`);
  // Only people who may manage users can see who could be added.
  const users = useAsync(
    (signal) => listUsers({ signal }).catch(() => []),
    `member-candidates:${vault}`,
  );
  const [adding, setAdding] = useState("");
  const [removing, setRemoving] = useState<MemberRow | null>(null);
  const me = session.status === "account" ? session.account.id : null;

  const fail = (error: unknown) => toast.push({ message: describeError(t, error), kind: "error" });
  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      members.reload();
    } catch (error) {
      fail(error);
    }
  };

  const candidates =
    members.status === "ready" && users.status === "ready"
      ? users.data.filter((u) => !u.disabled && !members.data.some((m) => m.account.id === u.id))
      : [];

  return (
    <section aria-labelledby="members-title">
      <h2 id="members-title">{t("members.title")}</h2>
      <p className="muted">{t("members.note")}</p>
      {members.status === "loading" && <Skeleton lines={3} />}
      {members.status === "error" && <FormError message={describeError(t, members.error)} />}
      {members.status === "ready" && (
        <ul className="rows">
          {members.data.map((m) => (
            <li key={m.account.id} className="row">
              <div className="row-main">
                <strong>{m.account.displayName}</strong>
                <span className="muted">@{m.account.username}</span>
                <span className="chips">
                  {m.roles.map((r) => (
                    <span key={r.id} className="role-chip">
                      {r.name}
                    </span>
                  ))}
                </span>
              </div>
              <select
                className="select"
                aria-label={t("members.positionOf", { name: m.account.displayName })}
                value={m.position}
                disabled={m.account.id === me}
                onChange={(event) =>
                  void act(() =>
                    setMember(vault, m.account.id, event.target.value as "admin" | "member"),
                  )
                }
              >
                <option value="member">{t("members.member")}</option>
                <option value="admin">{t("members.admin")}</option>
              </select>
              {m.account.id !== me && (
                <Button
                  variant="ghost"
                  icon="trash"
                  aria-label={t("members.removeNamed", { name: m.account.displayName })}
                  onClick={() => setRemoving(m)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {candidates.length > 0 && (
        <div className="inline-form">
          <div className="field">
            <label htmlFor="add-member">{t("members.add")}</label>
            <select
              id="add-member"
              className="select"
              value={adding}
              onChange={(event) => setAdding(event.target.value)}
            >
              <option value="">{t("members.choose")}</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} (@{u.username})
                </option>
              ))}
            </select>
          </div>
          <Button
            variant="primary"
            disabled={!adding}
            onClick={() =>
              void act(async () => {
                await setMember(vault, adding, "member");
                setAdding("");
                users.reload();
              })
            }
          >
            {t("members.addButton")}
          </Button>
        </div>
      )}
      <Confirm
        open={removing !== null}
        danger
        title={t("members.removeTitle")}
        body={t("members.removeBody", { name: removing?.account.displayName ?? "" })}
        confirmLabel={t("members.remove")}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await removeMember(vault, removing.account.id);
          members.reload();
        }}
      />
    </section>
  );
}

function PublicAccess({ vault }: { vault: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const paths = useAsync((signal) => getPublicPaths(vault, { signal }), `public:${vault}`);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (paths.status === "ready") setText(paths.data.map((p) => (p === "" ? "/" : p)).join("\n"));
  }, [paths.status === "ready" ? paths.data : null]);

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const list = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      await setPublicPaths(vault, list);
      toast.push({ message: t("public.saved"), kind: "success" });
      paths.reload();
    } catch (error) {
      setProblem(describeError(t, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="form" aria-labelledby="public-title">
      <h2 id="public-title">{t("public.title")}</h2>
      <p className="muted">{t("public.note")}</p>
      {paths.status === "loading" && <Skeleton lines={2} />}
      {paths.status === "error" && <FormError message={describeError(t, paths.error)} />}
      {paths.status === "ready" && (
        <>
          <label className="field">
            {t("public.paths")}
            <textarea
              className="input textarea"
              rows={4}
              value={text}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <p className="muted">{t("public.hint")}</p>
          <FormError message={problem} />
          <div>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

export function VaultSettings() {
  const { t } = useTranslation();
  const { vault = "" } = useParams();
  const permissions = useAsync((signal) => getMyPermissions(vault, { signal }), `perm:${vault}`);
  const has = (name: string) =>
    permissions.status === "ready" && (permissions.data.vault ?? []).includes(name);

  return (
    <div className="settings-stack">
      <p>
        <Link to="/settings/vaults">{t("vaults.backToList")}</Link>
      </p>
      <h2 className="vault-heading">{vault}</h2>
      {permissions.status === "loading" && <Skeleton lines={3} />}
      {permissions.status === "error" && (
        <FormError message={describeError(t, permissions.error)} />
      )}
      {permissions.status === "ready" && !has("members.manage") && !has("public.manage") && (
        <p className="muted">{t("vaults.nothingToManage")}</p>
      )}
      {has("members.manage") && <Members vault={vault} />}
      {has("public.manage") && <PublicAccess vault={vault} />}
    </div>
  );
}
