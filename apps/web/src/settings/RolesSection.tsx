import { useEffect, useState, type DragEvent, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  assignRole,
  createRole,
  deleteRole,
  listRoleMembers,
  listRoles,
  listUsers,
  unassignRole,
  updateRole,
  type PersonRef,
  type RoleRow,
} from "../api/admin.ts";
import { describeError } from "../api/errors.ts";
import { useAsync } from "../app/useAsync.ts";
import { FormError, TextField } from "../auth/forms.tsx";
import { useSession } from "../auth/session.tsx";
import { groupsFor, permissionHintKey, permissionKey } from "../roles/groups.ts";
import { reorder, sortRoles } from "../roles/order.ts";
import { RoleBadge } from "../roles/RoleBadge.tsx";
import { Button, Icon, Skeleton, useToast } from "../ui/index.ts";
import { Confirm } from "./Confirm.tsx";

const SWATCHES = [
  "#e05252",
  "#e0904f",
  "#c9a227",
  "#3fa964",
  "#2f9fb8",
  "#3b82f6",
  "#7461f0",
  "#c25aa8",
];

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

function Switch({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="switch-row">
      <span className="tri-text">
        <span className="tri-label">{label}</span>
        {hint && <span className="muted">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function RoleMembers({ role, canAssign }: { role: RoleRow; canAssign: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const members = useAsync(
    (signal) => listRoleMembers(role.id, { signal }),
    `role-members:${role.id}`,
  );
  // Only people who may manage users can see who could be added.
  const users = useAsync((signal) => listUsers({ signal }).catch(() => []), "role-candidates");
  const [adding, setAdding] = useState("");

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      members.reload();
    } catch (error) {
      toast.push({ message: describeError(t, error), kind: "error" });
    }
  };

  if (role.everyone) return <p className="muted">{t("roles.everyoneMembers")}</p>;
  const current: PersonRef[] = members.status === "ready" ? members.data : [];
  const candidates =
    users.status === "ready"
      ? users.data.filter((u) => !u.disabled && !current.some((m) => m.id === u.id))
      : [];

  return (
    <div>
      {members.status === "loading" && <Skeleton lines={2} />}
      {members.status === "error" && <FormError message={describeError(t, members.error)} />}
      {members.status === "ready" && current.length === 0 && (
        <p className="muted">{t("roles.noMembers")}</p>
      )}
      <ul className="rows">
        {current.map((m) => (
          <li key={m.id} className="row">
            <div className="row-main">
              <strong>{m.displayName}</strong>
              <span className="muted">@{m.username}</span>
            </div>
            {canAssign && (
              <Button
                variant="ghost"
                icon="close"
                aria-label={t("roles.removeMember", { name: m.displayName })}
                onClick={() => void act(() => unassignRole(m.id, role.id))}
              />
            )}
          </li>
        ))}
      </ul>
      {canAssign && candidates.length > 0 && (
        <div className="inline-form">
          <div className="field">
            <label htmlFor="role-add-member">{t("roles.addMember")}</label>
            <select
              id="role-add-member"
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
                await assignRole(adding, role.id);
                setAdding("");
              })
            }
          >
            {t("members.addButton")}
          </Button>
        </div>
      )}
    </div>
  );
}

