// Implements GitHub's 3-step user-attachments upload using plain fetch
// against github.com, authenticated with the user's browser session cookie.
//
// GitHub doesn't expose a public API for attachment upload; we replicate
// the requests the web UI makes when you drag-and-drop into an issue:
//
//   1. POST /upload/policies/assets       → signed form + S3 URL
//   2. POST <upload_url> (multipart)      → object stored
//   3. PUT  <asset_upload_url>            → confirm, asset href is live
//
// The third request's response isn't strictly needed — the `asset.href`
// returned from step 1 is already the final https://github.com/user-attachments/...
// URL we embed in markdown.

export interface PoliciesAsset {
  id: number;
  name: string;
  size: number;
  content_type: string;
  original_name: string | null;
  href: string;
}

interface PoliciesResponse {
  upload_url: string;
  upload_authenticity_token: string;
  form: Record<string, string>;
  header: Record<string, string>;
  asset: PoliciesAsset;
  asset_upload_url: string;
  asset_upload_authenticity_token: string;
  same_origin: boolean;
}

export interface UploadInput {
  /** Raw file bytes. */
  bytes: Uint8Array;
  /** Filename the server should see (determines extension → content type). */
  filename: string;
  /** Detected MIME type for the file. */
  contentType: string;
  /** Numeric `databaseId` of the repo the attachment is scoped to. */
  repositoryId: number;
  /** Raw `Cookie:` header value, e.g. `user_session=...; __Host-user_session_same_site=...`. */
  cookie: string;
  /**
   * Override the github host. Defaults to https://github.com. Enterprise users
   * can pass e.g. https://github.mycompany.com.
   */
  host?: string;
  /** When true, print each request's status + any error body to stderr. */
  debug?: boolean;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

function baseHeaders(cookie: string, host: string) {
  return {
    "User-Agent": UA,
    Origin: host,
    Referer: host + "/",
    Cookie: cookie,
  };
}

function dlog(debug: boolean | undefined, msg: string): void {
  if (debug) console.error(`[gh-drop upload] ${msg}`);
}

async function snapshotBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 2000);
  } catch {
    return "<unreadable body>";
  }
}

