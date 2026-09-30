# Hackathon Team Matchmaker

A small portfolio app for discovering developers with complementary skills and forming hackathon teams. Accounts use email and password only; there is no OAuth provider. The Express API stores bcrypt-hashed passwords and profiles in PostgreSQL, and can create Slack/Discord team channels when configured.

## Run

1. Install Node.js 20 or newer and PostgreSQL.
2. Create a database named `hackmatch` and run `db/schema.sql`.
3. Copy `.env.example` to `.env` and set `SESSION_SECRET`, `DATABASE_URL`, `APP_URL`, and any desired integration credentials.
4. In the project folder, run `npm install` and `npm run dev`.
5. Open `http://localhost:3000`.

For Slack, provide a bot token with the `channels:manage` scope and set `SLACK_TEAM_ID`. For Discord, invite a bot with Manage Channels permission to a guild and set `DISCORD_GUILD_ID`. Generated channels are visible to members of that workspace or server.

Without PostgreSQL, the static preview uses browser-local demo accounts. Demo passwords are PBKDF2-hashed in local storage; they are not sent to a server. With PostgreSQL enabled, account passwords are bcrypt-hashed and sessions are stored in PostgreSQL.

## Notes

- Bot tokens belong in the server environment, never in browser code.
- Use HTTPS, a persistent PostgreSQL-backed session store, and a strong session secret before deployment.
- Matching is a transparent skills-complement heuristic, not an opaque AI ranking model.
