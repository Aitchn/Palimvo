import { useState } from "react";
import { useTranslation } from "react-i18next";
import { describeError } from "../api/errors.ts";
import { Button, Dialog } from "../ui/index.ts";

interface Props {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onClose: () => void;
  /** Throw to keep the dialog open and show why. */
  onConfirm: () => Promise<void>;
}

/** A yes/no question before something that is hard to undo. */
export function Confirm({ open, title, body, confirmLabel, danger, onClose, onConfirm }: Props) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await onConfirm();
      onClose();
    } catch (error) {
      setProblem(describeError(t, error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant={danger ? "danger" : "primary"} loading={busy} onClick={() => void run()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{body}</p>
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
    </Dialog>
  );
}
