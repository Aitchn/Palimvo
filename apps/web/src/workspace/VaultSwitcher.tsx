import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { listVaults } from "../api/vaults.ts";
import { useAsync } from "../app/useAsync.ts";
import { Icon, Menu, type MenuItem } from "../ui/index.ts";
import { vaultHref } from "./deepLinks.ts";

/** The vault name at the top of the sidebar; opens a menu of the other vaults. */
export function VaultSwitcher({ vault }: { vault: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const vaults = useAsync((signal) => listVaults({ signal }), "vaults");
  const items: MenuItem[] = [
    ...(vaults.status === "ready" ? vaults.data : [{ id: vault, name: vault }]).map((v) => ({
      id: `vault:${v.id}`,
      label: v.name,
      icon: "files" as const,
      checked: v.id === vault,
      onSelect: () => {
        if (v.id !== vault) navigate(vaultHref(v.id));
      },
    })),
    { id: "all", label: t("workspace.allVaults"), onSelect: () => navigate("/") },
  ];
  return (
    <Menu label={t("workspace.switchVault")} items={items} className="vault-switch">
      <span className="vault-switch-name">{vault}</span>
      <Icon name="caret" />
    </Menu>
  );
}
