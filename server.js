const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = 3100;

const ADMIN_DB = {
  user: process.env.ADMIN_USER || 'USERNAME',
  password: process.env.ADMIN_PASSWORD || 'PASSWORD',
  database: 'postgres',
  host: 'localhost',
  port: 5432,
  max: 2
};
const adminPool = new Pool(ADMIN_DB);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'pg-manager-secret-key-2024',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function getPool(credentials) {
  return new Pool({
    host: 'localhost',
    port: 5432,
    user: credentials.user,
    password: credentials.password,
    database: credentials.database || 'postgres',
    max: 3,
    idleTimeoutMillis: 10000
  });
}

function getAuthPool(credentials) {
  return new Pool({
    host: 'localhost',
    port: 5432,
    user: credentials.user,
    password: credentials.password,
    database: 'postgres',
    max: 2,
    idleTimeoutMillis: 5000
  });
}

app.get('/', (req, res) => {
  if (!req.session.credentials) {
    return res.render('index', { view: 'login', error: null });
  }
  if (!req.session.credentials.database) {
    return res.redirect('/databases');
  }
  res.render('index', { view: 'manager', error: null, creds: req.session.credentials });
});

app.post('/login', async (req, res) => {
  const { user, password, database } = req.body;
  const pool = getAuthPool({ user, password });
  try {
    const client = await pool.connect();
    client.release();
    req.session.credentials = { user, password };
    if (database && database.trim()) {
      req.session.credentials.database = database.trim();
    }
    await pool.end();
    res.redirect('/');
  } catch (err) {
    await pool.end().catch(() => {});
    res.render('index', { view: 'login', error: err.message });
  }
});

