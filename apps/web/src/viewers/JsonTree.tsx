import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/index.ts";

/** Children drawn at once for a big array or object; the rest follow on request. */
const PAGE = 100;
/** Levels opened when the tree first appears. */
const OPEN_DEPTH = 2;

function describe(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).length}}`;
  return "";
}

function Leaf({ value }: { value: unknown }) {
  if (typeof value === "string")
    return <span className="json-string">{JSON.stringify(value)}</span>;
  if (typeof value === "number") return <span className="json-number">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="json-bool">{String(value)}</span>;
  return <span className="json-null">null</span>;
}

function Node({ name, value, depth }: { name: string | null; value: unknown; depth: number }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(PAGE);
  const branch = value !== null && typeof value === "object";
  const label = name === null ? null : <span className="json-key">{name}</span>;
  if (!branch) {
    return (
      <div className="json-row">
        {label}
        {label && ": "}
        <Leaf value={value} />
      </div>
    );
  }
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  return (
    <details className="json-branch" open={depth < OPEN_DEPTH}>
      <summary>
        {label}
        {label && ": "}
        <span className="json-count">{describe(value)}</span>
      </summary>
      <div className="json-children">
        {entries.slice(0, shown).map(([key, child]) => (
          <Node key={key} name={key} value={child} depth={depth + 1} />
        ))}
        {entries.length > shown && (
          <Button variant="ghost" onClick={() => setShown(shown + PAGE)}>
            {t("viewers.showMore", { count: entries.length - shown })}
          </Button>
        )}
      </div>
    </details>
  );
}

/** A parsed JSON value as a tree whose branches open and close. */
export function JsonTree({ value }: { value: unknown }) {
  return (
    <div className="json-tree" role="tree" aria-label="JSON">
      <Node name={null} value={value} depth={0} />
    </div>
  );
}
