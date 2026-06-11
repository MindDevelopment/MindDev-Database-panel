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
  } catch {
    return false;
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

if (!global.queryHistory) global.queryHistory = [];
if (!global.queryBookmarks) global.queryBookmarks = [];

app.post('/query/history', requireDb, (req, res) => {
  const { sql, duration, rowCount, error } = req.body;
  global.queryHistory.unshift({ sql, duration, rowCount, error, timestamp: Date.now(), database: req.session.credentials.database });
  if (global.queryHistory.length > 100) global.queryHistory = global.queryHistory.slice(0, 100);
  res.json({ success: true });
});

app.get('/query/history', requireDb, (req, res) => {
  res.json(global.queryHistory);
});

app.post('/query/bookmark', requireDb, (req, res) => {
  const { sql, name } = req.body;
  global.queryBookmarks.push({ sql, name, id: Date.now(), database: req.session.credentials.database });
  res.json({ success: true });
});

app.get('/query/bookmarks', requireDb, (req, res) => {
  res.json(global.queryBookmarks.filter(b => b.database === req.session.credentials.database));
});

app.delete('/query/bookmark/:id', requireDb, (req, res) => {
  global.queryBookmarks = global.queryBookmarks.filter(b => b.id !== parseInt(req.params.id));
  res.json({ success: true });
});

app.post('/table/create', requireDb, async (req, res) => {
  const { schema, name, columns } = req.body;
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let sql;
    if (type === 'postgres') {
      const colDefs = columns.map(c => {
        let def = `"${c.name}" ${c.type}`;
        if (c.primaryKey) def += ' PRIMARY KEY';
        if (c.notNull) def += ' NOT NULL';
        if (c.default) def += ` DEFAULT ${c.default}`;
        return def;
      }).join(', ');
      sql = `CREATE TABLE "${schema}"."${name}" (${colDefs})`;
    } else {
      const colDefs = columns.map(c => {
        let def = `\`${c.name}\` ${c.type}`;
        if (c.primaryKey) def += ' PRIMARY KEY';
        if (c.notNull) def += ' NOT NULL';
        if (c.default) def += ` DEFAULT ${c.default}`;
        return def;
      }).join(', ');
      sql = `CREATE TABLE \`${schema}\`.\`${name}\` (${colDefs})`;
    }
    await queryDb(pool, type, sql, []);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.post('/table/alter', requireDb, async (req, res) => {
  const { schema, name, action, column, columnType, newColumnName } = req.body;
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let sql;
    if (type === 'postgres') {
      if (action === 'add') sql = `ALTER TABLE "${schema}"."${name}" ADD COLUMN "${column}" ${columnType}`;
      else if (action === 'drop') sql = `ALTER TABLE "${schema}"."${name}" DROP COLUMN "${column}"`;
      else if (action === 'rename') sql = `ALTER TABLE "${schema}"."${name}" RENAME COLUMN "${column}" TO "${newColumnName}"`;
    } else {
      if (action === 'add') sql = `ALTER TABLE \`${schema}\`.\`${name}\` ADD COLUMN \`${column}\` ${columnType}`;
      else if (action === 'drop') sql = `ALTER TABLE \`${schema}\`.\`${name}\` DROP COLUMN \`${column}\``;
      else if (action === 'rename') sql = `ALTER TABLE \`${schema}\`.\`${name}\` RENAME COLUMN \`${column}\` TO \`${newColumnName}\``;
    }
    await queryDb(pool, type, sql, []);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.delete('/table/:schema/:name', requireDb, async (req, res) => {
  const { schema, name } = req.params;
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let sql;
    if (type === 'postgres') sql = `DROP TABLE IF EXISTS "${schema}"."${name}"`;
    else sql = `DROP TABLE IF EXISTS \`${schema}\`.\`${name}\``;
    await queryDb(pool, type, sql, []);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.post('/table/import-csv', requireDb, async (req, res) => {
  const { schema, name, rows, columns } = req.body;
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let inserted = 0;
    for (const row of rows) {
      const cols = columns.map(c => type === 'postgres' ? `"${c}"` : `\`${c}\``).join(', ');
      const placeholders = columns.map((_, i) => type === 'postgres' ? `$${i + 1}` : '?').join(', ');
      const values = columns.map(c => row[c] !== undefined ? row[c] : null);
      let sql;
      if (type === 'postgres') sql = `INSERT INTO "${schema}"."${name}" (${cols}) VALUES (${placeholders})`;
      else sql = `INSERT INTO \`${schema}\`.\`${name}\` (${cols}) VALUES (${placeholders})`;
      await queryDb(pool, type, sql, values);
      inserted++;
    }
    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.post('/table/:schema/:name/filter', requireDb, async (req, res) => {
  const { schema, name } = req.params;
  const { type } = req.session.credentials;
  const { page = 1, limit = 50, search = '', sortColumn = '', sortDirection = 'ASC' } = req.body;
  const pool = createPool(type, req.session.credentials);
  try {
    let columns;
    if (type === 'postgres') {
      const cr = await queryDb(pool, type, `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, name]);
      columns = cr.rows;
    } else {
      const cr = await queryDb(pool, type, `SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type, IS_NULLABLE as is_nullable, COLUMN_DEFAULT as column_default FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [schema, name]);
      columns = cr[0];
    }
    let whereClause = '';
    let params = [];
    if (search) {
      const searchConditions = columns.map((c, i) => {
        if (type === 'postgres') {
          return `"${c.column_name}"::text ILIKE $${i + 1}`;
        } else {
          return `CAST(\`${c.column_name}\` AS CHAR) LIKE ?`;
        }
      }).join(' OR ');
      whereClause = ` WHERE ${searchConditions}`;
      params = columns.map(() => type === 'postgres' ? `%${search}%` : `%${search}%`);
    }
    let orderBy = '';
    if (sortColumn) {
      const dir = sortDirection.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      if (type === 'postgres') orderBy = ` ORDER BY "${sortColumn}" ${dir}`;
      else orderBy = ` ORDER BY \`${sortColumn}\` ${dir}`;
    }
    const offset = (page - 1) * limit;
    let countSql, dataSql;
    if (type === 'postgres') {
      countSql = `SELECT COUNT(*) FROM "${schema}"."${name}"${whereClause}`;
      dataSql = `SELECT * FROM "${schema}"."${name}"${whereClause}${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    } else {
      countSql = `SELECT COUNT(*) as count FROM \`${schema}\`.\`${name}\`${whereClause}`;
      dataSql = `SELECT * FROM \`${schema}\`.\`${name}\`${whereClause}${orderBy} LIMIT ? OFFSET ?`;
    }
    const countParams = type === 'postgres' ? [...params] : [...params];
    const cr = await queryDb(pool, type, countSql, countParams);
    const total = type === 'postgres' ? parseInt(cr.rows[0].count) : cr[0][0].count;
    const dataParams = type === 'postgres' ? [...params, limit, offset] : [...params, limit, offset];
    const dr = await queryDb(pool, type, dataSql, dataParams);
    const data = type === 'postgres' ? dr.rows : dr[0];
    res.json({ columns, rows: data, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.post('/sql/format', requireDb, (req, res) => {
  const { sql } = req.body;
  if (!sql || !sql.trim()) return res.json({ formatted: '' });
  const keywords = ['SELECT','FROM','WHERE','AND','OR','ORDER BY','GROUP BY','HAVING','LIMIT','OFFSET','JOIN','LEFT JOIN','RIGHT JOIN','INNER JOIN','OUTER JOIN','FULL JOIN','CROSS JOIN','ON','AS','INSERT INTO','VALUES','UPDATE','SET','DELETE FROM','CREATE TABLE','ALTER TABLE','DROP TABLE','CREATE INDEX','DROP INDEX','UNION','UNION ALL','EXCEPT','INTERSECT','CASE','WHEN','THEN','ELSE','END','IN','NOT','NULL','IS','LIKE','BETWEEN','EXISTS','DISTINCT','COUNT','SUM','AVG','MIN','MAX','ASC','DESC'];
  let formatted = sql.trim();
  keywords.forEach(kw => {
    const regex = new RegExp(`\\b${kw}\\b`, 'gi');
    formatted = formatted.replace(regex, kw);
  });
  formatted = formatted.replace(/\b(SELECT)\b/gi, 'SELECT\n  ');
  formatted = formatted.replace(/\b(FROM)\b/gi, '\nFROM\n  ');
  formatted = formatted.replace(/\b(WHERE)\b/gi, '\nWHERE\n  ');
  formatted = formatted.replace(/\b(AND)\b/gi, '\n  AND ');
  formatted = formatted.replace(/\b(OR)\b/gi, '\n  OR ');
  formatted = formatted.replace(/\b(ORDER BY)\b/gi, '\nORDER BY ');
  formatted = formatted.replace(/\b(GROUP BY)\b/gi, '\nGROUP BY ');
  formatted = formatted.replace(/\b(HAVING)\b/gi, '\nHAVING ');
  formatted = formatted.replace(/\b(LIMIT)\b/gi, '\nLIMIT ');
  formatted = formatted.replace(/\b(OFFSET)\b/gi, '\nOFFSET ');
  formatted = formatted.replace(/\b(LEFT JOIN|RIGHT JOIN|INNER JOIN|JOIN)\b/gi, '\n$1 ');
  formatted = formatted.replace(/\b(ON)\b/gi, '\n  ON ');
  formatted = formatted.replace(/\b(INSERT INTO)\b/gi, 'INSERT INTO ');
  formatted = formatted.replace(/\b(VALUES)\b/gi, '\nVALUES ');
  formatted = formatted.replace(/\b(UPDATE)\b/gi, 'UPDATE ');
  formatted = formatted.replace(/\b(SET)\b/gi, '\nSET ');
  formatted = formatted.replace(/\b(DELETE FROM)\b/gi, 'DELETE FROM ');
  formatted = formatted.replace(/,\s*/g, ',\n  ');
  formatted = formatted.replace(/\n\s*\n/g, '\n');
  res.json({ formatted });
});

app.get('/table/:schema/:name/structure', requireDb, async (req, res) => {
  const { schema, name } = req.params;
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let columns, ddl;
    if (type === 'postgres') {
      const cr = await queryDb(pool, type, `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default, is_identity, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, name]);
      columns = cr.rows;
      const pk = await queryDb(pool, type, `SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'`, [schema, name]);
      const pkCols = pk.rows.map(r => r.column_name);
      const indexes = await queryDb(pool, type, `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`, [schema, name]);
      const fk = await queryDb(pool, type, `SELECT kcu.column_name, ccu.table_schema AS foreign_table_schema, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name FROM information_schema.table_constraints AS tc JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`, [schema, name]);
      let colDefs = columns.map(c => {
        let def = `  "${c.column_name}" ${c.data_type}`;
        if (c.character_maximum_length) def += `(${c.character_maximum_length})`;
        if (c.is_nullable === 'NO') def += ' NOT NULL';
        if (c.column_default) def += ` DEFAULT ${c.column_default}`;
        if (pkCols.includes(c.column_name)) def += ' PRIMARY KEY';
        return def;
      }).join(',\n');
      ddl = `CREATE TABLE "${schema}"."${name}" (\n${colDefs}\n);\n\n`;
      indexes.rows.forEach(idx => { ddl += `${idx.indexdef};\n`; });
      fk.rows.forEach(f => {
        ddl += `ALTER TABLE "${schema}"."${name}" ADD FOREIGN KEY ("${f.column_name}") REFERENCES "${f.foreign_table_schema}"."${f.foreign_table_name}" ("${f.foreign_column_name}");\n`;
      });
    } else {
      const cr = await queryDb(pool, type, `SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type, CHARACTER_MAXIMUM_LENGTH as character_maximum_length, IS_NULLABLE as is_nullable, COLUMN_DEFAULT as column_default, COLUMN_KEY as column_key FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [schema, name]);
      columns = cr[0];
      let colDefs = columns.map(c => {
        let def = `  \`${c.column_name}\` ${c.data_type}`;
        if (c.character_maximum_length) def += `(${c.character_maximum_length})`;
        if (c.is_nullable === 'NO') def += ' NOT NULL';
        if (c.column_default) def += ` DEFAULT ${c.column_default}`;
        if (c.column_key === 'PRI') def += ' PRIMARY KEY';
        return def;
      }).join(',\n');
      ddl = `CREATE TABLE \`${schema}\`.\`${name}\` (\n${colDefs}\n);`;
    }
    res.json({ columns, ddl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.get('/table/:schema/:name/indexes', requireDb, async (req, res) => {
  const { schema, name } = req.params;
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let indexes;
    if (type === 'postgres') {
      const r = await queryDb(pool, type, `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`, [schema, name]);
      indexes = r.rows;
    } else {
      const r = await queryDb(pool, type, `SELECT INDEX_NAME as indexname, COLUMN_NAME as column_name, NON_UNIQUE as non_unique, SEQ_IN_INDEX as seq_in_index FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? ORDER BY indexname, seq_in_index`, [schema, name]);
      const idxMap = {};
      r[0].forEach(row => {
        if (!idxMap[row.indexname]) idxMap[row.indexname] = { indexname: row.indexname, columns: [], non_unique: row.non_unique };
        idxMap[row.indexname].columns.push(row.column_name);
      });
      indexes = Object.values(idxMap).map(i => ({ indexname: i.indexname, indexdef: `CREATE ${i.non_unique ? '' : 'UNIQUE '}INDEX \`${i.indexname}\` ON \`${name}\` (${i.columns.map(c => `\`${c}\``).join(', ')})` }));
    }
    res.json(indexes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.post('/table/:schema/:name/index', requireDb, async (req, res) => {
  const { schema, name } = req.params;
  const { indexName, columns, unique } = req.body;
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let sql;
    const uniqueStr = unique ? 'UNIQUE ' : '';
    if (type === 'postgres') {
      const colStr = columns.map(c => `"${c}"`).join(', ');
      sql = `CREATE ${uniqueStr}INDEX "${indexName}" ON "${schema}"."${name}" (${colStr})`;
    } else {
      const colStr = columns.map(c => `\`${c}\``).join(', ');
      sql = `CREATE ${uniqueStr}INDEX \`${indexName}\` ON \`${schema}\`.\`${name}\` (${colStr})`;
    }
    await queryDb(pool, type, sql, []);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.delete('/table/:schema/:name/index/:indexName', requireDb, async (req, res) => {
  const { schema, name, indexName } = req.params;
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let sql;
    if (type === 'postgres') sql = `DROP INDEX IF EXISTS "${schema}"."${indexName}"`;
    else sql = `DROP INDEX IF EXISTS \`${indexName}\` ON \`${schema}\`.\`${name}\``;
    await queryDb(pool, type, sql, []);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.get('/monitor/connections', requireDb, async (req, res) => {
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let data;
    if (type === 'postgres') {
      const r = await queryDb(pool, type, `SELECT state, count(*) as count FROM pg_stat_activity GROUP BY state ORDER BY state`, []);
      const total = await queryDb(pool, type, `SELECT count(*) as total FROM pg_stat_activity`, []);
      const max = await queryDb(pool, type, `SHOW max_connections`, []);
      data = { states: r.rows, total: total.rows[0].total, max: max.rows[0].max_connections };
    } else {
      const r = await queryDb(pool, type, `SELECT COUNT(*) as total FROM information_schema.processlist`, []);
      const max = await queryDb(pool, type, `SHOW VARIABLES LIKE 'max_connections'`, []);
      data = { total: r[0][0].total, max: max[0][0].Value };
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.get('/monitor/history', requireDb, (req, res) => {
  if (!global.monitorHistory) global.monitorHistory = [];
  res.json(global.monitorHistory.slice(-60));
});

app.get('/table/:schema/:name/relations', requireDb, async (req, res) => {
  const { schema, name } = req.params;
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let relations;
    if (type === 'postgres') {
      const r = await queryDb(pool, type, `SELECT tc.constraint_name, kcu.column_name, ccu.table_schema AS foreign_table_schema, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name FROM information_schema.table_constraints AS tc JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`, [schema, name]);
      relations = r.rows;
    } else {
      const r = await queryDb(pool, type, `SELECT kcu.column_name, kcu.referenced_table_schema AS foreign_table_schema, kcu.referenced_table_name AS foreign_table_name, kcu.referenced_column_name AS foreign_column_name FROM information_schema.key_column_usage kcu WHERE kcu.table_schema = ? AND kcu.table_name = ? AND kcu.referenced_table_name IS NOT NULL`, [schema, name]);
      relations = r[0];
    }
    res.json(relations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.get('/tables/relations', requireDb, async (req, res) => {
  const { type, database } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let tables, relations;
    if (type === 'postgres') {
      const tr = await queryDb(pool, type, `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE' ORDER BY table_schema, table_name`, []);
      tables = tr.rows;
      const rr = await queryDb(pool, type, `SELECT tc.table_schema, tc.table_name, kcu.column_name, ccu.table_schema AS foreign_table_schema, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name FROM information_schema.table_constraints AS tc JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')`, []);
      relations = rr.rows;
    } else {
      const tr = await queryDb(pool, type, `SELECT TABLE_SCHEMA as table_schema, TABLE_NAME as table_name FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys') AND table_type = 'BASE TABLE' ORDER BY table_schema, table_name`, []);
      tables = tr[0];
      const rr = await queryDb(pool, type, `SELECT kcu.table_schema, kcu.table_name, kcu.column_name, kcu.referenced_table_schema AS foreign_table_schema, kcu.referenced_table_name AS foreign_table_name, kcu.referenced_column_name AS foreign_column_name FROM information_schema.key_column_usage kcu WHERE kcu.referenced_table_name IS NOT NULL AND kcu.table_schema NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')`, []);
      relations = rr[0];
    }
    res.json({ tables, relations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.post('/table/:schema/:name/bulk-delete', requireDb, async (req, res) => {
  const { schema, name } = req.params;
  const { pkCol, pkValues } = req.body;
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let sql;
    if (type === 'postgres') {
      const placeholders = pkValues.map((_, i) => `$${i + 1}`).join(', ');
      sql = `DELETE FROM "${schema}"."${name}" WHERE "${pkCol}" IN (${placeholders})`;
    } else {
      const placeholders = pkValues.map(() => '?').join(', ');
      sql = `DELETE FROM \`${schema}\`.\`${name}\` WHERE \`${pkCol}\` IN (${placeholders})`;
    }
    const r = await queryDb(pool, type, sql, pkValues);
    const deleted = type === 'postgres' ? r.rowCount : r[0].affectedRows;
    res.json({ success: true, deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.post('/query/explain', requireDb, async (req, res) => {
  const { sql } = req.body;
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let result;
    if (type === 'postgres') {
      const r = await queryDb(pool, type, `EXPLAIN (FORMAT JSON, ANALYZE) ${sql}`, []);
      result = r.rows;
    } else {
      const r = await queryDb(pool, type, `EXPLAIN FORMAT=JSON ${sql}`, []);
      result = r[0];
    }
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.get('/table/:schema/:name/export-sql', requireDb, async (req, res) => {
  const { schema, name } = req.params;
  const { type } = req.session.credentials;
  const pool = createPool(type, req.session.credentials);
  try {
    let structure, data;
    if (type === 'postgres') {
      const sr = await queryDb(pool, type, `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, name]);
      structure = sr.rows;
      const dr = await queryDb(pool, type, `SELECT * FROM "${schema}"."${name}"`, []);
      data = dr.rows;
    } else {
      const sr = await queryDb(pool, type, `SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type, CHARACTER_MAXIMUM_LENGTH as character_maximum_length, IS_NULLABLE as is_nullable, COLUMN_DEFAULT as column_default FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [schema, name]);
      structure = sr[0];
      const dr = await queryDb(pool, type, `SELECT * FROM \`${schema}\`.\`${name}\``, []);
      data = dr[0];
    }
    const colDefs = structure.map(c => {
      let def = `"${c.column_name}" ${c.data_type}`;
      if (c.character_maximum_length) def += `(${c.character_maximum_length})`;
      if (c.is_nullable === 'NO') def += ' NOT NULL';
      if (c.column_default) def += ` DEFAULT ${c.column_default}`;
      return def;
    }).join(', ');
    let sql = `-- Export: ${schema}.${name}\n`;
    sql += `-- Generated: ${new Date().toISOString()}\n\n`;
    sql += `CREATE TABLE "${schema}"."${name}" (\n  ${colDefs}\n);\n\n`;
    for (const row of data) {
      const cols = Object.keys(row).map(c => `"${c}"`).join(', ');
      const vals = Object.values(row).map(v => {
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number') return v;
        return `'${String(v).replace(/'/g, "''")}'`;
      }).join(', ');
      sql += `INSERT INTO "${schema}"."${name}" (${cols}) VALUES (${vals});\n`;
    }
    res.setHeader('Content-Type', 'application/sql; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.sql"`);
    res.send(sql);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await endPool(pool, type);
  }
});

app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`Database Manager running on http://0.0.0.0:${PORT}`);
});
