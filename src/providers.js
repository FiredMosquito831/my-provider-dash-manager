// Per-service status fetchers for home-card summaries. Each takes a token, returns a small
// summary object, and THROWS a clean Error on failure (401/403 -> token problem). Read-only
// endpoints only — the app never mutates anything via API.
const net = require('electron').net;

async function fetchJson(url, headers, method = 'GET', body = undefined) {
  const resp = await net.fetch(url, { headers, method, body });
  if (resp.status === 401 || resp.status === 403) throw new Error('TOKEN_INVALID');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

const PROVIDERS = {
  vercel: {
    async validate(token) {
      const teams = await fetchJson('https://api.vercel.com/v2/teams?limit=5', { Authorization: `Bearer ${token}` });
      const projects = await fetchJson('https://api.vercel.com/v9/projects?limit=10', { Authorization: `Bearer ${token}` });
      let latest = null;
      try {
        const deps = await fetchJson('https://api.vercel.com/v6/deployments?limit=1', { Authorization: `Bearer ${token}` });
        const d = deps.deployments && deps.deployments[0];
        if (d) latest = { app: d.name, state: d.readyState, at: d.created };
      } catch {}
      return { summary: { projects: projects.projects ? projects.projects.length : 0, teams: teams.teams ? teams.teams.length : 0, latest } };
    },
  },
  supabase: {
    async validate(token) {
      const projects = await fetchJson('https://api.supabase.com/v1/projects', { Authorization: `Bearer ${token}` });
      return { summary: { projects: Array.isArray(projects) ? projects.length : 0, names: (projects || []).slice(0, 3).map(p => p.name) } };
    },
  },
  netlify: {
    async validate(token) {
      const sites = await fetchJson('https://api.netlify.com/api/v1/sites?per_page=10', { Authorization: `Bearer ${token}` });
      return { summary: { projects: Array.isArray(sites) ? sites.length : 0, names: (sites || []).slice(0, 3).map(s => s.name) } };
    },
  },
  cloudflare: {
    async validate(token) {
      const data = await fetchJson('https://api.cloudflare.com/client/v4/zones?per_page=5', { Authorization: `Bearer ${token}` });
      if (!data.success) throw new Error('TOKEN_INVALID');
      return { summary: { projects: data.result ? data.result.length : 0, names: (data.result || []).slice(0, 3).map(z => z.name) } };
    },
  },
  railway: {
    async validate(token) {
      const data = await fetchJson('https://backboard.railway.com/graphql/v2', {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      }, 'POST', JSON.stringify({ query: '{ projects { edges { node { name } } } }' }));
      const edges = (((data || {}).data || {}).projects || {}).edges || [];
      return { summary: { projects: edges.length, names: edges.slice(0, 3).map(e => e.node.name) } };
    },
  },
  render: {
    async validate(token) {
      const services = await fetchJson('https://api.render.com/v1/services?limit=10', { Authorization: `Bearer ${token}`, Accept: 'application/json' });
      return { summary: { projects: Array.isArray(services) ? services.length : 0, names: (services || []).slice(0, 3).map(s => s.service && s.service.name) } };
    },
  },
  github: {
    async validate(token) {
      const repos = await fetchJson('https://api.github.com/user/repos?per_page=10&sort=pushed', { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'multi-acc-manager' });
      return { summary: { projects: Array.isArray(repos) ? repos.length : 0, names: (repos || []).slice(0, 3).map(r => r.name) } };
    },
  },
  // ---- added in 0.4.0 ----
  fly: {
    async validate(token) {
      const data = await fetchJson('https://api.fly.io/graphql', {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      }, 'POST', JSON.stringify({ query: '{ apps(first: 10) { nodes { name status } } }' }));
      if (data && data.errors && data.errors.length) throw new Error('TOKEN_INVALID');
      const nodes = (((data || {}).data || {}).apps || {}).nodes || [];
      return { summary: { projects: nodes.length, names: nodes.slice(0, 3).map(a => a.name) } };
    },
  },
  heroku: {
    async validate(token) {
      const apps = await fetchJson('https://api.heroku.com/apps', { Authorization: `Bearer ${token}`, Accept: 'application/vnd.heroku+json; version=3' });
      return { summary: { projects: Array.isArray(apps) ? apps.length : 0, names: (apps || []).slice(0, 3).map(a => a.name) } };
    },
  },
  digitalocean: {
    async validate(token) {
      const h = { Authorization: `Bearer ${token}` };
      const droplets = await fetchJson('https://api.digitalocean.com/v2/droplets?per_page=10', h);
      let apps = [];
      try { apps = (await fetchJson('https://api.digitalocean.com/v2/apps?per_page=10', h)).apps || []; } catch {}
      const list = [...(droplets.droplets || []), ...apps];
      return { summary: { projects: list.length, names: list.slice(0, 3).map(d => d.name || (d.spec && d.spec.name)) } };
    },
  },
  neon: {
    async validate(token) {
      const data = await fetchJson('https://console.neon.tech/api/v2/projects?limit=10', { Authorization: `Bearer ${token}`, Accept: 'application/json' });
      const projects = data.projects || [];
      return { summary: { projects: projects.length, names: projects.slice(0, 3).map(p => p.name) } };
    },
  },
  gitlab: {
    async validate(token) {
      const projects = await fetchJson('https://gitlab.com/api/v4/projects?membership=true&per_page=10&order_by=last_activity_at', { 'PRIVATE-TOKEN': token });
      return { summary: { projects: Array.isArray(projects) ? projects.length : 0, names: (projects || []).slice(0, 3).map(p => p.name) } };
    },
  },
  npm: {
    async validate(token) {
      const who = await fetchJson('https://registry.npmjs.org/-/whoami', { Authorization: `Bearer ${token}` });
      if (!who || !who.username) throw new Error('TOKEN_INVALID');
      let objects = [];
      try {
        const res = await fetchJson(`https://registry.npmjs.org/-/v1/search?text=maintainer:${encodeURIComponent(who.username)}&size=10`, {});
        objects = res.objects || [];
      } catch {}
      return { summary: { user: who.username, projects: objects.length, names: objects.slice(0, 3).map(o => o.package && o.package.name) } };
    },
  },
  dockerhub: {
    // Docker Hub has no bearer-token read API: a personal access token must be exchanged for a JWT
    // together with the username, so the stored token is "username:pat".
    async validate(token) {
      const i = token.indexOf(':');
      if (i <= 0) throw new Error('Enter username:token — Docker Hub needs both (a read-only personal access token)');
      const username = token.slice(0, i).trim();
      const pat = token.slice(i + 1).trim();
      const login = await fetchJson('https://hub.docker.com/v2/users/login', { 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ username, password: pat }));
      if (!login || !login.token) throw new Error('TOKEN_INVALID');
      const repos = await fetchJson(`https://hub.docker.com/v2/repositories/${encodeURIComponent(username)}/?page_size=10`, { Authorization: `Bearer ${login.token}` });
      const results = repos.results || [];
      return { summary: { user: username, projects: repos.count || results.length, names: results.slice(0, 3).map(r => r.name) } };
    },
  },
  huggingface: {
    async validate(token) {
      const who = await fetchJson('https://huggingface.co/api/whoami-v2', { Authorization: `Bearer ${token}` });
      if (!who || !who.name) throw new Error('TOKEN_INVALID');
      let models = [];
      try { models = await fetchJson(`https://huggingface.co/api/models?author=${encodeURIComponent(who.name)}&limit=10`, { Authorization: `Bearer ${token}` }); } catch {}
      return { summary: { user: who.name, projects: Array.isArray(models) ? models.length : 0, names: (models || []).slice(0, 3).map(m => (m.id || '').split('/').pop()) } };
    },
  },
  stripe: {
    async validate(token) {
      const acct = await fetchJson('https://api.stripe.com/v1/account', { Authorization: `Bearer ${token}` });
      const name = (acct.settings && acct.settings.dashboard && acct.settings.dashboard.display_name) || (acct.business_profile && acct.business_profile.name) || acct.id;
      return { summary: { user: name, live: token.includes('_live_'), charges: !!acct.charges_enabled, payouts: !!acct.payouts_enabled } };
    },
  },
};

module.exports = { PROVIDERS };
