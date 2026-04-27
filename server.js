const http = require('http');
const https = require('https');
const fs = require('fs');

const HS_TOKEN = process.env.HS_TOKEN || '';
const PORT = process.env.PORT || 3000;
const CACHE_FILE = '/tmp/geocache.json';
const DATA_FILE = '/tmp/clientsdata.json';
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// Load geocache from disk
function loadGeoCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } 
  catch { return {}; }
}

// Save geocache to disk
function saveGeoCache(cache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch {}
}

// Load cached client data
function loadDataCache() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Date.now() - d.timestamp < CACHE_TTL) return d;
  } catch {}
  return null;
}

function saveDataCache(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ timestamp: Date.now(), data })); } catch {}
}

// Geocode via Nominatim with fallback strategies
function nominatimQuery(q) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1&countrycodes=fr,be,ch,lu`;
    const req = https.get(url, { headers: { 'User-Agent': 'CSMMap/1.0' } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          if (d && d[0]) resolve({ lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) });
          else resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

async function geocode(rawAddress, rawZip, rawCity, rawCountry) {
  // Clean up messy data
  let city = (rawCity || '').replace(/^\d{5}\s*/, '').trim(); // remove zip from city
  let zip = (rawZip || '').replace(/\D/g, '').substring(0, 5); // keep only digits
  let address = (rawAddress || '').trim();
  let country = (rawCountry || 'France').trim();
  
  // If address is just a zip code, clear it
  if (/^\d{4,5}$/.test(address)) address = '';

  // Strategy 1: full address
  if (address && zip && city) {
    const r = await nominatimQuery(`${address}, ${zip} ${city}, ${country}`);
    if (r) return r;
    await new Promise(res => setTimeout(res, 300));
  }

  // Strategy 2: zip + city
  if (zip && city) {
    const r = await nominatimQuery(`${zip} ${city}, ${country}`);
    if (r) return r;
    await new Promise(res => setTimeout(res, 300));
  }

  // Strategy 3: city only
  if (city) {
    const r = await nominatimQuery(`${city}, ${country}`);
    if (r) return r;
    await new Promise(res => setTimeout(res, 300));
  }

  // Strategy 4: zip only (get city center)
  if (zip && zip.length >= 4) {
    const r = await nominatimQuery(`${zip}, ${country}`);
    if (r) return r;
  }

  return null;
}

// Fetch all HubSpot customers with geocoding (server-side)
async function fetchAllClients() {
  // Check cache first
  const cached = loadDataCache();
  if (cached) {
    console.log('Serving from cache:', cached.data.length, 'clients');
    return cached.data;
  }

  console.log('Fetching fresh data from HubSpot...');
  const geoCache = loadGeoCache();
  
  // Fetch owners
  const owners = {};
  let ownerAfter = '';
  while (true) {
    const url = ownerAfter ? `/crm/v3/owners?limit=100&after=${encodeURIComponent(ownerAfter)}` : `/crm/v3/owners?limit=100`;
    const res = await hsApiGet(url);
    if (!res.results) break;
    res.results.forEach(o => {
      owners[o.id] = `${o.firstName || ''} ${o.lastName || ''}`.trim() || o.email || `Owner ${o.id}`;
    });
    if (!res.paging?.next?.after) break;
    ownerAfter = res.paging.next.after;
  }
  console.log('Owners loaded:', Object.keys(owners).length);

  // Fetch companies
  const props = ['name','city','address','zip','country','latitude','longitude',
                 'hubspot_owner_id','phone','reseau','death_quantity'];
  const all = [];
  let after = undefined;
  let page = 0;
  while (true) {
    page++;
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'customer' }] }],
      properties: props,
      limit: 100
    };
    if (after) body.after = after;
    const res = await hsApiPost('/crm/v3/objects/companies/search', body);
    if (!res.results || res.results.length === 0) break;
    all.push(...res.results);
    if (!res.paging?.next?.after) break;
    after = res.paging.next.after;
    if (page > 50) break;
  }
  console.log('Companies loaded:', all.length);

  // Geocode all (server-side with cache)
  const clients = [];
  for (const co of all) {
    const p = co.properties;
    let lat = parseFloat(p.latitude);
    let lng = parseFloat(p.longitude);

    if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
      const hasLocation = p.address || p.zip || p.city;
      if (hasLocation) {
        const cacheKey = [p.address, p.zip, p.city, p.country].join("|");
        if (geoCache[cacheKey]) {
          lat = geoCache[cacheKey].lat;
          lng = geoCache[cacheKey].lng;
        } else {
          await new Promise(r => setTimeout(r, 250)); // rate limit Nominatim
          const coords = await geocode(p.address, p.zip, p.city, p.country);
          if (coords) {
            geoCache[cacheKey] = coords;
            lat = coords.lat;
            lng = coords.lng;
          }
        }
      }
    }

    if (!lat || !lng || isNaN(lat) || isNaN(lng)) continue;

    const ownerId = p.hubspot_owner_id || '';
    clients.push({
      id: co.id,
      name: p.name || 'Sans nom',
      city: (p.city || '').trim(),
      address: p.address || '',
      zip: p.zip || '',
      country: (p.country || '').trim(),
      lat, lng,
      ownerId,
      ownerName: owners[ownerId] || 'Non assigné',
      phone: p.phone || '',
      reseau: p.reseau || '',
      death_quantity: p.death_quantity || '',
      hsUrl: `https://app.hubspot.com/contacts/7141150/company/${co.id}`
    });
  }

  saveGeoCache(geoCache);
  saveDataCache(clients);
  console.log('Geocoded and cached:', clients.length, 'clients');
  return clients;
}

// HubSpot API helpers
function hsApiGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.hubapi.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function hsApiPost(path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: 'api.hubapi.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HS_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// Prefetch on startup
let prefetchDone = false;
setTimeout(async () => {
  try {
    await fetchAllClients();
    prefetchDone = true;
    console.log('Prefetch complete');
  } catch(e) {
    console.error('Prefetch error:', e.message);
  }
}, 2000);

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Serve map HTML
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = fs.readFileSync('./index.html', 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      res.writeHead(500); res.end('Error loading page');
    }
    return;
  }

  // API: get all clients (geocoded, cached)
  if (url.pathname === '/api/clients') {
    try {
      const clients = await fetchAllClients();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(clients));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: force refresh cache
  if (url.pathname === '/api/refresh') {
    try { fs.unlinkSync(DATA_FILE); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Cache invalidé, prochain chargement sera frais' }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`CSM Map server on port ${PORT}`));
