import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockMatchMedia, renderWithProviders } from "../test/render.tsx";
import { initTheme } from "../theme/theme.ts";
import { uploadQueue } from "./queue.ts";
import { UploadTray } from "./UploadTray.tsx";

beforeEach(() => {
  mockMatchMedia(false);
  initTheme();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("upload panel", () => {
  it("shows nothing when nothing is uploading", async () => {
    const { container } = await renderWithProviders(<UploadTray />);
    expect(container.querySelector(".upload-tray")).toBeNull();
  });

  it("shows progress, success and failure, and lets the person stop an upload", async () => {
    await renderWithProviders(<UploadTray />);
    let first!: ReturnType<typeof uploadQueue.start>;
    let second!: ReturnType<typeof uploadQueue.start>;
    act(() => {
      first = uploadQueue.start("video.mp4", 100 * 1024 * 1024);
      second = uploadQueue.start("song.mp3", 2048);
      first.progress(25 * 1024 * 1024);
    });
    expect(screen.getByLabelText("Uploads")).toBeInTheDocument();
    expect(screen.getByText("25.0 MiB of 100.0 MiB")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "video.mp4" })).toHaveAttribute(
      "value",
      String(25 * 1024 * 1024),
    );

    act(() => second.done());
    expect(screen.getByText("Uploaded")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(screen.queryByText("song.mp3")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Cancel upload of video.mp4" }));
    expect(first.signal.aborted).toBe(true);
    act(() => first.cancelled());
    expect(screen.queryByText("video.mp4")).not.toBeInTheDocument();

    let third!: ReturnType<typeof uploadQueue.start>;
    act(() => {
      third = uploadQueue.start("big.mov", 10);
      third.fail("The server does not have room for this file.");
    });
    expect(screen.getByRole("alert")).toHaveTextContent("does not have room");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("big.mov")).not.toBeInTheDocument();
  });
});
