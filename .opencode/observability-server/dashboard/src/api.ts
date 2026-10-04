import type { Stats, EventsResponse, SessionsResponse } from './types'

// Use the hostname the dashboard was loaded from, not a hardcoded 'localhost',
// so it works whether accessed locally or from another machine on the LAN.
const BASE_URL = `http://${window.location.hostname}:8889`

export async function getStats(): Promise<Stats> {
  const res = await fetch(`${BASE_URL}/api/stats`)
  if (!res.ok) throw new Error('Failed to fetch stats')
  return res.json()
}

export async function getEvents(params?: { 
  type?: string
  session_id?: string
  limit?: number
  offset?: number
}): Promise<EventsResponse> {
  const url = new URL(`${BASE_URL}/api/events`)
  if (params?.type) url.searchParams.set('type', params.type)
  if (params?.session_id) url.searchParams.set('session_id', params.session_id)
  if (params?.limit) url.searchParams.set('limit', params.limit.toString())
  if (params?.offset) url.searchParams.set('offset', params.offset.toString())
  
  const res = await fetch(url)
  if (!res.ok) throw new Error('Failed to fetch events')
  return res.json()
}

export function createEventStream(): EventSource {
  return new EventSource(`${BASE_URL}/api/events/stream`)
}

export async function getSessions(): Promise<SessionsResponse> {
  const res = await fetch(`${BASE_URL}/api/sessions`)
  if (!res.ok) throw new Error('Failed to fetch sessions')
  return res.json()
}
