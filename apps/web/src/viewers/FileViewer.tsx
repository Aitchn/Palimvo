import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { basename, fileExtension } from "@palimvo/core";
import { describeError } from "../api/errors.ts";
import { rawUrl } from "../api/files.ts";
import { Button, Icon, Skeleton } from "../ui/index.ts";
import { CsvTable } from "./CsvTable.tsx";
import { JsonTree } from "./JsonTree.tsx";
import { viewerKind, type ViewerKind } from "./kinds.ts";
import { useRawText, type RawText } from "./useRawText.ts";

interface Props {
  vault: string;
  path: string;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** The download address of a file: the raw route, asking the browser to save rather than show it. */
export const downloadUrl = (vault: string, path: string) => `${rawUrl(vault, path)}?download=1`;

/**
 * The main area for a file that is not a note, canvas or database: pictures, sound, video, PDFs
 * and the text formats (JSON as a tree, CSV as a table, YAML and plain text as text) are shown in
 * place; anything else offers the download.
 */
export function FileViewer({ vault, path }: Props) {
  const { t } = useTranslation();
  const kind = viewerKind(path);
  const src = rawUrl(vault, path);
  return (
    <article className="file-view viewer" aria-label={basename(path)}>
      <header className="file-view-head viewer-head">
        <div className="viewer-title">
          <h1>{basename(path)}</h1>
          <p className="muted file-view-path">{path}</p>
        </div>
        <a
          className="btn btn-secondary viewer-download"
          href={downloadUrl(vault, path)}
          download={basename(path)}
        >
          <Icon name="download" />
          <span>{t("viewers.download")}</span>
        </a>
      </header>
      <Body kind={kind} vault={vault} path={path} src={src} />
    </article>
  );
}

function Body({
  kind,
  vault,
  path,
  src,
}: {
  kind: ViewerKind;
  vault: string;
  path: string;
  src: string;
}) {
  const { t } = useTranslation();
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (broken)
    return (
      <div className="state" role="alert">
        <Icon name="warning" />
        <p>{t("viewers.loadFailed")}</p>
      </div>
    );
  switch (kind) {
    case "image":
      return (
        <div className="media-viewer">
          <img src={src} alt={path} onError={() => setBroken(true)} />
        </div>
      );
    case "audio":
      return (
        <div className="media-viewer">
          <audio controls preload="metadata" src={src} onError={() => setBroken(true)} />
        </div>
      );
    case "video":
      return (
        <div className="media-viewer">
          <video controls preload="metadata" src={src} onError={() => setBroken(true)} />
        </div>
      );
    case "pdf":
      return <iframe className="pdf-viewer" src={src} title={basename(path)} />;
    case "none":
      return (
        <div className="state">
          <Icon name="info" />
          <p className="muted">
            {t("viewers.noViewer", { type: fileExtension(path) ? `.${fileExtension(path)}` : "" })}
          </p>
        </div>
      );
    default:
      return <TextBody kind={kind} vault={vault} path={path} />;
  }
}

function TextBody({ kind, vault, path }: { kind: ViewerKind; vault: string; path: string }) {
  const { t } = useTranslation();
  const raw = useRawText(vault, path);
  if (raw.status === "loading") return <Skeleton lines={8} />;
  if (raw.status === "error")
    return (
      <div className="state" role="alert">
        <p>{describeError(t, raw.error)}</p>
        <Button onClick={raw.reload}>{t("common.retry")}</Button>
      </div>
    );
  if (raw.status === "too-big")
    return (
      <div className="state">
        <Icon name="info" />
        <p className="muted">{t("viewers.tooBig", { size: size(raw.bytes) })}</p>
      </div>
    );
  if (raw.text === "") return <p className="muted">{t("workspace.emptyFile")}</p>;
  return <Formatted kind={kind} text={raw.text} state={raw} />;
}

function Formatted({ kind, text, state }: { kind: ViewerKind; text: string; state: RawText }) {
  const { t } = useTranslation();
  const [asText, setAsText] = useState(false);
  const bytes = state.status === "ready" ? state.bytes : 0;
  const parsed = useMemo(() => {
    if (kind !== "json") return { ok: false as const };
    try {
      return { ok: true as const, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false as const };
    }
  }, [kind, text]);

  if (kind === "svg") return <SvgPicture text={text} />;
  const switchable = kind === "json" || kind === "csv";
  const showText = !switchable || asText || (kind === "json" && !parsed.ok);
  return (
    <div className="text-viewer">
      <div className="text-viewer-bar">
        <span className="muted">{size(bytes)}</span>
        {kind === "json" && !parsed.ok && (
          <span className="muted" role="status">
            {t("viewers.jsonInvalid")}
          </span>
        )}
        {switchable && !(kind === "json" && !parsed.ok) && (
          <label className="text-viewer-raw">
            <input type="checkbox" checked={asText} onChange={(e) => setAsText(e.target.checked)} />{" "}
            {t("viewers.showText")}
          </label>
        )}
      </div>
      {showText ? (
        <pre className="file-preview" tabIndex={0}>
          {text}
        </pre>
      ) : kind === "json" && parsed.ok ? (
        <JsonTree value={parsed.value} />
      ) : (
        <CsvTable text={text} />
      )}
    </div>
  );
}

/**
 * An SVG drawn through <img> from a blob of its text: browsers never run scripts or load anything
 * external for an SVG shown as an image, so a hostile file stays a picture. (The server sends SVG
 * as plain text for the same reason.)
 */
function SvgPicture({ text }: { text: string }) {
  const url = useMemo(
    () => URL.createObjectURL(new Blob([text], { type: "image/svg+xml" })),
    [text],
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="media-viewer svg-viewer">
      <img src={url} alt="" />
    </div>
  );
}
