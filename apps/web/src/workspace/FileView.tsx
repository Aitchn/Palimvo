import { useTranslation } from "react-i18next";
import { basename } from "@palimvo/core";
import { describeError } from "../api/errors.ts";
import { readFile } from "../api/files.ts";
import { useAsync } from "../app/useAsync.ts";
import { NoteEditor } from "../editor/NoteEditor.tsx";
import { Button, Skeleton } from "../ui/index.ts";
import { FileViewer } from "../viewers/FileViewer.tsx";

interface Props {
  vault: string;
  path: string;
  /** The file kind from the tree; only text-based kinds have a preview. */
  kind: "markdown" | "canvas" | "base" | "other";
  /** Every file path in the vault, for links. */
  paths: readonly string[];
  onOpen: (path: string) => void;
  /** A link to a note that does not exist yet. */
  onCreate: (target: string) => void;
  /** Viewers read and follow links but cannot type. */
  readOnly?: boolean;
}

/** The main area for an open file: notes are edited; other files get a viewer for their type. */
export function FileView({ vault, path, kind, paths, onOpen, onCreate, readOnly = false }: Props) {
  if (kind === "markdown") {
    return (
      <article className="file-view note-view" aria-label={basename(path)}>
        <NoteEditor
          vault={vault}
          path={path}
          paths={paths}
          onOpen={onOpen}
          onCreate={onCreate}
          readOnly={readOnly}
        />
      </article>
    );
  }
  // Canvases and databases keep a plain preview until their own views arrive.
  if (kind === "other") return <FileViewer vault={vault} path={path} />;
  return <TextPreview vault={vault} path={path} />;
}

function TextPreview({ vault, path }: Pick<Props, "vault" | "path">) {
  const { t } = useTranslation();
  const file = useAsync((signal) => readFile(vault, path, { signal }), `file:${vault}:${path}`);
  return (
    <article className="file-view" aria-label={basename(path)}>
      <header className="file-view-head">
        <h1>{basename(path)}</h1>
        <p className="muted file-view-path">{path}</p>
      </header>
      {file.status === "loading" && <Skeleton lines={6} />}
      {file.status === "error" && (
        <div className="state" role="alert">
          <p>{describeError(t, file.error)}</p>
          <Button onClick={file.reload}>{t("common.retry")}</Button>
        </div>
      )}
      {file.status === "ready" &&
        (file.data.content === "" ? (
          <p className="muted">{t("workspace.emptyFile")}</p>
        ) : (
          <pre className="file-preview" tabIndex={0} aria-label={t("workspace.readOnly")}>
            {file.data.content}
          </pre>
        ))}
    </article>
  );
}
