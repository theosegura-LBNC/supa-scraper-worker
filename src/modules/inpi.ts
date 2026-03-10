export interface Officer {
  name: string
  role: string
  date_naissance?: string
  nationalite?: string
}

const BASE_URL = 'https://annuaire-entreprises.data.gouv.fr/api/v1'

export async function enrichInpi(siren: string): Promise<Officer[]> {
  const res = await fetch(`${BASE_URL}/dirigeants/${siren}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'supa-scraper-worker/1.0' },
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) {
    if (res.status === 404) return []
    throw new Error(`dirigeants API error: ${res.status} for SIREN ${siren}`)
  }

  const data = (await res.json()) as any

  return (data.dirigeants ?? [])
    .map((d: any) => ({
      name: [d.prenom, d.nom].filter(Boolean).join(' ') || d.denomination || '',
      role: d.role ?? d.titre ?? '',
      date_naissance: d.date_naissance ?? undefined,
      nationalite: d.nationalite ?? undefined,
    }))
    .filter((o: Officer) => o.name)
}
