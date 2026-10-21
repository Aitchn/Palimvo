import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { describeConfig, loadConfig } from "./index.ts";

describe("loadConfig", () => {
  it("uses safe defaults", () => {
    const { config, sources } = loadConfig({}, {}, "/work");
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      trustProxy: false,
      logLevel: "info",
    });
    expect(config.dataDir).toBe(path.resolve("/work", "data"));
    expect(sources.port).toBe("default");
  });

  it("reads the environment and lets CLI flags win", () => {
    const { config, sources } = loadConfig(
      { PALIMVO_PORT: "4000", PALIMVO_HOST: "0.0.0.0", PALIMVO_TRUST_PROXY: "yes" },
      { port: "5000" },
    );
    expect(config).toMatchObject({ port: 5000, host: "0.0.0.0", trustProxy: true });
    expect(sources).toMatchObject({ port: "cli", host: "env", logLevel: "default" });
  });

  it("normalizes the public URL", () => {
    expect(loadConfig({ PALIMVO_PUBLIC_URL: "https://notes.example.com/" }).config.publicUrl).toBe(
      "https://notes.example.com",
    );
  });

  it.each([
    [{ PALIMVO_PORT: "70000" }, "PALIMVO_PORT"],
    [{ PALIMVO_PORT: "abc" }, "PALIMVO_PORT"],
    [{ PALIMVO_LOG_LEVEL: "loud" }, "PALIMVO_LOG_LEVEL"],
    [{ PALIMVO_TRUST_PROXY: "maybe" }, "PALIMVO_TRUST_PROXY"],
    [{ PALIMVO_PUBLIC_URL: "ftp://x" }, "PALIMVO_PUBLIC_URL"],
    [{ PALIMVO_PUBLIC_URL: "nope" }, "PALIMVO_PUBLIC_URL"],
  ])("rejects %j", (env, name) => {
    expect(() => loadConfig(env)).toThrow(AppError);
    expect(() => loadConfig(env)).toThrow(name);
  });

  it("rejects unknown flags", () => {
    expect(() => loadConfig({}, { prot: "1" })).toThrow("--prot");
  });

  it("describes each setting with its source", () => {
    const text = describeConfig(loadConfig({ PALIMVO_PORT: "4000" }));
    expect(text.port).toBe("4000 [env]");
    expect(text.publicUrl).toBe("(unset) [default]");
  });
});
