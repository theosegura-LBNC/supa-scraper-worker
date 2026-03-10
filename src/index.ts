import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { apiKeyAuth } from './auth/api-keys.js'
import { startQueueRunner } from './queue/runner.js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
})

const app = new Hono()

app.get('/health', (c) => c.json({ status: 'ok', ts: new Date().toISOString() }))

app.use('/v1/*', apiKeyAuth(supabase))

app.post('/v1/enrich', async (c) => {
  const tenant = c.get('tenant') as { id: string }
  const body = await c.req.json()
  const { type, data, priority = 0 } = body

  if (!type || !data) return c.json({ error: 'type and data are required' }, 400)
  if (!['company', 'person'].includes(type)) return c.json({ error: 'type must be company or person' }, 400)

  const { data: job, error } = await supabase
    .from('enrichment_jobs')
    .insert({
      tenant_id: tenant.id,
      entity_type: type,
      input_data: data,
      priority,
      status: 'queued',
      source: 'api_external',
      pipeline: type === 'company' ? 'company_v1' : 'person_v1',
    })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ job_id: job.id, status: 'queued' }, 201)
})

app.get('/v1/jobs/:id', async (c) => {
  const tenant = c.get('tenant') as { id: string }
  const id = c.req.param('id')

  const { data: job, error } = await supabase
    .from('enrichment_jobs')
    .select('*, enrichment_steps(*)')
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .single()

  if (error || !job) return c.json({ error: 'Job not found' }, 404)
  return c.json(job)
})

app.post('/v1/enrich/batch', async (c) => {
  const tenant = c.get('tenant') as { id: string }
  const body = await c.req.json()
  const { items, source = 'csv_import' } = body

  if (!Array.isArray(items) || items.length === 0) {
    return c.json({ error: 'items must be a non-empty array' }, 400)
  }

  const jobs = items.map((item: any) => ({
    tenant_id: tenant.id,
    entity_type: item.type,
    input_data: item.data,
    priority: item.priority ?? 0,
    status: 'queued',
    source,
    pipeline: item.type === 'company' ? 'company_v1' : 'person_v1',
  }))

  const { data, error } = await supabase.from('enrichment_jobs').insert(jobs).select('id')
  if (error) return c.json({ error: error.message }, 500)

  return c.json({ batch_id: crypto.randomUUID(), job_ids: (data as any[]).map((j) => j.id) }, 201)
})

app.get('/v1/jobs', async (c) => {
  const tenant = c.get('tenant') as { id: string }
  const status = c.req.query('status')
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200)
  const cursor = c.req.query('cursor')

  let query = supabase
    .from('enrichment_jobs')
    .select('*')
    .eq('tenant_id', tenant.id)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status) query = query.eq('status', status)
  if (cursor) query = query.lt('created_at', cursor)

  const { data, error } = await query
  if (error) return c.json({ error: error.message }, 500)

  const nextCursor = data.length === limit ? data[data.length - 1].created_at : null
  return c.json({ jobs: data, next_cursor: nextCursor })
})

startQueueRunner(supabase)

const port = parseInt(process.env.PORT ?? '3000')
serve({ fetch: app.fetch, port }, () => {
  console.log(`Worker listening on port ${port}`)
})
