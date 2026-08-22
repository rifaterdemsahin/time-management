/**
 * Google Calendar client for Cloudflare Workers.
 * Authenticates with a GCP service-account JSON stored as a Worker secret
 * (GOOGLE_SERVICE_ACCOUNT_JSON) — never bundled, never logged.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

let cachedToken = null;
let cachedTokenExp = 0;

function b64url(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToArrayBuffer(pem) {
  const cleaned = String(pem)
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function importPrivateKey(pem) {
  return crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

function parseServiceAccount(env) {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    const err = new Error('GOOGLE_SERVICE_ACCOUNT_JSON Worker secret is not set');
    err.status = 503;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
    err.status = 500;
    throw err;
  }
}

export function calendarId(env) {
  return env.CALENDAR_ID || 'info@pexabo.com';
}

export async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedTokenExp - 60) return cachedToken;

  const sa = parseServiceAccount(env);
  const headerRs = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: CALENDAR_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );
  const unsigned = `${headerRs}.${claim}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(sig)}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    const err = new Error(data.error_description || data.error || 'Google token exchange failed');
    err.status = 502;
    throw err;
  }
  cachedToken = data.access_token;
  cachedTokenExp = now + (Number(data.expires_in) || 3600);
  return cachedToken;
}

export async function calendarFetch(env, path, { method = 'GET', body, query } = {}) {
  const token = await getAccessToken(env);
  const url = new URL(path.startsWith('http') ? path : `${CALENDAR_API}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const message =
      data?.error?.message || data?.error_description || `Google Calendar API ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.details = data?.error || data;
    throw err;
  }
  return data;
}

export async function getCalendar(env) {
  const id = encodeURIComponent(calendarId(env));
  const meta = await calendarFetch(env, `/calendars/${id}`);
  // events.list returns accessRole; metadata endpoint does not
  const probe = await calendarFetch(env, `/calendars/${id}/events`, {
    query: { maxResults: 1, singleEvents: 'true' },
  });
  const sa = parseServiceAccount(env);
  return {
    id: meta.id,
    summary: meta.summary,
    description: meta.description,
    timeZone: meta.timeZone,
    accessRole: probe.accessRole || 'unknown',
    serviceAccount: sa.client_email,
    canReadDetails: ['reader', 'writer', 'owner'].includes(probe.accessRole),
    canWrite: ['writer', 'owner'].includes(probe.accessRole),
  };
}

export function normalizeEvent(item) {
  if (!item) return null;
  return {
    id: item.id,
    status: item.status,
    summary: item.summary || null,
    description: item.description || null,
    location: item.location || null,
    start: item.start || null,
    end: item.end || null,
    htmlLink: item.htmlLink || null,
    iCalUID: item.iCalUID || null,
    updated: item.updated || null,
    visibility: item.visibility || null,
    recurringEventId: item.recurringEventId || null,
    attendees: item.attendees || null,
    organizer: item.organizer || null,
    hangoutLink: item.hangoutLink || null,
    busy: !item.summary,
  };
}

export async function listEvents(env, opts = {}) {
  const id = encodeURIComponent(calendarId(env));
  const maxResults = Math.min(Number(opts.maxResults) || 50, 250);
  const data = await calendarFetch(env, `/calendars/${id}/events`, {
    query: {
      singleEvents: opts.singleEvents === false ? 'false' : 'true',
      orderBy: 'startTime',
      maxResults: String(maxResults),
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      pageToken: opts.pageToken,
      q: opts.q,
      showDeleted: opts.showDeleted ? 'true' : undefined,
    },
  });
  return {
    calendar: data.summary,
    description: data.description,
    timeZone: data.timeZone,
    accessRole: data.accessRole,
    nextPageToken: data.nextPageToken || null,
    items: (data.items || []).map(normalizeEvent),
    rawCount: (data.items || []).length,
  };
}

export async function listAllEvents(env, opts = {}) {
  const cap = Math.min(Number(opts.cap) || 500, 2000);
  const items = [];
  let pageToken = undefined;
  let accessRole = null;
  let meta = {};
  while (items.length < cap) {
    const page = await listEvents(env, {
      ...opts,
      maxResults: Math.min(250, cap - items.length),
      pageToken,
    });
    accessRole = page.accessRole;
    meta = { calendar: page.calendar, timeZone: page.timeZone, description: page.description };
    items.push(...page.items);
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return { ...meta, accessRole, items, truncated: items.length >= cap };
}

export async function getEvent(env, eventId) {
  const id = encodeURIComponent(calendarId(env));
  const item = await calendarFetch(env, `/calendars/${id}/events/${encodeURIComponent(eventId)}`);
  return normalizeEvent(item);
}

export async function createEvent(env, payload) {
  const id = encodeURIComponent(calendarId(env));
  const item = await calendarFetch(env, `/calendars/${id}/events`, {
    method: 'POST',
    body: payload,
  });
  return normalizeEvent(item);
}

export async function updateEvent(env, eventId, payload) {
  const id = encodeURIComponent(calendarId(env));
  const item = await calendarFetch(env, `/calendars/${id}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: payload,
  });
  return normalizeEvent(item);
}

export async function deleteEvent(env, eventId) {
  const id = encodeURIComponent(calendarId(env));
  await calendarFetch(env, `/calendars/${id}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
  });
  return { deleted: true, id: eventId };
}

async function probe(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err.message, status: err.status || 500, details: err.details };
  }
}

/**
 * Live checks mapped 1:1 to Grok's "Select what Grok can access" Calendar boxes.
 */
