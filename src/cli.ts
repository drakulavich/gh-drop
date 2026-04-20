#!/usr/bin/env bun
// gh-drop — drop images into a GitHub issue or PR from the CLI.
//
// Usage:
//   gh drop --issue 123 --image ./screenshot.png
//   gh drop --issue 123 --image ./a.png --image ./b.png --body "A: <!-- gh-drop:IMAGE:1 --> / B: <!-- gh-drop:IMAGE:2 -->"
//   gh drop auth login                 # set the github.com session cookie
//   gh drop auth status                # show current auth state
//
// Design choices (see docs/design.md for the long version):
//   * Auth for attachments: session cookie (GitHub provides no public API).
//   * Auth for everything else: the user's existing `gh` CLI login.
//   * Optional `--verify` uses Bun.WebView to screenshot the uploaded asset.

import { parseArgs } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";

import { mimeForFilename, acceptMimeMap } from "./mime.ts";
import { loadConfig, saveConfig, configPath } from "./config.ts";
import { uploadAttachment, UploadError } from "./upload.ts";
import { resolveRepo, postIssueComment, ensureGhAuth } from "./gh.ts";

const VERSION = "0.1.3";

function printUsage(): void {
  console.log(`gh-drop ${VERSION} — drop images into GitHub issues & PRs

USAGE
  gh drop --issue <N> --image <path> [--image <path> ...] [flags]
  gh drop auth <login|status|logout>
  gh drop --help

FLAGS
  --issue, -i <N>      Issue or PR number (required)
  --image, -f <path>   Image file to upload (repeatable)
  --body,  -b <text>   Comment body. Placeholders <!-- gh-drop:IMAGE:N --> are
                       replaced by the Nth uploaded image (1-indexed). If a
                       body is given without placeholders, images are appended.
  --repo,  -R <slug>   Target repo (owner/name). Defaults to the current dir.
  --host <url>         GitHub host. Default https://github.com (for GHE).
  --width <px>         Render uploaded images at this width (wraps in <img>).
  --dry-run            Upload images but don't post the comment.
  --debug              Print each upload request's status and any error body.
  --verify             After upload, open each asset URL in Bun.WebView and
                       save a screenshot to /tmp/gh-drop/ to confirm it
                       renders.
  --help, -h           Show this help.
  --version, -v        Print version.

AUTH
  Set your GitHub session cookie once:
    gh drop auth login
  It's stored at ~/.gh-drop/config.json (chmod 0600). You can also set
  GH_DROP_COOKIE / GH_DROP_HOST as environment variables.
`);
}

async function cmdAuthLogin(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  console.log(`
gh-drop needs your github.com browser session cookie to upload attachments
(GitHub does not expose attachment upload in its public API).

How to get it:
  1. Open https://github.com in your browser, signed in.
  2. Open DevTools → Application → Cookies → https://github.com
  3. Copy the value of the \`user_session\` cookie.
     (You can also paste the full Cookie header string if you prefer.)

This cookie is equivalent to your password — we store it at ${configPath()}
with mode 0600.
`);
  const cookie = (await rl.question("Paste cookie value: ")).trim();
  if (!cookie) {
    rl.close();
    throw new Error("No cookie provided.");
  }
  const normalized = cookie.includes("=") ? cookie : `user_session=${cookie}`;
  const host = (await rl.question("GitHub host [https://github.com]: ")).trim();
  rl.close();
  const cfg: { cookie: string; host?: string } = { cookie: normalized };
  if (host) cfg.host = host.replace(/\/$/, "");
  const path = await saveConfig(cfg);
  console.log(`✓ Saved to ${path}`);
}

async function cmdAuthStatus(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.log("Not logged in. Run: gh drop auth login");
    exit(1);
  }
  const host = cfg.host ?? "https://github.com";
  console.log(`Logged in to ${host}`);
  console.log(`Cookie: ${cfg.cookie.slice(0, 24)}…`);
  console.log(`Config: ${configPath()}`);
  // Quick liveness probe
  const res = await fetch(`${host}/settings/profile`, {
    headers: { Cookie: cfg.cookie, "User-Agent": "gh-drop" },
    redirect: "manual",
  });
  const alive = res.status === 200;
  console.log(alive ? "Session: ✓ valid" : `Session: ✗ HTTP ${res.status} (probably expired)`);
}

async function cmdAuthLogout(): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(configPath());
    console.log("✓ Logged out.");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") console.log("Already logged out.");
    else throw err;
  }
}

interface DropOpts {
  issue: number;
  images: string[];
  body?: string;
  repo?: string;
  host?: string;
  width?: number;
  dryRun: boolean;
  verify: boolean;
  debug: boolean;
}

