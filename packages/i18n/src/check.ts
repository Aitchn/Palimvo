export type Messages = { [key: string]: string | Messages | string[] };

export const REVIEW_KEY = "// review";

/** Flattens nested messages into dotted keys. Keys starting with "//" are metadata. */
export function flatten(messages: Messages, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(messages)) {
    if (key.startsWith("//")) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else if (!Array.isArray(value)) Object.assign(out, flatten(value, path));
  }
  return out;
}

export function reviewKeys(messages: Messages): string[] {
  const value = messages[REVIEW_KEY];
  return Array.isArray(value) ? value : [];
}

const BRAND = "Palimvo";

const PLURAL_SELECTOR = /(?:\b(?:zero|one|two|few|many|other)|=\d+)\s*$/;

/** Names of the ICU arguments a message uses, sorted and de-duplicated. */
export function placeholders(message: string): string[] {
  const names = new Set<string>();
  const re = /\{\s*([A-Za-z_]\w*)\s*(?=[,}])/g;
  for (let m = re.exec(message); m; m = re.exec(message)) {
    if (PLURAL_SELECTOR.test(message.slice(0, m.index))) continue;
    names.add(m[1] as string);
  }
  return [...names].sort();
}

export interface Report {
  /** Keys present in the reference locale but absent here. */
  missing: string[];
  /** Keys present here but not in the reference locale. */
  extra: string[];
  /** Keys whose placeholder names differ from the reference. */
  placeholderMismatch: string[];
  /** Keys a translator flagged for review. */
  review: string[];
  /** Keys whose text is identical to the reference (possibly untranslated). */
  untranslated: string[];
}

export function compareLocale(reference: Messages, other: Messages): Report {
  const ref = flatten(reference);
  const cur = flatten(other);
  const report: Report = {
    missing: Object.keys(ref).filter((k) => !(k in cur)),
    extra: Object.keys(cur).filter((k) => !(k in ref)),
    placeholderMismatch: [],
    review: reviewKeys(other),
    untranslated: [],
  };
  for (const [key, text] of Object.entries(cur)) {
    const refText = ref[key];
    if (refText === undefined) continue;
    if (placeholders(refText).join() !== placeholders(text).join()) {
      report.placeholderMismatch.push(key);
    }
    if (text === refText && text !== BRAND && /[A-Za-z]{3}/.test(text.replace(/\{[^}]*\}/g, ""))) {
      report.untranslated.push(key);
    }
  }
  return report;
}
