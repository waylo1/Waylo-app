const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(helmet());

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

// ================= DB =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE,
      password TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      name TEXT,
      desc TEXT
    );
  `);
})();

// ================= AUTH =================
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).send("Unauthorized");

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).send("Invalid token");
  }
}

// ================= API =================

// REGISTER
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || password.length < 6) {
    return res.status(400).send("Invalid input");
  }

  const hash = await bcrypt.hash(password, 10);

  try {
    await pool.query(
      'INSERT INTO users(email,password) VALUES($1,$2)',
      [email, hash]
    );
    res.send("OK");
  } catch {
    res.status(400).send("User exists");
  }
});

// LOGIN
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  const result = await pool.query(
    'SELECT * FROM users WHERE email=$1',
    [email]
  );

  const user = result.rows[0];
  if (!user) return res.status(400).send("Invalid");

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).send("Invalid");

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });

  res.json({ token });
});

// GET PROJECTS
app.get('/api/projects', auth, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM projects WHERE user_id=$1 ORDER BY id DESC',
    [req.user.id]
  );

  res.json(result.rows);
});

// ADD PROJECT
app.post('/api/projects', auth, async (req, res) => {
  const { name, desc } = req.body;

  await pool.query(
    'INSERT INTO projects(user_id,name,desc) VALUES($1,$2,$3)',
    [req.user.id, name, desc]
  );

  res.send("OK");
});

// DELETE PROJECT
app.delete('/api/projects/:id', auth, async (req, res) => {
  await pool.query(
    'DELETE FROM projects WHERE id=$1 AND user_id=$2',
    [req.params.id, req.user.id]
  );

  res.send("OK");
});

// ================= FRONTEND =================

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Waylo Dashboard</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/lucide@latest"></script>
</head>

<body class="bg-[#020617] text-white min-h-screen p-8">

<div id="app"></div>

<script>
let token = localStorage.getItem('token');

function setHTML(html){
  document.getElementById('app').innerHTML = html;
  lucide.createIcons();
}

// ================= AUTH UI =================
function renderAuth(){
  setHTML(\`
    <div class="flex items-center justify-center h-screen">
      <div class="bg-slate-900/60 border border-slate-800 p-8 rounded-2xl backdrop-blur-xl w-80">
        <h2 class="text-xl font-semibold mb-4 bg-gradient-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent">
          WAYLO
        </h2>

        <input id="email" placeholder="Email" class="w-full p-3 mb-2 bg-slate-800 border border-slate-700 rounded"/>
        <input id="pass" type="password" placeholder="Password" class="w-full p-3 mb-3 bg-slate-800 border border-slate-700 rounded"/>

        <button onclick="login()" class="w-full py-2 bg-gradient-to-r from-amber-400 to-orange-500 text-black rounded mb-2">
          Login
        </button>

        <button onclick="register()" class="w-full py-2 bg-slate-700 rounded">
          Register
        </button>
      </div>
    </div>
  \`);
}

// ================= DASHBOARD =================
function renderDashboard(projects){
  setHTML(\`
    <div class="max-w-5xl mx-auto">

      <div class="flex justify-between mb-8">
        <h1 class="text-2xl font-bold bg-gradient-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent">
          WAYLO Dashboard
        </h1>
        <button onclick="logout()" class="text-red-400">Logout</button>
      </div>

      <!-- STATS -->
      <div class="grid grid-cols-3 gap-4 mb-8">
        <div class="p-4 bg-slate-900 border border-slate-800 rounded-xl">Projets: \${projects.length}</div>
        <div class="p-4 bg-slate-900 border border-slate-800 rounded-xl">Score: 98%</div>
        <div class="p-4 bg-slate-900 border border-slate-800 rounded-xl">Status: OK</div>
      </div>

      <!-- ADD -->
      <div class="flex gap-2 mb-6">
        <input id="name" placeholder="Projet" class="p-2 bg-slate-800 rounded w-full"/>
        <input id="desc" placeholder="Description" class="p-2 bg-slate-800 rounded w-full"/>
        <button onclick="add()" class="px-4 bg-amber-500 text-black rounded">+</button>
      </div>

      <!-- LIST -->
      <div class="space-y-3">
        \${projects.map(p => \`
          <div class="flex justify-between items-center bg-slate-900 border border-slate-800 p-4 rounded-xl">
            <div>
              <div class="font-semibold">\${p.name}</div>
              <div class="text-sm text-slate-400">\${p.desc || ''}</div>
            </div>
            <button onclick="del(\${p.id})" class="text-red-400">
              <i data-lucide="trash"></i>
            </button>
          </div>
        \`).join('')}
      </div>

    </div>
  \`);
}

// ================= ACTIONS =================

async function login(){
  const email = document.getElementById('email').value;
  const password = document.getElementById('pass').value;

  const res = await fetch('/api/login',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({email,password})
  });

  const data = await res.json();
  token = data.token;
  localStorage.setItem('token', token);
  load();
}

async function register(){
  const email = document.getElementById('email').value;
  const password = document.getElementById('pass').value;

  await fetch('/api/register',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({email,password})
  });

  alert("Account created");
}

function logout(){
  localStorage.removeItem('token');
  token = null;
  load();
}

async function load(){
  if(!token) return renderAuth();

  const res = await fetch('/api/projects',{
    headers:{ Authorization: 'Bearer ' + token }
  });

  if(!res.ok){
    token = null;
    return renderAuth();
  }

  const data = await res.json();
  renderDashboard(data);
}

async function add(){
  await fetch('/api/projects',{
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      Authorization:'Bearer '+token
    },
    body: JSON.stringify({
      name: document.getElementById('name').value,
      desc: document.getElementById('desc').value
    })
  });
  load();
}

async function del(id){
  await fetch('/api/projects/'+id,{
    method:'DELETE',
    headers:{ Authorization:'Bearer '+token }
  });
  load();
}

load();
</script>

</body>
</html>
  `);
});

// ================= START =================
app.listen(process.env.PORT || 3000, () => {
  console.log("WAYLO LIVE 🚀");
});
