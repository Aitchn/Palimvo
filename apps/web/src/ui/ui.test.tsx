import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/render.tsx";
import { Button, Dialog, Menu, Sheet, Skeleton, useToast } from "./index.ts";

function DialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Settings">
        <input aria-label="first" />
        <input aria-label="second" />
      </Dialog>
    </>
  );
}

describe("Button", () => {
  it("ignores clicks while loading", async () => {
    const onClick = vi.fn();
    await renderWithProviders(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-busy", "true");
  });
});

describe("Dialog", () => {
  it("is labelled, takes focus, keeps it inside, closes on Escape and gives focus back", async () => {
    const user = userEvent.setup();
    await renderWithProviders(<DialogDemo />);
    const opener = screen.getByRole("button", { name: "open" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    // Tab wraps from the last control back to the first one.
    screen.getByLabelText("second").focus();
    screen.getByRole("button", { name: "Close" }).focus();
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("closes when the backdrop is pressed, not when the panel is", async () => {
    const user = userEvent.setup();
    await renderWithProviders(<DialogDemo />);
    await user.click(screen.getByRole("button", { name: "open" }));
    await user.click(screen.getByLabelText("first"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.mouseDown(document.querySelector(".overlay-backdrop") as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Sheet", () => {
  it("slides in from the chosen side", async () => {
    await renderWithProviders(
      <Sheet open onClose={() => {}} side="left" title="Files">
        body
      </Sheet>,
    );
    expect(screen.getByRole("dialog", { name: "Files" })).toHaveClass("sheet-left");
  });
});

describe("Menu", () => {
  const items = (onSelect: (id: string) => void) => [
    { id: "a", label: "Alpha", onSelect: () => onSelect("a") },
    { id: "b", label: "Beta", checked: true, onSelect: () => onSelect("b") },
    { id: "c", label: "Gamma", onSelect: () => onSelect("c") },
  ];

  it("opens, moves with arrow keys, selects with Enter and returns focus", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    await renderWithProviders(
      <Menu label="Theme" items={items(onSelect)}>
        x
      </Menu>,
    );
    const trigger = screen.getByRole("button", { name: "Theme" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    // The checked item starts focused.
    expect(screen.getByRole("menuitemradio", { name: "Beta" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Gamma" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes on Escape and on a click elsewhere", async () => {
    const user = userEvent.setup();
    await renderWithProviders(
      <Menu label="Theme" items={items(() => {})}>
        x
      </Menu>,
    );
    await user.click(screen.getByRole("button", { name: "Theme" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Theme" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

function ToastDemo() {
  const toast = useToast();
  return (
    <button onClick={() => toast.push({ message: "Saved", kind: "success", duration: 50 })}>
      go
    </button>
  );
}

describe("Toast", () => {
  it("announces a message, can be dismissed in the interface language, and expires", async () => {
    const user = userEvent.setup();
    await renderWithProviders(<ToastDemo />, "zh-TW");
    await user.click(screen.getByRole("button", { name: "go" }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(screen.getByRole("button", { name: "關閉通知" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Saved")).toBeNull());
    await act(async () => {});
  });

  it("uses the alert role for errors", async () => {
    function Demo() {
      const toast = useToast();
      return (
        <button onClick={() => toast.push({ message: "Nope", kind: "error", duration: 0 })}>
          go
        </button>
      );
    }
    const user = userEvent.setup();
    await renderWithProviders(<Demo />);
    await user.click(screen.getByRole("button", { name: "go" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Nope");
  });
});

describe("Skeleton", () => {
  it("says it is loading, in the interface language", async () => {
    await renderWithProviders(<Skeleton />, "zh-TW");
    expect(screen.getByRole("status")).toHaveTextContent("載入中…");
  });
});
