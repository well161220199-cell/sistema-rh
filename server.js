require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');
const mammoth = require('mammoth');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { EMPRESA, TEMPLATES, getLogoBase64 } = require('./templates');

const app = express();
const PORT = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : false });

async function initDB() {
  const c = await pool.connect();
  try {
    await c.query('CREATE TABLE IF NOT EXISTS "session" ("sid" varchar NOT NULL,"sess" json NOT NULL,"expire" timestamp(6) NOT NULL,CONSTRAINT "session_pkey" PRIMARY KEY ("sid"));CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");');
    await c.query('CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY,username VARCHAR(100) UNIQUE NOT NULL,password_hash VARCHAR(255) NOT NULL,name VARCHAR(255) NOT NULL,created_at TIMESTAMP DEFAULT NOW());');
    await c.query('CREATE TABLE IF NOT EXISTS employees (id SERIAL PRIMARY KEY,data JSONB NOT NULL DEFAULT \'{}\',photo TEXT DEFAULT \'\',created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW());');
    await c.query('DO $$ BEGIN ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo TEXT DEFAULT \'\'; EXCEPTION WHEN duplicate_column THEN NULL; END $$;');
    console.log('DB OK');
  } finally { c.release(); }
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ store: new pgSession({ pool, tableName: 'session' }), secret: process.env.SESSION_SECRET || 'rh-secret-2024', resave: false, saveUninitialized: false, cookie: { maxAge: 30*24*60*60*1000, secure: false } }));

function auth(req, res, next) { if (req.session?.userId) return next(); res.status(401).json({ error: 'Não autorizado' }); }

// AUTH
app.post('/api/register', async (req, res) => { try { const {username,password,name}=req.body; if(!username||!password||!name)return res.status(400).json({error:'Preencha todos'}); const ex=await pool.query('SELECT id FROM users WHERE username=$1',[username.toLowerCase()]); if(ex.rows.length>0)return res.status(400).json({error:'Usuário já existe'}); const h=await bcrypt.hash(password,10); const r=await pool.query('INSERT INTO users (username,password_hash,name) VALUES($1,$2,$3) RETURNING id,name',[username.toLowerCase(),h,name]); req.session.userId=r.rows[0].id;req.session.userName=r.rows[0].name; res.json({success:true,name:r.rows[0].name}); } catch(e){console.error(e);res.status(500).json({error:'Erro'})} });
app.post('/api/login', async (req, res) => { try { const {username,password}=req.body; if(!username||!password)return res.status(400).json({error:'Preencha todos'}); const r=await pool.query('SELECT * FROM users WHERE username=$1',[username.toLowerCase()]); if(!r.rows.length)return res.status(401).json({error:'Credenciais inválidas'}); if(!await bcrypt.compare(password,r.rows[0].password_hash))return res.status(401).json({error:'Credenciais inválidas'}); req.session.userId=r.rows[0].id;req.session.userName=r.rows[0].name; res.json({success:true,name:r.rows[0].name}); } catch(e){console.error(e);res.status(500).json({error:'Erro'})} });
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({success:true}); });
app.get('/api/me', (req, res) => { req.session?.userId ? res.json({logged:true,name:req.session.userName}) : res.json({logged:false}); });

// EMPLOYEES
app.get('/api/employees', auth, async (req, res) => { try { const r=await pool.query('SELECT id,data,photo FROM employees ORDER BY created_at DESC'); res.json(r.rows.map(x=>({id:x.id,...x.data,photo:x.photo||''}))); } catch(e){res.status(500).json({error:'Erro'})} });
app.post('/api/employees', auth, async (req, res) => { try { const d={...req.body};const p=d.photo||'';delete d.id;delete d.photo; const r=await pool.query('INSERT INTO employees (data,photo) VALUES($1,$2) RETURNING id',[JSON.stringify(d),p]); res.json({id:r.rows[0].id,success:true}); } catch(e){res.status(500).json({error:'Erro'})} });
app.put('/api/employees/:id', auth, async (req, res) => { try { const d={...req.body};const p=d.photo||'';delete d.id;delete d.photo; await pool.query('UPDATE employees SET data=$1,photo=$2,updated_at=NOW() WHERE id=$3',[JSON.stringify(d),p,req.params.id]); res.json({success:true}); } catch(e){res.status(500).json({error:'Erro'})} });
app.delete('/api/employees/:id', auth, async (req, res) => { try { await pool.query('DELETE FROM employees WHERE id=$1',[req.params.id]); res.json({success:true}); } catch(e){res.status(500).json({error:'Erro'})} });

