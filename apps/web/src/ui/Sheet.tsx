import type { ReactNode } from "react";
import { Overlay, type SheetSide } from "./Overlay.tsx";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Edge the panel slides in from. */
  side?: SheetSide;
  hideTitle?: boolean;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A panel that slides in from an edge: the phone's drawers and bottom sheets. */
export function Sheet(props: Props) {
  return <Overlay kind="sheet" {...props} />;
}
