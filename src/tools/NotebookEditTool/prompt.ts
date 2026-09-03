import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

export const DESCRIPTION =
  'Edit a cell in a Jupyter notebook — replace, insert, or delete.'

export const PROMPT = `Replaces, inserts, or deletes a single cell in a Jupyter notebook (.ipynb file).

Usage:
- You must use the ${FILE_READ_TOOL_NAME} tool on the notebook in this conversation before editing — this tool will fail otherwise.
- \`notebook_path\` must be an absolute path.
- \`cell_id\` is the \`id\` attribute shown in the ${FILE_READ_TOOL_NAME} tool's \`<cell id="...">\` output. It is required for \`replace\` and \`delete\`.
- \`edit_mode\` defaults to \`replace\`. Use \`insert\` to add a new cell after the cell with the given \`cell_id\` (or at the beginning of the notebook if \`cell_id\` is omitted) — \`cell_type\` is required when inserting. Use \`delete\` to remove the cell.`
