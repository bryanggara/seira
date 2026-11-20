// Real server, a fake Chrome profile, and a real headless Chromium as the bot's browser behind a stand-in for agent-browser.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { freemem, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { realpathSync, statSync } from "node:fs";
import { verificationServerEnvironment } from "../scripts/control-seira.ts";
import { writeFakeBrowser } from "./browser/chrome-import/testing/fake-profile.ts";
import { credentialStoreFlags } from "./browser/egress/gate.ts";
import { findChrome } from "./testing/chrome-pipe.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLI = join(ROOT, "server/testing/fake-claude-cli.ts");
const FAKE_ENGINE = join(ROOT, "server/browser/chrome-import/testing/fake-engine.mjs");
const CHROME = findChrome() ?? "";

const SESSION_VALUE = "e2e-cookie-value-3c9a71f0";
const PREFERENCE_VALUE = "e2e-cookie-value-90b2d4ee";
const OTHER_VALUE = "e2e-cookie-value-5d1e8a27";

const folders: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const folder of folders.splice(0)) await removeTempDir(folder);
});

/** Chromium as the bot's browser, and the DevTools address it opened. It starts the way the other real-Chrome suites start it
 * (no first-run work, no background network, no update check, no sync, no desktop keyring) so nothing outside the machine
 * or the desktop session can hold its start. A Chromium that exits, or that opens nothing in time, fails the test with what
 * it wrote to stderr: the old wait ignored the exit and ran out the clock with no word on why. */
async function startBrowser(root: string): Promise<string> {
  const profile = join(root, "chromium-profile");
  mkdirSync(profile, { recursive: true });
  const child = spawn(CHROME, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    ...credentialStoreFlags(), "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (chunk) => { if (stderr.length < 8_192) stderr += String(chunk); });
  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  for (;;) {
    const lines = existsSync(portFile) ? readFileSync(portFile, "utf8").split("\n") : [];
    if (lines.length >= 2) return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
    const state = child.exitCode !== null || child.signalCode !== null ? `exited with ${child.exitCode ?? child.signalCode}` : "still running";
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      throw new Error(`Chromium ${state} and had not opened its DevTools port (load ${loadavg().map((value) => value.toFixed(1)).join(" ")}, ${Math.round(freemem() / 1_048_576)} MB free):\n${stderr || "(nothing on stderr)"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// TEMPORARY DIAGNOSTIC: how long each browser takes to open its DevTools port in CI with an empty page cache.
const readText = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
const majorFaults = (pid: number | undefined) => Number(readText(`/proc/${pid}/stat`).split(") ")[1]?.split(" ")[9] ?? NaN);
async function probeLaunch(binary: string, label: string): Promise<Record<string, unknown>> {
  let dropped = "dropped";
  try { execFileSync("sudo", ["-n", "sh", "-c", "sync; echo 3 > /proc/sys/vm/drop_caches"], { stdio: "ignore" }); } catch (error) { dropped = String(error).slice(0, 80); }
  const root = mkdtempSync(join(tmpdir(), "probe-"));
  folders.push(root);
  const profile = join(root, "p");
  const started = Date.now();
  const child = spawn(binary, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    ...credentialStoreFlags(), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr!.resume();
  let ms = -1;
  let faults = NaN;
  while (Date.now() - started < 100_000) {
    faults = majorFaults(child.pid) || faults;
    if (existsSync(join(profile, "DevToolsActivePort")) && readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n").length >= 2) { ms = Date.now() - started; break; }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await waitForExit(child, { signal: "SIGTERM" });
  const real = realpathSync(binary);
  return { label, real, mb: Math.round(statSync(real).size / 1_048_576), dropped, ms, majorFaults: faults, load: loadavg().map((value) => value.toFixed(1)).join(" "), io: readText("/proc/pressure/io").split("\n")[0] };
}
beforeAll(async () => {
  if (process.platform !== "linux" || !process.env.CI || !CHROME) return;
  const report: unknown[] = [];
  report.push(await probeLaunch(CHROME, "chrome cold 1"));
  if (existsSync("/usr/bin/chromium")) report.push(await probeLaunch("/usr/bin/chromium", "chromium cold"));
  report.push(await probeLaunch(CHROME, "chrome cold 2"));
  console.log(`BROWSER COLD PROBE ${JSON.stringify(report)}`);
}, 400_000);

async function startServer(home: string, engine: string) {
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env: { ...verificationServerEnvironment(process.env, home, port), XDG_CONFIG_HOME: join(home, ".config"), OMB_AGENT_BROWSER_PATH: engine },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const output: string[] = [];
  child.stdout!.on("data", (chunk) => { output.push(String(chunk)); });
  child.stderr!.on("data", (chunk) => { output.push(String(chunk)); });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output.join("")}`);
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, { timeout: 30_000, interval: 50 }).toBe(true);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as any };
  };
  return { api, output: () => output.join("") };
}

