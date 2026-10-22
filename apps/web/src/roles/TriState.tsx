import { useTranslation } from "react-i18next";

export type Mode = "allow" | "inherit" | "deny";

const MODES: Mode[] = ["allow", "inherit", "deny"];

/** Allow / inherit / deny for one permission, like a Discord channel permission row. */
export function TriState({
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: Mode;
  disabled?: boolean;
  onChange: (next: Mode) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="tri-row">
      <div className="tri-text">
        <span className="tri-label">{label}</span>
        {hint && <span className="muted">{hint}</span>}
      </div>
      <div role="radiogroup" aria-label={label} className="tri">
        {MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={value === mode}
            data-mode={mode}
            disabled={disabled}
            className="tri-option"
            onClick={() => value !== mode && onChange(mode)}
          >
            {t(`permissions.mode.${mode}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
