// Curated Phase-1 service registry. A service is config: URLs, icon color, policy.
// multiAccountPolicy: 'ok' | 'warn' | 'one-per-person' (drives warning banners)
module.exports = [
  { key: 'vercel',     name: 'Vercel',     dashboardUrl: 'https://vercel.com/dashboard',        loginUrl: 'https://vercel.com/login',                   signupUrl: 'https://vercel.com/signup',          color: '#000000', multiAccountPolicy: 'warn' },
  { key: 'netlify',    name: 'Netlify',    dashboardUrl: 'https://app.netlify.com',             loginUrl: 'https://app.netlify.com/login',              signupUrl: 'https://app.netlify.com/signup',     color: '#00c7b7', multiAccountPolicy: 'warn' },
  { key: 'supabase',   name: 'Supabase',   dashboardUrl: 'https://supabase.com/dashboard',      loginUrl: 'https://supabase.com/dashboard/sign-in',     signupUrl: 'https://supabase.com/dashboard/sign-up', color: '#3ecf8e', multiAccountPolicy: 'warn' },
  { key: 'cloudflare', name: 'Cloudflare', dashboardUrl: 'https://dash.cloudflare.com',         loginUrl: 'https://dash.cloudflare.com/login',          signupUrl: 'https://dash.cloudflare.com/sign-up', color: '#f6821f', multiAccountPolicy: 'warn' },
  { key: 'railway',    name: 'Railway',    dashboardUrl: 'https://railway.com/dashboard',       loginUrl: 'https://railway.com/login',                  signupUrl: 'https://railway.com/signup',         color: '#a77dfb', multiAccountPolicy: 'one-per-person' },
  { key: 'render',     name: 'Render',     dashboardUrl: 'https://dashboard.render.com',        loginUrl: 'https://dashboard.render.com/login',         signupUrl: 'https://dashboard.render.com/register', color: '#46e3b7', multiAccountPolicy: 'ok' },
  { key: 'github',     name: 'GitHub',     dashboardUrl: 'https://github.com',                  loginUrl: 'https://github.com/login',                   signupUrl: 'https://github.com/signup',          color: '#238636', multiAccountPolicy: 'one-per-person' },
];
