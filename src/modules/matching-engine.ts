import type { EntrepriseResult } from './entreprises-api.js'

const LEGAL_SUFFIXES = new Set([
  'sarl', 'sas', 'sasu', 'sa', 'sci', 'snc', 'eurl', 'scp', 'scop',
  'se', 'sca', 'scs', 'gie', 'gip', 'association', 'fondation',
])

const ACCENT_MAP: Record<string, string> = {
  'à': 'a', 'â': 'a', 'ä': 'a', 'á': 'a', 'ã': 'a',
  'è': 'e', 'ê': 'e', 'ë': 'e', 'é': 'e',
  'î': 'i', 'ï': 'i', 'í': 'i', 'ì': 'i',
  'ô': 'o', 'ö': 'o', 'ó': 'o', 'ò': 'o', 'õ': 'o',
  'ù': 'u', 'û': 'u', 'ü': 'u', 'ú': 'u',
  'ç': 'c', 'ñ': 'n',
  'À': 'a', 'Â': 'a', 'Á': 'a', 'È': 'e', 'Ê': 'e', 'É': 'e',
  'Î': 'i', 'Ï': 'i', 'Ô': 'o', 'Ö': 'o', 'Ù': 'u', 'Û': 'u', 'Ü': 'u',
  'Ç': 'c', 'Ñ': 'n',
}

export function removeAccents(str: string): string {
  return str.split('').map((c) => ACCENT_MAP[c] ?? c).join('')
}

export function normalizeCompanyName(name: string): string {
  const n = removeAccents(name).toLowerCase().replace(/[^\w\s]/g, ' ')
  return n.split(/\s+/).filter((w) => w.length > 0 && !LEGAL_SUFFIXES.has(w)).join(' ').trim()
}

export function fingerprint(nameNorm: string, city: string): string {
  const cityNorm = removeAccents(city).toLowerCase().replace(/[^\w]/g, '')
  const input = `${nameNorm}|${cityNorm}`
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i)
    hash |= 0
  }
  return `${Math.abs(hash).toString(36)}_${nameNorm.slice(0, 20).replace(/\s/g, '_')}`
}

function tokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split(/\s+/).filter((t) => t.length > 1))
  const tokensB = new Set(b.split(/\s+/).filter((t) => t.length > 1))
  if (tokensA.size === 0 && tokensB.size === 0) return 1
  if (tokensA.size === 0 || tokensB.size === 0) return 0
  let intersection = 0
  for (const t of tokensA) if (tokensB.has(t)) intersection++
  return intersection / Math.max(tokensA.size, tokensB.size)
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
  return dp[m][n]
}

function nameSimilarity(inputName: string, resultName: string): number {
  const a = normalizeCompanyName(inputName)
  const b = normalizeCompanyName(resultName)
  const tokenSim = tokenSimilarity(a, b)
  const maxLen = Math.max(a.length, b.length)
  const levSim = maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen
  return tokenSim * 0.7 + levSim * 0.3
}

interface MatchInput {
  name: string
  city?: string
  postal_code?: string
  naf?: string
  website?: string
}

export interface MatchResult {
  result: EntrepriseResult
  score: number
  flags: string[]
}

export function matchCompany(input: MatchInput, results: EntrepriseResult[]): MatchResult | null {
  if (results.length === 0) return null
  let best: MatchResult | null = null

  for (const r of results) {
    const flags: string[] = []
    let score = 0

    const nameSim = nameSimilarity(input.name, r.name)
    score += nameSim * 50
    if (nameSim > 0.8) flags.push('name_match')

    if (input.postal_code && r.postal_code === input.postal_code) {
      score += 20
      flags.push('postal_match')
    } else if (input.city) {
      const cityA = removeAccents(input.city).toLowerCase()
      const cityB = removeAccents(r.city ?? '').toLowerCase()
      if (cityB.includes(cityA) || cityA.includes(cityB)) {
        score += 15
        flags.push('city_match')
      }
    }

    if (input.naf && r.naf && r.naf.startsWith(input.naf.slice(0, 2))) {
      score += 10
      flags.push('naf_match')
    }

    if (input.website) {
      try {
        const domain = new URL(
          input.website.startsWith('http') ? input.website : `https://${input.website}`
        ).hostname
        const nameTokens = normalizeCompanyName(input.name).split(' ')
        if (nameTokens.some((t) => t.length > 3 && domain.includes(t))) {
          score += 15
          flags.push('domain_hint')
        }
      } catch {}
    }

    if (!best || score > best.score) best = { result: r, score, flags }
  }

  if (!best || best.score < 60) return null
  return best
}
