const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SECRET = "waylo_super_secret_2026";
let users = [];
let missions = [];
let uid = 1;
let mid = 1;

// Middlewares
function auth(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.sendStatus(401);
    try {
        req.user = jwt.verify(token, SECRET);
        next();
    } catch { res.sendStatus(401); }
}

// API
app.post('/api/register', (req, res) => {
    const { email, password } = req.body;
    if (users.find(u => u.email === email)) return res.status(400).send("Existe déjà");
    users.push({ id: uid++, email, password });
    res.send("OK");
});

app.post('/api/login', (req, res) => {
    const user = users.find(u => u.email === req.body.email && u.password === req.body.password);
    if (!user) return res.status(400).send("Identifiants invalides");
    const token = jwt.sign({ id: user.id, email: user.email }, SECRET);
    res.json({ token });
});

app.get('/api/missions', auth, (req, res) => res.json(missions.slice().reverse()));

app.post('/api/missions', auth, (req, res) => {
    const { item, city, budget } = req.body;
    missions.push({ id: mid++, item, city, budget, status: "OPEN", owner: req.user.email });
    res.send("OK");
});

app.post('/api/missions/:id/accept', auth, (req, res) => {
    const m = missions.find(x => x.id == req.params.id);
    if (m && m.status === "OPEN") { m.status = "IN_PROGRESS"; res.send("OK"); }
    else res.sendStatus(400);
});

// Front-end HTML Unique
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WAYLO | Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-[#020617] text-white min-h-screen font-sans">
    <div id="app" class="max-w-md mx-auto p-6"></div>

    <script>
        let token = localStorage.getItem('token');
        const appDiv = document.getElementById('app');

        function renderAuth() {
            appDiv.innerHTML = \`
                <div class="mt-20 text-center">
                    <h1 class="text-4xl font-black mb-2 bg-gradient-to-r from-amber-200 to-amber-500 bg-clip-text text-transparent italic">WAYLO</h1>
                    <p class="text-slate-500 text-xs tracking-widest uppercase mb-10 text-center">L'innovation est en route</p>
                    <div class="bg-slate-900/50 border border-slate-800 p-8 rounded-[2rem] backdrop-blur-xl shadow-2xl">
                        <input id="email" type="email" placeholder="Email" class="w-full bg-slate-950 border border-slate-800 p-4 rounded-2xl mb-4 focus:border-amber-500 outline-none transition-all">
                        <input id="pass" type="password" placeholder="Mot de passe" class="w-full bg-slate-950 border border-slate-800 p-4 rounded-2xl mb-6 focus:border-amber-500 outline-none transition-all">
                        <button onclick="login()" class="w-full bg-amber-500 text-slate-950 font-black py-4 rounded-2xl mb-3 hover:scale-[1.02] active:scale-95 transition-all shadow-lg shadow-amber-500/20">SE CONNECTER</button>
                        <button onclick="register()" class="w-full bg-slate-800 text-white font-bold py-4 rounded-2xl text-sm hover:bg-slate-700 transition-all">CRÉER UN COMPTE</button>
                    </div>
                </div>
            \`;
        }

        function renderDashboard(missions) {
            appDiv.innerHTML = \`
                <div class="flex justify-between items-center mb-8">
                    <h1 class="text-2xl font-black bg-gradient-to-r from-amber-200 to-amber-500 bg-clip-text text-transparent italic">WAYLO</h1>
                    <button onclick="logout()" class="text-[10px] bg-slate-800 px-3 py-1 rounded-full text-slate-400 uppercase font-bold tracking-tighter">Déconnexion</button>
                </div>

                <div class="bg-slate-900/50 border border-slate-800 p-6 rounded-[2rem] mb-8 shadow-xl">
                    <h2 class="text-amber-500 text-[10px] font-black uppercase tracking-widest mb-4">Nouvelle Mission</h2>
                    <input id="item" placeholder="Objet (ex: Sac, Colis...)" class="w-full bg-slate-950 border border-slate-800 p-3 rounded-xl mb-3 outline-none text-sm">
                    <div class="flex gap-2 mb-3">
                        <input id="city" placeholder="Ville" class="w-1/2 bg-slate-950 border border-slate-800 p-3 rounded-xl outline-none text-sm">
                        <input id="budget" placeholder="Budget (€)" class="w-1/2 bg-slate-950 border border-slate-800 p-3 rounded-xl outline-none text-sm">
                    </div>
                    <button onclick="createMission()" class="w-full bg-amber-500 text-slate-950 font-black py-3 rounded-xl hover:bg-amber-400 transition-all">PUBLIER</button>
                </div>

                <div class="space-y-4">
                    \${missions.map(m => \`
                        <div class="bg-slate-900 border border-slate-800 p-5 rounded-[1.5rem] shadow-sm">
                            <div class="flex justify-between items-start mb-2">
                                <h3 class="font-bold text-lg">\${m.item}</h3>
                                <span class="text-[10px] font-bold px-2 py-1 rounded-md \${m.status === 'OPEN' ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-500 border border-amber-500/20'} uppercase">\${m.status}</span>
                            </div>
                            <p class="text-slate-400 text-sm mb-4">📍 \${m.city} • 💰 \${m.budget}€</p>
                            \${m.status === 'OPEN' ? \`<button onclick="acceptMission(\${m.id})" class="w-full bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold py-2 rounded-lg transition-all">ACCEPTER LA MISSION</button>\` : ''}
                        </div>
                    \`).join('')}
                </div>
            \`;
        }

        // Fonctions API
        async function login() {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ email: email.value, password: pass.value })
            });
            if (res.ok) { const data = await res.json(); token = data.token; localStorage.setItem('token', token); load(); }
            else alert("Erreur connexion");
        }

        async function register() {
            await fetch('/api/register', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ email: email.value, password: pass.value })
            });
            alert("Compte créé ! Connecte-toi.");
        }

        function logout() { localStorage.removeItem('token'); token = null; renderAuth(); }

        async function load() {
            if (!token) return renderAuth();
            const res = await fetch('/api/missions', { headers: { Authorization: 'Bearer ' + token } });
            if (res.ok) renderDashboard(await res.json()); else renderAuth();
        }

        async function createMission() {
            await fetch('/api/missions', {
                method: 'POST',
                headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token},
                body: JSON.stringify({ item: item.value, city: city.value, budget: budget.value })
            });
            load();
        }

        async function acceptMission(id) {
            await fetch('/api/missions/'+id+'/accept', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
            load();
        }

        load();
    </script>
</body>
</html>
    `);
});

app.listen(process.env.PORT || 3000);
