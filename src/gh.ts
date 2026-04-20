// Thin wrappers around the `gh` CLI. We re-use the user's existing `gh`
// auth for repo resolution and comment posting — the session cookie is
// only used where the public GitHub API doesn't reach (attachment upload).

export interface RepoInfo {
  id: number;
  nameWithOwner: string;
  owner: string;
  name: string;
}

async function runGh(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

/**
 * Resolves repo metadata, including the numeric `databaseId` which GitHub's
 * upload endpoint expects as `repository_id`. If `repo` is undefined, `gh`
 * infers it from the current working directory.
 */
export async function resolveRepo(repo?: string): Promise<RepoInfo> {
  const args = ["repo", "view"];
  if (repo) args.push(repo);
  args.push("--json", "databaseId,nameWithOwner,owner,name");

  const { stdout, stderr, code } = await runGh(args);
  if (code !== 0) {
    throw new Error(
      `gh repo view failed (${code}): ${stderr.trim() || stdout.trim()}`,
    );
  }
  const json = JSON.parse(stdout) as {
    databaseId: number;
    nameWithOwner: string;
    owner: { login: string };
    name: string;
  };
  return {
    id: json.databaseId,
    nameWithOwner: json.nameWithOwner,
    owner: json.owner.login,
    name: json.name,
  };
}

/**
 * Posts a comment on an issue or PR (GitHub treats PR comments as issue
 * comments for this API).
 */
export async function postIssueComment(
  repoNameWithOwner: string,
  issueNumber: number,
  body: string,
): Promise<{ url: string }> {
  const proc = Bun.spawn(
    [
      "gh",
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repoNameWithOwner,
      "--body-file",
      "-",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  proc.stdin.write(body);
  await proc.stdin.end();

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `gh issue comment failed (${code}): ${stderr.trim() || stdout.trim()}`,
    );
  }
  // gh prints the comment URL to stdout
  const url = stdout.trim().split(/\s+/).pop() ?? "";
  return { url };
}

/** Quick sanity check that `gh` is installed and authenticated. */
export async function ensureGhAuth(): Promise<void> {
  const { code, stderr } = await runGh(["auth", "status"]);
  if (code !== 0) {
    throw new Error(
      `gh is not authenticated. Run \`gh auth login\` first.\n${stderr.trim()}`,
    );
  }
}
