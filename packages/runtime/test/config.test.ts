import { describe, expect, it } from "vitest";
import { fixtures } from "@openrupiv/spec";
import { assertRuntimeConfig, configFromEnv, DEV_CLIENT_SECRET } from "../src/config";
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

  it("reads SANDBOX_URL + SANDBOX_TOKEN as a pair", () => {
    const config = configFromEnv({
      ...VALID_ENV,
      SANDBOX_URL: "http://sandbox:8443",
      SANDBOX_TOKEN: "test-only-sandbox-token-not-a-secret-xx",
    });
    expect(config.sandboxUrl).toBe("http://sandbox:8443");
    expect(config.sandboxToken).toBe("test-only-sandbox-token-not-a-secret-xx");
  });

  it("leaves the sandbox unset (agents off) when neither var is provided", () => {
    const config = configFromEnv(VALID_ENV);
    expect(config.sandboxUrl).toBeUndefined();
    expect(config.sandboxToken).toBeUndefined();
  });

  it("rejects a half-set sandbox pair (URL without token)", () => {
    expectRuntimeError(
      () => configFromEnv({ ...VALID_ENV, SANDBOX_URL: "http://sandbox:8443" }),
      "ERR_CONFIG",
    );
  });

  it("rejects a SANDBOX_TOKEN shorter than 32 characters", () => {
    expectRuntimeError(
      () => configFromEnv({ ...VALID_ENV, SANDBOX_URL: "http://sandbox:8443", SANDBOX_TOKEN: "short" }),
      "ERR_CONFIG",
    );
  });

  it("rejects an invalid OIDC_ISSUER url", () => {
    expectRuntimeError(
      () => configFromEnv({ ...VALID_ENV, OIDC_ISSUER: "not a url" }),
      "ERR_CONFIG",
    );
  });

  it("mcpServersConfigPath is undefined when MCP_SERVERS_CONFIG is unset", () => {
    const config = configFromEnv(VALID_ENV);
    expect(config.mcpServersConfigPath).toBeUndefined();
  });

  it("mcpServersConfigPath carries the env value through untouched", () => {
    const config = configFromEnv({
      ...VALID_ENV,
      MCP_SERVERS_CONFIG: "/etc/openrupiv/mcp-servers.json",
    });
    expect(config.mcpServersConfigPath).toBe("/etc/openrupiv/mcp-servers.json");
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

describe("assertRuntimeConfig re-checks the sandbox gate (defense in depth)", () => {
  const VALID_TOKEN = "test-only-sandbox-token-not-a-secret-xx"; // >= 32 chars

  it("accepts a valid paired sandbox config", () => {
    expect(() =>
      assertRuntimeConfig(
        testConfig({ sandboxUrl: "http://sandbox:8443", sandboxToken: VALID_TOKEN }),
      ),
    ).not.toThrow();
  });

  it("accepts a config with the sandbox unset (agents off)", () => {
    expect(() => assertRuntimeConfig(testConfig())).not.toThrow();
  });

  // The gap this closes: configFromEnv validated these, but a hand-built
  // config reaching createServer/assertRuntimeConfig directly did not — a
  // <32-char token used to fail *open*.
  it("rejects a hand-built config with a SANDBOX_TOKEN shorter than 32 chars", () => {
    expectRuntimeError(
      () => assertRuntimeConfig(testConfig({ sandboxUrl: "http://sandbox:8443", sandboxToken: "short" })),
      "ERR_CONFIG",
    );
  });

  it("rejects a hand-built half-set pair (url without token)", () => {
    expectRuntimeError(
      () => assertRuntimeConfig(testConfig({ sandboxUrl: "http://sandbox:8443" })),
      "ERR_CONFIG",
    );
  });

  it("rejects a hand-built half-set pair (token without url)", () => {
    expectRuntimeError(
      () => assertRuntimeConfig(testConfig({ sandboxToken: VALID_TOKEN })),
      "ERR_CONFIG",
    );
  });

  it("rejects a hand-built config with an invalid SANDBOX_URL", () => {
    expectRuntimeError(
      () => assertRuntimeConfig(testConfig({ sandboxUrl: "not a url", sandboxToken: VALID_TOKEN })),
      "ERR_CONFIG",
    );
  });
});
