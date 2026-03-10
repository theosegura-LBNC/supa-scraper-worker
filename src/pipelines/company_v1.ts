import type { SupabaseClient } from '@supabase/supabase-js'
import { searchEntreprises, type EntrepriseResult } from '../modules/entreprises-api.js'
import { enrichSirene } from '../modules/sirene.js'
import { enrichInpi } from '../modules/inpi.js'
import { matchCompany, normalizeCompanyName, fingerprint } from '../modules/matching-engine.js'

interface CompanyInput {
  name: string
  city?: string
  postal_code?: string
  website?: string
  siren?: string
  naf?: string
}

export async function runCompanyV1(
  supabase: SupabaseClient,
  job: any
): Promise<Record<string, unknown>> {
  const input = job.input_data as CompanyInput
  const steps: any[] = []

  const log = async (step: any) => {
    steps.push(step)
    await supabase.from('enrichment_steps').insert({
      job_id: job.id,
      step_name: step.step,
      status: step.status,
      data: step.data ?? null,
      source: step.source ?? null,
      confidence: step.confidence ?? null,
      duration_ms: step.duration_ms ?? null,
    })
  }

  const updateProgress = async (progress: number) => {
    await supabase.from('enrichment_jobs').update({ progress }).eq('id', job.id)
  }

  // Step 1: Normalize & Fingerprint
  const t1 = Date.now()
  const nameNorm = normalizeCompanyName(input.name)
  const fp = fingerprint(nameNorm, input.city ?? '')
  await log({ step: 'normalize_and_fingerprint', status: 'ok', data: { name_normalized: nameNorm, fingerprint: fp }, duration_ms: Date.now() - t1 })
  await updateProgress(15)

  // Step 2: Cache Check
  const t2 = Date.now()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  let cachedCompany: any = null

  if (input.siren) {
    const { data } = await supabase.from('entities_company').select('*').eq('siren', input.siren).gt('updated_at', thirtyDaysAgo).maybeSingle()
    cachedCompany = data
  }
  if (!cachedCompany) {
    const { data } = await supabase.from('entities_company').select('*').eq('fingerprint', fp).gt('updated_at', thirtyDaysAgo).maybeSingle()
    cachedCompany = data
  }

  if (cachedCompany) {
    await log({ step: 'cache_check', status: 'ok', data: { cache_hit: true, entity_id: cachedCompany.id }, duration_ms: Date.now() - t2 })
    return { entity_id: cachedCompany.id, cache_hit: true, steps }
  }

  await log({ step: 'cache_check', status: 'ok', data: { cache_hit: false }, duration_ms: Date.now() - t2 })
  await updateProgress(25)

  // Step 3: Search Recherche-Entreprises
  const t3 = Date.now()
  let matched: EntrepriseResult | null = null
  let matchScore = 0

  try {
    const results = await searchEntreprises({ q: input.name, code_postal: input.postal_code })
    const match = matchCompany(input, results)
    if (match) { matched = match.result; matchScore = match.score }
    await log({
      step: 'search_entreprises_gouv',
      status: matched ? 'ok' : 'no_match',
      data: { results_count: results.length, siren: matched?.siren, score: matchScore, flags: match?.flags },
      source: 'api_gouv',
      confidence: matchScore / 100,
      duration_ms: Date.now() - t3,
    })
  } catch (err: any) {
    await log({ step: 'search_entreprises_gouv', status: 'error', data: { error: err.message }, duration_ms: Date.now() - t3 })
  }

  await updateProgress(50)

  if (!matched) {
    const { data: entity } = await supabase
      .from('entities_company')
      .upsert({ tenant_id: job.tenant_id, name: input.name, name_normalized: nameNorm, fingerprint: fp, completeness_score: 5 }, { onConflict: 'fingerprint' })
      .select().single()
    return { entity_id: entity?.id, siren_found: false, steps }
  }

  // Step 4: Enrich SIRENE
  const t4 = Date.now()
  let sireneData: any = null
  try {
    sireneData = await enrichSirene(matched.siren)
    await log({ step: 'enrich_sirene', status: 'ok', data: sireneData, source: 'sirene', confidence: 0.99, duration_ms: Date.now() - t4 })
  } catch (err: any) {
    await log({ step: 'enrich_sirene', status: 'error', data: { error: err.message }, duration_ms: Date.now() - t4 })
  }

  await updateProgress(70)

  // Step 5: Enrich INPI (dirigeants)
  const t5 = Date.now()
  let officers: any[] = []
  try {
    officers = await enrichInpi(matched.siren)
    await log({ step: 'enrich_inpi', status: 'ok', data: { officers_count: officers.length, officers }, source: 'inpi', confidence: 0.95, duration_ms: Date.now() - t5 })
  } catch (err: any) {
    await log({ step: 'enrich_inpi', status: 'error', data: { error: err.message }, duration_ms: Date.now() - t5 })
  }

  await updateProgress(85)

  // Step 7: Score & Write
  const t7 = Date.now()
  const companyData: Record<string, any> = {
    tenant_id: job.tenant_id,
    name: matched.name,
    name_normalized: nameNorm,
    fingerprint: fp,
    siren: matched.siren,
    siret: sireneData?.siret_siege ?? matched.siret,
    naf_code: sireneData?.naf ?? matched.naf,
    naf_label: sireneData?.naf_label ?? matched.activite_principale_libelle,
    address: sireneData?.address ?? matched.address,
    city: sireneData?.city ?? matched.city,
    postal_code: sireneData?.postal_code ?? matched.postal_code,
    country: 'FR',
    legal_form: sireneData?.legal_form ?? matched.categorie_juridique_libelle,
    headcount_range: sireneData?.headcount_range ?? matched.tranche_effectif,
    founded_year: matched.date_creation ? parseInt(matched.date_creation.slice(0, 4)) : null,
    officers,
    domain: input.website ?? null,
  }

  const scoreableFields = ['siren', 'siret', 'naf_code', 'address', 'city', 'postal_code', 'legal_form', 'headcount_range', 'officers', 'domain']
  const filledFields = scoreableFields.filter((f) => {
    const v = companyData[f]
    if (v === null || v === undefined) return false
    if (Array.isArray(v)) return v.length > 0
    return true
  })
  companyData.completeness_score = Math.round((filledFields.length / scoreableFields.length) * 100)

  const { data: entity, error: upsertError } = await supabase
    .from('entities_company')
    .upsert(companyData, { onConflict: 'siren' })
    .select().single()

  if (upsertError) throw new Error(`Failed to write entity: ${upsertError.message}`)

  const evidenceEntries = [
    { field: 'siren', value: matched.siren, source: 'api_gouv', confidence: matchScore / 100 },
    { field: 'name', value: matched.name, source: 'api_gouv', confidence: matchScore / 100 },
    ...(sireneData ? [
      { field: 'address', value: sireneData.address, source: 'sirene', confidence: 0.99 },
      { field: 'naf_code', value: sireneData.naf, source: 'sirene', confidence: 0.99 },
      { field: 'headcount_range', value: sireneData.headcount_range, source: 'sirene', confidence: 0.95 },
    ] : []),
    ...(officers.length > 0 ? [{ field: 'officers', value: JSON.stringify(officers), source: 'inpi', confidence: 0.95 }] : []),
  ].filter((e) => e.value !== null && e.value !== undefined && e.value !== '')

  if (evidenceEntries.length > 0) {
    await supabase.from('evidence').insert(
      evidenceEntries.map((e) => ({
        entity_id: entity.id,
        entity_type: 'company',
        field_name: e.field,
        field_value: String(e.value),
        source: e.source,
        confidence: e.confidence,
        job_id: job.id,
      }))
    )
  }

  await log({ step: 'score_and_write', status: 'ok', data: { entity_id: entity.id, completeness_score: companyData.completeness_score }, duration_ms: Date.now() - t7 })
  await updateProgress(100)

  return { entity_id: entity.id, siren: matched.siren, completeness_score: companyData.completeness_score, steps }
}
