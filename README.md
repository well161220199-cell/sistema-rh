# Sistema RH — Gestão de Funcionários

Sistema completo de RH com banco de dados, login/senha, OCR via IA e preenchimento automático de formulários.

---

## COMO COLOCAR NO AR (Passo a Passo)

### PASSO 1: Criar conta no GitHub (se não tiver)
1. Acesse **github.com** e crie uma conta gratuita
2. Confirme seu e-mail

### PASSO 2: Subir o código no GitHub
1. No GitHub, clique em **"New repository"** (botão verde)
2. Nome: `sistema-rh`
3. Deixe como **Public**
4. Clique em **"Create repository"**
5. Na página do repositório, clique em **"uploading an existing file"**
6. Arraste TODOS os arquivos desta pasta (server.js, package.json, render.yaml, .gitignore e a pasta public/)
7. Clique em **"Commit changes"**

### PASSO 3: Criar conta no Render.com
1. Acesse **render.com**
2. Clique em **"Get Started for Free"**
3. Faça login com sua conta do GitHub (mais fácil)

### PASSO 4: Criar o Banco de Dados
1. No painel do Render, clique em **"New +"** → **"PostgreSQL"**
2. Nome: `sistema-rh-db`
3. Plano: **Free**
4. Clique em **"Create Database"**
5. Aguarde criar. Depois, copie a **"Internal Database URL"** (vai precisar dela)

### PASSO 5: Criar o Serviço Web
1. Clique em **"New +"** → **"Web Service"**
2. Conecte seu repositório GitHub `sistema-rh`
3. Configure:
   - **Name**: `sistema-rh`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: **Free**
4. Em **"Environment Variables"**, adicione:
   - `DATABASE_URL` = (cole a Internal Database URL do passo 4)
   - `SESSION_SECRET` = `minhaChaveSecreta2024` (qualquer texto)
   - `GROQ_API_KEY` = `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`
5. Clique em **"Create Web Service"**
6. Aguarde o deploy (2-3 minutos)

### PASSO 6: Acessar o Sistema
1. O Render vai gerar um link tipo: `https://sistema-rh.onrender.com`
2. Acesse esse link de qualquer computador
3. Crie uma conta (usuário + senha)
4. Pronto! O sistema está no ar!

---

## FUNCIONALIDADES

- **Login/Senha**: Cada pessoa cria sua conta para acessar
- **Banco de dados na nuvem**: Dados nunca se perdem, mesmo formatando o PC
- **OCR com IA**: Suba foto de ficha de registro e a IA extrai tudo automaticamente
- **Preenchimento automático**: Suba qualquer formulário, selecione funcionários, imprima preenchido
- **50+ campos**: Dados pessoais, documentos, endereço, dados bancários, saúde, dependentes

---

## OBSERVAÇÕES

- O plano gratuito do Render pode demorar ~30 segundos para carregar após inatividade (o servidor "dorme")
- O banco de dados gratuito do Render expira após 90 dias — renove gratuitamente quando pedir
- A chave da API Groq fica segura no servidor, não aparece no navegador
