import {
  calendarId,
  getCalendar,
  listEvents,
  listAllEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  runPermissionChecks,
} from './google.js';

const INDEX_KEY = 'backup:index';
const MAX_INDEX = 50;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      ...extra,
    },
  });
}

function errorResponse(err, fallback = 500) {
  const status = Number(err.status) || fallback;
  return json(
    {
      ok: false,
      error: err.message || 'Unexpected error',
      details: err.details || undefined,
      hint:
        status === 403
          ? 'Calendar ACL is not writer. Share info@pexabo.com as "See all event details" (read) or "Make changes to events" (write) — see /permissions.'
          : status === 503
            ? 'Deploy with npm run deploy:azure so GOOGLE_SERVICE_ACCOUNT_JSON is copied from Azure Key Vault into the Worker secret.'
            : undefined,
    },
    status
  );
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function defaultWindow() {
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  return { timeMin, timeMax };
}

function backupId() {
  return `bck_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

async function readIndex(env) {
  const raw = await env.BACKUPS.get(INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeIndex(env, entries) {
  await env.BACKUPS.put(INDEX_KEY, JSON.stringify(entries.slice(0, MAX_INDEX)));
}

export async function handleApi(request, env, ctx, path) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return json({ ok: true });
  }

  try {
    if (path === '/api/health' && method === 'GET') {
      return json({
        ok: true,
        status: 'ok',
        service: 'pexabo-calendar-backup',
        calendar: calendarId(env),
        timestamp: new Date().toISOString(),
        datacenter: request.cf?.colo || 'LOCAL',
        country: request.cf?.country || 'UNKNOWN',
        city: request.cf?.city || 'UNKNOWN',
        runtime: 'V8 Isolate',
        tier: 'Cloudflare Workers Free (100k req/day)',
      });
    }

    if ((path === '/api/calendar' || path === '/api/status') && method === 'GET') {
      const cal = await getCalendar(env);
      return json({ ok: true, calendar: cal });
    }

    if (
      (path === '/api/permissions' ||
        path === '/api/permissions/check' ||
        path === '/api/checks') &&
      method === 'GET'
    ) {
      const report = await runPermissionChecks(env);
      return json({ ok: true, ...report });
    }

    if (path === '/api/events' && method === 'GET') {
      const { timeMin, timeMax } = defaultWindow();
      const result = await listEvents(env, {
        timeMin: url.searchParams.get('timeMin') || timeMin,
        timeMax: url.searchParams.get('timeMax') || timeMax,
        maxResults: url.searchParams.get('maxResults') || 50,
        pageToken: url.searchParams.get('pageToken') || undefined,
        q: url.searchParams.get('q') || undefined,
      });
      return json({ ok: true, ...result });
    }

    if (path === '/api/events' && method === 'POST') {
      const body = await readJson(request);
      const created = await createEvent(env, body);
      return json({ ok: true, event: created }, 201);
    }

    const eventMatch = path.match(/^\/api\/events\/([^/]+)$/);
    if (eventMatch && method === 'GET') {
      const event = await getEvent(env, decodeURIComponent(eventMatch[1]));
      return json({ ok: true, event });
    }
    if (eventMatch && method === 'PATCH') {
      const body = await readJson(request);
      const event = await updateEvent(env, decodeURIComponent(eventMatch[1]), body);
      return json({ ok: true, event });
    }
    if (eventMatch && method === 'DELETE') {
      const result = await deleteEvent(env, decodeURIComponent(eventMatch[1]));
      return json({ ok: true, ...result });
    }

    if (path === '/api/backup' && method === 'POST') {
      const body = await readJson(request);
      const win = defaultWindow();
      const timeMin = body.timeMin || url.searchParams.get('timeMin') || win.timeMin;
      const timeMax = body.timeMax || url.searchParams.get('timeMax') || win.timeMax;
      const cap = Number(body.cap) || 500;
      const snapshot = await listAllEvents(env, { timeMin, timeMax, cap });
      const id = backupId();
      const record = {
        id,
        createdAt: new Date().toISOString(),
        calendarId: calendarId(env),
        timeMin,
        timeMax,
        accessRole: snapshot.accessRole,
        eventCount: snapshot.items.length,
        truncated: snapshot.truncated,
        timeZone: snapshot.timeZone,
        calendar: snapshot.calendar,
        events: snapshot.items,
      };
      await env.BACKUPS.put(`backup:${id}`, JSON.stringify(record));
      const index = await readIndex(env);
      index.unshift({
        id,
        createdAt: record.createdAt,
        eventCount: record.eventCount,
        timeMin,
        timeMax,
        accessRole: record.accessRole,
        truncated: record.truncated,
      });
      await writeIndex(env, index);
      return json({
        ok: true,
        backup: {
          id,
          createdAt: record.createdAt,
          eventCount: record.eventCount,
          timeMin,
          timeMax,
          accessRole: record.accessRole,
          truncated: record.truncated,
        },
      }, 201);
    }

    if (path === '/api/backups' && method === 'GET') {
      const index = await readIndex(env);
      return json({ ok: true, backups: index });
    }

    const icsMatch = path.match(/^\/api\/backups\/([^/]+)\.ics$/);
    if (icsMatch && method === 'GET') {
      const id = decodeURIComponent(icsMatch[1]);
      const raw = await env.BACKUPS.get(`backup:${id}`);
      if (!raw) return json({ ok: false, error: 'Backup not found' }, 404);
      const backup = JSON.parse(raw);
      return new Response(toIcs(backup), {
        headers: {
          'content-type': 'text/calendar;charset=UTF-8',
          'content-disposition': `attachment; filename="${id}.ics"`,
          'cache-control': 'no-store',
        },
      });
    }

    const backupMatch = path.match(/^\/api\/backups\/([^/]+)$/);
    if (backupMatch && method === 'GET') {
      const id = decodeURIComponent(backupMatch[1]);
      const raw = await env.BACKUPS.get(`backup:${id}`);
      if (!raw) return json({ ok: false, error: 'Backup not found' }, 404);
      return json({ ok: true, backup: JSON.parse(raw) });
    }

    const restoreMatch = path.match(/^\/api\/backups\/([^/]+)\/restore$/);
    if (restoreMatch && method === 'POST') {
      const id = decodeURIComponent(restoreMatch[1]);
      const raw = await env.BACKUPS.get(`backup:${id}`);
      if (!raw) return json({ ok: false, error: 'Backup not found' }, 404);
      const backup = JSON.parse(raw);
      const body = await readJson(request);
      const limit = Math.min(Number(body.limit) || 25, 100);
      const results = [];
      for (const event of backup.events.slice(0, limit)) {
        try {
          const payload = {
            summary: event.summary || 'Restored busy block',
            description: event.description || `Restored from backup ${id}`,
            location: event.location || undefined,
            start: event.start,
            end: event.end,
          };
          const created = await createEvent(env, payload);
          results.push({ ok: true, id: created.id, sourceId: event.id });
        } catch (err) {
          results.push({ ok: false, sourceId: event.id, error: err.message, status: err.status });
          break;
        }
      }
      return json({ ok: results.every((r) => r.ok), restored: results.length, results });
    }

    return json({ ok: false, error: 'Not found' }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}

function icsDate(slot) {
  if (!slot) return '';
  if (slot.date) return slot.date.replace(/-/g, '');
  const dt = (slot.dateTime || '').replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return dt;
}

function escapeIcs(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function toIcs(backup) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Pexabo//Calendar Backup//EN',
    `X-WR-CALNAME:${escapeIcs(backup.calendar || 'Pexabo Team')}`,
    `X-WR-TIMEZONE:${escapeIcs(backup.timeZone || 'Europe/London')}`,
  ];
  for (const event of backup.events || []) {
    const stamp = (event.updated || backup.createdAt || '').replace(/[-:]/g, '').replace(/\.\d{3}Z/, 'Z');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${escapeIcs(event.iCalUID || event.id)}`);
    if (stamp) lines.push(`DTSTAMP:${stamp}`);
    const start = icsDate(event.start);
    const end = icsDate(event.end);
    if (event.start?.date) lines.push(`DTSTART;VALUE=DATE:${start}`);
    else if (start) lines.push(`DTSTART:${start}`);
    if (event.end?.date) lines.push(`DTEND;VALUE=DATE:${end}`);
    else if (end) lines.push(`DTEND:${end}`);
    lines.push(`SUMMARY:${escapeIcs(event.summary || 'Busy')}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeIcs(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeIcs(event.location)}`);
    lines.push(`STATUS:${escapeIcs((event.status || 'CONFIRMED').toUpperCase())}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

export { json, errorResponse, defaultWindow };
