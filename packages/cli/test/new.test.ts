/**
 * `openrupiv new` — full-tree scaffold against a real temp dir with real
 * git: file contents per the phase-1 contract (Compose stack, Dex config,
 * DEV-ONLY markers), the signed initial commit, determinism, and the
 * environment-error exit code (4) on every failure path.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runNew } from "../src/commands/new";
import { EXIT_ENVIRONMENT, EXIT_OK } from "../src/errors";
import type { RunGit } from "../src/git";
import { makeRunGit } from "../src/git";
import {
  DEV_OIDC_CLIENT_ID,
  DEV_OIDC_CLIENT_SECRET,
  DEV_USER_EMAIL,
  DEV_USER_PASSWORD_BCRYPT,
  DEX_IMAGE,
  POSTGRES_IMAGE,
  workspaceFiles,
} from "../src/workspace-files";
import { gitOut, gitTestEnv, makeDeps, makeTmpDir, REPO_ROOT } from "./helpers";

let tmp: string;

beforeEach(async () => {
  tmp = await makeTmpDir();
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function read(ws: string, rel: string): string {
  return readFileSync(path.join(ws, rel), "utf8");
}

describe("openrupiv new — scaffold", () => {
  it("creates the full workspace tree with a signed initial commit on main", async () => {
    const { deps, out } = makeDeps(tmp);
    const code = await runNew("my-workspace", deps);
    expect(code).toBe(EXIT_OK);

    const ws = path.join(tmp, "my-workspace");
    for (const rel of [
      "openrupiv.yaml",
      "README.md",
      ".gitignore",
      ".env",
      "docker-compose.yaml",
      "dex/config.yaml",
    ]) {
      expect(existsSync(path.join(ws, rel)), `${rel} should exist`).toBe(true);
    }

    // git: branch main, exactly one commit, DCO sign-off, .env untracked.
    expect(await gitOut(ws, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(await gitOut(ws, "rev-list", "--count", "HEAD")).toBe("1");
    const body = await gitOut(ws, "log", "-1", "--format=%B");
    expect(body).toContain("chore(my-workspace): scaffold openrupiv workspace");
    expect(body).toContain("Signed-off-by: Test User <test@example.com>");
    const tracked = (await gitOut(ws, "ls-files")).split("\n").sort();
    expect(tracked).toEqual([
      ".gitignore",
      "README.md",
      "dex/config.yaml",
      "docker-compose.yaml",
      "openrupiv.yaml",
    ]);
    expect(tracked).not.toContain(".env");
    expect(await gitOut(ws, "status", "--porcelain")).toBe("");

    // Next steps are printed for humans.
    const stdout = out.text();
    expect(stdout).toContain("openrupiv generate");
    expect(stdout).toContain("docker compose up");
  });

  it("openrupiv.yaml is the contract placeholder ({ specVersion: '0.1', app: null })", async () => {
    const { deps } = makeDeps(tmp);
    await runNew("ws", deps);
    const config = parseYaml(read(path.join(tmp, "ws"), "openrupiv.yaml")) as Record<
      string,
      unknown
    >;
    expect(config).toEqual({ specVersion: "0.1", app: null });
  });

  it("generates SESSION_SECRET into .env (gitignored) along with OPENRUPIV_REPO", async () => {
    const { deps } = makeDeps(tmp, {
      randomBytes: (size) => Buffer.alloc(size, 0xab),
    });
    await runNew("ws", deps);
    const env = read(path.join(tmp, "ws"), ".env");
    expect(env).toContain(`SESSION_SECRET=${"ab".repeat(32)}`);
    expect(env).toContain(`OPENRUPIV_REPO=${REPO_ROOT}`);
    expect(read(path.join(tmp, "ws"), ".gitignore")).toContain(".env");
  });

  it("is deterministic: same inputs produce byte-identical files", async () => {
    const fixedRandom = (size: number) => Buffer.alloc(size, 0x42);
    // Same workspace name in two different roots — every byte must match.
    await mkdir(path.join(tmp, "a"));
    await mkdir(path.join(tmp, "b"));
    const a = makeDeps(path.join(tmp, "a"), { randomBytes: fixedRandom });
    await runNew("ws", a.deps);
    const b = makeDeps(path.join(tmp, "b"), { randomBytes: fixedRandom });
    await runNew("ws", b.deps);

    for (const rel of [
      "openrupiv.yaml",
      ".gitignore",
      ".env",
      "README.md",
      "docker-compose.yaml",
      "dex/config.yaml",
    ]) {
      expect(read(path.join(tmp, "a", "ws"), rel)).toBe(read(path.join(tmp, "b", "ws"), rel));
    }
    const files1 = workspaceFiles({ name: "x", sessionSecret: "s".repeat(64), sandboxToken: "s".repeat(64), repoRoot: "/r" });
    const files2 = workspaceFiles({ name: "x", sessionSecret: "s".repeat(64), sandboxToken: "s".repeat(64), repoRoot: "/r" });
    expect(files1).toEqual(files2);
    expect(files1.map((f) => f.path)).toEqual([...files1.map((f) => f.path)].sort());
  });

  it("generates a sandbox Compose service and SANDBOX_TOKEN, on an internal network with no published ports", async () => {
    const { deps } = makeDeps(tmp);
    const code = await runNew("my-workspace", deps);
    expect(code).toBe(EXIT_OK);

    const ws = path.join(tmp, "my-workspace");
    const compose = parseYaml(read(ws, "docker-compose.yaml")) as {
      services: Record<
        string,
        {
          networks?: string[] | Record<string, unknown>;
          ports?: string[];
          read_only?: boolean;
          tmpfs?: string[];
          cap_drop?: string[];
        }
      >;
      networks?: Record<string, { internal?: boolean }>;
    };
    expect(compose.services["sandbox"]).toBeDefined();
    expect(compose.services["sandbox"]?.ports).toBeUndefined();
    expect(compose.networks?.["sandbox-internal"]?.internal).toBe(true);

    // /workspaces must be a writable tmpfs even though the rest of the
    // sandbox's filesystem is read-only — per-run workspace directories
    // (createWorkspace) and the boot-canary's workspace dir are created
    // at runtime and would otherwise hit EROFS.
    expect(compose.services["sandbox"]?.read_only).toBe(true);
    expect(compose.services["sandbox"]?.tmpfs).toEqual(
      expect.arrayContaining(["/tmp", "/workspaces:mode=1777"]),
    );
    // Runs non-root (Dockerfile USER 10001) with every Linux capability
    // dropped: bwrap needs none of the container's caps — it maps its single
    // uid and acquires a full cap set inside the jail's own userns.
    expect(compose.services["sandbox"]?.cap_drop).toEqual(["ALL"]);

    const env = read(ws, ".env");
    expect(env).toMatch(/SANDBOX_TOKEN=[0-9a-f]{32,}/);
  });
});

describe("openrupiv new — docker-compose.yaml per contract", () => {
  interface ComposeDoc {
    services: Record<
      string,
      {
        image?: string;
        command?: string[];
        build?: { context: string; dockerfile: string };
        environment?: Record<string, string>;
        volumes?: string[];
        ports?: string[];
        healthcheck?: { test: string[] };
        depends_on?: Record<string, { condition: string }>;
      }
    >;
    volumes: Record<string, unknown>;
  }

  async function compose(): Promise<{ doc: ComposeDoc; raw: string }> {
    const { deps } = makeDeps(tmp);
    await runNew("ws", deps);
    const raw = read(path.join(tmp, "ws"), "docker-compose.yaml");
    return { doc: parseYaml(raw) as ComposeDoc, raw };
  }

  it("postgres:16 with volume and healthcheck", async () => {
    const { doc } = await compose();
    const postgres = doc.services["postgres"];
    expect(postgres?.image).toBe(POSTGRES_IMAGE);
    expect(postgres?.volumes).toEqual(["pgdata:/var/lib/postgresql/data"]);
    expect(postgres?.healthcheck?.test.join(" ")).toContain("pg_isready");
    expect(doc.volumes).toHaveProperty("pgdata");
  });

  it("dex service with mounted config and healthcheck", async () => {
    const { doc } = await compose();
    const dex = doc.services["dex"];
    expect(dex?.image).toBe(DEX_IMAGE);
    expect(dex?.command).toEqual(["dex", "serve", "/etc/dex/config.yaml"]);
    expect(dex?.volumes).toEqual(["./dex/config.yaml:/etc/dex/config.yaml:ro"]);
    expect(dex?.ports).toEqual(["5556:5556"]);
    expect(dex?.healthcheck?.test.join(" ")).toContain("healthz");
  });

  it("runtime is built from the monorepo checkout with the contract environment", async () => {
    const { doc } = await compose();
    const runtime = doc.services["runtime"];
    expect(runtime?.build?.dockerfile).toBe("packages/runtime/Dockerfile");
    expect(runtime?.build?.context).toContain("OPENRUPIV_REPO");
    expect(runtime?.environment).toMatchObject({
      DATABASE_URL: "postgres://openrupiv:openrupiv-dev-password@postgres:5432/openrupiv",
      OIDC_ISSUER: "http://dex:5556",
      OIDC_CLIENT_ID: DEV_OIDC_CLIENT_ID,
      OIDC_CLIENT_SECRET: DEV_OIDC_CLIENT_SECRET,
      OPENRUPIV_DEV_MODE: "true",
      APP_DIR: "/app-dir",
      BASE_URL: "http://localhost:3000",
      PORT: "3000",
      SANDBOX_URL: "http://sandbox:8443",
    });
    expect(runtime?.environment?.["SESSION_SECRET"]).toContain("SESSION_SECRET");
    // The runtime reaches the sandbox sidecar with the same generated token.
    expect(runtime?.environment?.["SANDBOX_TOKEN"]).toContain("SANDBOX_TOKEN");
    expect(runtime?.volumes).toEqual(["./app:/app-dir:ro"]);
    expect(runtime?.ports).toEqual(["3000:3000"]);
    expect(runtime?.depends_on).toEqual({
      postgres: { condition: "service_healthy" },
      dex: { condition: "service_healthy" },
      sandbox: { condition: "service_healthy" },
    });
  });

  it("carries conspicuous DEV-ONLY warnings", async () => {
    const { raw } = await compose();
    expect(raw).toContain("DEV ONLY");
    expect(raw).toContain("DO NOT DEPLOY");
  });
});

describe("openrupiv new — dex/config.yaml per contract", () => {
  interface DexDoc {
    issuer: string;
    storage: { type: string };
    web: { http: string };
    oauth2: { skipApprovalScreen: boolean };
    staticClients: { id: string; secret: string; redirectURIs: string[] }[];
    enablePasswordDB: boolean;
    staticPasswords: { email: string; hash: string; username: string; userID: string }[];
  }

  it("declares the static client, dev user with bcrypt hash, and DEV-ONLY markers", async () => {
    const { deps } = makeDeps(tmp);
    await runNew("ws", deps);
    const raw = read(path.join(tmp, "ws"), "dex/config.yaml");
    const doc = parseYaml(raw) as DexDoc;

    expect(doc.issuer).toBe("http://dex:5556");
    expect(doc.storage.type).toBe("memory");
    expect(doc.web.http).toBe("0.0.0.0:5556");
    expect(doc.oauth2.skipApprovalScreen).toBe(true);

    const client = doc.staticClients[0];
    expect(client?.id).toBe(DEV_OIDC_CLIENT_ID);
    expect(client?.secret).toBe(DEV_OIDC_CLIENT_SECRET);
    expect(client?.redirectURIs).toEqual(["http://localhost:3000/auth/callback"]);

    expect(doc.enablePasswordDB).toBe(true);
    const user = doc.staticPasswords[0];
    expect(user?.email).toBe(DEV_USER_EMAIL);
    expect(user?.hash).toBe(DEV_USER_PASSWORD_BCRYPT);
    expect(user?.hash).toMatch(/^\$2a\$10\$/);
    expect(user?.username).toBe("dev");
    expect(user?.userID).toBeTruthy();

    expect(raw).toContain("DEV ONLY");
  });

  it("README quickstart covers the whole <10-minute path honestly", async () => {
    const { deps } = makeDeps(tmp);
    await runNew("ws", deps);
    const readme = read(path.join(tmp, "ws"), "README.md");
    for (const needle of [
      "ANTHROPIC_API_KEY",
      "docker compose up",
      "dev@example.com",
      "dev-password",
      "/etc/hosts",
      "OPENRUPIV_DEV_MODE",
      "http://localhost:3000",
    ]) {
      expect(readme, `README should mention ${needle}`).toContain(needle);
    }
  });
});

describe("openrupiv new — failure paths (exit 4, machine-readable)", () => {
  it("rejects a non-kebab-case name", async () => {
    const { deps, err } = makeDeps(tmp);
    const code = await runNew("Bad_Name", deps);
    expect(code).toBe(EXIT_ENVIRONMENT);
    expect(err.text()).toContain("ERR_BAD_NAME");
    expect(existsSync(path.join(tmp, "Bad_Name"))).toBe(false);
  });

  it("refuses to touch an existing directory", async () => {
    await mkdir(path.join(tmp, "taken"));
    const { deps, err } = makeDeps(tmp);
    const code = await runNew("taken", deps);
    expect(code).toBe(EXIT_ENVIRONMENT);
    expect(err.text()).toContain("ERR_WORKSPACE_EXISTS");
  });

  it("maps a git failure to exit 4 and removes the half-created workspace", async () => {
    const env = gitTestEnv();
    const real = makeRunGit(env);
    const failingCommit: RunGit = async (args, opts) => {
      if (args[0] === "commit") {
        return {
          code: 128,
          stdout: "",
          stderr: "fatal: unable to auto-detect email address",
        };
      }
      return real(args, opts);
    };
    const { deps, err } = makeDeps(tmp, { env, runGit: failingCommit });
    const code = await runNew("ws", deps);
    expect(code).toBe(EXIT_ENVIRONMENT);
    expect(err.text()).toContain("ERR_GIT");
    expect(err.text()).toContain("auto-detect email address");
    expect(existsSync(path.join(tmp, "ws"))).toBe(false);
  });
});
