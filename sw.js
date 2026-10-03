/* Météo des spéciales, Team HCH Motorsport : service worker (version 13)

   Rôle : garder la page de l'appli dans le téléphone pour qu'elle s'ouvre sans réseau (zones blanches de Corse).
   - La page (index.html contient tout : polices, logos, carte, tracés) est cherchée sur le réseau d'abord, donc une nouvelle
     version mise en ligne remplace l'ancienne dès l'ouverture suivante. Sans réseau, ou si le réseau met plus de 4 secondes
     à répondre, on ouvre la copie gardée en mémoire.
   - Une page de connexion d'hôtel (wifi à portail) n'est jamais gardée à la place de l'appli : on vérifie que c'est bien elle.
   - Les fonds de carte déjà regardés sont gardés (300 au plus, 7 jours) pour que la carte ne soit pas vide hors réseau.
   - Les données météo ne passent pas par ici : l'appli les garde elle-même dans le téléphone.
   - L'appli peut demander ici si la page est bien gardée (message « status ») : elle n'affiche « prêt » qu'avec cette confirmation. */

const VERSION = 'v13';
const CACHE = 'tdc-app-' + VERSION;
const TILES = 'tdc-tiles-1';
const SCOPE_PATH = new URL(self.registration.scope).pathname;
const INDEX = new URL('index.html', self.registration.scope).href;
const MARK = 'name="tdc-app" content="meteo"';
const WAIT_NET = 4000;
const WARM_NET = 15000;
const MAX_TILES = 300;
const TILE_MAX_AGE = 7 * 24 * 3600 * 1000;
const STAMP = 'x-cached-at';

const OFFLINE_HTML = '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Hors réseau</title><body style="font:16px/1.5 system-ui,sans-serif;margin:0;padding:32px 24px;background:#C6C6C6;color:#1F1F1F">' +
  '<h1 style="font-size:22px;margin:0 0 12px">Hors réseau</h1><p>L’appli n’est pas encore gardée dans ce téléphone. Ouvre-la une fois avec du réseau (wifi ou 4G), puis touche «&nbsp;Tout charger&nbsp;».</p></body></html>';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    try {
      const res = await fetch(INDEX, { cache: 'reload' });
      if (await isApp(res)) await (await caches.open(CACHE)).put(INDEX, res);
    } catch (err) { /* pas de réseau (ou mémoire pleine) à l'installation : la première ouverture avec réseau s'en chargera, et l'appli le signale tant que la page n'est pas gardée */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      const cur = await caches.open(CACHE);
      /* si la copie de cette version manque, on reprend celle de la version précédente avant de la supprimer */
      if (!(await cur.match(INDEX))) {
        for (const k of keys) {
          if (k.startsWith('tdc-app-') && k !== CACHE) {
            const old = await (await caches.open(k)).match(INDEX);
            if (old) { try { await cur.put(INDEX, old); } catch (err) { /* mémoire pleine : tant pis */ } break; }
          }
        }
      }
      await Promise.all(keys.filter((k) => k.startsWith('tdc-app-') && k !== CACHE).map((k) => caches.delete(k)));
    } catch (err) { /* le ménage n'est jamais bloquant */ }
    await self.clients.claim();
  })());
});

/* La réponse est-elle bien notre page ? (et pas une page de connexion d'hôtel ou une erreur) */
async function isApp(res) {
  if (!res || !res.ok) return false;
  try { return (await res.clone().text()).includes(MARK); } catch (err) { return false; }
}

/* Cherche la page sur le réseau (en demandant au serveur si elle a changé) et la garde si c'est bien notre appli.
   Si la garde échoue (mémoire pleine), la page récupérée sert quand même pour cette ouverture. */
async function refreshIndex() {
  const res = await fetch(INDEX, { cache: 'no-cache' });
  if (await isApp(res)) {
    try { await (await caches.open(CACHE)).put(INDEX, res.clone()); } catch (err) { /* mémoire pleine */ }
    return res;
  }
  return { notApp: true, res };
}
async function cachedIndex() {
  try { return await (await caches.open(CACHE)).match(INDEX); } catch (err) { return undefined; }
}
/* Réponse à l'ouverture : le réseau s'il répond vite, sinon la copie gardée */
async function page(update) {
  const cached = await cachedIndex();
  try {
    const out = await Promise.race([update, new Promise((_, no) => setTimeout(() => no(new Error('lent')), cached ? WAIT_NET : 25000))]);
    if (out && out.notApp) return cached || out.res;
    return out;
  } catch (err) {
    return cached || new Response(OFFLINE_HTML, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
}

/* Fonds de carte : gardés avec leur date (en-tête x-cached-at, car l'en-tête Date du serveur n'est pas lisible depuis une autre origine) */
async function tile(url, evt) {
  let cache = null, hit = null;
  try { cache = await caches.open(TILES); hit = await cache.match(url); } catch (err) { /* pas de cache : on passe directement par le réseau */ }
  if (hit) {
    const at = Number(hit.headers.get(STAMP)) || 0;
    if ((at && Date.now() - at < TILE_MAX_AGE) || self.navigator.onLine === false) return hit;
  }
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (res.ok) {
      if (cache) evt.waitUntil(putTile(cache, url, res.clone()));
      return res;
    }
    return hit || res;
  } catch (err) {
    return hit || Response.error();
  }
}
async function putTile(cache, url, res) {
  try {
    const headers = new Headers(res.headers);
    headers.set(STAMP, String(Date.now()));
    await cache.put(url, new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers }));
    const keys = await cache.keys();
    if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => cache.delete(k)));
  } catch (err) { /* mémoire pleine : cette tuile ne sera pas gardée, la carte reste utilisable */ }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate' && url.origin === self.location.origin &&
      (url.pathname === SCOPE_PATH || url.pathname === SCOPE_PATH + 'index.html')) {
    const update = refreshIndex();
    e.waitUntil(update.catch(() => {}));      /* la mise à jour de la copie continue même si on a déjà répondu avec l'ancienne */
    e.respondWith(page(update));
    return;
  }
  if (url.hostname === 'tile.openstreetmap.org') e.respondWith(tile(req.url, e));
});

/* L'appli demande : la page est-elle gardée ? (warm : on la retélécharge d'abord, au plus 15 s) */
self.addEventListener('message', (e) => {
  const d = e.data || {};
  const port = e.ports && e.ports[0];
  if (d.type !== 'status' || !port) return;
  e.waitUntil((async () => {
    if (d.warm) {
      try {
        await Promise.race([refreshIndex(), new Promise((_, no) => setTimeout(() => no(new Error('lent')), WARM_NET))]);
      } catch (err) { /* pas de réseau : on répond avec ce qui est gardé */ }
    }
    const cached = !!(await cachedIndex());
    port.postMessage({ version: VERSION, cached });
  })());
});
