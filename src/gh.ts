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
 * Resolves repo metadata, including the numeric repo id which GitHub's
 * /upload/policies/assets endpoint expects as `repository_id`.
 *
 * We can't use `gh repo view --json databaseId` — that field exists on
 * the GraphQL Repository type but is not whitelisted for the `repo view`
 * command (see `gh repo view --json` available-fields list). The REST
 * endpoint /repos/{owner}/{name} returns the same value under `id`, so
 * we go through `gh api` which reuses the user's existing auth.
 *
 * If `repo` is undefined we resolve the current directory first via
 * `gh repo view --json nameWithOwner`, which *is* whitelisted.
 */
export async function resolveRepo(repo?: string): Promise<RepoInfo> {
  let nameWithOwner = repo;

  if (!nameWithOwner) {
    const { stdout, stderr, code } = await runGh([
      "repo",
      "view",
      "--json",
      "nameWithOwner",
    ]);
    if (code !== 0) {
      throw new Error(
        `gh repo view failed (${code}): ${stderr.trim() || stdout.trim()}`,
      );
    }
    nameWithOwner = (JSON.parse(stdout) as { nameWithOwner: string })
      .nameWithOwner;
  }

  const { stdout, stderr, code } = await runGh([
    "api",
    `/repos/${nameWithOwner}`,
    "--jq",
    "{id: .id, full_name: .full_name, name: .name, owner: .owner.login}",
  ]);
  if (code !== 0) {
    throw new Error(
      `gh api /repos/${nameWithOwner} failed (${code}): ${stderr.trim() || stdout.trim()}`,
    );
  }
  const json = JSON.parse(stdout) as {
    id: number;
    full_name: string;
    name: string;
    owner: string;
  };
  return {
    id: json.id,
    nameWithOwner: json.full_name,
    owner: json.owner,
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