app.get('/databases', async (req, res) => {
  if (!req.session.credentials) return res.redirect('/');
  const user = req.session.credentials.user;
  try {
    const result = await adminPool.query(
      `SELECT datname FROM pg_database WHERE datistemplate = false AND has_database_privilege($1, datname, 'CREATE') ORDER BY datname`,
      [user]
    );
    res.render('index', { view: 'databases', error: null, databases: result.rows, creds: req.session.credentials });
  } catch (err) {
    res.render('index', { view: 'databases', error: err.message, databases: [], creds: req.session.credentials });
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
  const pool = getPool(req.session.credentials);
  try {
    const result = await pool.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_type = 'BASE TABLE'
      ORDER BY table_schema, table_name
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.get('/table/:schema/:name', requireDb, async (req, res) => {
  const { schema, name } = req.params;
  const pool = getPool(req.session.credentials);
  try {
    const columns = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `, [schema, name]);

    const data = await pool.query(`SELECT * FROM "${schema}"."${name}" LIMIT 500`);
    res.json({ columns: columns.rows, rows: data.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.post('/query', requireDb, async (req, res) => {
  const { sql } = req.body;
  if (!sql || !sql.trim()) return res.status(400).json({ error: 'Geen SQL opgegeven' });
  const pool = getPool(req.session.credentials);
  try {
    const start = Date.now();
    const r = await pool.query(sql);
    const elapsed = Date.now() - start;
    res.json({
      rows: r.rows || [],
      fields: r.fields ? r.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })) : [],
      rowCount: r.rowCount ?? r.rows?.length ?? 0,
      command: r.command,
      duration: elapsed
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.put('/table/:schema/:name/:pkcol/:pkval', requireDb, async (req, res) => {
  const { schema, name, pkcol, pkval } = req.params;
  const updates = req.body;
  const pool = getPool(req.session.credentials);
  try {
    const setClauses = Object.keys(updates)
      .map((col, i) => `"${col}" = $${i + 2}`)
      .join(', ');
    const values = Object.values(updates);
    const sql = `UPDATE "${schema}"."${name}" SET ${setClauses} WHERE "${pkcol}" = $1`;
    const r = await pool.query(sql, [pkval, ...values]);
    res.json({ rowCount: r.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.get('/dashboard', requireDb, async (req, res) => {
  const pool = getPool(req.session.credentials);
  try {
    const dbSize = await pool.query(
      `SELECT pg_size_pretty(pg_database_size(current_database())) as size`
    );
    const tableCount = await pool.query(`
      SELECT COUNT(*) as count
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_type = 'BASE TABLE'
    `);
    const activeConns = await pool.query(
      `SELECT count(*) as count FROM pg_stat_activity WHERE state = 'active'`
    );
    res.json({
      dbSize: dbSize.rows[0].size,
      tableCount: tableCount.rows[0].count,
      activeConnections: activeConns.rows[0].count,
      database: req.session.credentials.database,
      user: req.session.credentials.user,
      host: 'localhost'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

async function isSuperuser(credentials) {
  const pool = getAuthPool(credentials);
  try {
    const r = await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname = $1', [credentials.user]);
    return r.rows.length > 0 && r.rows[0].rolsuper;
  } finally {
    await pool.end();
  }
}

function requireAdminAuth(req, res, next) {
  if (!req.session.credentials) return res.status(401).json({ error: 'Niet ingelogd' });
  next();
}

app.get('/admin/check', requireAdminAuth, async (req, res) => {
  try {
    const su = await isSuperuser(req.session.credentials);
    res.json({ superuser: su });
  } catch (err) {
    res.json({ superuser: false });
  }
});

app.get('/admin/roles', requireAdminAuth, async (req, res) => {
  const pool = getAuthPool(req.session.credentials);
  try {
    const r = await pool.query(`
      SELECT r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin,
        r.rolinherit, r.rolreplication, r.rolconnlimit,
        (SELECT COUNT(*) FROM pg_auth_members m WHERE m.roleid = r.oid) as member_count
      FROM pg_roles r
      WHERE r.rolname NOT LIKE 'pg_%'
      ORDER BY r.rolsuper DESC, r.rolname
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.post('/admin/role', requireAdminAuth, async (req, res) => {
  const { name, password, canLogin, superuser, createDb, createRole } = req.body;
  const pool = getAuthPool(req.session.credentials);
  try {
    const opts = [];
    if (canLogin) opts.push('LOGIN');
    if (superuser) opts.push('SUPERUSER');
    if (createDb) opts.push('CREATEDB');
    if (createRole) opts.push('CREATEROLE');
    if (password) opts.push(`PASSWORD '${password.replace(/'/g, "''")}'`);
    if (opts.length === 0) opts.push('NOLOGIN');
    await pool.query(`CREATE ROLE "${name}" ${opts.join(' ')}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.delete('/admin/role/:name', requireAdminAuth, async (req, res) => {
  const pool = getAuthPool(req.session.credentials);
  try {
    await pool.query(`DROP ROLE IF EXISTS "${req.params.name}"`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.post('/admin/role/:name/password', requireAdminAuth, async (req, res) => {
  const pool = getAuthPool(req.session.credentials);
  try {
    await pool.query(`ALTER ROLE "${req.params.name}" WITH PASSWORD '${req.body.password.replace(/'/g, "''")}'`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.get('/admin/dbs', requireAdminAuth, async (req, res) => {
  const pool = getAuthPool(req.session.credentials);
  try {
    const r = await pool.query(`
      SELECT d.datname, pg_size_pretty(pg_database_size(d.datname)) as size,
        u.rolname as owner,
        pg_encoding_to_char(d.encoding) as encoding
      FROM pg_database d
      JOIN pg_roles u ON d.datdba = u.oid
      WHERE d.datistemplate = false
      ORDER BY d.datname
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.post('/admin/db', requireAdminAuth, async (req, res) => {
  const { name, owner } = req.body;
  const pool = getAuthPool(req.session.credentials);
  try {
    const ownerClause = owner ? ` OWNER "${owner}"` : '';
    await pool.query(`CREATE DATABASE "${name}"${ownerClause}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.delete('/admin/db/:name', requireAdminAuth, async (req, res) => {
  const pool = getAuthPool(req.session.credentials);
  try {
    await pool.query(`DROP DATABASE IF EXISTS "${req.params.name}"`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.post('/admin/grant', requireAdminAuth, async (req, res) => {
  const { role, database, privilege } = req.body;
  const pool = getAuthPool(req.session.credentials);
  try {
    if (database === '*ALL*') {
      await pool.query(`GRANT ${privilege} ON ALL TABLES IN SCHEMA public TO "${role}"`);
      await pool.query(`GRANT ${privilege} ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
    } else {
      const dbPool = new Pool({
        host: 'localhost', port: 5432,
        user: req.session.credentials.user,
        password: req.session.credentials.password,
        database: database, max: 2, idleTimeoutMillis: 5000
      });
      try {
        await dbPool.query(`GRANT ${privilege} ON ALL TABLES IN SCHEMA public TO "${role}"`);
        await dbPool.query(`GRANT ${privilege} ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
      } finally {
        await dbPool.end();
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.post('/admin/revoke', requireAdminAuth, async (req, res) => {
  const { role, database, privilege } = req.body;
  const pool = getAuthPool(req.session.credentials);
  try {
    if (database === '*ALL*') {
      await pool.query(`REVOKE ${privilege} ON ALL TABLES IN SCHEMA public FROM "${role}"`);
      await pool.query(`REVOKE ${privilege} ON ALL SEQUENCES IN SCHEMA public FROM "${role}"`);
    } else {
      const dbPool = new Pool({
        host: 'localhost', port: 5432,
        user: req.session.credentials.user,
        password: req.session.credentials.password,
        database: database, max: 2, idleTimeoutMillis: 5000
      });
      try {
        await dbPool.query(`REVOKE ${privilege} ON ALL TABLES IN SCHEMA public FROM "${role}"`);
        await dbPool.query(`REVOKE ${privilege} ON ALL SEQUENCES IN SCHEMA public FROM "${role}"`);
      } finally {
        await dbPool.end();
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.post('/admin/grant-db', requireAdminAuth, async (req, res) => {
  const { role, database } = req.body;
  const pool = getAuthPool(req.session.credentials);
  try {
    await pool.query(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
    await pool.query(`GRANT ALL PRIVILEGES ON DATABASE "${database}" TO "${role}"`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.post('/admin/revoke-db', requireAdminAuth, async (req, res) => {
  const { role, database } = req.body;
  const pool = getAuthPool(req.session.credentials);
  try {
    await pool.query(`REVOKE ALL PRIVILEGES ON DATABASE "${database}" FROM "${role}"`);
    await pool.query(`REVOKE CONNECT ON DATABASE "${database}" FROM "${role}"`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PostgreSQL Manager draait op http://0.0.0.0:${PORT}`);
});
