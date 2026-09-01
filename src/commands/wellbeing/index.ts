import type { Command } from '../../commands.js'

// Official 2.1.149: `/wellbeing` (optional break reminders + quiet-hours
// nudges). Landed as a disabled stub (isEnabled: () => false) alongside /focus,
// which shipped in the same hop (bundle minified module WQ4).
const wellbeing = {
  type: 'local-jsx',
  name: 'wellbeing',
  aliases: ['breaks', 'break-reminder', 'downtime'],
  description: 'Configure optional break reminders and quiet-hours nudges',
  isEnabled: () => false,
  immediate: true,
  load: () => import('./wellbeing.js'),
} satisfies Command

export default wellbeing
