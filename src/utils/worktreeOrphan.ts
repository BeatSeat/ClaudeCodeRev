/** Official 2.1.101 stale-worktree self-heal copy. */
export function orphanedWorktreeRemoteFailed(
  worktreePath: string,
  stderr: string,
): string {
  return (
    'Orphaned worktree dir at ' +
    worktreePath +
    ' but `git remote` failed (' +
    stderr +
    ') - refusing to self-heal. Remove ' +
    worktreePath +
    ' manually if it has no work to keep.'
  )
}
