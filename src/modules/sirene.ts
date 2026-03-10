export interface SireneData {
  siret_siege: string
  naf: string
  naf_label: string
  address: string
  city: string
  postal_code: string
  legal_form: string
  headcount_range: string
  date_creation: string
}

const BASE_URL = 'https://annuaire-entreprises.data.gouv.fr/api/v1'

export async function enrichSirene(siren: string): Promise<SireneData> {
  const res = await fetch(`${BASE_URL}/entreprise/${siren}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'supa-scraper-worker/1.0' },
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) throw new Error(`annuaire-entreprises error: ${res.status} for SIREN ${siren}`)

  const data = (await res.json()) as any
  const siege = data.siege ?? {}

  return {
    siret_siege: siege.siret ?? '',
    naf: data.activite_principale ?? '',
    naf_label: data.libelle_activite_principale ?? '',
    address: [siege.numero_voie, siege.type_voie, siege.libelle_voie].filter(Boolean).join(' '),
    city: siege.libelle_commune ?? '',
    postal_code: siege.code_postal ?? '',
    legal_form: data.libelle_nature_juridique ?? '',
    headcount_range: data.libelle_tranche_effectif ?? '',
    date_creation: data.date_creation ?? '',
  }
}
