import { Facet } from "@codemirror/state";

/** Text the editor draws itself (widgets live outside React, so React hands the translations in). */
export interface EditorLabels {
  properties: string;
  copy: string;
  copied: string;
  loading: string;
  embedFailed: string;
  taskDone: string;
  taskTodo: string;
  diagramDrawing: string;
  diagramError: (message: string) => string;
}

export const DEFAULT_LABELS: EditorLabels = {
  properties: "Properties",
  copy: "Copy",
  copied: "Copied",
  loading: "Loading…",
  embedFailed: "This note could not be loaded",
  taskDone: "Done",
  taskTodo: "Not done",
  diagramDrawing: "Drawing diagram…",
  diagramError: (message) => `Diagram error: ${message}`,
};

export const editorLabels = Facet.define<EditorLabels, EditorLabels>({
  combine: (values) => values[0] ?? DEFAULT_LABELS,
});
