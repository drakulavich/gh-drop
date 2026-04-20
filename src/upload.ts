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

export async function uploadAttachment(input: UploadInput): Promise<PoliciesAsset> {
  const host = (input.host ?? "https://github.com").replace(/\/$/, "");
  // Cast to BlobPart — Bun's File constructor accepts Uint8Array at runtime
  // but TS's lib.dom types require an ArrayBuffer-backed view.
  const blob = new Blob([input.bytes as BlobPart], { type: input.contentType });
  const file = new File([blob], input.filename, { type: input.contentType });

  // Step 1 — request upload policy
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
  if (!policiesRes.ok) {
    throw new UploadError("upload/policies/assets failed", policiesRes);
  }
  const policies = (await policiesRes.json()) as PoliciesResponse;

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

  const storageRes = await fetch(policies.upload_url, {
    method: "POST",
    body: storageForm,
    headers: storageHeaders,
  });
  if (!storageRes.ok) {
    throw new UploadError("storage upload failed", storageRes);
  }

  // Step 3 — confirm the asset with GitHub
  const confirmForm = new FormData();
  confirmForm.append(
    "authenticity_token",
    policies.asset_upload_authenticity_token,
  );
  const confirmUrl = new URL(policies.asset_upload_url, host + "/").href;
  const confirmRes = await fetch(confirmUrl, {
    method: "PUT",
    body: confirmForm,
    headers: {
      ...baseHeaders(input.cookie, host),
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  if (!confirmRes.ok) {
    throw new UploadError("asset confirmation failed", confirmRes);
  }

  return policies.asset;
}

export class UploadError extends Error {
  constructor(
    message: string,
    public response: Response,
  ) {
    super(`${message}: ${response.status} ${response.statusText}`);
    this.name = "UploadError";
  }
}
