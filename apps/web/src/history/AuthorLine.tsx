import { useTranslation } from "react-i18next";
import type { Author } from "@palimvo/core";
import type { RosterEntry } from "../api/admin.ts";
import { AuthorBadge } from "../roles/RoleBadge.tsx";

/**
 * Who made a change: the person's name with their role label, or an AI client / plugin / outside
 * program with a tag that says which, so a reader never mistakes an AI's edit for a person's.
 */
export function AuthorLine({
  author,
  roster,
}: {
  author: Author;
  roster: ReadonlyMap<string, RosterEntry>;
}) {
  const { t } = useTranslation();
  return (
    <span className={`author-line author-${author.kind}`}>
      <AuthorBadge
        name={author.name}
        {...(author.kind === "human" ? { authorId: author.id } : {})}
        roster={roster}
      />
      {author.kind !== "human" && (
        <span className="author-kind">{t(`history.kind.${author.kind}`)}</span>
      )}
      {author.client && (
        <span className="muted">{t("history.via", { client: author.client })}</span>
      )}
    </span>
  );
}
