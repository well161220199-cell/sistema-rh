require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════
// DATABASE
// ══════════════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
      );
      CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('Database initialized');
  } finally {
    client.release();
  }
}

// ══════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'sistema-rh-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, secure: false },
}));

function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  res.status(401).json({ error: 'Não autorizado' });
}

// ══════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, name } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: 'Preencha todos os campos' });
    if (password.length < 4) return res.status(400).json({ error: 'Senha deve ter pelo menos 4 caracteres' });

    const exists = await pool.query('SELECT id FROM users WHERE username = $1', [username.toLowerCase()]);
    if (exists.rows.length > 0) return res.status(400).json({ error: 'Usuário já existe' });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, name) VALUES ($1, $2, $3) RETURNING id, name',
      [username.toLowerCase(), hash, name]
    );

    req.session.userId = result.rows[0].id;
    req.session.userName = result.rows[0].name;
    res.json({ success: true, name: result.rows[0].name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Preencha todos os campos' });

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username.toLowerCase()]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Usuário ou senha incorretos' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Usuário ou senha incorretos' });

    req.session.userId = user.id;
    req.session.userName = user.name;
    res.json({ success: true, name: user.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  if (req.session?.userId) {
    res.json({ logged: true, name: req.session.userName });
  } else {
    res.json({ logged: false });
  }
});

// ══════════════════════════════════════
// EMPLOYEE CRUD
// ══════════════════════════════════════
app.get('/api/employees', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, data, created_at, updated_at FROM employees ORDER BY created_at DESC');
    res.json(result.rows.map(r => ({ id: r.id, ...r.data, _created: r.created_at, _updated: r.updated_at })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar funcionários' });
  }
});

app.post('/api/employees', requireAuth, async (req, res) => {
  try {
    const data = req.body;
    delete data.id; delete data._created; delete data._updated;
    const result = await pool.query(
      'INSERT INTO employees (data) VALUES ($1) RETURNING id, created_at',
      [JSON.stringify(data)]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao salvar' });
  }
});

app.put('/api/employees/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;
    delete data.id; delete data._created; delete data._updated;
    await pool.query(
      'UPDATE employees SET data = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(data), id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao atualizar' });
  }
});

app.delete('/api/employees/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM employees WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao excluir' });
  }
});

// ══════════════════════════════════════
// GROQ PROXY (key stays on server)
// ══════════════════════════════════════
const GROQ_API_KEY = process.env.GROQ_API_KEY || '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';

app.post('/api/ocr', requireAuth, async (req, res) => {
  try {
    const { image, mimeType, prompt } = req.body;
    
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: 'llama-4-scout-17b-16e-instruct',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + image } },
            { type: 'text', text: prompt }
          ]
        }],
        max_tokens: 2048,
        temperature: 0.1,
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Groq error:', err);
      return res.status(500).json({ error: 'Erro na API Groq: ' + response.status });
    }

    const data = await response.json();
    let text = data.choices?.[0]?.message?.content || '';
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    
    const parsed = JSON.parse(text);
    res.json(parsed);
  } catch (err) {
    console.error('OCR Error:', err);
    res.status(500).json({ error: 'Erro ao processar imagem' });
  }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════════════════════════════════════
// START
// ══════════════════════════════════════
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Sistema RH rodando na porta ${PORT}`);
    console.log(`Acesse: http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Erro ao inicializar banco:', err);
  process.exit(1);
});
