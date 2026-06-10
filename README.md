# PostgreSQL Web Manager

Web-based PostgreSQL database manager built with Node.js and Express.

## Features

- **Login** — connect with any PostgreSQL user (database is optional)
- **Database selector** — pick a database after login, or leave blank to see all
- **Table browser** — view table data, edit cells inline
- **SQL query editor** — run ad-hoc queries with result display
- **Dashboard** — see database size, table count, active connections
- **Admin panel** (superusers only) — manage users/roles, create/drop databases, grant/revoke permissions
- **Responsive** — works on desktop and mobile

## Requirements

- Node.js 18+
- PostgreSQL 15+

## Installation

```bash
git clone <repo-url>
cd pgadmin-web
npm install
```

## Configuration

Credentials are stored as **environment variables** in `server.js` (lines 9–14):

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_USER` | `Daan` | Superuser for system queries |
| `ADMIN_PASSWORD` | `[REMOVED]` | Superuser password |

Edit these directly in `server.js` or set environment variables before starting.

## Usage

```bash
npm start
```

Open `http://<server-ip>:3100` in your browser.

### Login flow

1. Enter **username** and **password**
2. Optionally enter a **database** name to connect directly
3. Leave database empty → see a list of available databases

### Admin panel

The Admin tab appears after login for **superuser** accounts only. From there you can:

| Tab | Actions |
|-----|---------|
| **Users** | List roles, create new users with permissions, delete roles |
| **Databases** | List databases with size/owner, create new databases, drop databases |
| **Permissions** | Grant/revoke SELECT, INSERT, UPDATE, DELETE, ALL on tables per database |

## Tech Stack

- **Backend**: Express 5, express-session, pg (node-postgres)
- **Frontend**: EJS templates, vanilla JS, CSS with dark theme
- **Port**: 3100 (configurable in `server.js`)

## License

MI