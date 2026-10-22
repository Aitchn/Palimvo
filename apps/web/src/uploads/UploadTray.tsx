import { useTranslation } from "react-i18next";
import { Button, Icon } from "../ui/index.ts";
import { uploadQueue, useUploads } from "./queue.ts";

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/** Uploads in progress, with a bar each and a way to stop one. Renders nothing when idle. */
export function UploadTray() {
  const { t } = useTranslation();
  const uploads = useUploads();
  if (uploads.length === 0) return null;
  return (
    <section className="upload-tray" aria-label={t("uploads.title")}>
      <ul>
        {uploads.map((u) => (
          <li key={u.id} className={`upload-item upload-${u.state}`}>
            <div className="upload-line">
              <Icon
                name={u.state === "failed" ? "warning" : u.state === "done" ? "check" : "upload"}
              />
              <span className="upload-name" title={u.name}>
                {u.name}
              </span>
              {u.state === "uploading" ? (
                <Button
                  variant="ghost"
                  icon="close"
                  aria-label={t("uploads.cancel", { name: u.name })}
                  onClick={() => uploadQueue.cancel(u.id)}
                />
              ) : (
                <Button
                  variant="ghost"
                  icon="close"
                  aria-label={t("common.close")}
                  onClick={() => uploadQueue.dismiss(u.id)}
                />
              )}
            </div>
            {u.state === "uploading" && (
              <>
                <progress max={Math.max(1, u.total)} value={u.sent} aria-label={u.name} />
                <span className="muted upload-meta">
                  {t("uploads.progress", { sent: size(u.sent), total: size(u.total) })}
                </span>
              </>
            )}
            {u.state === "done" && <span className="muted upload-meta">{t("uploads.done")}</span>}
            {u.state === "failed" && (
              <span className="upload-meta upload-error" role="alert">
                {u.error}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
