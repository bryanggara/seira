import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { addedLines, blockedFolder, exemptFromGeneric, fileLines, findLeaks, privatePatterns } from "./check-local-leaks.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-local-leaks.mjs");

const labels = (lines, options) => findLeaks(lines, options).map((f) => `${f.path}:${f.line}: ${f.label}`);
const one = (text, path = "docs/setup.md") => labels([{ path, line: 1, text }]);

describe("generic rules", () => {
  it("finds a real home folder on each platform", () => {
    expect(one("run /home/alex/bin/tool")).toEqual(["docs/setup.md:1: home folder path (Linux)"]);
    expect(one('cwd: "/Users/milind/dev/app"')).toEqual(["docs/setup.md:1: home folder path (macOS)"]);
    expect(one("C:\\Users\\dana\\AppData")).toEqual(["docs/setup.md:1: home folder path (Windows)"]);
  });

  it("allows placeholders, container users and web routes", () => {
    for (const text of ["/home/node/app", "/home/you/.config", "/home/seira/.local/bin", "/Users/Shared/x", "https://x.com/home/feed/", "GET /users/42/"]) {
      expect(one(text)).toEqual([]);
    }
  });

  it("finds ls -l owner columns, private keys, provider keys and secret assignments", () => {
    expect(one("-rw-rw-r-- 1 alex alex 1198867 Nov 18 10:47 a.png")).toEqual(["docs/setup.md:1: ls -l output with owner names"]);
    expect(one("-----BEGIN OPENSSH PRIVATE KEY-----")).toEqual(["docs/setup.md:1: private key"]);
    expect(one(`token: ghp_${"a".repeat(36)}`)).toEqual(["docs/setup.md:1: provider API key"]);
    expect(one("DEPLOY_TOKEN=4f9c2a7e1b3d5f6a8c9e")).toEqual(["docs/setup.md:1: secret value in an assignment"]);
    expect(one("DEPLOY_TOKEN = config.f4c2a7e1b3d5f6a8c9e")).toEqual(["docs/setup.md:1: secret value in an assignment"]);
  });

  it("allows references to a secret", () => {
    for (const text of [
      "API_KEY=",
      "TOKEN=${TOKEN}",
      "API_KEY=<your key>",
      "SECRET='$SECRET_FROM_VAULT'",
      "childEnv.OMB_CLOUD_X_TOKEN = parentEnv.OMB_CLOUD_X_TOKEN;",
      "const DEPLOY_TOKEN = process.env.DEPLOY_TOKEN_VALUE",
    ]) {
      expect(one(text)).toEqual([]);
    }
  });

  it("skips tests, fixtures and generated files", () => {
    for (const path of ["server/config.test.ts", "electron/x.node-test.mjs", "scripts/testing/fixtures/a.json", "src/locales/source-hashes.json", "evals/a.md"]) {
      expect(exemptFromGeneric(path)).toBe(true);
      expect(one("/home/alex/x/", path)).toEqual([]);
    }
    expect(exemptFromGeneric("server/config.ts")).toBe(false);
  });

  it("turns off the generic rules on request, for a merge", () => {
    expect(labels([{ path: "a.md", line: 1, text: "/home/alex/x/" }], { generic: false })).toEqual([]);
  });
});

describe("private patterns", () => {
  const privateRules = privatePatterns("# my machine\n\nmy-laptop\nalex\\.example\\.org\n");

  it("skips comments and blank lines", () => {
    expect(privateRules).toHaveLength(2);
  });

  it("apply to every file, without case, and to the path", () => {
    const lines = [
      { path: "server/a.test.ts", line: 3, text: "ssh MY-LAPTOP" },
      { path: "notes/my-laptop.md", line: 1, text: "clean" },
      { path: "README.md", line: 9, text: "mail alex.example.org" },
    ];
    expect(labels(lines, { privateRules, generic: false })).toEqual([
      "server/a.test.ts:3: private pattern from .leakcheck.local",
      "notes/my-laptop.md:1: private pattern from .leakcheck.local",
      "README.md:9: private pattern from .leakcheck.local",
    ]);
  });
});

