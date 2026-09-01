/**
 * Official 113 YbH / Ml_ / Jl_ — live prompt draft for the away-summary
 * (session recap) gate. Recap must not auto-fire while unsent text is
 * sitting in the prompt.
 */
let draftInput = ''

export function getDraftInput(): string {
  return draftInput
}

export function setDraftInput(value: string): void {
  if (draftInput === value) return
  draftInput = value
}
