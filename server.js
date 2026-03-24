require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');
const mammoth = require('mammoth');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS "session" ("sid" varchar NOT NULL COLLATE "default","sess" json NOT NULL,"expire" timestamp(6) NOT NULL,CONSTRAINT "session_pkey" PRIMARY KEY ("sid"));CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");`);
    await client.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY,username VARCHAR(100) UNIQUE NOT NULL,password_hash VARCHAR(255) NOT NULL,name VARCHAR(255) NOT NULL,created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS employees (id SERIAL PRIMARY KEY,data JSONB NOT NULL DEFAULT '{}',photo TEXT DEFAULT '',created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`DO $$ BEGIN ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo TEXT DEFAULT ''; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`);
    console.log('DB initialized');
  } finally { client.release(); }
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ store: new pgSession({ pool, tableName: 'session' }), secret: process.env.SESSION_SECRET || 'sistema-rh-secret-2024', resave: false, saveUninitialized: false, cookie: { maxAge: 30*24*60*60*1000, secure: false } }));

function auth(req, res, next) { if (req.session?.userId) return next(); res.status(401).json({ error: 'Não autorizado' }); }

// ══════ AUTH ══════
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, name } = req.body;
    if (!username||!password||!name) return res.status(400).json({ error: 'Preencha todos os campos' });
    const exists = await pool.query('SELECT id FROM users WHERE username=$1', [username.toLowerCase()]);
    if (exists.rows.length > 0) return res.status(400).json({ error: 'Usuário já existe' });
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query('INSERT INTO users (username,password_hash,name) VALUES($1,$2,$3) RETURNING id,name', [username.toLowerCase(), hash, name]);
    req.session.userId = r.rows[0].id; req.session.userName = r.rows[0].name;
    res.json({ success: true, name: r.rows[0].name });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username||!password) return res.status(400).json({ error: 'Preencha todos os campos' });
    const r = await pool.query('SELECT * FROM users WHERE username=$1', [username.toLowerCase()]);
    if (r.rows.length === 0) return res.status(401).json({ error: 'Usuário ou senha incorretos' });
    const valid = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Usuário ou senha incorretos' });
    req.session.userId = r.rows[0].id; req.session.userName = r.rows[0].name;
    res.json({ success: true, name: r.rows[0].name });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/me', (req, res) => { req.session?.userId ? res.json({ logged: true, name: req.session.userName }) : res.json({ logged: false }); });

