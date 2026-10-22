import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  previewPermissions,
  setOverride,
  type PersonRef,
  type Subject,
  type VaultPermissions,
} from "../api/admin.ts";
import { describeError } from "../api/errors.ts";
import { useAsync } from "../app/useAsync.ts";
import { FormError } from "../auth/forms.tsx";
import { Button, Skeleton, useToast } from "../ui/index.ts";
import { permissionHintKey, permissionKey, groupsFor } from "./groups.ts";
import { PersonPicker } from "./PersonPicker.tsx";
import { RoleBadge } from "./RoleBadge.tsx";
import { TriState, type Mode } from "./TriState.tsx";

interface Props {
  vault: string;
  /** A folder path for a folder override; leave out for the whole vault. */
  folder?: string;
  data: VaultPermissions;
  /** Called with the server's answer after every change. */
  onData: (next: VaultPermissions) => void;
}

const keyOf = (s: Subject) => `${s.type}:${s.id}`;

/**
 * Per role or person: allow, inherit or deny for each permission that applies here (vault level,
 * or the write-type permissions at folder level), plus a "view as" preview of the result.
 */
export function PermissionEditor({ vault, folder, data, onData }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const where = folder === undefined ? "vault" : "folder";
  const groups = groupsFor(where);
  const [added, setAdded] = useState<Subject[]>([]);
  const [people, setPeople] = useState<PersonRef[]>([]);
  const [busy, setBusy] = useState(false);

  const here = data.overrides.filter((o) => o.folder === folder);
  const subjects: Subject[] = [
    ...here.map((o) => ({ type: o.subjectType, id: o.subjectId })),
    ...added,
  ].filter((s, i, all) => all.findIndex((x) => keyOf(x) === keyOf(s)) === i);
  const roleById = new Map(data.roles.map((r) => [r.id, r]));
  const personById = new Map([...data.people, ...people].map((p) => [p.id, p]));

  const nameOf = (s: Subject) =>
    s.type === "role"
      ? (roleById.get(s.id)?.name ?? s.id)
      : (personById.get(s.id)?.displayName ?? s.id);

  const modeOf = (s: Subject, permission: string): Mode => {
    const row = here.find((o) => o.subjectType === s.type && o.subjectId === s.id);
    if (row?.deny.includes(permission)) return "deny";
    if (row?.allow.includes(permission)) return "allow";
    return "inherit";
  };

  const change = async (s: Subject, permission: string, mode: Mode) => {
    const row = here.find((o) => o.subjectType === s.type && o.subjectId === s.id);
    const without = (list: string[] | undefined) => (list ?? []).filter((n) => n !== permission);
    const allow = mode === "allow" ? [...without(row?.allow), permission] : without(row?.allow);
    const deny = mode === "deny" ? [...without(row?.deny), permission] : without(row?.deny);
    setBusy(true);
    try {
      onData(
        await setOverride(vault, {
          ...(folder === undefined ? {} : { folder }),
          subject: s,
          allow,
          deny,
        }),
      );
    } catch (error) {
      toast.push({ message: describeError(t, error), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const clear = async (s: Subject) => {
    setBusy(true);
    try {
      onData(
        await setOverride(vault, {
          ...(folder === undefined ? {} : { folder }),
          subject: s,
          allow: [],
          deny: [],
        }),
      );
      setAdded((list) => list.filter((x) => keyOf(x) !== keyOf(s)));
    } catch (error) {
      toast.push({ message: describeError(t, error), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const addable = data.roles.filter((r) => !subjects.some((s) => keyOf(s) === `role:${r.id}`));

  return (
    <div className="permission-editor">
      <p className="muted">
        {t(folder === undefined ? "permissions.vaultNote" : "permissions.folderNote")}
      </p>

      {subjects.length === 0 && <p className="muted">{t("permissions.noOverrides")}</p>}
      <ul className="rows">
        {subjects.map((s) => {
          const role = s.type === "role" ? roleById.get(s.id) : undefined;
          const row = here.find((o) => o.subjectType === s.type && o.subjectId === s.id);
          const counts = { allow: row?.allow.length ?? 0, deny: row?.deny.length ?? 0 };
          return (
            <li key={keyOf(s)} className="override">
              <details open={added.some((x) => keyOf(x) === keyOf(s)) || subjects.length <= 2}>
                <summary>
                  <span className="override-who">
                    {role ? <RoleBadge role={role} /> : <strong>{nameOf(s)}</strong>}
                    {s.type === "account" && (
                      <span className="muted">{t("permissions.person")}</span>
                    )}
                  </span>
                  <span className="muted">
                    {t("permissions.counts", { allow: counts.allow, deny: counts.deny })}
                  </span>
                </summary>
                {groups.map((g) => (
                  <fieldset key={g.id} className="perm-group">
                    {groups.length > 1 && <legend>{t(`permissions.groups.${g.id}`)}</legend>}
                    {g.names.map((name) => (
                      <TriState
                        key={name}
                        label={t(permissionKey(name))}
                        hint={t(permissionHintKey(name))}
                        value={modeOf(s, name)}
                        disabled={busy}
                        onChange={(mode) => void change(s, name, mode)}
                      />
                    ))}
                  </fieldset>
                ))}
                <div>
                  <Button
                    variant="ghost"
                    icon="trash"
                    disabled={busy}
                    onClick={() => void clear(s)}
                  >
                    {t("permissions.removeOverride", { name: nameOf(s) })}
                  </Button>
                </div>
              </details>
            </li>
          );
        })}
      </ul>

      <div className="inline-form">
        <div className="field">
          <label htmlFor="override-role">{t("permissions.addRole")}</label>
          <select
            id="override-role"
            className="select"
            value=""
            onChange={(event) => {
              if (event.target.value)
                setAdded((list) => [...list, { type: "role", id: event.target.value }]);
            }}
          >
            <option value="">{t("permissions.chooseRole")}</option>
            {addable.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <PersonPicker
          vault={vault}
          label={t("permissions.addPerson")}
          onPick={(p) => {
            setPeople((list) => [...list, p]);
            setAdded((list) => [...list, { type: "account", id: p.id }]);
          }}
        />
      </div>

      <ViewAs
        vault={vault}
        {...(folder === undefined ? {} : { folder })}
        data={data}
        people={[...personById.values()]}
      />
    </div>
  );
}

/** "View as": the permissions a role (as a member) or a person ends up with here. */
function ViewAs({
  vault,
  folder,
  data,
  people,
}: {
  vault: string;
  folder?: string;
  data: VaultPermissions;
  people: PersonRef[];
}) {
  const { t } = useTranslation();
  const [subject, setSubject] = useState<Subject | null>(null);
  const [picked, setPicked] = useState<PersonRef | null>(null);
  const where = folder === undefined ? "vault" : "folder";
  const names = groupsFor(where).flatMap((g) => g.names);

  const result = useAsync(
    (signal) =>
      subject
        ? previewPermissions(vault, subject, {
            signal,
            ...(folder === undefined ? {} : { folder }),
          })
        : Promise.resolve(null),
    // The data changing (an override was set) must refresh the preview too.
    `${subject ? keyOf(subject) : "none"}|${folder ?? ""}|${JSON.stringify(data.overrides)}`,
  );
  const allowed = result.status === "ready" && result.data ? new Set(result.data) : null;

  return (
    <section className="view-as" aria-labelledby="view-as-title">
      <h3 id="view-as-title">{t("permissions.viewAs")}</h3>
      <p className="muted">{t("permissions.viewAsNote")}</p>
      <div className="inline-form">
        <div className="field">
          <label htmlFor="view-as-role">{t("permissions.viewAsRole")}</label>
          <select
            id="view-as-role"
            className="select"
            value={subject?.type === "role" ? subject.id : ""}
            onChange={(event) => {
              setPicked(null);
              setSubject(event.target.value ? { type: "role", id: event.target.value } : null);
            }}
          >
            <option value="">{t("permissions.chooseRole")}</option>
            {data.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <PersonPicker
          vault={vault}
          label={t("permissions.viewAsPerson")}
          onPick={(p) => {
            setPicked(p);
            setSubject({ type: "account", id: p.id });
          }}
        />
      </div>
      {subject?.type === "account" && (
        <p>
          {t("permissions.viewingAs", {
            name: (picked ?? people.find((p) => p.id === subject.id))?.displayName ?? subject.id,
          })}
        </p>
      )}
      {subject && result.status === "loading" && <Skeleton lines={3} />}
      {result.status === "error" && <FormError message={describeError(t, result.error)} />}
      {allowed && (
        <ul className="effective" aria-label={t("permissions.effective")}>
          {names.map((name) => (
            <li key={name} data-allowed={allowed.has(name) || undefined}>
              <span aria-hidden="true">{allowed.has(name) ? "✓" : "✕"}</span>
              <span>{t(permissionKey(name))}</span>
              <span className="sr-only">
                {t(allowed.has(name) ? "permissions.canDo" : "permissions.cannotDo")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