function RoleEditor({
  role,
  mayGrant,
  onSaved,
  onDeleted,
}: {
  role: RoleRow;
  /** Server permissions the editor may hand out; everything for an administrator. */
  mayGrant: (permission: string) => boolean;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color ?? "");
  const [permissions, setPermissions] = useState(role.permissions);
  const [joinDeny, setJoinDeny] = useState(role.joinDeny);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
  const locked = !role.manageable;

  const dirty =
    name !== role.name ||
    color !== (role.color ?? "") ||
    !same(permissions, role.permissions) ||
    !same(joinDeny, role.joinDeny);

  const toggle = (list: string[], set: (next: string[]) => void, item: string, on: boolean) =>
    set(on ? [...list, item] : list.filter((x) => x !== item));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await updateRole(role.id, {
        ...(role.everyone ? {} : { name: name.trim() }),
        color: color === "" ? null : color,
        permissions,
        joinDeny,
      });
      toast.push({ message: t("roles.saved"), kind: "success" });
      onSaved();
    } catch (error) {
      setProblem(describeError(t, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="form role-editor"
      onSubmit={save}
      aria-label={t("roles.editing", { name: role.name })}
    >
      {locked && <p className="muted">{t("roles.locked")}</p>}
      <TextField
        label={t("roles.name")}
        value={name}
        maxLength={40}
        required
        disabled={locked || role.everyone}
        onChange={(event) => setName(event.target.value)}
      />
      <fieldset className="choices" disabled={locked}>
        <legend>{t("roles.color")}</legend>
        <div className="swatches" role="radiogroup" aria-label={t("roles.color")}>
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color.toLowerCase() === c}
              aria-label={c}
              className="swatch"
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
          <input
            type="color"
            aria-label={t("roles.customColor")}
            value={color || "#888888"}
            onChange={(event) => setColor(event.target.value)}
          />
          <Button variant="ghost" disabled={color === ""} onClick={() => setColor("")}>
            {t("roles.noColor")}
          </Button>
        </div>
        <p className="muted">
          {t("roles.preview")}{" "}
          <RoleBadge role={{ name: name || role.name, ...(color ? { color } : {}) }} />
        </p>
      </fieldset>

      <fieldset className="choices" disabled={locked}>
        <legend>{t("roles.serverPermissions")}</legend>
        {groupsFor("server").map((g) => (
          <div key={g.id} className="perm-group">
            <h4>{t(`permissions.groups.${g.id}`)}</h4>
            {g.names.map((n) => (
              <Switch
                key={n}
                label={t(permissionKey(n))}
                hint={t(permissionHintKey(n))}
                checked={permissions.includes(n)}
                disabled={!permissions.includes(n) && !mayGrant(n)}
                onChange={(on) => toggle(permissions, setPermissions, n, on)}
              />
            ))}
          </div>
        ))}
      </fieldset>

      {!role.everyone && (
        <fieldset className="choices" disabled={locked}>
          <legend>{t("roles.joinDeny")}</legend>
          <p className="muted">{t("roles.joinDenyNote")}</p>
          {groupsFor("vault").map((g) => (
            <div key={g.id} className="perm-group">
              <h4>{t(`permissions.groups.${g.id}`)}</h4>
              {g.names.map((n) => (
                <Switch
                  key={n}
                  label={t(permissionKey(n))}
                  checked={joinDeny.includes(n)}
                  onChange={(on) => toggle(joinDeny, setJoinDeny, n, on)}
                />
              ))}
            </div>
          ))}
        </fieldset>
      )}

      <FormError message={problem} />
      <div className="form-actions">
        {!role.everyone && !locked ? (
          <Button variant="danger" icon="trash" onClick={() => setDeleting(true)}>
            {t("roles.delete")}
          </Button>
        ) : (
          <span />
        )}
        <Button variant="primary" type="submit" loading={busy} disabled={locked || !dirty}>
          {t("common.save")}
        </Button>
      </div>
      <Confirm
        open={deleting}
        danger
        title={t("roles.deleteTitle")}
        body={t("roles.deleteBody", { name: role.name })}
        confirmLabel={t("roles.delete")}
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          await deleteRole(role.id);
          onDeleted();
        }}
      />
    </form>
  );
}

