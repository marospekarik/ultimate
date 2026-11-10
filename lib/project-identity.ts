import { git } from './git.ts'

/** `github.com/<owner>/<repo>`, lowercased, for a GitHub SSH (host aliases such as `github.com-work` included) or HTTPS remote URL; undefined for any other. */
export function projectKey(remote: string): string | undefined {
  const match =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?github\.com(?:-[\w-]+)?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/i.exec(
      remote.trim(),
    )
  return match ? `github.com/${match[1]}/${match[2]}`.toLowerCase() : undefined
}

/** `github.com/<owner>/<repo>` of the project's `origin`, if it is on GitHub. */
export const githubRepo = (projectRoot: string) =>
  git(projectRoot, 'remote', 'get-url', 'origin')
    .then(projectKey)
    .catch(
      () =>
        // No repository or no origin: the project is not on GitHub, so callers show no GitHub links.
        undefined,
    )

/**
 * The project's global identity: its origin's GitHub key and the repository's oldest root commit. A worktree reads its
 * main checkout's origin. Undefined without a GitHub origin.
 */
export async function projectIdentity(
  root: string,
): Promise<{ key: string; rootCommit: string } | undefined> {
  try {
    const key = projectKey(await git(root, 'remote', 'get-url', 'origin'))
    if (!key) return undefined
    // rev-list lists newest first; a merged unrelated history adds roots, and the oldest stays the same.
    const rootCommit = (await git(root, 'rev-list', '--max-parents=0', 'HEAD')).split('\n').at(-1)!
    return { key, rootCommit }
  } catch {
    // No repository, no origin remote or no commit yet: the project has no global identity.
    return undefined
  }
}
