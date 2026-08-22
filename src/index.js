import pushPage from '../public/push.html';
import explainerPage from '../public/explainer.html';
import architecturePage from '../public/architecture.html';
import permissionsPage from '../public/permissions.html';
import styles from '../public/styles.css';
import { handleApi } from './calendar-api.js';
import { handleMcp } from './mcp.js';

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html;charset=UTF-8',
      'cache-control': 'public, max-age=120',
      'x-powered-by': 'Cloudflare Worker',
      'x-calendar': 'info@pexabo.com',
    },
  });
}

const notFoundPage = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found — Pexabo Calendar</title>
<link rel="stylesheet" href="/styles.css">
</head><body>
<div class="container">
  <nav class="nav-bar">
    <a class="nav-brand" href="/">📅 Pexabo Calendar</a>
    <div class="nav-links">
      <a class="nav-link" href="/push">Push</a>
      <a class="nav-link" href="/explainer">Explainer</a>
      <a class="nav-link" href="/architecture">Architecture</a>
      <a class="nav-link" href="/permissions">Permissions</a>
    </div>
  </nav>
  <section class="card">
    <p class="kicker">404</p>
    <h1>This route is not on the edge map.</h1>
    <p class="lede">Try the <a href="/push">Push console</a> or the <a href="/api/health">health API</a>.</p>
  </section>
</div>
</body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (path === '/styles.css') {
      return new Response(styles, {
        headers: {
          'content-type': 'text/css;charset=UTF-8',
          'cache-control': 'public, max-age=3600',
        },
      });
    }

    if (path === '/mcp' || path.startsWith('/mcp/') || path.startsWith('/api/mcp')) {
      return handleMcp(request, env, path);
    }

    if (path.startsWith('/api/')) {
      return handleApi(request, env, undefined, path);
    }

    if (
      path === '/' ||
      path === '/push' ||
      path === '/push.html' ||
      path === '/index.html' ||
      path === '/home'
    ) {
      return html(pushPage);
    }

    if (path === '/explainer' || path === '/explainer.html' || path === '/about') {
      return html(explainerPage);
    }

    if (path === '/architecture' || path === '/architecture.html' || path === '/arch') {
      return html(architecturePage);
    }

    if (path === '/permissions' || path === '/permissions.html' || path === '/acl') {
      return html(permissionsPage);
    }

    return html(notFoundPage, 404);
  },
};