export async function runPermissionChecks(env) {
  const id = calendarId(env);
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const [listProbe, eventsProbe, freeBusyProbe, metaProbe] = await Promise.all([
    probe(() =>
      calendarFetch(env, '/users/me/calendarList', {
        query: { maxResults: 250, showHidden: 'true', showDeleted: 'false' },
      })
    ),
    probe(() => listAllEvents(env, { timeMin, timeMax, cap: 250 })),
    probe(() =>
      calendarFetch(env, '/freeBusy', {
        method: 'POST',
        body: { timeMin, timeMax, items: [{ id }] },
      })
    ),
    probe(() => getCalendar(env)),
  ]);

  const calendars = (listProbe.data?.items || []).map((c) => ({
    id: c.id,
    summary: c.summary,
    accessRole: c.accessRole,
    primary: Boolean(c.primary),
    hidden: Boolean(c.hidden),
    selected: c.selected !== false,
  }));
  const targetOnList = calendars.some((c) => (c.id || '').toLowerCase() === id.toLowerCase());

  const events = eventsProbe.data?.items || [];
  const titled = events.filter((e) => e.summary).length;
  const busyOnly = events.filter((e) => e.busy).length;
  const accessRole = eventsProbe.data?.accessRole || metaProbe.data?.accessRole || 'unknown';
  const canReadDetails = ['reader', 'writer', 'owner'].includes(accessRole);
  const canWrite = ['writer', 'owner'].includes(accessRole);

  const busyCal = freeBusyProbe.data?.calendars?.[id] || freeBusyProbe.data?.calendars?.[id.toLowerCase()];
  const busyBlocks = busyCal?.busy?.length || 0;
  const freeBusyErrors = busyCal?.errors || freeBusyProbe.data?.calendars?.[id]?.errors;

  const checks = [
    {
      id: 'calendar_list',
      grokLabel: 'See the list of Google Calendars that you’re subscribed to',
      scope: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      api: 'GET /users/me/calendarList',
      status: listProbe.ok ? (calendars.length > 0 ? 'pass' : 'partial') : 'fail',
      passed: Boolean(listProbe.ok && calendars.length > 0),
      detail: listProbe.ok
        ? calendars.length
          ? `Listed ${calendars.length} subscribed calendar${calendars.length === 1 ? '' : 's'}${targetOnList ? `; includes ${id}` : `; ${id} not on calendarList (still reachable by id)`}.`
          : 'calendarList succeeded but returned 0 calendars. Shared calendars can still be opened by id.'
        : listProbe.error,
    },
    {
      id: 'events_view_edit',
      grokLabel: 'View and edit events on all of your calendars',
      scope: 'https://www.googleapis.com/auth/calendar.events',
      api: 'GET/POST …/calendars/{id}/events',
      status: canWrite ? 'pass' : canReadDetails ? 'partial' : 'fail',
      passed: canWrite,
      view: canReadDetails,
      edit: canWrite,
      detail: canWrite
        ? `Writer ACL — can view and edit. ${titled}/${events.length} events in the next 14 days have titles.`
        : canReadDetails
          ? `Reader ACL — can view all event details (${titled}/${events.length} titled) but cannot create, patch, or restore.`
          : eventsProbe.ok
            ? `accessRole=${accessRole}. Event titles are hidden (${busyOnly} busy blocks). Share as “See all event details” or “Make changes to events”.`
            : eventsProbe.error,
    },
    {
      id: 'freebusy',
      grokLabel: 'View your availability in your calendars',
      scope: 'https://www.googleapis.com/auth/calendar.freebusy',
      api: 'POST /freeBusy',
      status: freeBusyProbe.ok && !freeBusyErrors ? 'pass' : 'fail',
      passed: Boolean(freeBusyProbe.ok && !freeBusyErrors),
      detail: freeBusyProbe.ok
        ? freeBusyErrors
          ? `freeBusy returned errors: ${JSON.stringify(freeBusyErrors)}`
          : `Availability readable — ${busyBlocks} busy block${busyBlocks === 1 ? '' : 's'} in the next 14 days.`
        : freeBusyProbe.error,
    },
    {
      id: 'see_and_download',
      grokLabel: 'See and download any calendar that you can access using your Google Calendar',
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      api: 'GET /calendars/{id} + events list / ICS export',
      status: canReadDetails && events.length > 0 && titled === events.length ? 'pass' : canReadDetails ? 'partial' : 'fail',
      passed: Boolean(canReadDetails && events.length > 0 && titled === events.length),
      allEventsVisible: Boolean(canReadDetails && titled === events.length),
      detail: canReadDetails
        ? titled === events.length
          ? `All ${events.length} events in the next 14 days expose titles, times, and downloadable fields (ICS). Truncated=${Boolean(eventsProbe.data?.truncated)}.`
          : `${titled}/${events.length} events have titles; ${busyOnly} still look like Busy.`
        : metaProbe.ok
          ? `Calendar metadata readable (${metaProbe.data?.summary}) but event details are not (accessRole=${accessRole}).`
          : metaProbe.error,
    },
  ];

  const selectAll = checks.every((c) => c.status === 'pass');
  const allEventsInTarget =
    canReadDetails && events.length > 0 && titled === events.length && !eventsProbe.data?.truncated;

  return {
    checkedAt: now.toISOString(),
    calendarId: id,
    accessRole,
    canReadDetails,
    canWrite,
    serviceAccount: metaProbe.data?.serviceAccount || null,
    grok: {
      source: 'Select what Grok can access → Google Calendar',
      selectAll,
      equivalent:
        'These four boxes match Grok Calendar OAuth. This Worker uses a service account with scope https://www.googleapis.com/auth/calendar plus the calendar share ACL.',
    },
    checks,
    calendars,
    events: {
      window: { timeMin, timeMax },
      count: events.length,
      titled,
      busyOnly,
      truncated: Boolean(eventsProbe.data?.truncated),
      allEventsVisible: allEventsInTarget,
      sample: events.slice(0, 12).map((e) => ({
        summary: e.summary,
        start: e.start,
        end: e.end,
        busy: e.busy,
      })),
    },
  };
}
