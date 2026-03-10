import type { MiddlewareHandler } from 'hono'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'

export function apiKeyAuth(supabase: SupabaseClient): MiddlewareHandler {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401)
    }

    const rawKey = authHeader.slice(7)
    const keyHash = createHash('sha256').update(rawKey).digest('hex')

    const { data: apiKey, error } = await supabase
      .from('api_keys')
      .select('*')
      .eq('key_hash', keyHash)
      .eq('is_active', true)
      .single()

    if (error || !apiKey) {
      return c.json({ error: 'Invalid or inactive API key' }, 401)
    }

    c.set('tenant', { id: apiKey.owner_id })
    c.set('api_key', apiKey)

    await next()
  }
}
