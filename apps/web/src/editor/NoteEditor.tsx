import { linkResolver } from "@palimvo/core";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeError } from "../api/errors.ts";
import { readFile } from "../api/files.ts";
import { Button, Skeleton } from "../ui/index.ts";
import { EditorHeader } from "./EditorHeader.tsx";
import { MarkdownSurface } from "./MarkdownSurface.tsx";
import { useEditorLabels } from "./useEditorLabels.ts";
import { useCollabNote } from "./useCollabNote.ts";
import { useNoteSession, type NoteSession } from "./useNoteSession.ts";
import type { WikiLinkHost } from "./wikilinks.ts";

interface Props {
  vault: string;
  path: string;
  /** Every file path in the vault: links resolve against it and `[[` completes from it. */
  paths: readonly string[];
  /** Opens a vault file in the workspace. */
  onOpen: (path: string) => void;
  /** A link points to a note that does not exist yet: make it and open it. */
  onCreate: (target: string) => void;
  /** Viewers can read and follow links but not type. */
  readOnly?: boolean;
  /** Put the cursor in the text when the note opens. */
  autoFocus?: boolean;
  /** Another source of the note's text; by default it comes from the server's live document. */
  session?: NoteSession;
  /** False reads and saves the note over plain HTTP, one writer at a time (no live connection). */
  live?: boolean;
}

/**
 * A markdown note: live-preview editing, a reading view, and a calm save indicator. Edits merge
 * with everyone else's through the server's live document (`useCollabNote`).
 */
export function NoteEditor({ session, live = true, ...props }: Props) {
  if (session) return <NoteView {...props} note={session} />;
  return live ? <LiveNote {...props} /> : <HttpNote {...props} />;
}

type ViewProps = Omit<Props, "session" | "live">;

function LiveNote(props: ViewProps) {
  return <NoteView {...props} note={useCollabNote(props.vault, props.path)} />;
}

function HttpNote(props: ViewProps) {
  return <NoteView {...props} note={useNoteSession(props.vault, props.path)} />;
}

function NoteView({
  vault,
  path,
  paths,
  onOpen,
  onCreate,
  readOnly = false,
  autoFocus = false,
  note,
}: ViewProps & { note: NoteSession }) {
  const { t } = useTranslation();
  const labels = useEditorLabels();
  const [reading, setReading] = useState(false);

  const frozen = useMemo(() => Object.freeze([...paths]), [paths]);
  const links = useMemo<WikiLinkHost>(() => {
    const resolver = linkResolver(frozen);
    return {
      paths: () => frozen,
      resolve: (target) => resolver.resolve(target, path),
      open: (target) => {
        const found = resolver.resolve(target.split("#")[0] ?? target, path);
        if (found) onOpen(found);
        else onCreate(target.split("#")[0] ?? target);
      },
      readText: async (embedded) => (await readFile(vault, embedded)).content,
    };
  }, [frozen, path, vault, onOpen, onCreate]);

  const editable = !readOnly && !reading;
  return (
    <div className="editor">
      <EditorHeader
        path={path}
        status={note.status}
        peers={note.peers}
        notice={note.notice}
        readOnly={readOnly}
        reading={reading}
        onToggleReading={() => setReading((r) => !r)}
      />
      {note.status === "conflict" && (
        <div className="editor-banner" role="alert">
          <span>{t("editor.conflict")}</span>
          <Button onClick={() => note.resolve("theirs")}>{t("editor.useTheirs")}</Button>
          <Button variant="primary" onClick={() => note.resolve("mine")}>
            {t("editor.keepMine")}
          </Button>
        </div>
      )}
      {note.status === "error" ? (
        <div className="state" role="alert">
          <p>{describeError(t, note.error)}</p>
          <Button onClick={note.retry}>{t("common.retry")}</Button>
        </div>
      ) : note.source ? (
        <MarkdownSurface
          className="editor-body"
          source={note.source}
          links={links}
          paths={frozen}
          labels={labels}
          editable={editable}
          autoFocus={autoFocus && editable}
        />
      ) : (
        <div className="editor-body editor-loading">
          <Skeleton lines={6} />
        </div>
      )}
    </div>
  );
}
