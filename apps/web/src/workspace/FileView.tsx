import { useState } from "react";
import { useTranslation } from "react-i18next";
import { basename } from "@palimvo/core";
import { resolveLocalized } from "@palimvo/plugin-sdk";
import { describeError } from "../api/errors.ts";
import { readFile } from "../api/files.ts";
import { useAsync } from "../app/useAsync.ts";
import { NoteEditor } from "../editor/NoteEditor.tsx";
import { PluginFrame } from "../plugins/PluginFrame.tsx";
import { usePluginRuntime } from "../plugins/PluginsProvider.tsx";
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
  return <OtherFile vault={vault} path={path} kind={kind} />;
}

/** A file without its own editor: drawn by a plugin viewer when one is enabled, else by the built-in viewer. */
function OtherFile({ vault, path, kind }: Pick<Props, "vault" | "path" | "kind">) {
  const { t, i18n } = useTranslation();
  const viewers = usePluginRuntime()?.registry.viewersFor(path) ?? [];
  // "pluginId/viewerId", or "text" to see the raw text instead.
  const [choice, setChoice] = useState<string | null>(null);
  const builtIn =
    kind === "other" ? (
      <FileViewer vault={vault} path={path} />
    ) : (
      <TextPreview vault={vault} path={path} />
    );
  if (viewers.length === 0) return builtIn;
  const chosen =
    choice === "text"
      ? null
      : (viewers.find((v) => `${v.pluginId}/${v.id}` === choice) ?? viewers[0]!);
  return (
    <article className="file-view file-view-plugin" aria-label={basename(path)}>
      <div className="viewer-switch" role="group" aria-label={t("plugins.viewer.label")}>
        {viewers.map((viewer) => (
          <Button
            key={`${viewer.pluginId}/${viewer.id}`}
            variant={chosen === viewer ? "secondary" : "ghost"}
            aria-pressed={chosen === viewer}
            onClick={() => setChoice(`${viewer.pluginId}/${viewer.id}`)}
          >
            {resolveLocalized(viewer.name, i18n.language)}
          </Button>
        ))}
        <Button
          variant={chosen === null ? "secondary" : "ghost"}
          aria-pressed={chosen === null}
          onClick={() => setChoice("text")}
        >
          {t("plugins.viewer.text")}
        </Button>
      </div>
      {chosen ? (
        <PluginFrame
          key={`${chosen.pluginId}/${chosen.id}`}
          pluginId={chosen.pluginId}
          mode="viewer"
          target={chosen.id}
          context={{ path }}
        />
      ) : (
        builtIn
      )}
    </article>
  );
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
