import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { searchPeople, type PersonHit } from "../api/admin.ts";

/** A search box that finds people by name; picking one calls `onPick`. */
export function PersonPicker({
  vault,
  label,
  onPick,
}: {
  vault: string;
  label: string;
  onPick: (person: PersonHit) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PersonHit[]>([]);

  useEffect(() => {
    if (query.trim() === "") {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchPeople(vault, query.trim(), { signal: controller.signal }).then(
        (found) => {
          if (!controller.signal.aborted) setHits(found);
        },
        () => {
          if (!controller.signal.aborted) setHits([]);
        },
      );
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [vault, query]);

  return (
    <div className="field person-picker">
      <label>
        {label}
        <input
          className="input"
          type="search"
          value={query}
          placeholder={t("permissions.searchPeople")}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {query.trim() !== "" && (
        <ul className="rows picker-hits" aria-label={t("permissions.peopleFound")}>
          {hits.length === 0 && <li className="muted">{t("permissions.nobodyFound")}</li>}
          {hits.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="picker-hit"
                onClick={() => {
                  onPick(p);
                  setQuery("");
                }}
              >
                <strong>{p.displayName}</strong> <span className="muted">@{p.username}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
