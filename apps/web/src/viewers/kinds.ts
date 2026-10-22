import { fileExtension, mediaOf } from "@palimvo/core";

export type ViewerKind =
  "image" | "svg" | "audio" | "video" | "pdf" | "json" | "csv" | "yaml" | "text" | "none";

/** Which built-in viewer shows a file, by its extension; "none" when the app has no view for it. */
export function viewerKind(path: string): ViewerKind {
  const media = mediaOf(path);
  if (media) return media.kind;
  switch (fileExtension(path)) {
    case "svg":
      return "svg";
    case "pdf":
      return "pdf";
    case "json":
      return "json";
    case "csv":
      return "csv";
    case "yaml":
    case "yml":
      return "yaml";
    case "txt":
    case "log":
      return "text";
    default:
      return "none";
  }
}

/** Text files bigger than this are offered as a download instead of being drawn. */
export const MAX_TEXT_VIEW_BYTES = 5 * 1024 * 1024;
