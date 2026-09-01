import type { VimMode } from './textInputTypes.js'

export type StatusLineCommandInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
  session_name?: string
  model: {
    id: string
    display_name: string
  }
  workspace: {
    current_dir: string
    project_dir: string
    added_dirs: string[]
    git_worktree?: string
    /** Official 2.1.145: parsed git remote when the host looks like a repo. */
    repo?: {
      host: string
      owner: string
      name: string
    }
  }
  version: string
  output_style: {
    name: string
  }
  cost: {
    total_cost_usd: number
    total_duration_ms: number
    total_api_duration_ms: number
    total_lines_added: number
    total_lines_removed: number
  }
  context_window: {
    total_input_tokens: number
    total_output_tokens: number
    context_window_size: number
    current_usage: unknown
    used_percentage: number | null
    remaining_percentage: number | null
  }
  exceeds_200k_tokens: boolean
  effort?: {
    level: string
  }
  thinking: {
    enabled: boolean
  }
  rate_limits?: {
    five_hour?: {
      used_percentage: number
      resets_at: number
    }
    seven_day?: {
      used_percentage: number
      resets_at: number
    }
  }
  vim?: {
    mode: VimMode
  }
  agent?: {
    name: string
  }
  remote?: {
    session_id: string
  }
  worktree?: {
    name: string
    path: string
    branch?: string
    original_cwd: string
    original_branch?: string
  }
  /** Official 2.1.145: open PR for the current branch (mirrors the footer PR badge). */
  pr?: {
    number: number
    url: string
    review_state?:
      | 'approved'
      | 'pending'
      | 'changes_requested'
      | 'draft'
      | 'merged'
      | 'closed'
  }
}
