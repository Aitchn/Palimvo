import { baseColumn, type BaseFile } from "@palimvo/core";
import type { TFunction } from "i18next";

/** A column's heading: file fields are translated, properties and formulas keep their own names. */
export function columnLabel(t: TFunction, id: string, base?: BaseFile): string {
  if (id.startsWith("file.")) {
    const key = `bases.fields.${id.slice("file.".length)}`;
    const text = t(key, { defaultValue: "" });
    if (text) return text;
  }
  return baseColumn(id, base).label;
}
