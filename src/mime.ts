// Mirrors GitHub's accepted file types for user-attachments uploads.
// Derived from the github.com upload dialog client (as of 2026-Q1).
export const acceptMimeMap: Record<string, string> = {
  // Images / media acceptable anywhere on github.com
  svg: "image/svg+xml",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mov: "video/quicktime",
  mp4: "video/mp4",
  webm: "video/webm",

  // Repo-scoped attachments (accepted when repository_id is supplied)
  cpuprofile: "application/json",
  csv: "text/csv",
  dmp: "application/octet-stream",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gz: "application/gzip",
  json: "application/json",
  jsonc: "application/json",
  log: "text/plain",
  md: "text/markdown",
  patch: "text/x-diff",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  tgz: "application/gzip",
  txt: "text/plain",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/x-zip-compressed",
};

export function mimeForFilename(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return undefined;
  return acceptMimeMap[name.slice(dot + 1).toLowerCase()];
}
