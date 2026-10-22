import type { ReactNode } from "react";
import { Overlay } from "./Overlay.tsx";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  footer?: ReactNode;
  children: ReactNode;
}

/** A centred modal on wide screens; below 900px the same markup becomes a bottom sheet (see ui.css). */
export function Dialog(props: Props) {
  return <Overlay kind="dialog" {...props} />;
}
