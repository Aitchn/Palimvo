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
import type { ChangeNote } from "../history/history.ts";

/** Who the history credits when a request does not say. Accounts (T10) replace this with the signed-in user. */
const ANONYMOUS = makeAuthor("human", "Anonymous", { id: "anonymous" });

/**
 * The author a client states with `X-Palimvo-Author` (`ai:Claude Code`, URI-encoded). Until
 * accounts arrive (T10) this is taken on trust.
 */
export function requestAuthor(c: Context): Author {
  const header = readCompatHeader(
    (name) => c.req.header(name),
    AUTHOR_HEADER,
    LEGACY_AUTHOR_HEADER,
  );
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