export async function uploadAttachment(
  input: UploadInput,
): Promise<PoliciesAsset> {
  const host = (input.host ?? "https://github.com").replace(/\/$/, "");
  const debug = input.debug;
  // Cast to BlobPart — Bun's File constructor accepts Uint8Array at runtime
  // but TS's lib.dom types require an ArrayBuffer-backed view.
  const blob = new Blob([input.bytes as BlobPart], { type: input.contentType });
  const file = new File([blob], input.filename, { type: input.contentType });

  // Step 1 — request upload policy
  dlog(
    debug,
    `step 1: POST ${host}/upload/policies/assets (repo=${input.repositoryId}, size=${file.size}, type=${file.type})`,
  );
  const policiesForm = new FormData();
  policiesForm.append("repository_id", String(input.repositoryId));
  policiesForm.append("name", file.name);
  policiesForm.append("size", String(file.size));
  policiesForm.append("content_type", file.type);

  const policiesRes = await fetch(`${host}/upload/policies/assets`, {
    method: "POST",
    body: policiesForm,
    headers: {
      ...baseHeaders(input.cookie, host),
      "GitHub-Verified-Fetch": "true",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json",
    },
  });
  dlog(debug, `step 1: ← ${policiesRes.status} ${policiesRes.statusText}`);
  if (!policiesRes.ok) {
    const body = await snapshotBody(policiesRes);
    dlog(debug, `step 1: body: ${body}`);
    throw new UploadError("upload/policies/assets failed", policiesRes, body);
  }
  const policies = (await policiesRes.json()) as PoliciesResponse;
  dlog(
    debug,
    `step 1: upload_url=${policies.upload_url} same_origin=${policies.same_origin} asset.id=${policies.asset?.id} asset.href=${policies.asset?.href}`,
  );

  // Step 2 — upload bytes to the storage backend (usually S3)
  const storageForm = new FormData();
  for (const [k, v] of Object.entries(policies.form)) {
    storageForm.append(k, v);
  }
  if (policies.same_origin) {
    storageForm.append(
      "authenticity_token",
      policies.upload_authenticity_token,
    );
  }
  storageForm.append("file", file, file.name);

  const storageHeaders: Record<string, string> = {
    "User-Agent": UA,
    ...policies.header,
  };
  // S3 rejects the Cookie header — only send it when the upload is same-origin.
  if (policies.same_origin) {
    storageHeaders.Cookie = input.cookie;
    storageHeaders.Origin = host;
    storageHeaders.Referer = host + "/";
  }

  dlog(debug, `step 2: POST ${policies.upload_url}`);
  const storageRes = await fetch(policies.upload_url, {
    method: "POST",
    body: storageForm,
    headers: storageHeaders,
  });
  dlog(debug, `step 2: ← ${storageRes.status} ${storageRes.statusText}`);
  if (!storageRes.ok) {
    const body = await snapshotBody(storageRes);
    dlog(debug, `step 2: body: ${body}`);
    throw new UploadError("storage upload failed", storageRes, body);
  }

  // Step 3 — confirm the asset with GitHub.
  //
  // The classic shape (PUT <asset_upload_url> with a multipart body
  // containing `authenticity_token`, used by lisonge/user-attachments)
  // returns a 422 HTML error page on github.com as of 2026 — the front-end
  // router rejects it before the controller runs. The modern web UI sends a
  // POST with Rails-style `_method=put` override plus the authenticity
  // token mirrored into an `X-CSRF-Token` header; that's what works today.
  //
  // Strategy A is the happy path. B and C are legacy fallbacks kept around
  // in case GitHub rotates the shape again; they'll only run if A fails.
  const confirmUrl = new URL(policies.asset_upload_url, host + "/").href;
  const strategies: Array<{ name: string; run: () => Promise<Response> }> = [
    {
      name: "POST + _method=put + X-CSRF-Token",
      run: () => {
        const f = new FormData();
        f.append("_method", "put");
        f.append(
          "authenticity_token",
          policies.asset_upload_authenticity_token,
        );
        return fetch(confirmUrl, {
          method: "POST",
          body: f,
          headers: {
            ...baseHeaders(input.cookie, host),
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-Token": policies.asset_upload_authenticity_token,
            "GitHub-Verified-Fetch": "true",
          },
        });
      },
    },
    {
      name: "classic PUT multipart",
      run: () => {
        const f = new FormData();
        f.append(
          "authenticity_token",
          policies.asset_upload_authenticity_token,
        );
        return fetch(confirmUrl, {
          method: "PUT",
          body: f,
          headers: {
            ...baseHeaders(input.cookie, host),
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
        });
      },
    },
    {
      name: "PUT urlencoded + X-CSRF-Token",
      run: () => {
        const body = new URLSearchParams({
          authenticity_token: policies.asset_upload_authenticity_token,
        }).toString();
        return fetch(confirmUrl, {
          method: "PUT",
          body,
          headers: {
            ...baseHeaders(input.cookie, host),
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-Token": policies.asset_upload_authenticity_token,
          },
        });
      },
    },
  ];

  let lastRes: Response | undefined;
  let lastBody = "";
  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i]!;
    const tag = `step 3${String.fromCharCode(65 + i)}`;
    dlog(debug, `${tag}: ${s.name} → ${confirmUrl}`);
    const res = await s.run();
    dlog(debug, `${tag}: ← ${res.status} ${res.statusText}`);
    if (res.ok) return policies.asset;
    lastRes = res;
    lastBody = await snapshotBody(res);
    dlog(debug, `${tag}: body: ${lastBody.slice(0, 400)}`);
  }

  throw new UploadError(
    "asset confirmation failed (tried POST+override, PUT multipart, PUT urlencoded)",
    lastRes!,
    lastBody,
  );
}

export class UploadError extends Error {
  constructor(
    message: string,
    public response: Response,
    public body?: string,
  ) {
    const suffix = body && body.trim() ? ` — ${body.trim().slice(0, 300)}` : "";
    super(
      `${message}: ${response.status} ${response.statusText}${suffix}`,
    );
    this.name = "UploadError";
  }
}
