import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon.tsx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Leading icon. */
  icon?: IconName;
  /** Shows a spinner and ignores clicks. */
  loading?: boolean;
  children?: ReactNode;
}

/** Text button, or an icon-only button when there are no children (then `aria-label` is required). */
export function Button({
  variant = "secondary",
  icon,
  loading = false,
  children,
  className,
  type = "button",
  disabled,
  ...rest
}: Props) {
  const classes = ["btn", `btn-${variant}`, children ? "" : "btn-icon", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="btn-spinner" aria-hidden="true" /> : icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