// GROQ OCR
const GROQ_KEY = process.env.GROQ_API_KEY;
const OCR_PROMPT = 'Você é um especialista em OCR de documentos trabalhistas brasileiros. Leia CADA caractere com precisão. CPF: 000.000.000-00. Datas: DD/MM/AAAA. Se ilegível use "". NUNCA invente dados. Retorne APENAS JSON: {"nome":"","cpf":"","rg":"","orgaoEmissor":"","dataNascimento":"","sexo":"","estadoCivil":"","nacionalidade":"","naturalidade":"","nomeMae":"","nomePai":"","endereco":"","numero":"","complemento":"","bairro":"","cidade":"","estado":"","cep":"","telefone":"","celular":"","email":"","ctpsNumero":"","ctpsSerie":"","ctpsUf":"","pisPasep":"","tituloEleitor":"","zonaEleitoral":"","secaoEleitoral":"","reservista":"","cnhNumero":"","cnhCategoria":"","cnhValidade":"","cargo":"","departamento":"","dataAdmissao":"","salario":"","tipoContrato":"","jornadaTrabalho":"","escolaridade":"","banco":"","agencia":"","conta":"","tipoConta":"","chavePix":"","tipoSanguineo":"","alergias":"","contatoEmergencia":"","telEmergencia":"","dependentes":""}';

