// Optional post-upload verification using Bun.WebView (WebKit backend on
// macOS, Chrome elsewhere). After a successful upload we can load the
// asset URL in a headless page and take a screenshot to prove it's live
// and the embedded markdown will render in the issue.
//
// This runs only when --verify is passed; the core upload path never
// touches the webview. We do it this way because:
//   * Bun.WebView is headless-only (see docs), so it can't host the login.
//   * Its WKWebView backend can't be given an external cookie store, so
//     it can't drive authenticated requests either.
// Verification — an unauthenticated GET of a public-by-token URL — is
// the one thing it's actually suited for here.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface VerifyResult {
  ok: boolean;
  screenshotPath: string;
  title: string;
  finalUrl: string;
}

export async function verifyAssetRenders(
  assetUrl: string,
): Promise<VerifyResult> {
  // Dynamic import so environments without Bun.WebView (older bun, CI
  // without WKWebView on Linux + no Chrome) fail with a clear message
  // only when --verify is requested.
  const webview = (globalThis as { Bun?: { WebView?: unknown } }).Bun?.WebView;
  if (!webview) {
    throw new Error(
      "Bun.WebView not available in this runtime. Upgrade to Bun >= 1.3.12.",
    );
  }

  const outDir = join(tmpdir(), "gh-drop");
  await mkdir(outDir, { recursive: true });
  const screenshotPath = join(outDir, `verify-${Date.now()}.png`);

  // `await using` auto-closes the view when the function returns.
  // Cast via unknown — @types/bun may or may not have WebView yet; the
  // runtime check above guarantees it exists.
  const WebViewCtor = webview as new (opts: {
    width: number;
    height: number;
  }) => {
    navigate(url: string): Promise<void>;
    screenshot(): Promise<Uint8Array>;
    url: string;
    title: string;
    [Symbol.asyncDispose](): Promise<void>;
  };
  await using view = new WebViewCtor({ width: 1024, height: 768 });
  await view.navigate(assetUrl);
  const png = await view.screenshot();
  await Bun.write(screenshotPath, png);

  const title = view.title;
  const finalUrl = view.url;

  return {
    ok: !finalUrl.includes("/login") && !finalUrl.includes("/404"),
    screenshotPath,
    title,
    finalUrl,
  };
}
