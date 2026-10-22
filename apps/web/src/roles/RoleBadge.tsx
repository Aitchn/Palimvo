import { useMemo } from "react";
import { getRoster, type RoleLabel, type RosterEntry } from "../api/admin.ts";
import { useAsync } from "../app/useAsync.ts";
import { Icon } from "../ui/index.ts";
import { useTranslation } from "react-i18next";

/** The small coloured label of a role. With `onRemove` it gets a remove button. */
export function RoleBadge({
  role,
  onRemove,
}: {
  role: { name: string; color?: string };
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

/** The role that stands for a person: the highest-ranked one that has a colour, else the highest. */
export function topRole(roles: readonly RoleLabel[]): RoleLabel | undefined {
  const ranked = [...roles].sort((a, b) => b.position - a.position);
  return ranked.find((r) => r.color) ?? ranked[0];
}

/** Role labels of the people in a vault, by the id their changes carry as author. */
export function useRoster(vault: string): ReadonlyMap<string, RosterEntry> {
  const roster = useAsync((signal) => getRoster(vault, { signal }), `roster:${vault}`);
  return useMemo(
    () => new Map(roster.status === "ready" ? roster.data.map((p) => [p.authorId, p]) : []),
    [roster.status === "ready" ? roster.data : null],
  );
}

/**
 * A person's name with their role label, for history entries, the activity feed, proposals and
 * anywhere else a change shows who made it. AIs, plugins and unknown names get just the name.
 */
export function AuthorBadge({
  name,
  authorId,
  roster,
}: {
  name: string;
  /** The author's id; leave out for authors that are not people. */
  authorId?: string;
  roster: ReadonlyMap<string, RosterEntry>;
}) {
  const entry = authorId === undefined ? undefined : roster.get(authorId);
  const role = entry ? topRole(entry.roles) : undefined;
  return (
    <span className="author-badge">
      <span className="author-name">{name}</span>
      {role && <RoleBadge role={role} />}
    </span>
  );
}
