require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3100;

const ENV_PATH = path.resolve(__dirname, '.env');

function getEnabledDbTypes() {
  const raw = process.env.DB_TYPE || '';
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

let DB_TYPES = getEnabledDbTypes();
const SETUP_DONE = DB_TYPES.length > 0;

function reloadEnv() {
  delete require.cache[require.resolve('dotenv')];
  const dotenv = require('dotenv');
  const result = dotenv.config({ path: ENV_PATH });
  if (result.parsed) {
    for (const [k, v] of Object.entries(result.parsed)) {
      process.env[k] = v;
    }
    DB_TYPES = getEnabledDbTypes();
  }
}

function saveEnv(updates) {
  let content = '';
  try {
    content = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    content = '';
  }
  const lines = content.split('\n');
  const existing = {};
  for (const line of lines) {
    const m = line.match(/^([^#=]+)=(.+)$/);
    if (m) existing[m[1].trim()] = line;
  }
  for (const [k, v] of Object.entries(updates)) {
    const line = `${k}=${v}`;
    if (existing[k] !== undefined) {
      const idx = lines.findIndex(l => l.startsWith(k + '='));
      lines[idx] = line;
    } else {
      lines.push(line);
    }
    existing[k] = line;
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n');
  reloadEnv();
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'pg-manager-secret-key-2024',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: parseInt(process.env.SESSION_MAX_AGE) || 24 * 60 * 60 * 1000 }
}));

function createPool(type, credentials) {
  const host = credentials.host || 'localhost';
  const port = credentials.port || (type === 'postgres' ? 5432 : 3306);
  const user = credentials.user;
  const password = credentials.password;
  const database = credentials.database;

  if (type === 'postgres') {
    const { Pool } = require('pg');
    return new Pool({ host, port, user, password, database: database || 'postgres', max: 3, idleTimeoutMillis: 10000 });
  }
  if (type === 'mysql' || type === 'mariadb') {
    const mysql = require('mysql2/promise');
    return mysql.createPool({ host, port, user, password, database, waitForConnections: true, connectionLimit: 3 });
  }
  throw new Error(`Unknown database type: ${type}`);
}

function createAdminPool(type) {
  const prefix = type === 'postgres' ? 'PG_' : type === 'mysql' ? 'MYSQL_' : 'MARIADB_';
  return createPool(type, {
    host: process.env[`${prefix}HOST`] || 'localhost',
    port: process.env[`${prefix}PORT`],
    user: process.env[`${prefix}USER`] || 'root',
    password: process.env[`${prefix}PASSWORD`] || '',
    database: type === 'postgres' ? process.env[`${prefix}DATABASE`] || 'postgres' : undefined
  });
}

function getDefaultCredentials(type, user, password, database) {
  const creds = { user, password };
  if (database) creds.database = database;
  if (type === 'postgres') {
    creds.host = process.env.PG_HOST || 'localhost';
    creds.port = process.env.PG_PORT || 5432;
  } else if (type === 'mysql') {
    creds.host = process.env.MYSQL_HOST || 'localhost';
    creds.port = process.env.MYSQL_PORT || 3306;
  } else if (type === 'mariadb') {
    creds.host = process.env.MARIADB_HOST || 'localhost';
    creds.port = process.env.MARIADB_PORT || 3306;
  }
  return creds;
}

function pgQuery(pool, sql, params) {
  return pool.query(sql, params);
}

function mysqlQuery(pool, sql, params) {
  const q = sql.replace(/\$(\d+)/g, '?');
  return pool.query(q, params);
}

async function queryDb(pool, type, sql, params) {
  if (type === 'postgres') return pgQuery(pool, sql, params);
  return mysqlQuery(pool, sql, params);
}

async function endPool(pool, type) {
  try {
    if (type === 'postgres') await pool.end();
    else await pool.end();
  } catch {}
}

async function testConnection(type, credentials) {
  const pool = createPool(type, credentials);
  try {
    if (type === 'postgres') {
      const client = await pool.connect();
      client.release();
    } else {
      await pool.getConnection();
    }
    return true;
  } finally {
    await endPool(pool, type);
  }
}

app.use((req, res, next) => {
  if (!SETUP_DONE && req.path !== '/setup' && req.path !== '/favicon.ico') {
    return res.redirect('/setup');
  }
  next();
});

app.get('/setup', (req, res) => {
  if (SETUP_DONE && !req.query.force) {
    return res.redirect('/');
  }
  res.render('index', {
    view: 'setup',
    error: null,
    current: {
      pg: process.env.PG_HOST ? true : false,
      mysql: process.env.MYSQL_HOST ? true : false,
      mariadb: process.env.MARIADB_HOST ? true : false
    }
  });
});

app.post('/setup', async (req, res) => {
  const { db_pg, db_mysql, db_mariadb } = req.body;
  const enabled = [];
  const updates = {};

  if (db_pg) {
    const host = req.body.pg_host || 'localhost';
    const port = req.body.pg_port || '5432';
    const user = req.body.pg_user || 'postgres';
    const password = req.body.pg_password || '';
    updates['PG_HOST'] = host;
    updates['PG_PORT'] = port;
    updates['PG_USER'] = user;
    updates['PG_PASSWORD'] = password;
    updates['PG_DATABASE'] = req.body.pg_database || 'postgres';
    enabled.push('postgres');
    if (!req.body.skip_test) {
      const ok = await testConnection('postgres', { host, port, user, password, database: req.body.pg_database || 'postgres' });
      if (!ok) return res.render('index', { view: 'setup', error: 'PostgreSQL verbinding mislukt', current: { pg: true, mysql: !!db_mysql, mariadb: !!db_mariadb } });
    }
  }
  if (db_mysql) {
    const host = req.body.mysql_host || 'localhost';
    const port = req.body.mysql_port || '3306';
    const user = req.body.mysql_user || 'root';
    const password = req.body.mysql_password || '';
    updates['MYSQL_HOST'] = host;
    updates['MYSQL_PORT'] = port;
    updates['MYSQL_USER'] = user;
    updates['MYSQL_PASSWORD'] = password;
    enabled.push('mysql');
  }
  if (db_mariadb) {
    const host = req.body.mariadb_host || 'localhost';
    const port = req.body.mariadb_port || '3306';
    const user = req.body.mariadb_user || 'root';
    const password = req.body.mariadb_password || '';
    updates['MARIADB_HOST'] = host;
    updates['MARIADB_PORT'] = port;
    updates['MARIADB_USER'] = user;
    updates['MARIADB_PASSWORD'] = password;
    enabled.push('mariadb');
  }

  updates['DB_TYPE'] = enabled.join(',');
  saveEnv(updates);

  res.redirect('/');
});

app.get('/', (req, res) => {
  if (!SETUP_DONE) return res.redirect('/setup');
  if (!req.session.credentials) {
    return res.render('index', { view: 'login', error: null, dbTypes: DB_TYPES });
  }
  if (!req.session.credentials.database) {
    return res.redirect('/databases');
  }
  res.render('index', { view: 'manager', error: null, creds: req.session.credentials });
});

app.post('/login', async (req, res) => {
  const { db_type, user, password, database } = req.body;
  const type = db_type || DB_TYPES[0] || 'postgres';
  const creds = getDefaultCredentials(type, user, password, database);
  const ok = await testConnection(type, creds);
  if (!ok) {
    return res.render('index', { view: 'login', error: 'Verbinding mislukt: controleer je gegevens', dbTypes: DB_TYPES });
  }
  req.session.credentials = { type, user, password };
  if (database && database.trim()) {
    req.session.credentials.database = database.trim();
  }
  res.redirect('/');
});

app.get('/databases', async (req, res) => {
  if (!req.session.credentials) return res.redirect('/');
  const { type, user, password } = req.session.credentials;
  const pool = createAdminPool(type);
  try {
    let dbs;
    if (type === 'postgres') {
      const r = await queryDb(pool, type, `SELECT datname FROM pg_database WHERE datistemplate = false AND has_database_privilege($1, datname, 'CONNECT') ORDER BY datname`, [user]);
      dbs = r.rows.map(r => ({ name: r.datname }));
    } else {
      const r = await queryDb(pool, type, 'SHOW DATABASES', []);
      dbs = r[0].map(r => ({ name: Object.values(r)[0] }));
    }
    res.render('index', { view: 'databases', error: null, databases: dbs, creds: req.session.credentials });
  } catch (err) {
    res.render('index', { view: 'databases', error: err.message, databases: [], creds: req.session.credentials });
  } finally {
    await endPool(pool, type);
  }
});

app.post('/select-database', (req, res) => {
  if (!req.session.credentials) return res.redirect('/');
  req.session.credentials.database = req.body.database;
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

function requireDb(req, res, next) {
  if (!req.session.credentials || !req.session.credentials.database) {
    return res.status(401).json({ error: 'Geen database geselecteerd' });
  }
  next();
}

app.get('/tables', requireDb, async (req, res) => {
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let rows;
    if (type === 'postgres') {
      const r = await queryDb(pool, type, `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE' ORDER BY table_schema, table_name`, []);
      rows = r.rows;
    } else {
      const r = await queryDb(pool, type, 'SELECT TABLE_SCHEMA as table_schema, TABLE_NAME as table_name FROM information_schema.tables WHERE table_schema NOT IN (\'information_schema\', \'performance_schema\', \'mysql\', \'sys\') AND table_type = \'BASE TABLE\' ORDER BY table_schema, table_name', []);
      rows = r[0];
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.get('/table/:schema/:name', requireDb, async (req, res) => {
  const { schema, name } = req.params;
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let columns, data;
    if (type === 'postgres') {
      const cr = await queryDb(pool, type, `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, name]);
      columns = cr.rows;
      const dr = await queryDb(pool, type, `SELECT * FROM "${schema}"."${name}" LIMIT 500`, []);
      data = dr.rows;
    } else {
      const cr = await queryDb(pool, type, `SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type, IS_NULLABLE as is_nullable, COLUMN_DEFAULT as column_default FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [schema, name]);
      columns = cr[0];
      const escaped = `\`${schema}\`.\`${name}\``;
      const dr = await queryDb(pool, type, `SELECT * FROM ${escaped} LIMIT 500`, []);
      data = dr[0];
    }
    res.json({ columns, rows: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.get('/table/:schema/:name/export', requireDb, async (req, res) => {
  const { schema, name } = req.params;
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let rows;
    if (type === 'postgres') {
      const r = await queryDb(pool, type, `SELECT * FROM "${schema}"."${name}"`, []);
      rows = r.rows;
    } else {
      const r = await queryDb(pool, type, `SELECT * FROM \`${schema}\`.\`${name}\``, []);
      rows = r[0];
    }
    const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
    let csv = '\ufeff' + cols.join(',') + '\n';
    for (const row of rows) {
      csv += cols.map(c => {
        const v = row[c];
        if (v === null || v === undefined) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',') + '\n';
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.post('/query', requireDb, async (req, res) => {
  const { sql } = req.body;
  if (!sql || !sql.trim()) return res.status(400).json({ error: 'Geen SQL opgegeven' });
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    const start = Date.now();
    const r = await queryDb(pool, type, sql, []);
    const elapsed = Date.now() - start;
    let rows, fields, rowCount, command;
    if (type === 'postgres') {
      rows = r.rows || [];
      fields = r.fields ? r.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })) : [];
      rowCount = r.rowCount ?? r.rows?.length ?? 0;
      command = r.command;
    } else {
      rows = r[0] || [];
      fields = rows.length > 0 ? Object.keys(rows[0]).map(k => ({ name: k })) : [];
      rowCount = rows.length;
      command = 'QUERY';
    }
    res.json({ rows, fields, rowCount, command, duration: elapsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.put('/table/:schema/:name/:pkcol/:pkval', requireDb, async (req, res) => {
  const { schema, name, pkcol, pkval } = req.params;
  const { type } = req.session.credentials;
  const updates = req.body;
  const pool = createPool(type, req.session.credentials);
  try {
    let sql, values;
    if (type === 'postgres') {
      const setClauses = Object.keys(updates).map((col, i) => `"${col}" = $${i + 2}`).join(', ');
      values = [pkval, ...Object.values(updates)];
      sql = `UPDATE "${schema}"."${name}" SET ${setClauses} WHERE "${pkcol}" = $1`;
    } else {
      const setClauses = Object.keys(updates).map(col => `\`${col}\` = ?`).join(', ');
      values = [...Object.values(updates), pkval];
      sql = `UPDATE \`${schema}\`.\`${name}\` SET ${setClauses} WHERE \`${pkcol}\` = ?`;
    }
    const r = await queryDb(pool, type, sql, values);
    if (type === 'postgres') res.json({ rowCount: r.rowCount });
    else res.json({ rowCount: r[0].affectedRows || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.get('/dashboard', requireDb, async (req, res) => {
  const { type, database, user } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let dbSize = '?', tableCount = 0, activeConns = 0;
    if (type === 'postgres') {
      const sr = await queryDb(pool, type, `SELECT pg_size_pretty(pg_database_size(current_database())) as size`, []);
      dbSize = sr.rows[0].size;
      const tr = await queryDb(pool, type, `SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE'`, []);
      tableCount = tr.rows[0].count;
      const ar = await queryDb(pool, type, `SELECT count(*) as count FROM pg_stat_activity WHERE state = 'active'`, []);
      activeConns = ar.rows[0].count;
    } else {
      const tr = await queryDb(pool, type, `SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys') AND table_type = 'BASE TABLE'`, []);
      tableCount = tr[0][0].count;
    }
    res.json({ dbSize, tableCount, activeConnections: activeConns, database, user, host: process.env[`${type.toUpperCase()}_HOST`] || 'localhost' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

async function isSuperuser(credentials) {
  const pool = createPool(credentials.type, { ...credentials, database: credentials.type === 'postgres' ? 'postgres' : undefined });
  try {
    if (credentials.type === 'postgres') {
      const r = await queryDb(pool, 'postgres', 'SELECT rolsuper FROM pg_roles WHERE rolname = $1', [credentials.user]);
      return r.rows.length > 0 && r.rows[0].rolsuper;
    }
    const r = await queryDb(pool, credentials.type, 'SELECT Super_priv FROM mysql.user WHERE user = ?', [credentials.user]);
    return r[0].length > 0 && r[0][0].Super_priv === 'Y';
  } catch { return false; }
  finally { await endPool(pool, credentials.type); }
}

function requireAdminAuth(req, res, next) {
  if (!req.session.credentials) return res.status(401).json({ error: 'Not logged in' });
  next();
}

app.get('/admin/check', requireAdminAuth, async (req, res) => {
  try {
    const su = await isSuperuser(req.session.credentials);
    res.json({ superuser: su, type: req.session.credentials.type });
  } catch {
    res.json({ superuser: false, type: req.session.credentials.type });
  }
});

app.get('/admin/roles', requireAdminAuth, async (req, res) => {
  const { type } = req.session.credentials;
  let rows;
  try {
    if (type === 'postgres') {
      const pool = createAdminPool('postgres');
      try {
        const r = await queryDb(pool, 'postgres', `SELECT r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin, r.rolinherit, r.rolreplication, r.rolconnlimit, (SELECT COUNT(*) FROM pg_auth_members m WHERE m.roleid = r.oid) as member_count FROM pg_roles r WHERE r.rolname NOT LIKE 'pg_%' ORDER BY r.rolsuper DESC, r.rolname`, []);
        rows = r.rows;
      } finally { await endPool(pool, 'postgres'); }
    } else {
      const pool = createAdminPool(type);
      try {
        const r = await queryDb(pool, type, `SELECT user, host, Super_priv, Create_user_priv, Create_priv, Select_priv, Insert_priv, Update_priv, Delete_priv FROM mysql.user WHERE user NOT IN ('mysql','sys','healthcheck') ORDER BY user`, []);
        rows = r[0].map(u => ({ rolname: u.User + '@' + u.Host, rolsuper: u.Super_priv === 'Y', rolcreatedb: u.Create_priv === 'Y', rolcreaterole: u.Create_user_priv === 'Y', rolcanlogin: true }));
      } finally { await endPool(pool, type); }
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/role', requireAdminAuth, async (req, res) => {
  const { type } = req.session.credentials;
  const { name, host, password, canLogin, superuser, createDb, createRole } = req.body;
  try {
    if (type === 'postgres') {
      const pool = createAdminPool('postgres');
      try {
        const opts = [];
        if (canLogin) opts.push('LOGIN');
        if (superuser) opts.push('SUPERUSER');
        if (createDb) opts.push('CREATEDB');
        if (createRole) opts.push('CREATEROLE');
        if (password) opts.push(`PASSWORD '${password.replace(/'/g, "''")}'`);
        if (opts.length === 0) opts.push('NOLOGIN');
        await queryDb(pool, 'postgres', `CREATE ROLE "${name}" ${opts.join(' ')}`, []);
      } finally { await endPool(pool, 'postgres'); }
    } else {
      const pool = createAdminPool(type);
      try {
        const h = host || '%';
        await queryDb(pool, type, 'CREATE USER ?@? IDENTIFIED BY ?', [name, h, password || '']);
        if (superuser) await queryDb(pool, type, 'GRANT ALL PRIVILEGES ON *.* TO ?@? WITH GRANT OPTION', [name, h]);
      } finally { await endPool(pool, type); }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/role/:name', requireAdminAuth, async (req, res) => {
  const { type } = req.session.credentials;
  const full = req.params.name;
  try {
    if (type === 'postgres') {
      const pool = createAdminPool('postgres');
      try { await queryDb(pool, 'postgres', `DROP ROLE IF EXISTS "${full}"`, []); } finally { await endPool(pool, 'postgres'); }
    } else {
      const pool = createAdminPool(type);
      try {
        const parts = full.split('@');
        const user = parts[0];
        const host = parts[1] || '%';
        await queryDb(pool, type, 'DROP USER ?@?', [user, host]);
      } finally { await endPool(pool, type); }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/role/:name/password', requireAdminAuth, async (req, res) => {
  const { type } = req.session.credentials;
  const full = req.params.name;
  try {
    if (type === 'postgres') {
      const pool = createAdminPool('postgres');
      try { await queryDb(pool, 'postgres', `ALTER ROLE "${full}" WITH PASSWORD '${req.body.password.replace(/'/g, "''")}'`, []); } finally { await endPool(pool, 'postgres'); }
    } else {
      const pool = createAdminPool(type);
      try {
        const parts = full.split('@');
        await queryDb(pool, type, 'ALTER USER ?@? IDENTIFIED BY ?', [parts[0], parts[1] || '%', req.body.password]);
      } finally { await endPool(pool, type); }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/dbs', requireAdminAuth, async (req, res) => {
  const { type } = req.session.credentials;
  try {
    if (type === 'postgres') {
      const pool = createAdminPool('postgres');
      try {
        const r = await queryDb(pool, 'postgres', `SELECT d.datname, pg_size_pretty(pg_database_size(d.datname)) as size, u.rolname as owner, pg_encoding_to_char(d.encoding) as encoding FROM pg_database d JOIN pg_roles u ON d.datdba = u.oid WHERE d.datistemplate = false ORDER BY d.datname`, []);
        return res.json(r.rows);
      } finally { await endPool(pool, 'postgres'); }
    }
    const pool = createAdminPool(type);
    try {
      const r = await queryDb(pool, type, 'SELECT table_schema, ROUND(SUM(data_length+index_length)/1024/1024,2) as size_mb FROM information_schema.tables GROUP BY table_schema ORDER BY table_schema', []);
      const sizes = {};
      r[0].forEach(row => { sizes[row.table_schema] = row.size_mb + ' MB'; });
      const dbs = await queryDb(pool, type, 'SHOW DATABASES', []);
      const dbsList = dbs[0].map(d => {
        const name = Object.values(d)[0];
        return { datname: name, size: sizes[name] || '?', owner: '-', encoding: 'utf8' };
      });
      res.json(dbsList);
    } finally { await endPool(pool, type); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/db', requireAdminAuth, async (req, res) => {
  const { type } = req.session.credentials;
  const { name } = req.body;
  try {
    if (type === 'postgres') {
      const pool = createAdminPool('postgres');
      try { await queryDb(pool, 'postgres', `CREATE DATABASE "${name}"`, []); } finally { await endPool(pool, 'postgres'); }
    } else {
      const pool = createAdminPool(type);
      try { await queryDb(pool, type, 'CREATE DATABASE ??', [name]); } finally { await endPool(pool, type); }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/db/:name', requireAdminAuth, async (req, res) => {
  const { type } = req.session.credentials;
  const name = req.params.name;
  try {
    if (type === 'postgres') {
      const pool = createAdminPool('postgres');
      try { await queryDb(pool, 'postgres', `DROP DATABASE IF EXISTS "${name}"`, []); } finally { await endPool(pool, 'postgres'); }
    } else {
      const pool = createAdminPool(type);
      try { await queryDb(pool, type, 'DROP DATABASE IF EXISTS ??', [name]); } finally { await endPool(pool, type); }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/grant', requireAdminAuth, async (req, res) => {
  const { type } = req.session.credentials;
  const { role, database, privilege } = req.body;
  if (type === 'postgres') {
    const pool = createAdminPool('postgres');
    try {
      if (database === '*ALL*') {
        await queryDb(pool, 'postgres', `GRANT ${privilege} ON ALL TABLES IN SCHEMA public TO "${role}"`, []);
        await queryDb(pool, 'postgres', `GRANT ${privilege} ON ALL SEQUENCES IN SCHEMA public TO "${role}"`, []);
      } else {
        const dbPool = createPool('postgres', { host: process.env.PG_HOST || 'localhost', port: process.env.PG_PORT || 5432, user: req.session.credentials.user, password: req.session.credentials.password, database });
        try {
          await queryDb(dbPool, 'postgres', `GRANT ${privilege} ON ALL TABLES IN SCHEMA public TO "${role}"`, []);
          await queryDb(dbPool, 'postgres', `GRANT ${privilege} ON ALL SEQUENCES IN SCHEMA public TO "${role}"`, []);
        } finally { await endPool(dbPool, 'postgres'); }
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await endPool(pool, 'postgres'); }
  } else {
    const pool = createAdminPool(type);
    try {
      const isAll = database === '*ALL*';
      const parts = role.split('@');
      const user = parts[0], host = parts[1] || '%';
      await queryDb(pool, type, `GRANT ${privilege} ON ${isAll?'*':`\`${database}\``}.* TO ?@?`, [user, host]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await endPool(pool, type); }
  }
});

app.post('/admin/revoke', requireAdminAuth, async (req, res) => {
  const { type } = req.session.credentials;
  const { role, database, privilege } = req.body;
  if (type === 'postgres') {
    const pool = createAdminPool('postgres');
    try {
      if (database === '*ALL*') {
        await queryDb(pool, 'postgres', `REVOKE ${privilege} ON ALL TABLES IN SCHEMA public FROM "${role}"`, []);
        await queryDb(pool, 'postgres', `REVOKE ${privilege} ON ALL SEQUENCES IN SCHEMA public FROM "${role}"`, []);
      } else {
        const dbPool = createPool('postgres', { host: process.env.PG_HOST || 'localhost', port: process.env.PG_PORT || 5432, user: req.session.credentials.user, password: req.session.credentials.password, database });
        try {
          await queryDb(dbPool, 'postgres', `REVOKE ${privilege} ON ALL TABLES IN SCHEMA public FROM "${role}"`, []);
          await queryDb(dbPool, 'postgres', `REVOKE ${privilege} ON ALL SEQUENCES IN SCHEMA public FROM "${role}"`, []);
        } finally { await endPool(dbPool, 'postgres'); }
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await endPool(pool, 'postgres'); }
  } else {
    const pool = createAdminPool(type);
    try {
      const isAll = database === '*ALL*';
      const parts = role.split('@');
      const user = parts[0], host = parts[1] || '%';
      await queryDb(pool, type, `REVOKE ${privilege} ON ${isAll?'*':`\`${database}\``}.* FROM ?@?`, [user, host]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await endPool(pool, type); }
  }
});

app.post('/admin/grant-db', requireAdminAuth, async (req, res) => {
  const { type } = req.session.credentials;
  const { role, database } = req.body;
  if (type === 'postgres') {
    const pool = createAdminPool('postgres');
    try {
      await queryDb(pool, 'postgres', `GRANT CONNECT ON DATABASE "${database}" TO "${role}"`, []);
      await queryDb(pool, 'postgres', `GRANT ALL PRIVILEGES ON DATABASE "${database}" TO "${role}"`, []);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await endPool(pool, 'postgres'); }
  } else {
    const pool = createAdminPool(type);
    try {
      const parts = role.split('@');
      await queryDb(pool, type, `GRANT ALL PRIVILEGES ON \`${database}\`.* TO ?@?`, [parts[0], parts[1] || '%']);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await endPool(pool, type); }
  }
});

app.post('/admin/revoke-db', requireAdminAuth, async (req, res) => {
  const { type } = req.session.credentials;
  const { role, database } = req.body;
  if (type === 'postgres') {
    const pool = createAdminPool('postgres');
    try {
      await queryDb(pool, 'postgres', `REVOKE ALL PRIVILEGES ON DATABASE "${database}" FROM "${role}"`, []);
      await queryDb(pool, 'postgres', `REVOKE CONNECT ON DATABASE "${database}" FROM "${role}"`, []);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await endPool(pool, 'postgres'); }
  } else {
    const pool = createAdminPool(type);
    try {
      const parts = role.split('@');
      await queryDb(pool, type, `REVOKE ALL PRIVILEGES ON \`${database}\`.* FROM ?@?`, [parts[0], parts[1] || '%']);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await endPool(pool, type); }
  }
});

app.get('/admin/roles', requireAdminAuth, async (req, res) => {
  if (req.session.credentials.type !== 'postgres') return res.json([]);
  const pool = createAdminPool('postgres');
  try {
    const r = await queryDb(pool, 'postgres', `SELECT r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin, r.rolinherit, r.rolreplication, r.rolconnlimit, (SELECT COUNT(*) FROM pg_auth_members m WHERE m.roleid = r.oid) as member_count FROM pg_roles r WHERE r.rolname NOT LIKE 'pg_%' ORDER BY r.rolsuper DESC, r.rolname`, []);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, 'postgres');
  }
});

app.post('/admin/role', requireAdminAuth, async (req, res) => {
  if (req.session.credentials.type !== 'postgres') return res.status(400).json({ error: 'PostgreSQL only' });
  const { name, password, canLogin, superuser, createDb, createRole } = req.body;
  const pool = createAdminPool('postgres');
  try {
    const opts = [];
    if (canLogin) opts.push('LOGIN');
    if (superuser) opts.push('SUPERUSER');
    if (createDb) opts.push('CREATEDB');
    if (createRole) opts.push('CREATEROLE');
    if (password) opts.push(`PASSWORD '${password.replace(/'/g, "''")}'`);
    if (opts.length === 0) opts.push('NOLOGIN');
    await queryDb(pool, 'postgres', `CREATE ROLE "${name}" ${opts.join(' ')}`, []);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, 'postgres');
  }
});

app.delete('/admin/role/:name', requireAdminAuth, async (req, res) => {
  if (req.session.credentials.type !== 'postgres') return res.status(400).json({ error: 'PostgreSQL only' });
  const pool = createAdminPool('postgres');
  try {
    await queryDb(pool, 'postgres', `DROP ROLE IF EXISTS "${req.params.name}"`, []);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, 'postgres');
  }
});

app.post('/admin/role/:name/password', requireAdminAuth, async (req, res) => {
  if (req.session.credentials.type !== 'postgres') return res.status(400).json({ error: 'PostgreSQL only' });
  const pool = createAdminPool('postgres');
  try {
    await queryDb(pool, 'postgres', `ALTER ROLE "${req.params.name}" WITH PASSWORD '${req.body.password.replace(/'/g, "''")}'`, []);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, 'postgres');
  }
});

app.get('/admin/dbs', requireAdminAuth, async (req, res) => {
  if (req.session.credentials.type !== 'postgres') return res.json([]);
  const pool = createAdminPool('postgres');
  try {
    const r = await queryDb(pool, 'postgres', `SELECT d.datname, pg_size_pretty(pg_database_size(d.datname)) as size, u.rolname as owner, pg_encoding_to_char(d.encoding) as encoding FROM pg_database d JOIN pg_roles u ON d.datdba = u.oid WHERE d.datistemplate = false ORDER BY d.datname`, []);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, 'postgres');
  }
});

app.post('/admin/db', requireAdminAuth, async (req, res) => {
  if (req.session.credentials.type !== 'postgres') return res.status(400).json({ error: 'PostgreSQL only' });
  const { name, owner } = req.body;
  const pool = createAdminPool('postgres');
  try {
    const ownerClause = owner ? ` OWNER "${owner}"` : '';
    await queryDb(pool, 'postgres', `CREATE DATABASE "${name}"${ownerClause}`, []);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, 'postgres');
  }
});

app.delete('/admin/db/:name', requireAdminAuth, async (req, res) => {
  if (req.session.credentials.type !== 'postgres') return res.status(400).json({ error: 'PostgreSQL only' });
  const pool = createAdminPool('postgres');
  try {
    await queryDb(pool, 'postgres', `DROP DATABASE IF EXISTS "${req.params.name}"`, []);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, 'postgres');
  }
});

app.post('/admin/grant', requireAdminAuth, async (req, res) => {
  if (req.session.credentials.type !== 'postgres') return res.status(400).json({ error: 'PostgreSQL only' });
  const { role, database, privilege } = req.body;
  const pool = createAdminPool('postgres');
  try {
    if (database === '*ALL*') {
      await queryDb(pool, 'postgres', `GRANT ${privilege} ON ALL TABLES IN SCHEMA public TO "${role}"`, []);
      await queryDb(pool, 'postgres', `GRANT ${privilege} ON ALL SEQUENCES IN SCHEMA public TO "${role}"`, []);
    } else {
      const dbPool = createPool('postgres', { host: process.env.PG_HOST || 'localhost', port: process.env.PG_PORT || 5432, user: req.session.credentials.user, password: req.session.credentials.password, database });
      try {
        await queryDb(dbPool, 'postgres', `GRANT ${privilege} ON ALL TABLES IN SCHEMA public TO "${role}"`, []);
        await queryDb(dbPool, 'postgres', `GRANT ${privilege} ON ALL SEQUENCES IN SCHEMA public TO "${role}"`, []);
      } finally {
        await endPool(dbPool, 'postgres');
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, 'postgres');
  }
});

app.post('/admin/revoke', requireAdminAuth, async (req, res) => {
  if (req.session.credentials.type !== 'postgres') return res.status(400).json({ error: 'PostgreSQL only' });
  const { role, database, privilege } = req.body;
  const pool = createAdminPool('postgres');
  try {
    if (database === '*ALL*') {
      await queryDb(pool, 'postgres', `REVOKE ${privilege} ON ALL TABLES IN SCHEMA public FROM "${role}"`, []);
      await queryDb(pool, 'postgres', `REVOKE ${privilege} ON ALL SEQUENCES IN SCHEMA public FROM "${role}"`, []);
    } else {
      const dbPool = createPool('postgres', { host: process.env.PG_HOST || 'localhost', port: process.env.PG_PORT || 5432, user: req.session.credentials.user, password: req.session.credentials.password, database });
      try {
        await queryDb(dbPool, 'postgres', `REVOKE ${privilege} ON ALL TABLES IN SCHEMA public FROM "${role}"`, []);
        await queryDb(dbPool, 'postgres', `REVOKE ${privilege} ON ALL SEQUENCES IN SCHEMA public FROM "${role}"`, []);
      } finally {
        await endPool(dbPool, 'postgres');
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, 'postgres');
  }
});

app.post('/admin/grant-db', requireAdminAuth, async (req, res) => {
  if (req.session.credentials.type !== 'postgres') return res.status(400).json({ error: 'PostgreSQL only' });
  const { role, database } = req.body;
  const pool = createAdminPool('postgres');
  try {
    await queryDb(pool, 'postgres', `GRANT CONNECT ON DATABASE "${database}" TO "${role}"`, []);
    await queryDb(pool, 'postgres', `GRANT ALL PRIVILEGES ON DATABASE "${database}" TO "${role}"`, []);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, 'postgres');
  }
});

app.post('/admin/revoke-db', requireAdminAuth, async (req, res) => {
  if (req.session.credentials.type !== 'postgres') return res.status(400).json({ error: 'PostgreSQL only' });
  const { role, database } = req.body;
  const pool = createAdminPool('postgres');
  try {
    await queryDb(pool, 'postgres', `REVOKE ALL PRIVILEGES ON DATABASE "${database}" FROM "${role}"`, []);
    await queryDb(pool, 'postgres', `REVOKE CONNECT ON DATABASE "${database}" FROM "${role}"`, []);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, 'postgres');
  }
});

app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`Database Manager running on http://0.0.0.0:${PORT}`);
});