// ══════ EMPLOYEES ══════
app.get('/api/employees', auth, async (req, res) => {
  try { const r = await pool.query('SELECT id,data,photo,created_at,updated_at FROM employees ORDER BY created_at DESC'); res.json(r.rows.map(x => ({ id: x.id, ...x.data, photo: x.photo || '', _created: x.created_at, _updated: x.updated_at }))); }
  catch (e) { res.status(500).json({ error: 'Erro' }); }
});
app.post('/api/employees', auth, async (req, res) => {
  try { const d = { ...req.body }; const photo = d.photo || ''; delete d.id; delete d._created; delete d._updated; delete d.photo; const r = await pool.query('INSERT INTO employees (data,photo) VALUES($1,$2) RETURNING id', [JSON.stringify(d), photo]); res.json({ id: r.rows[0].id, success: true }); }
  catch (e) { res.status(500).json({ error: 'Erro ao salvar' }); }
});
app.put('/api/employees/:id', auth, async (req, res) => {
  try { const d = { ...req.body }; const photo = d.photo || ''; delete d.id; delete d._created; delete d._updated; delete d.photo; await pool.query('UPDATE employees SET data=$1,photo=$2,updated_at=NOW() WHERE id=$3', [JSON.stringify(d), photo, req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: 'Erro' }); }
});
app.delete('/api/employees/:id', auth, async (req, res) => {
  try { await pool.query('DELETE FROM employees WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: 'Erro' }); }
});

// ══════ GROQ AI ══════
const GROQ_KEY = process.env.GROQ_API_KEY;

const OCR_PROMPT = `Você é um especialista em OCR de documentos trabalhistas brasileiros. Analise esta imagem com MÁXIMA PRECISÃO.

REGRAS:
- Leia CADA caractere com cuidado, letra por letra, número por número
- CPF: 000.000.000-00 (11 dígitos). RG: pode ter letras e números
- Datas: DD/MM/AAAA. Nomes: COMPLETOS sem abreviar
- Se ilegível, use "" (vazio) - NUNCA invente dados
- Atenção: 0 vs O, 1 vs I vs l, 5 vs S, 8 vs B

Retorne APENAS JSON válido (sem markdown, sem backticks):
{"nome":"","cpf":"","rg":"","orgaoEmissor":"","dataNascimento":"","sexo":"","estadoCivil":"","nacionalidade":"","naturalidade":"","nomeMae":"","nomePai":"","endereco":"","numero":"","complemento":"","bairro":"","cidade":"","estado":"","cep":"","telefone":"","celular":"","email":"","ctpsNumero":"","ctpsSerie":"","ctpsUf":"","pisPasep":"","tituloEleitor":"","zonaEleitoral":"","secaoEleitoral":"","reservista":"","cnhNumero":"","cnhCategoria":"","cnhValidade":"","cargo":"","departamento":"","dataAdmissao":"","salario":"","tipoContrato":"","jornadaTrabalho":"","escolaridade":"","banco":"","agencia":"","conta":"","tipoConta":"","chavePix":"","tipoSanguineo":"","alergias":"","contatoEmergencia":"","telEmergencia":"","dependentes":""}`;

const FORM_PROMPT = `Analise este formulário/documento. Identifique TODOS os campos que precisam ser preenchidos.
Para cada campo, retorne sua posição aproximada na página (porcentagem do topo: 0=topo, 100=rodapé) e posição horizontal (porcentagem da esquerda: 0=esquerda, 100=direita).

Chaves: nome,cpf,rg,orgaoEmissor,dataNascimento,sexo,estadoCivil,nacionalidade,naturalidade,nomeMae,nomePai,endereco,numero,complemento,bairro,cidade,estado,cep,telefone,celular,email,ctpsNumero,ctpsSerie,ctpsUf,pisPasep,tituloEleitor,zonaEleitoral,secaoEleitoral,reservista,cnhNumero,cnhCategoria,cnhValidade,cargo,departamento,dataAdmissao,salario,tipoContrato,jornadaTrabalho,escolaridade,banco,agencia,conta,tipoConta,chavePix,tipoSanguineo,alergias,contatoEmergencia,telEmergencia,dependentes

Retorne APENAS JSON (sem markdown):
{"formTitle":"Nome do Formulário","fields":[{"label":"texto do campo","key":"nome","x":30,"y":15,"w":40}]}

x=posição horizontal (% da esquerda onde o VALOR deve ser escrito, não o label)
y=posição vertical (% do topo)
w=largura aproximada do campo (% da largura da página)
Se não tiver chave correspondente, use "custom".`;

async function callGroq(imageB64, mimeType, prompt) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + imageB64 } },
        { type: 'text', text: prompt }
      ]}],
      max_completion_tokens: 4096, temperature: 0.05,
    })
  });
  if (!resp.ok) { const t = await resp.text(); console.error('Groq error:', t); throw new Error('API Groq erro ' + resp.status); }
  const data = await resp.json();
  let text = data.choices?.[0]?.message?.content || '';
  text = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('IA não retornou JSON válido');
  return JSON.parse(m[0]);
}

async function callGroqText(textContent, prompt) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{ role: 'user', content: prompt + '\n\nConteúdo do documento:\n' + textContent }],
      max_completion_tokens: 4096, temperature: 0.05,
    })
  });
  if (!resp.ok) throw new Error('API Groq erro ' + resp.status);
  const data = await resp.json();
  let text = data.choices?.[0]?.message?.content || '';
  text = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('IA não retornou JSON válido');
  return JSON.parse(m[0]);
}

