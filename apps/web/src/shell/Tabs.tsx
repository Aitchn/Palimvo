import { useTranslation } from "react-i18next";
import { Icon } from "../ui/index.ts";

export interface TabItem {
  id: string;
  title: string;
  /** Longer text shown as a tooltip (the full path). */
  detail?: string;
}

interface Props {
  tabs: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

/** The strip of open files above the main area. */
export function Tabs({ tabs, activeId, onSelect, onClose }: Props) {
  const { t } = useTranslation();
  return (
    <div className="tabs" role="tablist" aria-label={t("shell.tabs")}>
      {tabs.map((tab) => (
        <div key={tab.id} className="tab" data-active={tab.id === activeId || undefined}>
          <button
            type="button"
            role="tab"
            aria-selected={tab.id === activeId}
            className="tab-title"
            title={tab.detail}
            onClick={() => onSelect(tab.id)}
          >
            <Icon name="note" />
            <span>{tab.title}</span>
          </button>
          <button
            type="button"
            className="tab-close"
            aria-label={`${t("common.close")}: ${tab.title}`}
            onClick={() => onClose(tab.id)}
          >
            <Icon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}
