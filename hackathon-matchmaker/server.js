require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 3000);
const appUrl = process.env.APP_URL || `http://localhost:${port}`;
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined }) : null;
const sessionStore = pool ? new (require('connect-pg-simple')(session))({ pool, createTableIfMissing: true }) : undefined;
const asyncRoute = handler => (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'] } } }));
app.use(express.json({ limit: '32kb' }));
app.use(session({ name: 'buildcircuit.sid', secret: process.env.SESSION_SECRET || 'dev-only-replace-this-session-secret', resave: false, saveUninitialized: false, store: sessionStore, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 7 } }));
app.use('/api/', rateLimit({ windowMs: 60 * 1000, limit: 90, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAccount(request, response, next) { if (!request.session.account) return response.status(401).json({ error: 'Sign in to continue.' }); next(); }
function accountUser(account) { return { id: account.id, email: account.email, name: account.display_name }; }
function regenerateSession(request) { return new Promise((resolve, reject) => request.session.regenerate(error => error ? reject(error) : resolve())); }
function saveSession(request) { return new Promise((resolve, reject) => request.session.save(error => error ? reject(error) : resolve())); }
function safeChannelName(value) { return String(value || 'hackathon-team').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'hackathon-team'; }
function requireString(value, field, max = 120) { if (typeof value !== 'string' || !value.trim() || value.length > max) { const error = new Error(`${field} is required.`); error.status = 400; throw error; } return value.trim(); }
async function ensureSchema() { if (!pool) return; const schema = await fs.readFile(path.join(__dirname, 'db', 'schema.sql'), 'utf8'); await pool.query(schema); }

app.get('/api/bootstrap', (request, response) => response.json({ authBackend: Boolean(pool), database: Boolean(pool), slack: Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_TEAM_ID), discord: Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID), authenticated: Boolean(request.session.account), user: request.session.account || null }));
app.get('/api/health', (request, response) => response.json({ ok: true, databaseConfigured: Boolean(pool) }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false });
app.post('/api/auth/register', authLimiter, asyncRoute(async (request, response) => {
  if (!pool) return response.status(503).json({ error: 'Email/password accounts require PostgreSQL. Use the local demo account store for preview.' });
  const email = requireString(request.body?.email, 'Email', 254).toLowerCase();
  const password = request.body?.password;
  const name = requireString(request.body?.name, 'Name', 100);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ error: 'Enter a valid email address.' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return response.status(400).json({ error: 'Use a password between 8 and 128 characters.' });
  const passwordHash = await bcrypt.hash(password, 12);
  let result;
  try { result = await pool.query('INSERT INTO accounts (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id,email,display_name', [email, passwordHash, name]); }
  catch (error) { if (error.code === '23505') return response.status(409).json({ error: 'An account with this email already exists. Sign in instead.' }); throw error; }
  await regenerateSession(request);
  request.session.account = accountUser(result.rows[0]);
  await saveSession(request);
  response.status(201).json({ user: request.session.account });
}));

app.post('/api/auth/login', authLimiter, asyncRoute(async (request, response) => {
  if (!pool) return response.status(503).json({ error: 'Email/password accounts require PostgreSQL. Use the local demo account store for preview.' });
  const email = requireString(request.body?.email, 'Email', 254).toLowerCase();
  const password = request.body?.password;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ error: 'Enter a valid email address.' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return response.status(401).json({ error: 'Email or password is incorrect.' });
  const result = await pool.query('SELECT id,email,display_name,password_hash FROM accounts WHERE email=$1', [email]);
  const account = result.rows[0];
  if (!account || !await bcrypt.compare(password, account.password_hash)) return response.status(401).json({ error: 'Email or password is incorrect.' });
  await regenerateSession(request);
  request.session.account = accountUser(account);
  await saveSession(request);
  response.json({ user: request.session.account });
}));

app.post('/api/auth/logout', (request, response) => request.session.destroy(error => { if (error) return response.status(500).json({ error: 'Could not sign out.' }); response.clearCookie('buildcircuit.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }); response.json({ ok: true }); }));

app.get('/api/me', requireAccount, asyncRoute(async (request, response) => {
  const result = await pool.query('SELECT id,email,display_name,role,bio,location,timezone,skills,seeking,availability,preferred_hackathon FROM accounts WHERE id=$1', [request.session.account.id]);
  response.json({ profile: result.rows[0] || null });
}));
app.post('/api/profile', requireAccount, asyncRoute(async (request, response) => {
  if (!pool) return response.status(503).json({ error: 'PostgreSQL is not configured. Set DATABASE_URL in .env.' });
  const body = request.body || {};
  const skills = Array.isArray(body.skills) ? body.skills.filter(item => typeof item === 'string').slice(0, 20) : [];
  const seeking = Array.isArray(body.seeking) ? body.seeking.filter(item => typeof item === 'string').slice(0, 20) : [];
  const result = await pool.query('UPDATE accounts SET display_name=$2, role=$3, bio=$4, location=$5, timezone=$6, skills=$7, seeking=$8, availability=$9, preferred_hackathon=$10, updated_at=NOW() WHERE id=$1 RETURNING *', [request.session.account.id, String(body.name || '').slice(0, 100), String(body.role || 'Builder').slice(0, 100), String(body.bio || '').slice(0, 500), String(body.location || '').slice(0, 100), String(body.timezone || 'UTC').slice(0, 80), skills, seeking, String(body.availability || 'flexible').slice(0, 80), String(body.hackathon || '').slice(0, 120)]);
  response.json({ profile: result.rows[0] || null });
}));

app.post('/api/teams', requireAccount, asyncRoute(async (request, response) => {
  if (!pool) return response.status(503).json({ error: 'PostgreSQL is not configured. Set DATABASE_URL in .env.' });
  const name = requireString(request.body?.name, 'Team name');
  const hackathon = requireString(request.body?.hackathon, 'Hackathon', 160);
  const result = await pool.query('INSERT INTO teams (name, hackathon, owner_account_id) VALUES ($1,$2,$3) RETURNING *', [name, hackathon, request.session.account.id]);
  await pool.query('INSERT INTO team_members (team_id, account_id, role, status) VALUES ($1,$2,$3,$4)', [result.rows[0].id, request.session.account.id, 'owner', 'accepted']);
  response.status(201).json({ team: result.rows[0] });
}));

app.post('/api/teams/:teamId/channels', requireAccount, asyncRoute(async (request, response) => {
  const platform = requireString(request.body?.platform, 'Platform', 20).toLowerCase();
  const channelName = safeChannelName(request.body?.name);
  const memberIds = Array.isArray(request.body?.memberIds) ? request.body.memberIds.filter(id => /^\d{5,25}$/.test(String(id))).slice(0, 49) : [];
  if (platform === 'slack') {
    if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_TEAM_ID) return response.status(503).json({ error: 'Slack is not configured. Set SLACK_BOT_TOKEN and SLACK_TEAM_ID in .env.' });
    const createResponse = await fetch('https://slack.com/api/conversations.create', { method: 'POST', headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ name: channelName, is_private: false, team_id: process.env.SLACK_TEAM_ID }) });
    const created = await createResponse.json();
    if (!createResponse.ok || !created.ok) return response.status(502).json({ error: created.error || 'Slack could not create the channel.' });
    if (memberIds.length) { const inviteResponse = await fetch('https://slack.com/api/conversations.invite', { method: 'POST', headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ channel: created.channel.id, users: memberIds.join(',') }) }); const invited = await inviteResponse.json(); if (!inviteResponse.ok || !invited.ok) return response.status(502).json({ error: invited.error || 'Channel created, but Slack could not invite every member.' }); }
    return response.status(201).json({ platform, channelId: created.channel.id, url: `https://app.slack.com/client/${process.env.SLACK_TEAM_ID}/${created.channel.id}` });
  }
  if (platform === 'discord') {
    if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) return response.status(503).json({ error: 'Discord is not configured. Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID in .env.' });
    const createResponse = await fetch(`https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/channels`, { method: 'POST', headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: channelName, type: 0 }) });
    const channel = await createResponse.json();
    if (!createResponse.ok) return response.status(502).json({ error: channel.message || 'Discord could not create the channel.' });
    return response.status(201).json({ platform, channelId: channel.id, url: `https://discord.com/channels/${process.env.DISCORD_GUILD_ID}/${channel.id}` });
  }
  return response.status(400).json({ error: 'Platform must be slack or discord.' });
}));

app.get('*', (request, response) => response.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((error, request, response, next) => { console.error(error); if (response.headersSent) return next(error); response.status(error.status || 500).json({ error: error.status ? error.message : 'Unexpected server error.' }); });

ensureSchema().then(() => {
  if (pool) console.log('PostgreSQL schema ready.');
  app.listen(port, () => console.log(`BuildCircuit running at ${appUrl}`));
}).catch(error => {
  console.error('PostgreSQL unavailable; continuing with demo mode:', error.message);
  app.listen(port, () => console.log(`BuildCircuit running in demo mode at ${appUrl}`));
});
