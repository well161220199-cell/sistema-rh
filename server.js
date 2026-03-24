require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
        id SERIAL PRIMARY KEY, username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL, created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}',
        photo TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`DO $$ BEGIN ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo TEXT DEFAULT ''; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`);
    console.log('Database initialized');
  } finally { client.release(); }
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'sistema-rh-secret-key-2024',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, secure: false },
}));

function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  res.status(401).json({ error: 'Não autorizado' });
}

// ══════ AUTH ══════
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, name } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: 'Preencha todos os campos' });
    if (password.length < 4) return res.status(400).json({ error: 'Senha deve ter pelo menos 4 caracteres' });
    const exists = await pool.query('SELECT id FROM users WHERE username = $1', [username.toLowerCase()]);
    if (exists.rows.length > 0) return res.status(400).json({ error: 'Usuário já existe' });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query('INSERT INTO users (username, password_hash, name) VALUES ($1, $2, $3) RETURNING id, name', [username.toLowerCase(), hash, name]);
    req.session.userId = result.rows[0].id;
    req.session.userName = result.rows[0].name;
    res.json({ success: true, name: result.rows[0].name });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
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
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/me', (req, res) => {
  if (req.session?.userId) res.json({ logged: true, name: req.session.userName });
  else res.json({ logged: false });
});

// ══════ EMPLOYEES ══════
app.get('/api/employees', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, data, photo, created_at, updated_at FROM employees ORDER BY created_at DESC');
    res.json(result.rows.map(r => ({ id: r.id, ...r.data, photo: r.photo || '', _created: r.created_at, _updated: r.updated_at })));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao buscar funcionários' }); }
});

app.post('/api/employees', requireAuth, async (req, res) => {
  try {
    const data = { ...req.body };
    const photo = data.photo || '';
    delete data.id; delete data._created; delete data._updated; delete data.photo;
    const result = await pool.query('INSERT INTO employees (data, photo) VALUES ($1, $2) RETURNING id', [JSON.stringify(data), photo]);
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao salvar' }); }
});

app.put('/api/employees/:id', requireAuth, async (req, res) => {
  try {
    const data = { ...req.body };
    const photo = data.photo || '';
    delete data.id; delete data._created; delete data._updated; delete data.photo;
    await pool.query('UPDATE employees SET data = $1, photo = $2, updated_at = NOW() WHERE id = $3', [JSON.stringify(data), photo, req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao atualizar' }); }
});

app.delete('/api/employees/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM employees WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao excluir' }); }
});

// ══════ GROQ OCR ══════
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const OCR_PROMPT = `Você é um especialista em OCR de documentos trabalhistas brasileiros. Analise esta imagem com MÁXIMA PRECISÃO.

REGRAS OBRIGATÓRIAS:
- Leia CADA caractere com cuidado, letra por letra, número por número
- CPF: formato 000.000.000-00 (EXATAMENTE 11 dígitos). Leia cada dígito com atenção
- RG: pode conter números e letras. Leia com precisão
- Datas: formato DD/MM/AAAA. Verifique se o ano faz sentido (ex: nascimento entre 1940-2010, admissão entre 1980-2026)
- Nomes: leia o nome COMPLETO, sem abreviar, com acentos corretos
- Se um campo estiver ilegível ou não existir na ficha, use "" (string vazia) - NUNCA INVENTE dados
- Se a letra for manuscrita/cursiva, faça o melhor esforço para ler
- Preste atenção especial a: 0 vs O, 1 vs I vs l, 5 vs S, 8 vs B, 6 vs G
- Salário: inclua o valor com vírgula (ex: "1.500,00" ou "R$ 2.300,00")
- Endereço: leia completo incluindo número, complemento, bairro, cidade e UF

Analise TODA a ficha e extraia TODOS os campos visíveis.

Retorne EXCLUSIVAMENTE um JSON válido com estas chaves (sem markdown, sem backticks, sem texto adicional):
{
  "nome": "",
  "cpf": "",
  "rg": "",
  "orgaoEmissor": "",
  "dataNascimento": "",
  "sexo": "",
  "estadoCivil": "",
  "nacionalidade": "",
  "naturalidade": "",
  "nomeMae": "",
  "nomePai": "",
  "endereco": "",
  "numero": "",
  "complemento": "",
  "bairro": "",
  "cidade": "",
  "estado": "",
  "cep": "",
  "telefone": "",
  "celular": "",
  "email": "",
  "ctpsNumero": "",
  "ctpsSerie": "",
  "ctpsUf": "",
  "pisPasep": "",
  "tituloEleitor": "",
  "zonaEleitoral": "",
  "secaoEleitoral": "",
  "reservista": "",
  "cnhNumero": "",
  "cnhCategoria": "",
  "cnhValidade": "",
  "cargo": "",
  "departamento": "",
  "dataAdmissao": "",
  "salario": "",
  "tipoContrato": "",
  "jornadaTrabalho": "",
  "escolaridade": "",
  "banco": "",
  "agencia": "",
  "conta": "",
  "tipoConta": "",
  "chavePix": "",
  "tipoSanguineo": "",
  "alergias": "",
  "contatoEmergencia": "",
  "telEmergencia": "",
  "dependentes": ""
}`;

