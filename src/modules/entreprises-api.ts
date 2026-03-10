export interface EntrepriseResult {
  siren: string
  siret: string
  name: string
  address?: string
  city?: string
  postal_code?: string
  naf?: string
  activite_principale_libelle?: string
  categorie_juridique_libelle?: string
  tranche_effectif?: string
  date_creation?: string
}

interface SearchParams {
  q: string
  code_postal?: string
  per_page?: number
}

const BASE_URL = 'https://recherche-entreprises.api.gouv.fr'

export async function searchEntreprises(params: SearchParams): Promise<EntrepriseResult[]> {
  const url = new URL(`${BASE_URL}/search`)
  url.searchParams.set('q', params.q)
  url.searchParams.set('per_page', String(params.per_page ?? 10))
  if (params.code_postal) url.searchParams.set('code_postal', params.code_postal)

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json', 'User-Agent': 'supa-scraper-worker/1.0' },
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) throw new Error(`recherche-entreprises API error: ${res.status}`)

  const data = (await res.json()) as any

  return (data.results ?? []).map((r: any) => {
    const siege = r.siege ?? {}
    return {
      siren: r.siren,
      siret: siege.siret ?? '',
      name: r.nom_complet ?? r.nom_raison_sociale ?? '',
      address: [siege.numero_voie, siege.type_voie, siege.libelle_voie].filter(Boolean).join(' '),
      city: siege.libelle_commune ?? '',
      postal_code: siege.code_postal ?? '',
      naf: r.activite_principale ?? siege.activite_principale ?? '',
      activite_principale_libelle: r.libelle_activite_principale ?? '',
      categorie_juridique_libelle: r.libelle_nature_juridique ?? '',
      tranche_effectif: r.libelle_tranche_effectif ?? '',
      date_creation: r.date_creation ?? '',
    } as EntrepriseResult
  })
}