describe.skipIf(process.platform !== "linux" || !CHROME)("importing sign-ins from Chrome", () => {
  it("copies chosen sites into a running bot browser, lists them, and signs out of them", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-chrome-import-"));
    folders.push(home);
    mkdirSync(join(home, "tmp"), { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      features: { browser: true },
      instances: { claude: { driver: "claudeAgent", displayName: "Verification fixture", config: { cli: FAKE_CLI } } },
    }));
    writeFakeBrowser(join(home, ".config", "google-chrome"), [{ name: "Person 1", cookies: [
      { hostKey: ".example.com", name: "sid", value: SESSION_VALUE },
      { hostKey: "www.example.com", name: "pref", value: PREFERENCE_VALUE },
      { hostKey: ".other.test", name: "tok", value: OTHER_VALUE },
    ] }]);

    const addressFile = join(home, "cdp-url");
    writeFileSync(addressFile, await startBrowser(home));
    const engine = join(home, "agent-browser");
    writeFileSync(engine, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_ENGINE}' '${addressFile}' "$@"\n`, { mode: 0o755 });

    const { api, output } = await startServer(home, engine);
    const bot = (await api("POST", "/api/bots", { name: "Import probe" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browser: true })).status).toBe(200);

    const profiles = await api("GET", "/api/browser-sites/import/profiles");
    expect(profiles.status).toBe(200);
    expect(profiles.body.profiles).toHaveLength(1);
    expect(profiles.body.profiles[0]).toMatchObject({ name: "Person 1" });

    const listing = await api("POST", "/api/browser-sites/import/sites", { bot: bot.id, source: profiles.body.profiles[0].id });
    expect(listing.status).toBe(200);
    expect(listing.body.sites.map((site: { site: string; cookies: number }) => [site.site, site.cookies]).sort()).toEqual([["example.com", 2], ["other.test", 1]]);

    expect((await api("GET", `/api/browser-sites?bot=${bot.id}`)).body.sites).toEqual([]);
    const imported = await api("POST", "/api/browser-sites/import", { bot: bot.id, ticket: listing.body.ticket, sites: ["example.com"] });
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ imported: { sites: 1, cookies: 2 }, running: true });

    const after = await api("GET", `/api/browser-sites?bot=${bot.id}`);
    expect(after.status).toBe(200);
    expect(after.body.sites.map((site: { site: string }) => site.site)).toEqual(["example.com"]);
    expect(after.body.sites[0].cookies).toBe(2);

    const reused = await api("POST", "/api/browser-sites/import", { bot: bot.id, ticket: listing.body.ticket, sites: ["example.com"] });
    expect(reused.status).toBe(409);

    const signedOut = await api("POST", "/api/browser-sites/sign-out", { bot: bot.id, site: "example.com" });
    expect(signedOut.status).toBe(200);
    expect(signedOut.body.sites).toEqual([]);
    expect((await api("GET", `/api/browser-sites?bot=${bot.id}`)).body.sites).toEqual([]);

    const everything = [profiles.text, listing.text, imported.text, after.text, output()].join("\n");
    for (const value of [SESSION_VALUE, PREFERENCE_VALUE, OTHER_VALUE]) expect(everything).not.toContain(value);
  }, 120_000);
});