const FORM_PROMPT = `Analise este formulário brasileiro e identifique TODOS os campos para preenchimento.
Para cada campo, associe à chave correspondente do cadastro de funcionário.

Chaves disponíveis: nome, cpf, rg, orgaoEmissor, dataNascimento, sexo, estadoCivil, nacionalidade, naturalidade, nomeMae, nomePai, endereco, numero, complemento, bairro, cidade, estado, cep, telefone, celular, email, ctpsNumero, ctpsSerie, ctpsUf, pisPasep, tituloEleitor, zonaEleitoral, secaoEleitoral, reservista, cnhNumero, cnhCategoria, cnhValidade, cargo, departamento, dataAdmissao, salario, tipoContrato, jornadaTrabalho, escolaridade, banco, agencia, conta, tipoConta, chavePix, tipoSanguineo, alergias, contatoEmergencia, telEmergencia, dependentes.

Retorne APENAS JSON (sem markdown): {"formTitle":"Nome do Formulário","fields":[{"label":"texto do campo","key":"chave"}]}
Se não tiver chave correspondente, use "custom" com "customLabel".`;

app.post('/api/ocr', requireAuth, async (req, res) => {
  try {
    const { image, mimeType, type } = req.body;
    if (!image) return res.status(400).json({ error: 'Imagem é obrigatória' });
    if (!GROQ_API_KEY) return res.status(500).json({ error: 'Chave da API Groq não configurada' });

    const finalPrompt = type === 'form' ? FORM_PROMPT : OCR_PROMPT;
    console.log('OCR Request - Size:', Math.round(image.length / 1024), 'KB, Type:', type || 'ocr');

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_API_KEY },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:' + (mimeType || 'image/jpeg') + ';base64,' + image } },
            { type: 'text', text: finalPrompt }
          ]
        }],
        max_completion_tokens: 4096,
        temperature: 0.05,
      })
    });

    const responseText = await response.text();
    if (!response.ok) {
      console.error('Groq error:', responseText);
      return res.status(500).json({ error: 'Erro na API Groq: ' + response.status });
    }

    const data = JSON.parse(responseText);
    let text = data.choices?.[0]?.message?.content || '';
    console.log('Groq response:', text.substring(0, 500));
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'IA não retornou dados válidos. Tente imagem mais nítida.' });

    res.json(JSON.parse(jsonMatch[0]));
  } catch (err) {
    console.error('OCR Error:', err.message);
    res.status(500).json({ error: 'Erro: ' + err.message });
  }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

initDB().then(() => {
  app.listen(PORT, () => console.log(`Sistema RH rodando em http://localhost:${PORT}`));
}).catch(err => { console.error('DB Error:', err); process.exit(1); });
