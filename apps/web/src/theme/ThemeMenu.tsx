import { useTranslation } from "react-i18next";
import { Icon, Menu, type IconName, type MenuItem } from "../ui/index.ts";
import { useTheme, type ThemePreference } from "./theme.ts";

const OPTIONS: { value: ThemePreference; icon: IconName }[] = [
  { value: "system", icon: "monitor" },
  { value: "light", icon: "sun" },
  { value: "dark", icon: "moon" },
];

/** Rail button that opens the light / dark / system choice. Its icon shows the theme in use. */
export function ThemeMenu({ placement = "right" }: { placement?: "below" | "right" }) {
  const { t } = useTranslation();
  const { theme, preference, setPreference } = useTheme();
  const items: MenuItem[] = OPTIONS.map(({ value, icon }) => ({
    id: value,
    icon,
    label: t(`theme.${value}`),
    checked: preference === value,
    onSelect: () => setPreference(value),
  }));
  return (
    <Menu label={t("theme.label")} items={items} placement={placement}>
      <Icon name={theme === "light" ? "sun" : "moon"} />
    </Menu>
  );
}