// OCR endpoint
app.post('/api/ocr', auth, async (req, res) => {
  try {
    const { image, mimeType, type } = req.body;
    if (!image) return res.status(400).json({ error: 'Imagem obrigatória' });
    if (!GROQ_KEY) return res.status(500).json({ error: 'API Groq não configurada' });
    const prompt = type === 'form' ? FORM_PROMPT : OCR_PROMPT;
    const result = await callGroq(image, mimeType || 'image/jpeg', prompt);
    res.json(result);
  } catch (e) { console.error('OCR Error:', e.message); res.status(500).json({ error: e.message }); }
});

// DOCX text extraction
app.post('/api/extract-docx', auth, async (req, res) => {
  try {
    const { fileBase64 } = req.body;
    if (!fileBase64) return res.status(400).json({ error: 'Arquivo obrigatório' });
    const buffer = Buffer.from(fileBase64, 'base64');
    const result = await mammoth.extractRawText({ buffer });
    res.json({ text: result.value });
  } catch (e) { console.error('DOCX Error:', e.message); res.status(500).json({ error: 'Erro ao ler DOCX: ' + e.message }); }
});

// Analyze DOCX text with AI
app.post('/api/analyze-text', auth, async (req, res) => {
  try {
    const { text, type } = req.body;
    if (!text) return res.status(400).json({ error: 'Texto obrigatório' });
    if (!GROQ_KEY) return res.status(500).json({ error: 'API Groq não configurada' });

    const prompt = type === 'form'
      ? `Analise este conteúdo de formulário/documento. Identifique TODOS os campos que precisam ser preenchidos.
Chaves: nome,cpf,rg,orgaoEmissor,dataNascimento,sexo,estadoCivil,nacionalidade,naturalidade,nomeMae,nomePai,endereco,numero,complemento,bairro,cidade,estado,cep,telefone,celular,email,ctpsNumero,ctpsSerie,ctpsUf,pisPasep,tituloEleitor,zonaEleitoral,secaoEleitoral,reservista,cnhNumero,cnhCategoria,cnhValidade,cargo,departamento,dataAdmissao,salario,tipoContrato,jornadaTrabalho,escolaridade,banco,agencia,conta,tipoConta,chavePix,tipoSanguineo,alergias,contatoEmergencia,telEmergencia,dependentes
Retorne APENAS JSON: {"formTitle":"Nome","fields":[{"label":"campo","key":"chave","x":30,"y":15,"w":40}]}`
      : OCR_PROMPT;

    const result = await callGroqText(text, prompt);
    res.json(result);
  } catch (e) { console.error('Analyze Error:', e.message); res.status(500).json({ error: e.message }); }
});

