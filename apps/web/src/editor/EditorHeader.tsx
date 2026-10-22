import { useTranslation } from "react-i18next";
import { Button } from "../ui/index.ts";
import type { SaveStatus } from "./useNoteSession.ts";

interface Props {
  path: string;
  status: SaveStatus;
  peers: number;
  notice: "recovered" | "reloaded" | null;
  readOnly: boolean;
  reading: boolean;
  onToggleReading: () => void;
}

/** A quiet breadcrumb with a save dot; the state is spelled out only when it needs attention. */
export function EditorHeader({
  path,
  status,
  peers,
  notice,
  readOnly,
  reading,
  onToggleReading,
}: Props) {
  const { t } = useTranslation();
  const parts = path.split("/");
  return (
    <header className="editor-header">
      <span className="editor-path" title={path}>
        {parts.slice(0, -1).map((folder, i) => (
          <span key={i} className="editor-crumb">
            {folder}
            <span className="editor-crumb-sep" aria-hidden="true">
              /
            </span>
          </span>
        ))}
        <span className="editor-crumb current">{parts.at(-1)}</span>
      </span>
      <span className="editor-meta">
        {peers > 1 && <span className="peers">{t("editor.peers", { count: peers })}</span>}
        {notice && <span className="editor-notice">{t(`editor.notice.${notice}`)}</span>}
        {readOnly ? (
          <span className="muted">{t("editor.viewOnly")}</span>
        ) : (
          <Button
            variant="ghost"
            icon={reading ? "edit" : "eye"}
            aria-pressed={reading}
            title={reading ? t("editor.switchToEditing") : t("editor.switchToReading")}
            onClick={onToggleReading}
          >
            {reading ? t("editor.edit") : t("editor.read")}
          </Button>
        )}
        <span className={`save-state ${status}`} role="status">
          <span className="save-dot" aria-hidden="true" />
          <span className="save-text">{t(`editor.status.${status}`)}</span>
        </span>
      </span>
    </header>
  );
}
