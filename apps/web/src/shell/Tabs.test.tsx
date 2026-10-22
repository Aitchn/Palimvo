import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/render.tsx";
import { Tabs } from "./Tabs.tsx";

describe("Tabs", () => {
  it("marks the active tab and reports selection and close", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    await renderWithProviders(
      <Tabs
        tabs={[
          { id: "a.md", title: "a.md" },
          { id: "b.md", title: "b.md" },
        ]}
        activeId="b.md"
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "a.md" })).toHaveAttribute("aria-selected", "false");
    await user.click(screen.getByRole("tab", { name: "a.md" }));
    expect(onSelect).toHaveBeenCalledWith("a.md");
    await user.click(screen.getByRole("button", { name: "Close: b.md" }));
    expect(onClose).toHaveBeenCalledWith("b.md");
  });
});
