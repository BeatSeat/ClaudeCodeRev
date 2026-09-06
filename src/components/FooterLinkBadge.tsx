import * as React from 'react'
import { Link, Text } from '../ink.js'
import type { FooterLink } from '../utils/footerLinks.js'

type Props = {
  link: FooterLink
}

/**
 * Official 176 `vC9`. Optional dim prefix, then a `Link` whose children are
 * the underlined label (fallback is the same label without underline).
 */
export function FooterLinkBadge({ link }: Props): React.ReactNode {
  const prefix =
    link.prefix !== undefined ? (
      <>
        <Text dimColor>{link.prefix}</Text>{' '}
      </>
    ) : null
  const dim = !link.color
  const fallback = (
    <Text color={link.color} dimColor={dim}>
      {link.label}
    </Text>
  )
  const labeled = (
    <Text color={link.color} dimColor={dim} underline>
      {link.label}
    </Text>
  )
  return (
    <Text>
      {prefix}
      <Link url={link.url} fallback={fallback}>
        {labeled}
      </Link>
    </Text>
  )
}
