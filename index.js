const express = require('express');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SECRET = "dev";

// ====== DB MEMORY ======
let users = [];
let missions = [];

let uid = 1;
let mid = 1;

// ====== AUTH ======
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.sendStatus(401);
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.sendStatus(401);
  }
}

// ====== AUTH API ======
app.post('/api/register', (req, res) => {
  const { email, password } = req.body;
  users.push({ id: uid++, email, password });
  res.send("OK");
});

app.post('/api/login', (req, res) => {
  const user = users.find(u => u.email === req.body.email);
  if (!user) return res.status(400).send("Invalid");

  const token = jwt.sign({ id: user.id }, SECRET);
  res.json({ token });
});

// ====== MISSIONS ======

// create
app.post('/api/missions', auth, (req, res) => {
  const { item, city, budget } = req.body;

  missions.push({
    id: mid++,
    item,
    city,
    budget,
    owner: req.user.id,
    status: "OPEN",
    traveler: null,
    proof: null
  });

  res.send("OK");
});

// list
app.get('/api/missions', auth, (req, res) => {
  res.json(missions.reverse());
});

// accept
app.post('/api/missions/:id/accept', auth, (req, res) => {
  const m = missions.find(x => x.id == req.params.id);
  if (!m || m.status !== "OPEN") return res.sendStatus(400);

  m.status = "IN_PROGRESS";
  m.traveler = req.user.id;

  res.send("OK");
});

// validate (PPR simulation)
app.post('/api/missions/:id/validate', auth, (req, res) => {
  const m = missions.find(x => x.id == req.params.id);
  if (!m) return res.sendStatus(400);

  m.status = "COMPLETED";
  m.proof = {
    time: new Date().toISOString(),
    location: "GPS_OK",
    otp: "VALID",
    photo: "captured"
  };

  res.send("OK");
});

// ====== FRONT ======

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Waylo</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>

<body class="bg-[#020617] text-white p-6">

<div id="app"></div>

<script>
let token = localStorage.getItem('token');

// ===== UI =====
function set(html){
  document.getElementById('app').innerHTML = html;
}

// ===== AUTH =====
function authUI(){
  set(\`
    <div class="flex h-screen items-center justify-center">
      <div class="bg-slate-900 p-6 rounded-xl w-80">
        <h2 class="mb-4 text-lg">WAYLO</h2>
        <input id="email" placeholder="email" class="w-full p-2 mb-2 bg-slate-800"/>
        <input id="pass" type="password" placeholder="password" class="w-full p-2 mb-3 bg-slate-800"/>
        <button onclick="login()" class="w-full bg-amber-500 text-black p-2 mb-2">Login</button>
        <button onclick="register()" class="w-full bg-slate-700 p-2">Register</button>
      </div>
    </div>
  \`);
}

// ===== HOME =====
function home(missions){
  set(\`
    <div class="max-w-3xl mx-auto">

      <h1 class="text-xl mb-4">WAYLO</h1>

      <div class="mb-6">
        <input id="item" placeholder="Objet" class="p-2 bg-slate-800 w-full mb-2"/>
        <input id="city" placeholder="Ville" class="p-2 bg-slate-800 w-full mb-2"/>
        <input id="budget" placeholder="Budget" class="p-2 bg-slate-800 w-full mb-2"/>
        <button onclick="create()" class="bg-amber-500 text-black px-4 py-2">Publier</button>
      </div>

      <div>
        \${missions.map(m => \`
          <div class="bg-slate-900 p-4 mb-3 rounded">
            <div><b>\${m.item}</b> — \${m.city}</div>
            <div>Budget: \${m.budget}</div>
            <div>Status: \${m.status}</div>

            \${m.status === 'OPEN' ? 
              '<button onclick="accept('+m.id+')" class="mt-2 bg-green-500 px-2 py-1">Accepter</button>' 
              : ''}

            \${m.status === 'IN_PROGRESS' ? 
              '<button onclick="validate('+m.id+')" class="mt-2 bg-amber-500 px-2 py-1">Remise</button>' 
              : ''}

            \${m.status === 'COMPLETED' ? 
              '<div class="text-green-400 mt-2">✔ Remise confirmée</div>' 
              : ''}

          </div>
        \`).join('')}
      </div>

    </div>
  \`);
}

// ===== API =====

async function login(){
  const res = await fetch('/api/login',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      email: email.value,
      password: pass.value
    })
  });

  const data = await res.json();
  token = data.token;
  localStorage.setItem('token', token);
  load();
}

async function register(){
  await fetch('/api/register',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      email: email.value,
      password: pass.value
    })
  });
  alert("ok");
}

async function load(){
  if(!token) return authUI();

  const res = await fetch('/api/missions',{
    headers:{ Authorization:'Bearer '+token }
  });

  const data = await res.json();
  home(data);
}

async function create(){
  await fetch('/api/missions',{
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      Authorization:'Bearer '+token
    },
    body: JSON.stringify({
      item: item.value,
      city: city.value,
      budget: budget.value
    })
  });
  load();
}

async function accept(id){
  await fetch('/api/missions/'+id+'/accept',{
    method:'POST',
    headers:{ Authorization:'Bearer '+token }
  });
  load();
}

async function validate(id){
  alert("Simulation PPR (GPS + Photo + OTP)");
  await fetch('/api/missions/'+id+'/validate',{
    method:'POST',
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

app.listen(process.env.PORT || 3000);
