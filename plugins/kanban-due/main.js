// Extends the kanban board: a badge with each card's due date. It needs no folder access of its
// own, the board hands it the properties of the cards it shows.
//
// The date comes from the "due" property (YYYY-MM-DD, optionally followed by a time). A card is
// "soon" when it is due within SOON_DAYS days.

const DAY = 24 * 60 * 60 * 1000;
const SOON_DAYS = 3;

export default function activate(palimvo) {
  palimvo.extensions.contribute("kanban", "card-badge", ({ cards }) =>
    badges(palimvo, cards, new Date()),
  );
}

/** Badges for the cards that have a due date; `now` is a parameter so tests can fix the day. */
export function badges(palimvo, cards, now) {
  const today = startOfDay(now);
  const out = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const raw = card && card.properties ? card.properties.due : undefined;
    const value = Array.isArray(raw) ? raw[0] : raw;
    const date = typeof value === "string" ? parseDate(value) : null;
    if (!date) continue;
    const days = Math.round((date - today) / DAY);
    const key = days < 0 ? "overdue" : days === 0 ? "today" : days === 1 ? "tomorrow" : "inDays";
    out.push({
      path: card.path,
      text: palimvo.i18n.t(key, { days: Math.abs(days) }),
      tone: days < 0 ? "danger" : days <= SOON_DAYS ? "warning" : "muted",
      title: palimvo.i18n.t("dueOn", { date: value }),
    });
  }
  return out;
}

export function parseDate(value) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value.trim());
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // new Date rolls 2026-02-31 over into March; a date that moved is not a date.
  if (date.getMonth() !== Number(m[2]) - 1) return null;
  return date.getTime();
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
