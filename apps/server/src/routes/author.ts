import type { Context } from "hono";
import {
  AUTHOR_HEADER,
  LEGACY_AUTHOR_HEADER,
  LEGACY_REASON_HEADER,
  REASON_HEADER,
  makeAuthor,
  parseAuthor,
  readCompatHeader,
  type Author,
} from "@palimvo/core";
import { principalOf } from "../auth/principal.ts";
import type { ChangeNote } from "../history/history.ts";

/** Who the history credits when a request does not say (only possible before the first account exists). */
const ANONYMOUS = makeAuthor("human", "Anonymous", { id: "anonymous" });

/**
 * The signed-in person, always: a browser session cannot pass itself off as someone else. In setup
 * mode (no accounts yet) the client's `X-Palimvo-Author` (`ai:Claude Code`, URI-encoded) is taken on
 * trust. An AI token is always credited as an AI: under the name its client gives in that header,
 * or else the OAuth app's name or the token's own name.
 */
export function requestAuthor(c: Context): Author {
  const principal = principalOf(c);
  if (principal.kind === "account")
    return makeAuthor("human", principal.account.displayName, { id: principal.account.username });
  const header = readCompatHeader(
    (name) => c.req.header(name),
    AUTHOR_HEADER,
    LEGACY_AUTHOR_HEADER,
  );
  if (principal.kind === "token")
    return makeAuthor("ai", parseAuthor(header)?.name ?? principal.bearer.label);
  return parseAuthor(header) ?? ANONYMOUS;
}

/** The change note for a request: the client's `X-Palimvo-Reason` (URI-encoded) and what the app did. */
export function requestNote(c: Context, summary?: string): ChangeNote {
  const header = readCompatHeader(
    (name) => c.req.header(name),
    REASON_HEADER,
    LEGACY_REASON_HEADER,
  );
  let reason: string | undefined;
  if (header) {
    try {
      reason = decodeURIComponent(header);
    } catch {
      reason = header;
    }
  }
  return { reason, summary };
}
