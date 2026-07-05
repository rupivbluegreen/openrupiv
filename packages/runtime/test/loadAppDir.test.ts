import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixtures, type SpecError } from "@openrupiv/spec";
import { loadAppDir } from "../src/server";

async function appDir(specJson: string | undefined): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openrupiv-appdir-"));
  if (specJson !== undefined) {
    await writeFile(path.join(dir, "spec.json"), specJson, "utf8");
  }
  return dir;
}

describe("loadAppDir", () => {
  it("loads and validates a canonical app directory", async () => {
    const dir = await appDir(JSON.stringify(fixtures.vendorOnboardingSpec, null, 2));
    const spec = await loadAppDir(dir);
    expect(spec).toEqual(fixtures.vendorOnboardingSpec);
  });

  it("throws ERR_APP_DIR when spec.json is missing", async () => {
    const dir = await appDir(undefined);
    await expect(loadAppDir(dir)).rejects.toMatchObject({ code: "ERR_APP_DIR" });
  });

  it("throws ERR_APP_SPEC_INVALID for malformed JSON", async () => {
    const dir = await appDir("{ not json");
    await expect(loadAppDir(dir)).rejects.toMatchObject({
      code: "ERR_APP_SPEC_INVALID",
    });
  });

  it("throws ERR_APP_SPEC_INVALID with SpecError details for an invalid spec", async () => {
    const invalid = {
      ...fixtures.minimalSpec,
      entities: [], // schema requires at least one entity
    };
    const dir = await appDir(JSON.stringify(invalid));
    try {
      await loadAppDir(dir);
      throw new Error("expected loadAppDir to throw");
    } catch (error) {
      const details = (error as { details: SpecError[] }).details;
      expect((error as { code: string }).code).toBe("ERR_APP_SPEC_INVALID");
      expect(Array.isArray(details)).toBe(true);
      expect(details.length).toBeGreaterThan(0);
      expect(details[0]).toHaveProperty("code");
      expect(details[0]).toHaveProperty("path");
      expect(details[0]).toHaveProperty("message");
    }
  });
});
