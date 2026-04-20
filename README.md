# gh-drop

Drop images into GitHub issues and PRs from the command line.
A [`gh`](https://cli.github.com) extension, written in TypeScript, powered by [Bun](https://bun.sh).

```bash
gh extension install drakulavich/gh-drop

gh drop --issue 123 --image ./screenshot.png
```

## Why

`gh` can't upload images to issue or PR comments — GitHub never shipped a
public API for it. The web UI does it through an internal `/upload/policies/assets`
endpoint that requires a browser session cookie. `gh-drop` replicates that
flow from the terminal so your AI agent, CI run, or bug-report script can
attach screenshots without a browser.

Functionally equivalent to [`gh-attach`](https://github.com/atani/gh-attach),
but with a [Bun single-file binary](https://bun.sh/docs/bundler/executables)
per platform — no Node, no Playwright, no runtime dependencies.

## Install

```bash
gh extension install drakulavich/gh-drop
```

`gh` auto-downloads the right prebuilt binary for your OS (macOS / Linux /
Windows, x64 and arm64). First run sets up auth:

```bash
gh drop auth login
```

You'll be asked for your `github.com` session cookie. Grab it from DevTools
→ Application → Cookies → `https://github.com` → `user_session`. It's stored
at `~/.gh-drop/config.json` (mode `0600`) and used only for the attachment
upload — everything else goes through your existing `gh` login.

## Use

```bash
# Basic
gh drop --issue 123 --image ./screenshot.png

# Multiple images, custom body
gh drop --issue 123 \
  --image ./before.png \
  --image ./after.png \
  --body "Before: <!-- gh-drop:IMAGE:1 -->
After: <!-- gh-drop:IMAGE:2 -->"

# Explicit repo (otherwise inferred from cwd)
gh drop --repo owner/name --issue 456 --image bug.png

# Render at fixed width instead of full-bleed
gh drop --issue 123 --image wide.png --width 720

# Upload but don't post the comment (print the markdown instead)
gh drop --issue 123 --image ./screenshot.png --dry-run

# Upload and screenshot the asset URL to verify it renders
gh drop --issue 123 --image ./screenshot.png --verify
```

### Body placeholders

Put `<!-- gh-drop:IMAGE:N -->` anywhere in `--body` and the Nth image (1-indexed)
is substituted in. Without placeholders, images are appended after the body.
Without a body at all, the comment is just the images.

### GitHub Enterprise

```bash
gh drop auth login                                         # enter your GHE host at the second prompt
gh drop --host https://github.mycompany.com --issue 123 --image x.png
```

Or set `GH_DROP_HOST` as an env var.

## Configuration

| Source                 | Precedence | Notes                                                   |
| ---------------------- | ---------- | ------------------------------------------------------- |
| `GH_DROP_COOKIE` env   | 1 (wins)   | Full cookie string, e.g. `user_session=...`. For CI.    |
| `GH_DROP_HOST` env     | 1 (wins)   | Override GitHub host.                                   |
| `~/.gh-drop/config.json` | 2        | Written by `gh drop auth login`. Mode `0600`.           |

## How it works

The upload replicates what github.com's drag-and-drop UI does:

1. `POST /upload/policies/assets` — metadata + signed form for the storage backend
2. `POST <policies.upload_url>` — the bytes (usually straight to S3)
3. `POST <policies.asset_upload_url>` with `_method=put` + `X-CSRF-Token` — confirms the upload

Step 3 used to be a plain `PUT` (and still is in most published references),
but github.com now rejects that shape with a 422 HTML error page. The working
shape mirrors what the web UI does: a POST with Rails-style method override
and the `authenticity_token` duplicated into an `X-CSRF-Token` header. Two
legacy shapes (classic PUT multipart, PUT urlencoded) remain as automatic
fallbacks in case GitHub rotates things again.

`gh` itself is used for the two things it's good at: resolving the numeric
repo id (via `gh api /repos/{owner}/{name}`) and posting the final comment
(`gh issue comment`). The only part `gh-drop` owns is the cookie-authenticated
upload.

The optional `--verify` flag uses [`Bun.WebView`](https://bun.com/docs/runtime/webview)
(system WKWebView on macOS, headless Chrome elsewhere) to load the returned
asset URL and screenshot it — a quick sanity check that the attachment is
live and will render in the comment.

## Develop

```bash
git clone https://github.com/drakulavich/gh-drop
cd gh-drop
bun install
bun run typecheck

# Install the dev version as a gh extension pointing at this checkout
gh extension install .

# Source install uses the gh-drop bash shim, which invokes `bun run src/cli.ts`
```

To cut a release, push a `v*` tag. CI runs `cli/gh-extension-precompile@v2`
with our `script/build.sh`, producing one `bun build --compile` binary per
platform under `dist/gh-drop_<tag>_<os>-<arch>[.exe]`. Users of
`gh extension install` get the right one automatically.

## Security

The session cookie grants full access to your GitHub account. `gh-drop`
stores it with mode `0600` under `~/.gh-drop/`, reads it only to upload,
and never logs it. If it leaks, rotate it by signing out of all sessions
at <https://github.com/settings/sessions>.

## License

MIT.
