import { describe, expect, it } from "vitest";
import { fixtures } from "@openrupiv/spec";
import { configFromEnv, DEV_CLIENT_SECRET } from "../src/config";
import { RuntimeError } from "../src/errors";
import { createServer } from "../src/server";
import { FakeDb } from "./helpers/fakeDb";
import { testConfig, unreachableOidcProvider } from "./helpers/testServer";

const VALID_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://app:pw@localhost:5432/app",
  OIDC_ISSUER: "https://idp.example.com",
  OIDC_CLIENT_ID: "my-client",
  OIDC_CLIENT_SECRET: "a-real-client-secret",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
};

function expectRuntimeError(fn: () => unknown, code: string): RuntimeError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe(code);
    return error as RuntimeError;
  }
  throw new Error(`expected RuntimeError ${code}, nothing was thrown`);
}

describe("configFromEnv", () => {
  it("builds a full config from a valid environment", () => {
    const config = configFromEnv(VALID_ENV);
    expect(config).toEqual({
      databaseUrl: "postgres://app:pw@localhost:5432/app",
      oidc: {
        issuer: "https://idp.example.com",
        clientId: "my-client",
        clientSecret: "a-real-client-secret",
        rolesClaim: "roles",
      },
      sessionSecret: "0123456789abcdef0123456789abcdef",
      baseUrl: "http://localhost:3000",
      port: 3000,
      devMode: false,
    });
  });

  it("honors PORT, BASE_URL, OIDC_ROLES_CLAIM and OPENRUPIV_DEV_MODE", () => {
    const config = configFromEnv({
      ...VALID_ENV,
      PORT: "8080",
      BASE_URL: "https://apps.example.com/",
      OIDC_ROLES_CLAIM: "groups",
      OPENRUPIV_DEV_MODE: "true",
    });
    expect(config.port).toBe(8080);
    expect(config.baseUrl).toBe("https://apps.example.com");
    expect(config.oidc.rolesClaim).toBe("groups");
    expect(config.devMode).toBe(true);
  });

  it("lists every missing variable in a single typed error", () => {
    const error = expectRuntimeError(() => configFromEnv({}), "ERR_CONFIG");
    const details = error.details as string[];
    for (const name of [
      "DATABASE_URL",
      "OIDC_ISSUER",
      "OIDC_CLIENT_ID",
      "OIDC_CLIENT_SECRET",
      "SESSION_SECRET",
    ]) {
      expect(details.some((d) => d.includes(name))).toBe(true);
    }
  });

  it("treats empty strings as missing", () => {
    expectRuntimeError(
      () => configFromEnv({ ...VALID_ENV, DATABASE_URL: "  " }),
      "ERR_CONFIG",
    );
  });

  it("rejects a SESSION_SECRET shorter than 32 characters", () => {
    const error = expectRuntimeError(
      () => configFromEnv({ ...VALID_ENV, SESSION_SECRET: "too-short" }),
      "ERR_CONFIG",
    );
    expect(error.message).toContain("SESSION_SECRET");
  });

  it("rejects a non-numeric or out-of-range PORT", () => {
    expectRuntimeError(() => configFromEnv({ ...VALID_ENV, PORT: "abc" }), "ERR_CONFIG");
    expectRuntimeError(() => configFromEnv({ ...VALID_ENV, PORT: "0" }), "ERR_CONFIG");
    expectRuntimeError(() => configFromEnv({ ...VALID_ENV, PORT: "70000" }), "ERR_CONFIG");
  });

  it("rejects an invalid OIDC_ISSUER url", () => {
    expectRuntimeError(
      () => configFromEnv({ ...VALID_ENV, OIDC_ISSUER: "not a url" }),
      "ERR_CONFIG",
    );
  });
});

describe("dev credential refusal (ADR-0002)", () => {
  it("refuses to start with the bundled dev secret outside dev mode", () => {
    const error = expectRuntimeError(
      () => configFromEnv({ ...VALID_ENV, OIDC_CLIENT_SECRET: DEV_CLIENT_SECRET }),
      "ERR_DEV_CREDENTIALS",
    );
    expect(error.message).toContain("OPENRUPIV_DEV_MODE");
  });

  it("only the exact string \"true\" enables dev mode", () => {
    for (const value of ["1", "TRUE", "yes", "True"]) {
      expectRuntimeError(
        () =>
          configFromEnv({
            ...VALID_ENV,
            OIDC_CLIENT_SECRET: DEV_CLIENT_SECRET,
            OPENRUPIV_DEV_MODE: value,
          }),
        "ERR_DEV_CREDENTIALS",
      );
    }
  });

  it("allows the dev secret when OPENRUPIV_DEV_MODE=true", () => {
    const config = configFromEnv({
      ...VALID_ENV,
      OIDC_CLIENT_SECRET: DEV_CLIENT_SECRET,
      OPENRUPIV_DEV_MODE: "true",
    });
    expect(config.devMode).toBe(true);
    expect(config.oidc.clientSecret).toBe(DEV_CLIENT_SECRET);
  });

  it("createServer re-enforces the refusal for hand-built configs", async () => {
    const config = testConfig({ devMode: false });
    config.oidc.clientSecret = DEV_CLIENT_SECRET;
    await expect(
      createServer(fixtures.minimalSpec, config, {
        db: new FakeDb(),
        oidcProvider: unreachableOidcProvider,
      }),
    ).rejects.toMatchObject({ code: "ERR_DEV_CREDENTIALS" });
  });

  it("createServer re-enforces the session secret minimum", async () => {
    const config = testConfig({ sessionSecret: "short" });
    await expect(
      createServer(fixtures.minimalSpec, config, {
        db: new FakeDb(),
        oidcProvider: unreachableOidcProvider,
      }),
    ).rejects.toMatchObject({ code: "ERR_CONFIG" });
  });
});
