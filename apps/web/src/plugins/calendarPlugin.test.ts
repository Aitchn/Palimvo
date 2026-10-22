import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The official calendar plugin (plugins/calendar) against a fake `palimvo` over an in-memory
// vault: the pure date helpers, then the drawn calendar with clicks and drag and drop.

interface Calendar {
  default: (palimvo: unknown) => void;
  mount: (
    palimvo: unknown,
    el: HTMLElement,
    options?: Record<string, unknown>,
    now?: Date,
  ) => () => void;
  normalizeDate: (v: string) => string | null;
  readProperty: (text: string, field: string) => string | undefined;
  dayOf: (path: string, text: string, field: string) => string | null;
  setDay: (text: string, field: string, day: string) => string;
  newNoteText: (template: string | null, field: string, day: string) => string;
  newNotePath: (folder: string, day: string) => string;
  monthGrid: (y: number, m: number, weekStart: number) => Array<{ key: string; other: boolean }>;
  weekGrid: (a: Date, weekStart: number) => Array<{ key: string }>;
  weekStartOf: (locale: string) => number;
  parseBlock: (source: string) => Record<string, string>;
}

const file = path.resolve(process.cwd(), "../../plugins/calendar/main.js");
const cal = (await import(/* @vite-ignore */ file)) as Calendar;

describe("calendar helpers", () => {
  it("accepts real dates only and ignores a time", () => {
    expect(cal.normalizeDate("2026-03-14")).toBe("2026-03-14");
    expect(cal.normalizeDate("2026-3-4T10:00")).toBe("2026-03-04");
    expect(cal.normalizeDate("2026-02-30")).toBeNull();
    expect(cal.normalizeDate("March 14")).toBeNull();
  });

  it("finds a note's day from the property, then from the file name", () => {
    expect(cal.dayOf("a.md", "---\ndate: 2026-03-14\n---\nx", "date")).toBe("2026-03-14");
    expect(cal.dayOf("a.md", '---\ndue: "2026-04-01"\n---', "due")).toBe("2026-04-01");
    expect(cal.dayOf("Daily/2026-05-06.md", "no front matter", "date")).toBe("2026-05-06");
    expect(cal.dayOf("Daily/2026-05-06 Trip.md", "---\ndate: 2026-05-07\n---", "date")).toBe(
      "2026-05-07",
    );
    expect(cal.dayOf("plain.md", "---\ndate: soon\n---", "date")).toBeNull();
  });

  it("sets the day, keeping the time, quotes and the other lines", () => {
    expect(cal.setDay("---\ndate: 2026-03-14\ntags: [a]\n---\nbody", "date", "2026-03-20")).toBe(
      "---\ndate: 2026-03-20\ntags: [a]\n---\nbody",
    );
    expect(cal.setDay("---\ndate: 2026-03-14T10:30\n---\n", "date", "2026-03-20")).toBe(
      "---\ndate: 2026-03-20T10:30\n---\n",
    );
    expect(cal.setDay('---\ndate: "2026-03-14"\n---\n', "date", "2026-03-20")).toBe(
      '---\ndate: "2026-03-20"\n---\n',
    );
    expect(cal.setDay("---\ntags: [a]\n---\nbody", "date", "2026-03-20")).toBe(
      "---\ntags: [a]\ndate: 2026-03-20\n---\nbody",
    );
    expect(cal.setDay("just text\n", "date", "2026-03-20")).toBe(
      "---\ndate: 2026-03-20\n---\n\njust text\n",
    );
    expect(cal.setDay("---\r\ndate: 2026-03-14\r\n---\r\nx", "date", "2026-03-20")).toBe(
      "---\r\ndate: 2026-03-20\r\n---\r\nx",
    );
    expect(cal.setDay("---\ndate:\n  - 2026-03-14\nz: 1\n---\n", "date", "2026-03-20")).toBe(
      "---\ndate: 2026-03-20\nz: 1\n---\n",
    );
  });

  it("builds new notes from a template or a default", () => {
    expect(cal.newNoteText(null, "date", "2026-03-14")).toBe(
      "---\ndate: 2026-03-14\n---\n\n# 2026-03-14\n",
    );
    expect(cal.newNoteText("# {{title}}\n", "date", "2026-03-14")).toBe(
      "---\ndate: 2026-03-14\n---\n\n# 2026-03-14\n",
    );
    expect(cal.newNoteText("---\ndate: {{date}}\n---\nx", "date", "2026-03-14")).toBe(
      "---\ndate: 2026-03-14\n---\nx",
    );
    expect(cal.newNoteText("---\ndate: 2025-01-01\n---\nx", "date", "2026-03-14")).toBe(
      "---\ndate: 2026-03-14\n---\nx",
    );
    expect(cal.newNotePath("", "2026-03-14")).toBe("2026-03-14.md");
    expect(cal.newNotePath("/Daily/", "2026-03-14")).toBe("Daily/2026-03-14.md");
  });

  it("lays out six weeks for a month and seven days for a week", () => {
    const sunday = cal.monthGrid(2026, 2, 0);
    expect(sunday).toHaveLength(42);
    expect(sunday[0]?.key).toBe("2026-03-01");
    const monday = cal.monthGrid(2026, 2, 1);
    expect(monday[0]?.key).toBe("2026-02-23");
    expect(monday[0]?.other).toBe(true);
    const week = cal.weekGrid(new Date(2026, 2, 18), 1);
    expect(week.map((d) => d.key)).toEqual([
      "2026-03-16",
      "2026-03-17",
      "2026-03-18",
      "2026-03-19",
      "2026-03-20",
      "2026-03-21",
      "2026-03-22",
    ]);
  });

  it("starts the week on Monday in zh-CN only", () => {
    expect(cal.weekStartOf("zh-CN")).toBe(1);
    expect(cal.weekStartOf("zh-TW")).toBe(0);
    expect(cal.weekStartOf("en")).toBe(0);
  });

  it("reads block options", () => {
    expect(cal.parseBlock("field: due\nview: week\nfolder: Plans")).toEqual({
      field: "due",
      view: "week",
      folder: "Plans",
      template: "",
    });
    expect(cal.parseBlock("")).toMatchObject({ field: "date", view: "month" });
  });
});

