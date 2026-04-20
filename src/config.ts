// Persists the GitHub session cookie (and optional host override for GHE)
// at ~/.gh-drop/config.json. We chmod 0600 because this cookie grants full
// access to the user's GitHub account — treat it like a password.
//
// The env vars GH_DROP_COOKIE and GH_DROP_HOST take precedence over the file,
// making CI usage straightforward.

import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";

export interface StoredConfig {
  cookie: string;
  host?: string;
}

const DIR = join(homedir(), ".gh-drop");
const FILE = join(DIR, "config.json");

export async function loadConfig(): Promise<StoredConfig | null> {
  const envCookie = process.env.GH_DROP_COOKIE;
  if (envCookie) {
    return { cookie: envCookie, host: process.env.GH_DROP_HOST };
  }
  try {
    const raw = await readFile(FILE, "utf8");
    return JSON.parse(raw) as StoredConfig;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

export async function saveConfig(cfg: StoredConfig): Promise<string> {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  await writeFile(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await chmod(FILE, 0o600);
  return FILE;
}

export function configPath(): string {
  return FILE;
}
