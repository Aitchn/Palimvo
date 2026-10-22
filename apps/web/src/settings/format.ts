/** A moment (milliseconds since 1970) written for people, in the interface language. */
export function formatTime(ms: number, locale: string): string {
  return new Date(ms).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}
