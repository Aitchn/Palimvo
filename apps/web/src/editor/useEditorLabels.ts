import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { EditorLabels } from "./labels.ts";

/** The editor's own text in the current language (a new object only when the language changes). */
export function useEditorLabels(): EditorLabels {
  const { t, i18n } = useTranslation();
  return useMemo<EditorLabels>(
    () => ({
      properties: t("editor.properties"),
      copy: t("editor.copy"),
      copied: t("editor.copied"),
      loading: t("common.loading"),
      embedFailed: t("editor.embedFailed"),
      taskDone: t("editor.taskDone"),
      taskTodo: t("editor.taskTodo"),
      diagramDrawing: t("editor.diagramDrawing"),
      diagramError: (message) => t("editor.diagramError", { message }),
    }),
    // `t` changes with the language; i18n.language makes that explicit.
    [t, i18n.language],
  );
}
