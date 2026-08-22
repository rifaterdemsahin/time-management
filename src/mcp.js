import {
  getCalendar,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  listAllEvents,
  calendarId,
  runPermissionChecks,
} from './google.js';
import { json, defaultWindow } from './calendar-api.js';

const SERVER_INFO = {
  name: 'pexabo-calendar-backup',
  version: '1.0.0',
  title: 'Pexabo Calendar Backup MCP',
};

export const TOOLS = [
  {
    name: 'calendar_status',
    description: 'Show connection status for the info@pexabo.com Google Calendar (access role, timezone, service account).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'calendar_permission_check',
    description: 'Live-check Grok Google Calendar access boxes (calendar list, view/edit events, freebusy, see-and-download) against info@pexabo.com.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'calendar_list_events',
    description: 'List events on info@pexabo.com. Defaults to the next 14 days. With freeBusyReader ACL, summaries are hidden and shown as Busy.',
    inputSchema: {
      type: 'object',
      properties: {
        timeMin: { type: 'string', description: 'RFC3339 lower bound (inclusive start window)' },
        timeMax: { type: 'string', description: 'RFC3339 upper bound' },
        maxResults: { type: 'integer', minimum: 1, maximum: 250 },
        pageToken: { type: 'string' },
        q: { type: 'string', description: 'Free-text search (requires reader access)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'calendar_get_event',
    description: 'Get a single event by Google Calendar event id.',
    inputSchema: {
      type: 'object',
      properties: { eventId: { type: 'string' } },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'calendar_create_event',
    description: 'Create an event on info@pexabo.com. Requires writer ACL.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        start: { type: 'object' },
        end: { type: 'object' },
      },
      required: ['start', 'end'],
      additionalProperties: true,
    },
  },
  {
    name: 'calendar_update_event',
    description: 'Patch an event. Requires writer ACL.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        summary: { type: 'string' },
        description: { type: 'string' },
        start: { type: 'object' },
        end: { type: 'object' },
      },
      required: ['eventId'],
      additionalProperties: true,
    },
  },
  {
    name: 'calendar_delete_event',
    description: 'Delete an event by id. Requires writer ACL.',
    inputSchema: {
      type: 'object',
      properties: { eventId: { type: 'string' } },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'calendar_backup',
    description: 'Snapshot events in a time window into Cloudflare KV. Returns a backup id.',
    inputSchema: {
      type: 'object',
      properties: {
        timeMin: { type: 'string' },
        timeMax: { type: 'string' },
        cap: { type: 'integer', minimum: 1, maximum: 2000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'calendar_list_backups',
    description: 'List KV snapshots previously taken by calendar_backup.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'calendar_get_backup',
    description: 'Fetch a full backup snapshot by id.',
    inputSchema: {
      type: 'object',
      properties: { backupId: { type: 'string' } },
      required: ['backupId'],
      additionalProperties: false,
    },
  },
  {
    name: 'calendar_restore_backup',
    description: 'Re-create events from a snapshot. Requires writer ACL. Limited to 25 events by default.',
    inputSchema: {
      type: 'object',
      properties: {
        backupId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['backupId'],
      additionalProperties: false,
    },
  },
];

async function callTool(env, name, args = {}) {
  switch (name) {
    case 'calendar_status':
      return { calendar: await getCalendar(env) };
    case 'calendar_permission_check':
      return await runPermissionChecks(env);
    case 'calendar_list_events': {
      const win = defaultWindow();
      return await listEvents(env, {
        timeMin: args.timeMin || win.timeMin,
        timeMax: args.timeMax || win.timeMax,
        maxResults: args.maxResults || 50,
        pageToken: args.pageToken,
        q: args.q,
      });
    }
    case 'calendar_get_event':
      return { event: await getEvent(env, args.eventId) };
    case 'calendar_create_event':
      return { event: await createEvent(env, args) };
    case 'calendar_update_event': {
      const { eventId, ...rest } = args;
      return { event: await updateEvent(env, eventId, rest) };
    }
    case 'calendar_delete_event':
      return await deleteEvent(env, args.eventId);
    case 'calendar_backup': {
      const win = defaultWindow();
      const timeMin = args.timeMin || win.timeMin;
      const timeMax = args.timeMax || win.timeMax;
      const snapshot = await listAllEvents(env, { timeMin, timeMax, cap: args.cap || 500 });
      const id = `bck_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
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
      const raw = await env.BACKUPS.get('backup:index');
      const index = raw ? JSON.parse(raw) : [];
      index.unshift({
        id,
        createdAt: record.createdAt,
        eventCount: record.eventCount,
        timeMin,
        timeMax,
        accessRole: record.accessRole,
        truncated: record.truncated,
      });
      await env.BACKUPS.put('backup:index', JSON.stringify(index.slice(0, 50)));
      return {
        id,
        createdAt: record.createdAt,
        eventCount: record.eventCount,
        timeMin,
        timeMax,
        accessRole: record.accessRole,
      };
    }
    case 'calendar_list_backups': {
      const raw = await env.BACKUPS.get('backup:index');
      return { backups: raw ? JSON.parse(raw) : [] };
    }
    case 'calendar_get_backup': {
      const raw = await env.BACKUPS.get(`backup:${args.backupId}`);
      if (!raw) {
        const err = new Error('Backup not found');
        err.status = 404;
        throw err;
      }
      return { backup: JSON.parse(raw) };
    }
    case 'calendar_restore_backup': {
      const raw = await env.BACKUPS.get(`backup:${args.backupId}`);
      if (!raw) {
        const err = new Error('Backup not found');
        err.status = 404;
        throw err;
      }
      const backup = JSON.parse(raw);
      const limit = Math.min(Number(args.limit) || 25, 100);
      const results = [];
      for (const event of backup.events.slice(0, limit)) {
        try {
          const created = await createEvent(env, {
            summary: event.summary || 'Restored busy block',
            description: event.description || `Restored from backup ${args.backupId}`,
            location: event.location || undefined,
            start: event.start,
            end: event.end,
          });
          results.push({ ok: true, id: created.id, sourceId: event.id });
        } catch (err) {
          results.push({ ok: false, sourceId: event.id, error: err.message, status: err.status });
          break;
        }
      }
      return { restored: results.length, results };
    }
    default: {
      const err = new Error(`Unknown tool: ${name}`);
      err.status = 400;
      throw err;
    }
  }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

export async function handleMcp(request, env, path) {
  const method = request.method.toUpperCase();

  if (method === 'GET' && (path === '/mcp' || path === '/mcp/tools' || path === '/api/mcp/tools')) {
    return json({
      ok: true,
      protocol: 'jsonrpc-2.0',
      endpoint: '/mcp',
      server: SERVER_INFO,
      tools: TOOLS,
      example: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'calendar_list_events', arguments: {} },
      },
    });
  }

  if (method !== 'POST') {
    return json({ ok: false, error: 'MCP JSON-RPC accepts POST /mcp' }, 405);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), 400);
  }

  const messages = Array.isArray(payload) ? payload : [payload];
  const replies = [];

  for (const msg of messages) {
    const id = msg?.id ?? null;
    try {
      if (msg?.jsonrpc !== '2.0' || !msg.method) {
        replies.push(rpcError(id, -32600, 'Invalid Request'));
        continue;
      }
      if (msg.method === 'initialize') {
        replies.push(
          rpcResult(id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          })
        );
        continue;
      }
      if (msg.method === 'notifications/initialized' || msg.method.startsWith('notifications/')) {
        continue;
      }
      if (msg.method === 'tools/list' || msg.method === 'list_tools') {
        replies.push(rpcResult(id, { tools: TOOLS }));
        continue;
      }
      if (msg.method === 'tools/call' || msg.method === 'call_tool') {
        const name = msg.params?.name;
        const args = msg.params?.arguments || msg.params?.args || {};
        if (!name) {
          replies.push(rpcError(id, -32602, 'Missing params.name'));
          continue;
        }
        const result = await callTool(env, name, args);
        replies.push(
          rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
            isError: false,
          })
        );
        continue;
      }
      if (msg.method.startsWith('calendar_')) {
        const result = await callTool(env, msg.method, msg.params || {});
        replies.push(rpcResult(id, result));
        continue;
      }
      replies.push(rpcError(id, -32601, `Method not found: ${msg.method}`));
    } catch (err) {
      replies.push(
        rpcError(id, err.status === 404 ? -32004 : -32000, err.message, {
          status: err.status,
          details: err.details,
        })
      );
    }
  }

  if (Array.isArray(payload)) return json(replies);
  return json(replies[0] || rpcError(null, -32600, 'Empty batch'));
}

export { callTool };
