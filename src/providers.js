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
};

module.exports = { PROVIDERS };
