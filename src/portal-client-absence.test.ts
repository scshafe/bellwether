import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/** The SPA half of the ADR-0023 discipline: prove the credential surface is
 *  absent from what actually ships, not merely unreferenced. These read the
 *  client source and the built bundle from disk, so a login form cannot creep
 *  back in through a component the server tests never see. */

const repoRoot = new URL("../", import.meta.url);

const credentialMarkers = [
  '"/auth/session"',
  "/auth/session",
  'type="password"',
  "current-password",
  "createSession",
  "setPassword",
  "setUsername",
  "TRUSTED_PROXY_TOKEN"
];

async function readClientSources(): Promise<Array<{ path: string; source: string }>> {
  const roots = [new URL("client/src/", repoRoot), new URL("client/src/store/", repoRoot)];
  const files: Array<{ path: string; source: string }> = [];

  for (const root of roots) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(tsx?|css)$/u.test(entry.name)) {
        continue;
      }

      const url = new URL(entry.name, root);
      files.push({ path: fileURLToPath(url), source: await readFile(url, "utf8") });
    }
  }

  return files;
}

describe("the deleted SPA login form", () => {
  it("leaves no credential input anywhere in the client source", async () => {
    const files = await readClientSources();

    assert.ok(files.length > 5, "expected to have read the client source");

    for (const file of files) {
      for (const marker of credentialMarkers) {
        assert.equal(file.source.includes(marker), false, `${file.path} still contains ${marker}`);
      }

      assert.equal(/<input[^>]*type="password"/u.test(file.source), false, `${file.path} still renders a password input`);
      assert.equal(/\bpassword\b/iu.test(file.source), false, `${file.path} still mentions a password`);
    }
  });

  it("posts to no login route and sends no Bearer token", async () => {
    for (const file of await readClientSources()) {
      assert.equal(file.source.includes("Bearer"), false, `${file.path} still sends a Bearer token`);
      assert.equal(/fetch\(\s*["'`]\/auth\//u.test(file.source), false, `${file.path} still calls an /auth route`);
    }
  });

  it("ships a bundle with no login form in it", async () => {
    // The built artifact is what a browser receives; assert on that, not only
    // on the source it came from.
    const assetsDir = new URL("client/dist/assets/", repoRoot);
    let bundles: string[];

    try {
      bundles = (await readdir(assetsDir)).filter((name) => name.endsWith(".js"));
    } catch {
      assert.fail("client/dist/assets is missing — run `npm run build:client` before the test suite");
    }

    assert.ok(bundles.length > 0, "expected at least one built client bundle");

    for (const name of bundles) {
      const bundle = await readFile(new URL(name, assetsDir), "utf8");

      // React's own input-type table contains the word "password", so the
      // markers here are ones only this app's deleted UI could have produced.
      for (const marker of ['type:"password"', "current-password", "/auth/session", "Open Portal", "in-memory-session"]) {
        assert.equal(bundle.includes(marker), false, `${name} still ships ${marker}`);
      }
    }
  });
});