app.post('/api/ocr', auth, async (req, res) => {
  try {
    const {image,mimeType}=req.body; if(!image||!GROQ_KEY)return res.status(400).json({error:'Imagem ou API key ausente'});
    const resp=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_KEY},body:JSON.stringify({model:'meta-llama/llama-4-scout-17b-16e-instruct',messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:'+(mimeType||'image/jpeg')+';base64,'+image}},{type:'text',text:OCR_PROMPT}]}],max_completion_tokens:4096,temperature:0.05})});
    if(!resp.ok)throw new Error('API Groq erro '+resp.status);
    const data=await resp.json();let text=data.choices?.[0]?.message?.content||'';text=text.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();
    const m=text.match(/\{[\s\S]*\}/);if(!m)throw new Error('IA não retornou JSON');
    res.json(JSON.parse(m[0]));
  } catch(e){console.error('OCR:',e.message);res.status(500).json({error:e.message})}
});

// TEMPLATES LIST
app.get('/api/templates', auth, (req, res) => {
  const list = TEMPLATES.map(t => ({
    id: t.id, title: t.title, category: t.category,
    categoryLabel: t.categoryLabel, icon: t.icon,
    customFields: t.customFields
  }));
  res.json(list);
});

// GENERATE DOCUMENT PDF
app.post('/api/generate-document', auth, async (req, res) => {
  try {
    const { templateId, employee, customFields } = req.body;
    const template = TEMPLATES.find(t => t.id === templateId);
    if (!template) return res.status(404).json({ error: 'Template não encontrado' });

    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const W = 595.28, H = 841.89, M = 45;

    // Try to embed logo
    let logoImage = null;
    const logoB64 = getLogoBase64();
    if (logoB64) {
      try { logoImage = await pdf.embedJpg(Buffer.from(logoB64, 'base64')); } catch (e) { console.error('Logo embed error:', e.message); }
    }

    let page = pdf.addPage([W, H]);
    let y = H - M;

    // ── HEADER with logo ──
    if (logoImage) {
      const logoH = 55;
      const logoW = logoH * (logoImage.width / logoImage.height);
      page.drawImage(logoImage, { x: M, y: y - logoH + 10, width: logoW, height: logoH });
      // Company info to the right of logo
      var infoX = M + logoW + 15;
      page.drawText(EMPRESA.nome, { x: infoX, y: y - 5, size: 8, font: fontBold, color: rgb(0.15, 0.15, 0.2) });
      page.drawText(EMPRESA.endereco + ' - CEP ' + EMPRESA.cep, { x: infoX, y: y - 18, size: 7, font: font, color: rgb(0.4, 0.4, 0.45) });
      page.drawText('CNPJ: ' + EMPRESA.cnpj + ' | IE: ' + EMPRESA.ie, { x: infoX, y: y - 30, size: 7, font: font, color: rgb(0.4, 0.4, 0.45) });
      y -= 70;
    } else {
      page.drawText(EMPRESA.nome, { x: M, y: y, size: 10, font: fontBold, color: rgb(0.15, 0.15, 0.2) });
      page.drawText(EMPRESA.endereco + ' - CEP ' + EMPRESA.cep, { x: M, y: y - 14, size: 8, font: font, color: rgb(0.4, 0.4, 0.45) });
      page.drawText('CNPJ: ' + EMPRESA.cnpj + ' | IE: ' + EMPRESA.ie, { x: M, y: y - 26, size: 8, font: font, color: rgb(0.4, 0.4, 0.45) });
      y -= 50;
    }

    // Separator
    page.drawLine({ start: { x: M, y: y }, end: { x: W - M, y: y }, thickness: 1.5, color: rgb(0.8, 0.15, 0.15) });
    y -= 25;

    // Document title
    var titleWidth = fontBold.widthOfTextAtSize(template.title, 14);
    page.drawText(template.title, { x: (W - titleWidth) / 2, y: y, size: 14, font: fontBold, color: rgb(0.12, 0.12, 0.18) });
    y -= 30;

    // Process body
    var custom = customFields || {};
    var emp = employee || {};

    function replacePlaceholders(text) {
      // Replace employee fields {{field}}
      text = text.replace(/\{\{(\w+)\}\}/g, function(_, key) { return emp[key] || '_______________'; });
      // Replace custom fields [[key]]
      text = text.replace(/\[\[(\w+)\]\]/g, function(_, key) { return custom[key] || '_______________'; });
      return text;
    }

    function drawText(text, x, yy, size, f, color) {
      // Word wrap
      var words = text.split(' ');
      var line = '';
      var maxW = W - M * 2;
      var lineH = size * 1.5;
      
      for (var i = 0; i < words.length; i++) {
        var test = line + (line ? ' ' : '') + words[i];
        var tw = f.widthOfTextAtSize(test, size);
        if (tw > maxW && line) {
          if (yy < 50) { page = pdf.addPage([W, H]); yy = H - M; }
          page.drawText(line, { x: x, y: yy, size: size, font: f, color: color });
          yy -= lineH;
          line = words[i];
        } else {
          line = test;
        }
      }
      if (line) {
        if (yy < 50) { page = pdf.addPage([W, H]); yy = H - M; }
        page.drawText(line, { x: x, y: yy, size: size, font: f, color: color });
        yy -= lineH;
      }
      return yy;
    }

    for (var bi = 0; bi < template.body.length; bi++) {
      var line = template.body[bi];

      if (y < 60) { page = pdf.addPage([W, H]); y = H - M; }

      // Section header
      if (line.startsWith('# ')) {
        y -= 5;
        page.drawRectangle({ x: M, y: y - 2, width: W - M * 2, height: 18, color: rgb(0.94, 0.95, 0.97) });
        page.drawText(line.substring(2).toUpperCase(), { x: M + 8, y: y + 2, size: 8, font: fontBold, color: rgb(0.2, 0.3, 0.5) });
        y -= 22;
        continue;
      }

      // Separator
      if (line === '---') {
        y -= 3;
        page.drawLine({ start: { x: M, y: y }, end: { x: W - M, y: y }, thickness: 0.5, color: rgb(0.85, 0.85, 0.88) });
        y -= 10;
        continue;
      }

      // Employee info block
      if (line === '[EMPLOYEE_INFO]') {
        var fields = [
          ['Nome', emp.nome], ['CPF', emp.cpf], ['RG', emp.rg],
          ['Data Nasc.', emp.dataNascimento], ['Endereço', (emp.endereco||'')+', '+(emp.numero||'')+' - '+(emp.bairro||'')+', '+(emp.cidade||'')+'/'+(emp.estado||'')],
          ['Cargo', emp.cargo], ['Admissão', emp.dataAdmissao]
        ];
        for (var fi = 0; fi < fields.length; fi++) {
          if (y < 50) { page = pdf.addPage([W, H]); y = H - M; }
          var label = fields[fi][0] + ': ';
          var val = fields[fi][1] || '_______________';
          page.drawText(label, { x: M, y: y, size: 8, font: fontBold, color: rgb(0.4, 0.4, 0.5) });
          page.drawText(val, { x: M + fontBold.widthOfTextAtSize(label, 8), y: y, size: 9, font: font, color: rgb(0.1, 0.1, 0.15) });
          y -= 15;
        }
        continue;
      }

      // Ponto table
      if (line === '[PONTO_TABLE]') {
        var days = ['Dia','Entrada','Saída Alm.','Retorno','Saída','Assinatura'];
        var colW = (W - M * 2) / days.length;
        // Header
        page.drawRectangle({ x: M, y: y - 2, width: W - M * 2, height: 16, color: rgb(0.94, 0.95, 0.97) });
        for (var di = 0; di < days.length; di++) {
          page.drawText(days[di], { x: M + di * colW + 4, y: y + 2, size: 7, font: fontBold, color: rgb(0.3, 0.3, 0.4) });
        }
        y -= 18;
        // 31 rows
        for (var row = 1; row <= 31; row++) {
          if (y < 50) { page = pdf.addPage([W, H]); y = H - M; }
          page.drawText(String(row).padStart(2, '0'), { x: M + 4, y: y, size: 7, font: font, color: rgb(0.3, 0.3, 0.3) });
          page.drawLine({ start: { x: M, y: y - 4 }, end: { x: W - M, y: y - 4 }, thickness: 0.3, color: rgb(0.9, 0.9, 0.9) });
          for (var ci = 1; ci < days.length; ci++) {
            page.drawLine({ start: { x: M + ci * colW, y: y + 10 }, end: { x: M + ci * colW, y: y - 4 }, thickness: 0.3, color: rgb(0.9, 0.9, 0.9) });
          }
          y -= 14;
        }
        continue;
      }

      // Date line
      if (line === '[DATE_LINE]') {
        y -= 10;
        var today = new Date();
        var dateStr = EMPRESA.cidade + '/' + EMPRESA.uf + ', _____ de _________________ de ________';
        page.drawText(dateStr, { x: M, y: y, size: 9, font: font, color: rgb(0.3, 0.3, 0.3) });
        y -= 25;
        continue;
      }

      // Signatures
      if (line.startsWith('[SIGNATURES:')) {
        var count = parseInt(line.match(/\d+/)[0]) || 2;
        y -= 20;
        var labels = ['Empregador', 'Funcionário(a)', 'Testemunha 1', 'Testemunha 2'];
        var sigW = count <= 2 ? 200 : 150;
        var gap = (W - M * 2 - sigW * Math.min(count, 2)) / (Math.min(count, 2) - 1 || 1);
        
        // First row
        var row1 = Math.min(count, 2);
        for (var si = 0; si < row1; si++) {
          if (y < 60) { page = pdf.addPage([W, H]); y = H - M - 20; }
          var sx = M + si * (sigW + gap);
          page.drawLine({ start: { x: sx, y: y }, end: { x: sx + sigW, y: y }, thickness: 1, color: rgb(0.2, 0.2, 0.25) });
          page.drawText(labels[si] || 'Assinatura', { x: sx + (sigW - font.widthOfTextAtSize(labels[si] || 'Assinatura', 8)) / 2, y: y - 14, size: 8, font: font, color: rgb(0.5, 0.5, 0.55) });
        }
        y -= 35;

        // Second row if needed
        if (count > 2) {
          for (var si2 = 2; si2 < count; si2++) {
            if (y < 60) { page = pdf.addPage([W, H]); y = H - M - 20; }
            var sx2 = M + (si2 - 2) * (sigW + gap);
            page.drawLine({ start: { x: sx2, y: y }, end: { x: sx2 + sigW, y: y }, thickness: 1, color: rgb(0.2, 0.2, 0.25) });
            page.drawText(labels[si2] || 'Assinatura', { x: sx2 + (sigW - font.widthOfTextAtSize(labels[si2] || 'Assinatura', 8)) / 2, y: y - 14, size: 8, font: font, color: rgb(0.5, 0.5, 0.55) });
          }
          y -= 35;
        }
        continue;
      }

      // Emphasized text
      if (line.startsWith('> ')) {
        var eText = replacePlaceholders(line.substring(2));
        y = drawText(eText, M + 10, y, 10, fontBold, rgb(0.1, 0.1, 0.2));
        y -= 3;
        continue;
      }

      // Bullet points
      if (line.startsWith('• ')) {
        var bText = replacePlaceholders(line.substring(2));
        page.drawText('•', { x: M + 5, y: y, size: 9, font: font, color: rgb(0.3, 0.3, 0.4) });
        y = drawText(bText, M + 18, y, 9, font, rgb(0.2, 0.2, 0.25));
        continue;
      }

      // Empty line
      if (line === '') { y -= 8; continue; }

      // Regular text with placeholders
      var processed = replacePlaceholders(line);
      
      // Check if it's a label:value line
      if (processed.includes(': ') && processed.indexOf(': ') < 30) {
        var parts = processed.split(': ');
        var lbl = parts[0] + ': ';
        var val = parts.slice(1).join(': ');
        page.drawText(lbl, { x: M, y: y, size: 8, font: fontBold, color: rgb(0.4, 0.4, 0.5) });
        var lblW = fontBold.widthOfTextAtSize(lbl, 8);
        y = drawText(val, M + lblW, y, 9, font, rgb(0.1, 0.1, 0.15));
      } else {
        y = drawText(processed, M, y, 9, font, rgb(0.2, 0.2, 0.25));
      }
    }

    // Footer
    var lastPage = pdf.getPages()[pdf.getPageCount() - 1];
    lastPage.drawRectangle({ x: 0, y: 0, width: W, height: 22, color: rgb(0.96, 0.96, 0.97) });
    lastPage.drawText(EMPRESA.nome + ' — Documento gerado pelo Sistema RH', { x: M, y: 7, size: 6, font: font, color: rgb(0.6, 0.6, 0.65) });

    const pdfBytes = await pdf.save();
    var filename = (template.title + ' - ' + (emp.nome || 'doc')).replace(/[^a-zA-Z0-9À-ú\s\-]/g, '').replace(/\s+/g, '_');
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="' + filename + '.pdf"' });
    res.send(Buffer.from(pdfBytes));
  } catch (e) {
    console.error('PDF Error:', e);
    res.status(500).json({ error: 'Erro ao gerar PDF: ' + e.message });
  }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
initDB().then(() => { app.listen(PORT, () => console.log('Sistema RH: http://localhost:' + PORT)); }).catch(e => { console.error('DB:', e); process.exit(1); });
