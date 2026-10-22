import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { basename, linkResolver } from "@palimvo/core";
import { describeError } from "../api/errors.ts";
import { readFile } from "../api/files.ts";
import { useAsync } from "../app/useAsync.ts";
import { BaseView } from "../bases/BaseView.tsx";
import { NoteEditor } from "../editor/NoteEditor.tsx";
import { Button, Icon, Skeleton } from "../ui/index.ts";

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

/** Extensions that are plain text even though the app has no dedicated view for them. */
const TEXT = /\.(txt|json|ya?ml|csv|log|toml|ini|js|ts|css|html?)$/i;

/** The main area for an open file: notes are edited; other text files are shown read-only for now. */
export function FileView({ vault, path, kind, paths, onOpen, onCreate, readOnly = false }: Props) {
  const resolver = useMemo(() => linkResolver(paths), [paths]);
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
  if (kind === "base") {
    return (
      <article className="file-view base-file-view" aria-label={basename(path)}>
        <header className="file-view-head">
          <h1>{basename(path)}</h1>
          <p className="muted file-view-path">{path}</p>
        </header>
        <BaseView
          vault={vault}
          target={{ kind: "file", path }}
          canEdit={!readOnly}
          onOpen={onOpen}
          onOpenLink={(target) => {
            const found = resolver.resolve(target.split("#")[0] ?? target, path);
            if (found) onOpen(found);
            else onCreate(target.split("#")[0] ?? target);
          }}
        />
      </article>
    );
  }
  return <TextPreview vault={vault} path={path} kind={kind} />;
}

function TextPreview({ vault, path, kind }: Pick<Props, "vault" | "path" | "kind">) {
  const { t } = useTranslation();
  const previewable = kind !== "other" || TEXT.test(path);
  const file = useAsync(
    (signal) => (previewable ? readFile(vault, path, { signal }) : Promise.resolve(null)),
    `file:${vault}:${path}`,
  );
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
        (file.data === null ? (
          <div className="state">
            <Icon name="info" />
            <p className="muted">{t("workspace.noPreview")}</p>
          </div>
        ) : file.data.content === "" ? (
          <p className="muted">{t("workspace.emptyFile")}</p>
        ) : (
          <pre className="file-preview" tabIndex={0} aria-label={t("workspace.readOnly")}>
            {file.data.content}
          </pre>
        ))}
    </article>
  );
}