describe("addedLines", () => {
  it("keeps only added lines, with their new line numbers", () => {
    const diff = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -3,0 +4,2 @@ heading",
      "+first",
      "+second",
      "@@ -9 +11 @@",
      "-old",
      "+new",
      "diff --git a/gone.md b/gone.md",
      "--- a/gone.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n");
    expect(addedLines(diff)).toEqual([
      { path: "x.md", line: 4, text: "first" },
      { path: "x.md", line: 5, text: "second" },
      { path: "x.md", line: 11, text: "new" },
    ]);
  });
});

describe("fileLines", () => {
  it("numbers the lines of a text file", () => {
    expect(fileLines("a.txt", Buffer.from("x\ny"))).toEqual([
      { path: "a.txt", line: 1, text: "x" },
      { path: "a.txt", line: 2, text: "y" },
    ]);
  });

  it("checks a binary file only for home paths and private patterns", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from("tEXt /home/alex/x/ -----BEGIN RSA PRIVATE KEY-----")]);
    expect(labels(fileLines("a.png", png))).toEqual(["a.png:0: home folder path (Linux)"]);
  });
});

describe("folders for working documents", () => {
  it("names the folders that the public repository does not take", () => {
    for (const path of ["docs/superpowers/specs/a.md", "docs/specs/a.md", "docs/plans/a.md", ".tmpexp/run.sh"]) expect(blockedFolder(path)).toBeTruthy();
    for (const path of ["docs/guide.md", "docs/plans-and-pricing.md", "internal/notes.md", "src/docs/plans/a.md", "docs/verification/plans.md"]) expect(blockedFolder(path)).toBeUndefined();
  });

  describe("in a repository", () => {
    let repo;
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    const write = (path, text = "note\n") => {
      mkdirSync(join(repo, dirname(path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    };
    const check = (...args) => {
      const run = spawnSync("node", [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });
      return { code: run.status, out: run.stdout + run.stderr };
    };

    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), "leakcheck-folders-"));
      git("init", "-q", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      git("config", "commit.gpgsign", "false");
      write("README.md", "hello\n");
      write("docs/plans/old.md", "an old plan\n");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
    });
    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    it("refuses a staged new file in a blocked folder and says where it belongs", () => {
      write("docs/superpowers/specs/new.md");
      git("add", "-A");
      const { code, out } = check("--staged");
      expect(code).toBe(1);
      expect(out).toContain("docs/superpowers/specs/new.md");
      expect(out).toContain("internal/");
    });

    it("refuses a file that is renamed into a blocked folder", () => {
      write("docs/guide.md", "a guide that is long enough to be a rename\n");
      git("add", "-A");
      git("commit", "-q", "-m", "guide");
      mkdirSync(join(repo, "docs/specs"), { recursive: true });
      git("mv", "docs/guide.md", "docs/specs/guide.md");
      expect(check("--staged").code).toBe(1);
    });

    it("lets a change delete or edit a file there, and add one elsewhere", () => {
      git("rm", "-q", "docs/plans/old.md");
      write("docs/guide.md");
      git("add", "-A");
      expect(check("--staged")).toEqual({ code: 0, out: "" });
    });

    it("checks the range that a pull request holds, so skipping the hook does not help", () => {
      const base = git("rev-parse", "HEAD").trim();
      write(".tmpexp/run.mjs");
      git("add", "-A");
      git("commit", "-q", "--no-verify", "-m", "skip the hook");
      const head = git("rev-parse", "HEAD").trim();
      const { code, out } = check("--range", `${base}...${head}`);
      expect(code).toBe(1);
      expect(out).toContain(".tmpexp/run.mjs");
      expect(check("--range", `${head}...${head}`).code).toBe(0);
    });

    it("asks for a range after --range", () => {
      expect(check("--range").code).toBe(2);
    });
  });
});