async function cmdDrop(opts: DropOpts): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    throw new Error("Not logged in. Run: gh drop auth login");
  }
  const host = opts.host ?? cfg.host ?? "https://github.com";

  await ensureGhAuth();
  const repo = await resolveRepo(opts.repo);
  console.log(`→ ${repo.nameWithOwner} #${opts.issue} (repo id ${repo.id})`);

  // Validate and read all files up front — fail fast before any upload.
  const prepared = await Promise.all(
    opts.images.map(async (p) => {
      const abs = resolve(p);
      const st = await stat(abs).catch(() => null);
      if (!st || !st.isFile()) {
        throw new Error(`Not a file: ${p}`);
      }
      const filename = basename(abs);
      const contentType = mimeForFilename(filename);
      if (!contentType) {
        const ext = extname(filename).slice(1) || "<none>";
        throw new Error(
          `Unsupported extension ".${ext}" for ${filename}. Accepted: ${Object.keys(acceptMimeMap).join(", ")}`,
        );
      }
      const bytes = new Uint8Array(await readFile(abs));
      return { abs, filename, contentType, bytes };
    }),
  );

  // Upload each image sequentially — GitHub rate-limits this endpoint
  // aggressively, and attachments tend to be small so parallelism buys
  // little.
  const assets: { url: string; filename: string }[] = [];
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i]!;
    process.stdout.write(`↑ uploading ${p.filename} (${p.bytes.length} B) … `);
    try {
      const asset = await uploadAttachment({
        bytes: p.bytes,
        filename: p.filename,
        contentType: p.contentType,
        repositoryId: repo.id,
        cookie: cfg.cookie,
        host,
        debug: opts.debug,
      });
      assets.push({ url: asset.href, filename: p.filename });
      console.log(`done`);
      console.log(`  ${asset.href}`);
    } catch (err) {
      if (err instanceof UploadError && err.response.status === 401) {
        throw new Error(
          "GitHub rejected the session cookie (401). Run: gh drop auth login",
        );
      }
      throw err;
    }
  }

  // Compose the comment body.
  const markdown = composeBody(opts.body, assets, opts.width);

  if (opts.dryRun) {
    console.log("\n--- dry run: would post ---");
    console.log(markdown);
    console.log("---------------------------");
  } else {
    const { url } = await postIssueComment(repo.nameWithOwner, opts.issue, markdown);
    console.log(`💬 ${url || "comment posted"}`);
  }

  if (opts.verify) {
    const { verifyAssetRenders } = await import("./verify.ts");
    for (const a of assets) {
      process.stdout.write(`👁  verifying ${a.filename} … `);
      try {
        const r = await verifyAssetRenders(a.url);
        console.log(r.ok ? `ok (screenshot ${r.screenshotPath})` : `⚠ ${r.finalUrl}`);
      } catch (err) {
        console.log(`skipped: ${(err as Error).message}`);
      }
    }
  }
}

function composeBody(
  body: string | undefined,
  assets: { url: string; filename: string }[],
  width?: number,
): string {
  const renderOne = (a: { url: string; filename: string }): string =>
    width
      ? `<img src="${a.url}" alt="${a.filename}" width="${width}">`
      : `![${a.filename}](${a.url})`;

  if (!body) {
    return assets.map(renderOne).join("\n\n");
  }

  const placeholderRe = /<!--\s*gh-drop:IMAGE:(\d+)\s*-->/g;
  const hasPlaceholder = placeholderRe.test(body);

  if (hasPlaceholder) {
    return body.replace(/<!--\s*gh-drop:IMAGE:(\d+)\s*-->/g, (_m, n: string) => {
      const idx = Number(n) - 1;
      const a = assets[idx];
      return a ? renderOne(a) : `<!-- gh-drop:IMAGE:${n} missing -->`;
    });
  }

  // No placeholders — append all images after the body.
  return [body, ...assets.map(renderOne)].join("\n\n");
}

async function main(): Promise<void> {
  const rawArgs = argv.slice(2);

  // Subcommand dispatch: `gh drop auth <...>`
  if (rawArgs[0] === "auth") {
    const sub = rawArgs[1] ?? "status";
    switch (sub) {
      case "login":
        return cmdAuthLogin();
      case "status":
        return cmdAuthStatus();
      case "logout":
        return cmdAuthLogout();
      default:
        throw new Error(`Unknown auth subcommand: ${sub}`);
    }
  }

  if (rawArgs.includes("--help") || rawArgs.includes("-h") || rawArgs.length === 0) {
    printUsage();
    return;
  }
  if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
    console.log(VERSION);
    return;
  }

  const { values } = parseArgs({
    args: rawArgs,
    options: {
      issue: { type: "string", short: "i" },
      image: { type: "string", short: "f", multiple: true },
      body: { type: "string", short: "b" },
      repo: { type: "string", short: "R" },
      host: { type: "string" },
      width: { type: "string" },
      "dry-run": { type: "boolean" },
      debug: { type: "boolean" },
      verify: { type: "boolean" },
    },
    allowPositionals: false,
    strict: true,
  });

  if (!values.issue) throw new Error("--issue is required");
  if (!values.image || values.image.length === 0) {
    throw new Error("--image is required (can be passed multiple times)");
  }
  const issueNumber = Number(values.issue);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`--issue must be a positive integer, got ${values.issue}`);
  }
  const width = values.width ? Number(values.width) : undefined;
  if (width !== undefined && (!Number.isFinite(width) || width <= 0)) {
    throw new Error(`--width must be a positive number, got ${values.width}`);
  }

  await cmdDrop({
    issue: issueNumber,
    images: values.image,
    body: values.body,
    repo: values.repo,
    host: values.host,
    width,
    dryRun: Boolean(values["dry-run"]),
    debug: Boolean(values.debug),
    verify: Boolean(values.verify),
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`error: ${msg}`);
  exit(1);
});
