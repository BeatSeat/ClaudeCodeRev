const GITHUB_STYLE_PR_URL =
  /^https:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/

type ParsedPrUrl = {
  url: string
  host: string
  owner: string
  repo: string
  num: number
}

function parseGithubStylePrUrl(url: string): ParsedPrUrl | null {
  const match = url.match(GITHUB_STYLE_PR_URL)
  if (!match) return null
  return {
    url,
    host: match[1]!,
    owner: match[2]!,
    repo: match[3]!,
    num: Number(match[4]),
  }
}

/** 119 `fX7`: rewrite a github-style PR URL through `settings.prUrlTemplate`. */
export function applyPrUrlTemplate(
  url: string,
  template: string | undefined,
): string {
  if (!template) return url
  const parsed = parseGithubStylePrUrl(url)
  if (!parsed) return url
  return template
    .replaceAll('{host}', parsed.host)
    .replaceAll('{owner}', parsed.owner)
    .replaceAll('{repo}', parsed.repo)
    .replaceAll('{number}', String(parsed.num))
    .replaceAll('{url}', url)
}