// Generate filled PDF with original document as background
app.post('/api/generate-pdf', auth, async (req, res) => {
  try {
    const { originalImage, originalMimeType, originalPdfBase64, fields, employee, formTitle } = req.body;
    
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let pageWidth = 595.28; // A4
    let pageHeight = 841.89;

    // If original is a PDF, copy its first page
    if (originalPdfBase64) {
      try {
        const origPdf = await PDFDocument.load(Buffer.from(originalPdfBase64, 'base64'));
        const [copiedPage] = await pdfDoc.copyPages(origPdf, [0]);
        pdfDoc.addPage(copiedPage);
        const page = pdfDoc.getPages()[0];
        pageWidth = page.getWidth();
        pageHeight = page.getHeight();
      } catch (e) {
        console.error('PDF copy error, using image fallback');
        // fallback to image
        if (originalImage) {
          const page = pdfDoc.addPage([pageWidth, pageHeight]);
          const imgBytes = Buffer.from(originalImage, 'base64');
          const img = originalMimeType?.includes('png') ? await pdfDoc.embedPng(imgBytes) : await pdfDoc.embedJpg(imgBytes);
          const scaled = img.scaleToFit(pageWidth - 40, pageHeight - 40);
          page.drawImage(img, { x: 20, y: pageHeight - scaled.height - 20, width: scaled.width, height: scaled.height });
        }
      }
    } else if (originalImage) {
      // Embed image as background
      const page = pdfDoc.addPage([pageWidth, pageHeight]);
      const imgBytes = Buffer.from(originalImage, 'base64');
      let img;
      try { img = await pdfDoc.embedPng(imgBytes); } catch { img = await pdfDoc.embedJpg(imgBytes); }
      const scaled = img.scaleToFit(pageWidth - 20, pageHeight - 20);
      page.drawImage(img, { x: 10, y: pageHeight - scaled.height - 10, width: scaled.width, height: scaled.height, opacity: 0.3 });
    }

    // Overlay page with filled data
    const overlayPage = pdfDoc.getPages().length > 0 ? pdfDoc.getPages()[0] : pdfDoc.addPage([pageWidth, pageHeight]);
    
    // If we have field positions, overlay text at those positions
    if (fields && fields.length > 0 && fields[0].x !== undefined) {
      for (const f of fields) {
        if (!f.value) continue;
        const x = (f.x / 100) * pageWidth;
        const y = pageHeight - ((f.y / 100) * pageHeight);
        overlayPage.drawText(f.value, {
          x: Math.max(10, x),
          y: Math.max(10, Math.min(pageHeight - 10, y)),
          size: 10,
          font: font,
          color: rgb(0, 0, 0.6),
        });
      }
    }

    // Add a clean summary page
    const summaryPage = pdfDoc.addPage([pageWidth, pageHeight]);
    let yPos = pageHeight - 50;

    summaryPage.drawText(formTitle || 'Formulário Preenchido', { x: 50, y: yPos, size: 18, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
    yPos -= 25;
    summaryPage.drawText(employee.nome || '', { x: 50, y: yPos, size: 13, font: font, color: rgb(0.3, 0.3, 0.3) });
    yPos -= 8;
    summaryPage.drawLine({ start: { x: 50, y: yPos }, end: { x: pageWidth - 50, y: yPos }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
    yPos -= 25;

    for (const f of (fields || [])) {
      if (yPos < 80) {
        const newPage = pdfDoc.addPage([pageWidth, pageHeight]);
        yPos = pageHeight - 50;
      }
      summaryPage.drawText(f.label + ':', { x: 50, y: yPos, size: 9, font: fontBold, color: rgb(0.4, 0.4, 0.4) });
      yPos -= 15;
      summaryPage.drawText(f.value || '—', { x: 50, y: yPos, size: 11, font: font, color: rgb(0.1, 0.1, 0.1) });
      yPos -= 8;
      summaryPage.drawLine({ start: { x: 50, y: yPos }, end: { x: pageWidth - 50, y: yPos }, thickness: 0.5, color: rgb(0.9, 0.9, 0.9) });
      yPos -= 18;
    }

    // Signature area
    if (yPos > 120) {
      yPos -= 40;
      summaryPage.drawLine({ start: { x: 50, y: yPos }, end: { x: 250, y: yPos }, thickness: 1, color: rgb(0.2, 0.2, 0.2) });
      summaryPage.drawText('Assinatura do Funcionário', { x: 80, y: yPos - 15, size: 8, font: font, color: rgb(0.5, 0.5, 0.5) });
      summaryPage.drawLine({ start: { x: 320, y: yPos }, end: { x: pageWidth - 50, y: yPos }, thickness: 1, color: rgb(0.2, 0.2, 0.2) });
      summaryPage.drawText('Assinatura do Responsável', { x: 350, y: yPos - 15, size: 8, font: font, color: rgb(0.5, 0.5, 0.5) });
    }

    const pdfBytes = await pdfDoc.save();
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${(employee.nome || 'formulario').replace(/[^a-zA-Z0-9]/g, '_')}.pdf"` });
    res.send(Buffer.from(pdfBytes));
  } catch (e) {
    console.error('PDF Error:', e.message);
    res.status(500).json({ error: 'Erro ao gerar PDF: ' + e.message });
  }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

initDB().then(() => { app.listen(PORT, () => console.log(`Sistema RH em http://localhost:${PORT}`)); }).catch(e => { console.error('DB Error:', e); process.exit(1); });
