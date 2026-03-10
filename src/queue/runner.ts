import type { SupabaseClient } from '@supabase/supabase-js'
import { runCompanyV1 } from '../pipelines/company_v1.js'

const POLL_INTERVAL_MS = 2000
const BATCH_SIZE = 3

export function startQueueRunner(supabase: SupabaseClient) {
  console.log('[queue] Runner started, polling every', POLL_INTERVAL_MS, 'ms')
  poll(supabase)
}

async function poll(supabase: SupabaseClient) {
  try {
    await processJobs(supabase)
  } catch (err) {
    console.error('[queue] Unexpected error:', err)
  } finally {
    setTimeout(() => poll(supabase), POLL_INTERVAL_MS)
  }
}

async function processJobs(supabase: SupabaseClient) {
  const { data: jobs, error } = await supabase.rpc('claim_enrichment_jobs', {
    p_batch_size: BATCH_SIZE,
  })

  if (error) {
    console.error('[queue] Failed to claim jobs:', error.message)
    return
  }

  if (!jobs || jobs.length === 0) return

  console.log(`[queue] Claimed ${jobs.length} job(s)`)
  await Promise.allSettled(jobs.map((job: any) => processJob(supabase, job)))
}

async function processJob(supabase: SupabaseClient, job: any) {
  const start = Date.now()
  console.log(`[job:${job.id}] Starting (${job.pipeline}, attempt ${job.attempts})`)

  try {
    let result: Record<string, unknown> = {}

    if (job.pipeline === 'company_v1') {
      result = await runCompanyV1(supabase, job)
    } else {
      throw new Error(`Unknown pipeline: ${job.pipeline}`)
    }

    await supabase
      .from('enrichment_jobs')
      .update({ status: 'done', result_data: result, completed_at: new Date().toISOString() })
      .eq('id', job.id)

    console.log(`[job:${job.id}] Done in ${Date.now() - start}ms`)
  } catch (err: any) {
    const attempts = job.attempts ?? 1
    const isDead = attempts >= 3
    const nextRunAt = isDead ? null : new Date(Date.now() + attempts * 2 * 60 * 1000).toISOString()

    await supabase
      .from('enrichment_jobs')
      .update({
        status: isDead ? 'dead' : 'failed',
        error_message: err.message,
        next_run_at: nextRunAt,
      })
      .eq('id', job.id)

    console.error(`[job:${job.id}] Failed (attempt ${attempts}): ${err.message}`)
  }
}