function NewRole({ onCreated }: { onCreated: (role: RoleRow) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return;
    setBusy(true);
    setProblem(null);
    try {
      const role = await createRole({ name: name.trim() });
      setName("");
      onCreated(role);
    } catch (error) {
      setProblem(describeError(t, error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={submit}>
      <TextField
        label={t("roles.newRole")}
        error={problem}
        value={name}
        maxLength={40}
        autoComplete="off"
        onChange={(event) => setName(event.target.value)}
      />
      <Button
        variant="primary"
        type="submit"
        icon="add"
        loading={busy}
        disabled={name.trim() === ""}
      >
        {t("roles.create")}
      </Button>
    </form>
  );
}

/** `/settings/roles`: create, colour, order and give permissions to roles, and see who holds them. */
export function RolesSection() {
  const { t } = useTranslation();
  const toast = useToast();
  const { session } = useSession();
  const roles = useAsync((signal) => listRoles({ signal }), "admin-roles-page");
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const me = session.status === "account" ? session.account : null;
  const isAdmin = me?.serverAdmin ?? session.status === "open";
  const held = session.status === "account" ? session.server : null;
  const mayGrant = (permission: string) => isAdmin || (held?.has(permission) ?? false);

  const sorted = roles.status === "ready" ? sortRoles(roles.data) : [];
  const ranked = sorted.filter((r) => !r.everyone);
  const current = sorted.find((r) => r.id === selected) ?? sorted[0];

  useEffect(() => {
    if (selected === null && sorted[0]) setSelected(sorted[0].id);
  }, [roles.status]);

  const move = async (from: number, to: number) => {
    const changes = reorder(ranked, from, to, isAdmin);
    if (changes.length === 0) return;
    try {
      // Lowest rank first, so nobody is ever briefly ranked above themselves.
      for (const c of [...changes].sort((a, b) => a.position - b.position))
        await updateRole(c.id, { position: c.position });
    } catch (error) {
      toast.push({ message: describeError(t, error), kind: "error" });
    }
    roles.reload();
  };

  const onDrop = (event: DragEvent, to: number) => {
    event.preventDefault();
    const from = ranked.findIndex((r) => r.id === dragging);
    setDragging(null);
    if (from >= 0) void move(from, to);
  };

  return (
    <div className="settings-stack">
      <section aria-labelledby="roles-title">
        <div className="section-head">
          <h2 id="roles-title">{t("roles.title")}</h2>
        </div>
        <p className="muted">{t("roles.intro")}</p>
        {roles.status === "loading" && <Skeleton lines={4} />}
        {roles.status === "error" && <FormError message={describeError(t, roles.error)} />}
        {roles.status === "ready" && (
          <div className="roles-layout">
            <div>
              <ul className="role-list" aria-label={t("roles.listLabel")}>
                {sorted.map((r) => {
                  const index = ranked.findIndex((x) => x.id === r.id);
                  return (
                    <li
                      key={r.id}
                      className="role-item"
                      data-selected={r.id === current?.id || undefined}
                      data-dragging={dragging === r.id || undefined}
                      draggable={!r.everyone && r.manageable}
                      onDragStart={() => setDragging(r.id)}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={(event) => {
                        if (dragging && !r.everyone) event.preventDefault();
                      }}
                      onDrop={(event) => !r.everyone && onDrop(event, index)}
                    >
                      <button
                        type="button"
                        className="role-pick"
                        aria-current={r.id === current?.id ? "true" : undefined}
                        onClick={() => setSelected(r.id)}
                      >
                        <RoleBadge role={r} />
                        <span className="muted">
                          {t("roles.memberCount", { count: r.memberCount ?? 0 })}
                        </span>
                      </button>
                      {!r.everyone && r.manageable && (
                        <span className="role-move">
                          <Button
                            variant="ghost"
                            aria-label={t("roles.moveUp", { name: r.name })}
                            disabled={index <= 0}
                            onClick={() => void move(index, index - 1)}
                          >
                            <Icon name="caret" style={{ transform: "rotate(180deg)" }} />
                          </Button>
                          <Button
                            variant="ghost"
                            aria-label={t("roles.moveDown", { name: r.name })}
                            disabled={index >= ranked.length - 1}
                            onClick={() => void move(index, index + 1)}
                          >
                            <Icon name="caret" />
                          </Button>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <NewRole
                onCreated={(role) => {
                  setSelected(role.id);
                  roles.reload();
                }}
              />
            </div>
            {current && (
              <div className="role-detail">
                <h3>{current.name}</h3>
                <RoleEditor
                  key={`${current.id}:${current.name}:${current.color ?? ""}:${current.permissions.join()}:${current.joinDeny.join()}`}
                  role={current}
                  mayGrant={mayGrant}
                  onSaved={roles.reload}
                  onDeleted={() => {
                    setSelected(null);
                    roles.reload();
                  }}
                />
                <section aria-labelledby="role-members-title">
                  <h4 id="role-members-title">{t("roles.members")}</h4>
                  <RoleMembers role={current} canAssign={current.manageable} />
                </section>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
