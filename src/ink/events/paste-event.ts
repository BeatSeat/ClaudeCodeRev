import { TerminalEvent } from './terminal-event.js'

/**
 * Paste event dispatched through the DOM tree via capture/bubble.
 * Official 2.1.98 gC1: type "paste", bubbles + cancelable, text payload.
 */
export class PasteEvent extends TerminalEvent {
  readonly text: string

  constructor(text: string) {
    super('paste', { bubbles: true, cancelable: true })
    this.text = text
  }
}
