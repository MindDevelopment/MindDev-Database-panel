# Database Manager

Web-based multi-database manager (PostgreSQL, MySQL, MariaDB) built with Node.js and Express.

## Features

- **Multi-DB support** — PostgreSQL, MySQL, and MariaDB from a single UI
- **First-run setup wizard** — configure which DB types and credentials on first launch
- **Login** — connect with any database user (database is optional)
- **Database selector** — pick a database after login, or leave blank to see all
- **Table browser** — view table data, edit cells inline
- **SQL query editor** — run ad-hoc queries with result display
- **Dashboard** — see database size, table count, active connections
- **Admin panel** (superusers only) — manage users/roles, create/drop databases, grant/revoke permissions
- **Responsive** — works on desktop and mobile
- **GitHub sync** — `scripts/github.js` commits and pushes the `server/` folder to GitHub

## Requirements

- Node.js 18+
- PostgreSQL 15+ (optional), MySQL 8+ (optional), MariaDB 10+ (optional)

## Installation

```bash
git clone <repo-url>
cd server
npm install
```

## Configuration

All configuration lives in `server/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Web server port |
| `DB_TYPE` | (empty) | Comma-separated list: `postgres,mysql,mariadb` |
| `PG_HOST` | `localhost` | PostgreSQL host |
| `PG_PORT` | `5432` | PostgreSQL port |
| `PG_USER` | `Daan` | PostgreSQL admin user |
| `PG_PASSWORD` | — | PostgreSQL admin password |
| `PG_DATABASE` | `postgres` | Default database for admin queries |
| `MYSQL_HOST` | `localhost` | MySQL host |
| `MYSQL_PORT` | `3306` | MySQL port |
| `MYSQL_USER` | `root` | MySQL admin user |
| `MYSQL_PASSWORD` | — | MySQL admin password |
| `MARIADB_HOST` | `localhost` | MariaDB host |
| `MARIADB_PORT` | `3306` | MariaDB port |
| `MARIADB_USER` | `root` | MariaDB admin user |
| `MARIADB_PASSWORD` | — | MariaDB admin password |
| `SESSION_SECRET` | auto | Session encryption key |
| `SESSION_MAX_AGE` | `86400000` | Session TTL (ms) |

On first launch (no `DB_TYPE` set), the **setup wizard** appears at `/setup` to guide you through configuration. You can re-trigger it with `/setup?force=1`.

A `.env.example` file is included as a template.

## Usage

```bash
npm start
```

Open `http://<server-ip>:3100` in your browser.

### Login flow

1. Select **Database type** (only shown when multiple DB types are configured)
2. Enter **username** and **password**
3. Optionally enter a **database** name to connect directly
4. Leave database empty → see a list of available databases

### Admin panel

The **Management** section appears on the database list page for **superuser** accounts. It adapts to the current DB type:

| Tab | Actions |
|-----|---------|
| **Users** | List users/roles, create new users with permissions, delete users |
| **Databases** | List databases with size/owner, create new databases, drop databases |
| **Permissions** | Grant/revoke SELECT, INSERT, UPDATE, DELETE, ALL privileges |

For MySQL/MariaDB, user names are shown as `user@host` format and the host field is available when creating users.

## GitHub Sync

The `scripts/github.js` script commits and pushes the `server/` folder to a GitHub repository.

```bash
node scripts/github.js
```

Edit the `EXCLUDE` array at the top of the script to customize which files/directories are excluded from the sync. Default exclusions: `.git`, `.env`, `node_modules`, `package-lock.json`, `scripts`, `server.log`.

## Tech Stack

- **Backend**: Express 5, express-session, pg (node-postgres), mysql2
- **Frontend**: EJS templates, vanilla JS, CSS with dark theme (glassmorphism)
- **Port**: 3100 (configurable in `.env`)

## License

MIT
