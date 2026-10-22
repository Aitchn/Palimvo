import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  assignRole,
  createInvite,
  createUser,
  deleteUser,
  listInvites,
  listRoles,
  listUsers,
  resetPassword,
  revokeInvite,
  unassignRole,
  updateUser,
  type RoleRow,
  type UserRow,
} from "../api/admin.ts";
import { describeError } from "../api/errors.ts";
import { listVaults } from "../api/vaults.ts";
import { useAsync } from "../app/useAsync.ts";
import { FormError, TextField } from "../auth/forms.tsx";
import { useServerCan, useSession } from "../auth/session.tsx";
import { Button, Dialog, Icon, Menu, Skeleton, useToast, type MenuItem } from "../ui/index.ts";
import { Confirm } from "./Confirm.tsx";
import { formatTime } from "./format.ts";

const MIN_PASSWORD = 10;

function RoleChip({
  role,
  onRemove,
}: {
  role: { id: string; name: string; color?: string };
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <span
      className="role-chip"
      style={role.color ? ({ "--role": role.color } as never) : undefined}
    >
      {role.name}
      {onRemove && (
        <button
          type="button"
          className="chip-remove"
          aria-label={t("settings.removeRole", { name: role.name })}
          onClick={onRemove}
        >
          <Icon name="close" />
        </button>
      )}
    </span>
  );
}

function NewUserDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await createUser({
        username: username.trim(),
        password,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      setUsername("");
      setDisplayName("");
      setPassword("");
      onDone();
      onClose();
    } catch (error) {
      setProblem(describeError(t, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("users.newUser")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" form="new-user" loading={busy}>
            {t("users.create")}
          </Button>
        </>
      }
    >
      <form id="new-user" className="form" onSubmit={submit}>
        <TextField
          label={t("auth.username")}
          value={username}
          autoComplete="off"
          autoCapitalize="none"
          required
          onChange={(event) => setUsername(event.target.value)}
        />
        <TextField
          label={t("auth.displayName")}
          value={displayName}
          autoComplete="off"
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <TextField
          label={t("users.temporaryPassword")}
          hint={t("setup.passwordHint", { count: MIN_PASSWORD })}
          type="password"
          value={password}
          autoComplete="new-password"
          required
          onChange={(event) => setPassword(event.target.value)}
        />
        <FormError message={problem} />
      </form>
    </Dialog>
  );
}

function InviteDialog({
  open,
  roles,
  onClose,
  onDone,
}: {
  open: boolean;
  roles: RoleRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const vaults = useAsync((signal) => listVaults({ signal }), "invite-vaults");
  const [note, setNote] = useState("");
  const [hours, setHours] = useState(168);
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [vaultIds, setVaultIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const toast = useToast();

  const toggle = (list: string[], set: (next: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const close = () => {
    setLink(null);
    setNote("");
    setRoleIds([]);
    setVaultIds([]);
    setProblem(null);
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const result = await createInvite({
        ...(note.trim() ? { note: note.trim() } : {}),
        expiresInHours: hours,
        ...(roleIds.length ? { roleIds } : {}),
        ...(vaultIds.length
          ? { vaults: vaultIds.map((vaultId) => ({ vaultId, position: "member" as const })) }
          : {}),
      });
      setLink(result.url);
      onDone();
    } catch (error) {
      setProblem(describeError(t, error));
    } finally {
      setBusy(false);
    }
  };

  const assignable = roles.filter((r) => !r.everyone && r.manageable);

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("users.invitePeople")}
      footer={
        link ? (
          <Button variant="primary" onClick={close}>
            {t("common.close")}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" type="submit" form="new-invite" loading={busy}>
              {t("users.createInvite")}
            </Button>
          </>
        )
      }
    >
      {link ? (
        <div className="form">
          <p>{t("users.inviteReady")}</p>
          <input
            className="input"
            readOnly
            value={link}
            aria-label={t("users.inviteLink")}
            onFocus={(e) => e.target.select()}
          />
          <div>
            <Button
              icon="copy"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(link)
                  .then(() => toast.push({ message: t("users.copied"), kind: "success" }));
              }}
            >
              {t("users.copyLink")}
            </Button>
          </div>
          <p className="muted">{t("users.inviteOnce")}</p>
        </div>
      ) : (
        <form id="new-invite" className="form" onSubmit={submit}>
          <TextField
            label={t("users.inviteNote")}
            hint={t("users.inviteNoteHint")}
            value={note}
            maxLength={200}
            onChange={(event) => setNote(event.target.value)}
          />
          <TextField
            label={t("users.expiresIn")}
            type="number"
            min={1}
            max={720}
            value={hours}
            onChange={(event) => setHours(Number(event.target.value) || 1)}
          />
          <fieldset className="choices">
            <legend>{t("users.inviteVaults")}</legend>
            {vaults.status === "ready" && vaults.data.length === 0 && (
              <p className="muted">{t("shell.vaultsEmpty")}</p>
            )}
            {vaults.status === "ready" &&
              vaults.data.map((v) => (
                <label key={v.id} className="check">
                  <input
                    type="checkbox"
                    checked={vaultIds.includes(v.id)}
                    onChange={() => toggle(vaultIds, setVaultIds, v.id)}
                  />
                  {v.name}
                </label>
              ))}
          </fieldset>
          {assignable.length > 0 && (
            <fieldset className="choices">
              <legend>{t("users.inviteRoles")}</legend>
              {assignable.map((r) => (
                <label key={r.id} className="check">
                  <input
                    type="checkbox"
                    checked={roleIds.includes(r.id)}
                    onChange={() => toggle(roleIds, setRoleIds, r.id)}
                  />
                  <RoleChip role={r} />
                </label>
              ))}
            </fieldset>
          )}
          <FormError message={problem} />
        </form>
      )}
    </Dialog>
  );
}