function fakePalimvo(files: Map<string, string>, locale = "en") {
  const strings: Record<string, string> = {
    month: "Month",
    week: "Week",
    today: "Today",
    count: "{count} dated notes",
    add: "New note on {date}",
    more: "+{count} more",
  };
  const opened: string[] = [];
  const writes: Array<[string, string]> = [];
  const notices: string[] = [];
  const handlers = new Map<string, () => void>();
  let locale_ = locale;
  const palimvo = {
    i18n: {
      get locale() {
        return locale_;
      },
      t: (key: string, params: Record<string, string | number> = {}) =>
        (strings[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(params[k])),
    },
    events: {
      on: (event: string, handler: () => void) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    },
    vault: {
      list: () =>
        Promise.resolve(
          [...files.keys()].map((path) => ({ path, name: path, kind: "file" as const })),
        ),
      read: (path: string) => {
        const text = files.get(path);
        return text === undefined
          ? Promise.reject(Object.assign(new Error("no"), { code: "not_found" }))
          : Promise.resolve(text);
      },
      write: (path: string, content: string) => {
        files.set(path, content);
        writes.push([path, content]);
        return Promise.resolve({ revision: "r" });
      },
    },
    ui: {
      openFile: (path: string) => opened.push(path),
      showNotice: (message: string) => notices.push(message),
    },
  };
  return {
    palimvo,
    opened,
    writes,
    notices,
    fire: () => handlers.get("file:changed")?.(),
    setLocale: (next: string) => {
      locale_ = next;
      handlers.get("locale:changed")?.();
    },
  };
}

const NOW = new Date(2026, 2, 18);
const flush = () => vi.waitFor(() => undefined);

describe("calendar view", () => {
  let el: HTMLElement;
  beforeEach(() => {
    el = document.createElement("div");
    document.body.append(el);
  });
  afterEach(() => el.remove());

  function files() {
    return new Map([
      ["2026-03-05 Trip.md", "no props"],
      ["Plan.md", "---\ndate: 2026-03-18\n---\nx"],
      ["Other.md", "---\ndate: 2026-04-02\n---\nx"],
      ["Undated.md", "hi"],
    ]);
  }
  const dayCell = (day: string) => el.querySelector<HTMLElement>(`[data-day="${day}"]`)!;

  it("puts notes on their days (property and file name) and counts them", async () => {
    const { palimvo } = fakePalimvo(files());
    cal.mount(palimvo, el, {}, NOW);
    await vi.waitFor(() =>
      expect(el.querySelector(".cal-count")?.textContent).toBe("3 dated notes"),
    );
    expect(dayCell("2026-03-05").textContent).toContain("2026-03-05 Trip");
    expect(dayCell("2026-03-18").textContent).toContain("Plan");
    expect(dayCell("2026-04-02")?.textContent ?? "").toContain("Other");
    expect(dayCell("2026-03-18").classList.contains("today")).toBe(true);
  });

  it("switches to the week view and back", async () => {
    const { palimvo } = fakePalimvo(files());
    cal.mount(palimvo, el, {}, NOW);
    await flush();
    [...el.querySelectorAll("button")].find((b) => b.textContent === "Week")!.click();
    expect(el.querySelectorAll(".cal-day")).toHaveLength(7);
    [...el.querySelectorAll("button")].find((b) => b.textContent === "Month")!.click();
    expect(el.querySelectorAll(".cal-day")).toHaveLength(42);
  });

  it("creates a note for the clicked day in the chosen folder and opens it", async () => {
    const f = files();
    const { palimvo, opened, writes } = fakePalimvo(f);
    cal.mount(palimvo, el, { folder: "Daily" }, NOW);
    await flush();
    dayCell("2026-03-20").querySelector<HTMLButtonElement>(".cal-add")!.click();
    await vi.waitFor(() => expect(opened).toEqual(["Daily/2026-03-20.md"]));
    expect(writes).toEqual([
      ["Daily/2026-03-20.md", "---\ndate: 2026-03-20\n---\n\n# 2026-03-20\n"],
    ]);
  });

  it("opens an existing note of that day instead of overwriting it", async () => {
    const f = files();
    f.set("2026-03-20.md", "mine");
    const { palimvo, opened, writes } = fakePalimvo(f);
    cal.mount(palimvo, el, {}, NOW);
    await flush();
    dayCell("2026-03-20").querySelector<HTMLButtonElement>(".cal-add")!.click();
    await vi.waitFor(() => expect(opened).toEqual(["2026-03-20.md"]));
    expect(writes).toEqual([]);
    expect(f.get("2026-03-20.md")).toBe("mine");
  });

  it("uses the template and says so when it is missing", async () => {
    const f = files();
    f.set("Templates/Day.md", "# {{date}}\n\nNotes:\n");
    const { palimvo, writes } = fakePalimvo(f);
    cal.mount(palimvo, el, { template: "Templates/Day.md" }, NOW);
    await flush();
    dayCell("2026-03-21").querySelector<HTMLButtonElement>(".cal-add")!.click();
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.[1]).toBe("---\ndate: 2026-03-21\n---\n\n# 2026-03-21\n\nNotes:\n");

    cal.mount(palimvo, el, { template: "Templates/Nope.md" }, NOW);
    await flush();
    dayCell("2026-03-22").querySelector<HTMLButtonElement>(".cal-add")!.click();
    await vi.waitFor(() => expect(el.querySelector(".cal-msg.error")).not.toBeNull());
    expect(writes).toHaveLength(1);
  });

  it("dragging a note onto another day rewrites its date property", async () => {
    const f = files();
    const { palimvo, writes } = fakePalimvo(f);
    cal.mount(palimvo, el, {}, NOW);
    await vi.waitFor(() => expect(dayCell("2026-03-18").textContent).toContain("Plan"));
    const dt = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => dt.set(k, v),
      getData: (k: string) => dt.get(k) ?? "",
      effectAllowed: "",
      dropEffect: "",
    };
    const drag = (type: string, target: Element) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { dataTransfer });
      target.dispatchEvent(event);
    };
    drag("dragstart", dayCell("2026-03-18").querySelector(".cal-note")!);
    drag("dragover", dayCell("2026-03-25"));
    drag("drop", dayCell("2026-03-25"));
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual(["Plan.md", "---\ndate: 2026-03-25\n---\nx"]);
    await vi.waitFor(() => expect(dayCell("2026-03-25").textContent).toContain("Plan"));
  });

  it("a note dated by its file name gets a date property when dragged", async () => {
    const f = files();
    const { palimvo, writes } = fakePalimvo(f);
    cal.mount(palimvo, el, {}, NOW);
    await vi.waitFor(() => expect(dayCell("2026-03-05").textContent).toContain("Trip"));
    const dt = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => dt.set(k, v),
      getData: (k: string) => dt.get(k) ?? "",
    };
    for (const [type, target] of [
      ["dragstart", dayCell("2026-03-05").querySelector(".cal-note")!],
      ["drop", dayCell("2026-03-09")],
    ] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { dataTransfer });
      target.dispatchEvent(event);
    }
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual(["2026-03-05 Trip.md", "---\ndate: 2026-03-09\n---\n\nno props"]);
  });

  it("starts the week on Monday for zh-CN", async () => {
    const { palimvo } = fakePalimvo(files(), "zh-CN");
    cal.mount(palimvo, el, { view: "week" }, NOW);
    await flush();
    expect(el.querySelector(".cal-day")?.getAttribute("data-day")).toBe("2026-03-16");
  });

  it("redraws in the new language, keeping the week and the first day", async () => {
    const { palimvo, setLocale } = fakePalimvo(files());
    cal.mount(palimvo, el, { view: "week" }, NOW);
    await flush();
    expect(el.querySelector(".cal-day")?.getAttribute("data-day")).toBe("2026-03-15");
    setLocale("zh-CN");
    expect(el.querySelector(".cal-day")?.getAttribute("data-day")).toBe("2026-03-16");
    expect(el.querySelectorAll(".cal-day")).toHaveLength(7);
  });

  it("reloads when a file changes and stops after cleanup", async () => {
    const f = files();
    const { palimvo, fire } = fakePalimvo(f);
    const dispose = cal.mount(palimvo, el, {}, NOW);
    await vi.waitFor(() =>
      expect(el.querySelector(".cal-count")?.textContent).toBe("3 dated notes"),
    );
    f.set("New.md", "---\ndate: 2026-03-10\n---\n");
    fire();
    await vi.waitFor(() =>
      expect(el.querySelector(".cal-count")?.textContent).toBe("4 dated notes"),
    );
    dispose();
  });
});
