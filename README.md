# Database Manager

Web-based multi-database manager (PostgreSQL, MySQL, MariaDB) built with Node.js and Express.

## Features

### Core Features
- **Multi-DB support** — PostgreSQL, MySQL, and MariaDB from a single UI
- **First-run setup wizard** — configure which DB types and credentials on first launch
- **Login** — connect with any database user (database is optional)
- **Database selector** — pick a database after login, or leave blank to see all
- **Responsive design** — works on desktop and mobile
- **Dark/Light mode** — toggle between themes, preference saved in browser
- **Collapsible admin panel** — management section hidden by default, click to expand

### Table Management
- **Table browser** — view table data with inline cell editing
- **Table creation** — create new tables with custom columns via UI
- **Column management** — add, drop, and rename columns
- **Index management** — view, create, and drop indexes
- **Table structure view** — see columns, types, DDL, and constraints
- **Search & filter** — search across all columns in a table
- **Sorting** — click column headers to sort ascending/descending
- **Pagination** — navigate through large datasets (50 rows per page)
- **Bulk operations** — select multiple rows and delete them at once
- **CSV import** — paste CSV data to import into a table
- **CSV export** — download table data as CSV
- **SQL export** — download table structure and data as SQL dump
- **Drop table** — delete tables with confirmation

### SQL Query Editor
- **Multiple query tabs** — work on multiple queries simultaneously
- **SQL autocomplete** — auto-suggests table and column names as you type
- **SQL formatter** — format SQL with one click
- **Query history** — view last 100 executed queries with timing
- **Query bookmarks** — save frequently used queries with custom names
- **EXPLAIN analysis** — analyze query performance with EXPLAIN output
- **Keyboard shortcuts** — Ctrl+Enter to execute query
- **Toast notifications** — non-intrusive success/error messages

### Monitoring & Visualization
- **Dashboard** — see database size, table count, active connections
- **Connection monitor** — real-time connection statistics with progress bar
- **Connection history chart** — bar chart showing connection trends
- **ER diagram** — visualize table relationships in a grid layout

### Admin Panel (Superusers Only)
- **User management** — list, create, edit, and delete users/roles
- **Password editing** — change user passwords directly
- **Database management** — list databases with size/owner, create/drop databases
- **Permission management** — grant/revoke SELECT, INSERT, UPDATE, DELETE, ALL privileges
- **Adaptive UI** — adjusts to PostgreSQL vs MySQL/MariaDB differences

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

### Login Flow

1. Select **Database type** (only shown when multiple DB types are configured)
2. Enter **username** and **password**
3. Optionally enter a **database** name to connect directly
4. Leave database empty → see a list of available databases

### Main Views

#### Overview
- Database statistics (size, tables, connections)
- Connection history chart
- Quick access to key metrics

#### Tables
- Browse all tables in the current database
- Click a table to view its data
- Search, sort, and paginate through rows
- Edit cells inline and save changes
- Export data as CSV or SQL
- Import data from CSV
- Manage table structure (columns, indexes)
- Create new tables or drop existing ones

#### SQL Query
- Write and execute SQL queries
- Use autocomplete for table/column names
- Format SQL with one click
- Save queries as bookmarks
- View query history
- Analyze query performance with EXPLAIN
- Work on multiple queries with tabs

#### Monitor
- Real-time connection statistics
- Connection usage progress bar
- Active connections by state
- Historical connection data

#### ER Diagram
- Visual representation of table relationships
- Shows foreign key connections
- Grid layout for easy navigation

### Admin Panel

The **Management** section appears on the database list page for **superuser** accounts. It's collapsed by default — click the "Management" button to expand it.

| Tab | Actions |
|-----|---------|
| **Users** | List users/roles, create new users, edit passwords, delete users |
| **Databases** | List databases with size/owner, create new databases, drop databases |
| **Permissions** | Grant/revoke SELECT, INSERT, UPDATE, DELETE, ALL privileges |

For MySQL/MariaDB, user names are shown as `user@host` format and the host field is available when creating users.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Execute SQL query |
| `Escape` | Close autocomplete dropdown |

## GitHub Sync

The `scripts/github.js` script commits and pushes the `server/` folder to a GitHub repository.

```bash
node scripts/github.js
```

Edit the `EXCLUDE` array at the top of the script to customize which files/directories are excluded from the sync. Default exclusions: `.git`, `.env`, `node_modules`, `package-lock.json`, `scripts`, `server.log`.

## Tech Stack

- **Backend**: Express 5, express-session, pg (node-postgres), mysql2
- **Frontend**: EJS templates, vanilla JavaScript
- **Styling**: Custom CSS with CSS variables, dark/light themes
- **Icons**: Lucide icons
- **Fonts**: Inter, JetBrains Mono (Google Fonts)
- **Port**: 3100 (configurable in `.env`)

## Project Structure

```
server/
├── public/
│   └── style.css          # All styles (dark/light themes)
├── views/
│   └── index.ejs          # Single-page app with all views
├── server.js              # Express server + all API endpoints
├── .env                   # Configuration (not in git)
├── .env.example           # Configuration template
└── package.json           # Dependencies
```

## API Endpoints

### Authentication & Setup
- `GET /setup` — Setup wizard
- `POST /setup` — Save initial configuration
- `GET /` — Main app (redirects to login or dashboard)
- `POST /login` — Authenticate user
- `GET /logout` — End session

### Database Operations
- `GET /databases` — List available databases
- `POST /select-database` — Select active database
- `GET /dashboard` — Database statistics
- `GET /tables` — List tables in current database
- `GET /table/:schema/:name` — Get table data (columns + rows)
- `PUT /table/:schema/:name/:pkcol/:pkval` — Update row

### Query Operations
- `POST /query` — Execute SQL query
- `POST /query/explain` — EXPLAIN ANALYZE query
- `POST /sql/format` — Format SQL
- `GET /query/history` — Get query history
- `POST /query/history` — Add to history
- `GET /query/bookmarks` — Get saved bookmarks
- `POST /query/bookmark` — Save bookmark
- `DELETE /query/bookmark/:id` — Delete bookmark

### Table Management
- `POST /table/create` — Create new table
- `POST /table/alter` — Add/drop/rename column
- `DELETE /table/:schema/:name` — Drop table
- `POST /table/:schema/:name/filter` — Filtered/paginated data
- `POST /table/:schema/:name/import-csv` — Import CSV data
- `GET /table/:schema/:name/export` — Export as CSV
- `GET /table/:schema/:name/export-sql` — Export as SQL
- `GET /table/:schema/:name/structure` — Get DDL and columns
- `GET /table/:schema/:name/indexes` — List indexes
- `POST /table/:schema/:name/index` — Create index
- `DELETE /table/:schema/:name/index/:name` — Drop index
- `POST /table/:schema/:name/bulk-delete` — Delete multiple rows
- `GET /table/:schema/:name/relations` — Get foreign key relations

### Monitoring
- `GET /monitor/connections` — Connection statistics
- `GET /tables/relations` — All table relations for ER diagram

### Admin (Superusers Only)
- `GET /admin/check` — Check if user is superuser
- `GET /admin/roles` — List users/roles
- `POST /admin/role` — Create user/role
- `DELETE /admin/role/:name` — Drop user/role
- `POST /admin/role/:name/password` — Change password
- `GET /admin/dbs` — List all databases
- `POST /admin/db` — Create database
- `DELETE /admin/db/:name` — Drop database
- `POST /admin/grant` — Grant privileges
- `POST /admin/revoke` — Revoke privileges
- `POST /admin/grant-db` — Grant database access
- `POST /admin/revoke-db` — Revoke database access

## License

MIT