type Pending =
  | { kind: "delete"; user: UserRow }
  | { kind: "reset"; user: UserRow }
  | { kind: "revoke"; id: string };

export function UsersSection() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { session } = useSession();
  const canRoles = useServerCan("roles.manage");
  const users = useAsync((signal) => listUsers({ signal }), "admin-users");
  const roles = useAsync((signal) => listRoles({ signal }), "admin-roles");
  const invites = useAsync((signal) => listInvites({ signal }), "admin-invites");
  const [newUser, setNewUser] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [temp, setTemp] = useState<{ name: string; password: string } | null>(null);
  const me = session.status === "account" ? session.account : null;
  const iAmAdmin = me?.serverAdmin ?? false;

  const fail = (error: unknown) => toast.push({ message: describeError(t, error), kind: "error" });
  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      users.reload();
    } catch (error) {
      fail(error);
    }
  };

  const roleList = roles.status === "ready" ? roles.data : [];
  const itemsFor = (user: UserRow): MenuItem[] => {
    const isMe = user.id === me?.id;
    const locked = user.serverAdmin && !iAmAdmin;
    const items: MenuItem[] = [];
    if (!locked) {
      items.push({
        id: "reset",
        label: t("users.resetPassword"),
        icon: "edit",
        onSelect: () => setPending({ kind: "reset", user }),
      });
      if (!isMe)
        items.push({
          id: "disable",
          label: user.disabled ? t("users.enable") : t("users.disable"),
          icon: "eye",
          onSelect: () => void act(() => updateUser(user.id, { disabled: !user.disabled })),
        });
      if (iAmAdmin && !isMe)
        items.push({
          id: "admin",
          label: user.serverAdmin ? t("users.removeAdmin") : t("users.makeAdmin"),
          icon: "settings",
          onSelect: () => void act(() => updateUser(user.id, { serverAdmin: !user.serverAdmin })),
        });
      if (!isMe)
        items.push({
          id: "delete",
          label: t("common.delete"),
          icon: "trash",
          danger: true,
          onSelect: () => setPending({ kind: "delete", user }),
        });
    }
    return items;
  };

  return (
    <div className="settings-stack">
      <section aria-labelledby="users-title">
        <div className="section-head">
          <h2 id="users-title">{t("users.title")}</h2>
          <div className="section-actions">
            <Button icon="add" onClick={() => setNewUser(true)}>
              {t("users.newUser")}
            </Button>
            <Button variant="primary" icon="user" onClick={() => setInviting(true)}>
              {t("users.invitePeople")}
            </Button>
          </div>
        </div>
        {users.status === "loading" && <Skeleton lines={3} />}
        {users.status === "error" && <FormError message={describeError(t, users.error)} />}
        {users.status === "ready" && (
          <ul className="rows">
            {users.data.map((user) => {
              const addable = roleList.filter(
                (r) => !r.everyone && r.manageable && !user.roles.some((u) => u.id === r.id),
              );
              return (
                <li key={user.id} className="row">
                  <div className="row-main">
                    <strong>{user.displayName}</strong>
                    <span className="muted">@{user.username}</span>
                    <span className="chips">
                      {user.serverAdmin && (
                        <span className="badge">{t("settings.serverAdmin")}</span>
                      )}
                      {user.disabled && (
                        <span className="badge badge-warn">{t("users.disabled")}</span>
                      )}
                      {user.roles.map((r) => {
                        const full = roleList.find((x) => x.id === r.id);
                        return (
                          <RoleChip
                            key={r.id}
                            role={{ ...r, ...(full?.color ? { color: full.color } : {}) }}
                            {...(canRoles && full?.manageable && !full.everyone
                              ? { onRemove: () => void act(() => unassignRole(user.id, r.id)) }
                              : {})}
                          />
                        );
                      })}
                      {canRoles && addable.length > 0 && (
                        <select
                          className="select select-small"
                          aria-label={t("users.addRole", { name: user.displayName })}
                          value=""
                          onChange={(event) => {
                            if (event.target.value)
                              void act(() => assignRole(user.id, event.target.value));
                          }}
                        >
                          <option value="">{t("users.addRolePlaceholder")}</option>
                          {addable.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </span>
                  </div>
                  {itemsFor(user).length > 0 && (
                    <Menu
                      label={t("users.actionsFor", { name: user.displayName })}
                      items={itemsFor(user)}
                      align="end"
                    >
                      <Icon name="more" />
                    </Menu>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="invites-title">
        <h2 id="invites-title">{t("users.invitesTitle")}</h2>
        {invites.status === "loading" && <Skeleton lines={2} />}
        {invites.status === "error" && <FormError message={describeError(t, invites.error)} />}
        {invites.status === "ready" &&
          (invites.data.filter((i) => !i.usedAt).length === 0 ? (
            <p className="muted">{t("users.noInvites")}</p>
          ) : (
            <ul className="rows">
              {invites.data
                .filter((i) => !i.usedAt)
                .map((invite) => (
                  <li key={invite.id} className="row">
                    <div className="row-main">
                      <strong>{invite.note ?? t("users.inviteNoNote")}</strong>
                      <span className="muted">
                        {invite.expired
                          ? t("users.expired")
                          : t("users.expiresAt", {
                              time: formatTime(invite.expiresAt, i18n.language),
                            })}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      onClick={() => setPending({ kind: "revoke", id: invite.id })}
                    >
                      {t("users.revoke")}
                    </Button>
                  </li>
                ))}
            </ul>
          ))}
      </section>

      <NewUserDialog open={newUser} onClose={() => setNewUser(false)} onDone={users.reload} />
      <InviteDialog
        open={inviting}
        roles={roleList}
        onClose={() => setInviting(false)}
        onDone={invites.reload}
      />
      <Confirm
        open={pending?.kind === "delete"}
        danger
        title={t("users.deleteTitle")}
        body={t("users.deleteBody", {
          name: pending?.kind === "delete" ? pending.user.displayName : "",
        })}
        confirmLabel={t("common.delete")}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind !== "delete") return;
          await deleteUser(pending.user.id);
          users.reload();
        }}
      />
      <Confirm
        open={pending?.kind === "reset"}
        title={t("users.resetTitle")}
        body={t("users.resetBody", {
          name: pending?.kind === "reset" ? pending.user.displayName : "",
        })}
        confirmLabel={t("users.resetPassword")}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind !== "reset") return;
          const password = await resetPassword(pending.user.id);
          if (password) setTemp({ name: pending.user.displayName, password });
        }}
      />
      <Confirm
        open={pending?.kind === "revoke"}
        title={t("users.revokeTitle")}
        body={t("users.revokeBody")}
        confirmLabel={t("users.revoke")}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind !== "revoke") return;
          await revokeInvite(pending.id);
          invites.reload();
        }}
      />
      <Dialog
        open={temp !== null}
        onClose={() => setTemp(null)}
        title={t("users.resetDoneTitle")}
        footer={
          <Button variant="primary" onClick={() => setTemp(null)}>
            {t("common.close")}
          </Button>
        }
      >
        <div className="form">
          <p>{t("users.resetDoneBody", { name: temp?.name ?? "" })}</p>
          <input
            className="input"
            readOnly
            value={temp?.password ?? ""}
            aria-label={t("users.temporaryPassword")}
            onFocus={(e) => e.target.select()}
          />
          <p className="muted">{t("users.resetDoneNote")}</p>
        </div>
      </Dialog>
    </div>
  );
}
