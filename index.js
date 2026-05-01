const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔑 Ta clé MongoDB configurée
const MONGO_URI = "mongodb+srv://Waylo:Code3210@waylo.r5axf1u.mongodb.net/?retryWrites=true&w=majority&appName=Waylo"; 
const JWT_SECRET = "waylo_ultra_secret_2026";

// STRUCTURE DES DONNÉES
const User = mongoose.model('User', new mongoose.Schema({ 
    email: { type: String, unique: true }, 
    password: String 
}));

const Mission = mongoose.model('Mission', new mongoose.Schema({ 
    item: String, 
    city: String, 
    budget: Number, 
    status: { type: String, default: "OPEN" }, 
    buyer: String, 
    traveler: String, 
    otp: String 
}));

// CONNEXION DB
mongoose.connect(MONGO_URI).then(() => console.log("Waylo est connecté au Cloud")).catch(err => console.log(err));

// AUTHENTIFICATION
const auth = (req, res, next) => {
    try { 
        const token = req.headers.authorization?.split(' ')[1];
        req.user = jwt.verify(token, JWT_SECRET); 
        next(); 
    } catch { res.sendStatus(401); }
};

// ROUTES API
app.post('/api/register', async (req, res) => {
    const hashed = await bcrypt.hash(req.body.password, 10);
    try { await User.create({ email: req.body.email, password: hashed }); res.send("OK"); } 
    catch { res.status(400).send("Erreur"); }
});

app.post('/api/login', async (req, res) => {
    const user = await User.findOne({ email: req.body.email });
    if (user && await bcrypt.compare(req.body.password, user.password)) {
        res.json({ token: jwt.sign({ email: user.email }, JWT_SECRET) });
    } else res.status(400).send("Erreur");
});

app.get('/api/missions', auth, async (req, res) => res.json(await Mission.find().sort({ _id: -1 })));

app.post('/api/missions', auth, async (req, res) => { 
    await Mission.create({ ...req.body, buyer: req.user.email }); 
    res.send("OK"); 
});

app.post('/api/missions/:id/accept', auth, async (req, res) => {
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    await Mission.findByIdAndUpdate(req.params.id, { traveler: req.user.email, status: "IN_PROGRESS", otp });
    res.send("OK");
});

app.post('/api/missions/:id/validate', auth, async (req, res) => {
    const m = await Mission.findById(req.params.id);
    if (m.otp === req.body.otp) { 
        m.status = "COMPLETED"; 
        await m.save(); 
        res.send("OK"); 
    } else res.status(400).send("Code faux");
});

// INTERFACE (Design Premium Waylo)
app.get('*', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WAYLO</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-[#020617] text-white min-h-screen p-6 font-sans">
    <div id="app" class="max-w-md mx-auto"></div>
    <script>
        let t = localStorage.getItem('t');
        async function req(u, m='GET', b=null) {
            const r = await fetch(u, {method: m, headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer '+t}, body: b?JSON.stringify(b):null});
            return r.ok ? r.json().catch(()=>({})) : null;
        }
        async function render() {
            const app = document.getElementById('app');
            if(!t) {
                app.innerHTML = \`
                    <div class="mt-20 text-center">
                        <h1 class="text-5xl font-black mb-10 italic text-amber-500">WAYLO</h1>
                        <div class="bg-slate-900/50 p-8 rounded-[2rem] border border-white/5">
                            <input id="e" placeholder="Email" class="w-full bg-black p-4 rounded-2xl mb-4 border border-white/10 outline-none">
                            <input id="p" type="password" placeholder="Mot de passe" class="w-full bg-black p-4 rounded-2xl mb-6 border border-white/10 outline-none">
                            <button onclick="auth('login')" class="w-full bg-amber-500 text-black font-black py-4 rounded-2xl mb-4">SE CONNECTER</button>
                            <button onclick="auth('register')" class="text-xs text-slate-500 underline">Créer un compte</button>
                        </div>
                    </div>\`;
                return;
            }
            const mis = await req('/api/missions');
            app.innerHTML = \`
                <div class="flex justify-between items-center mb-8">
                    <h1 class="text-3xl font-black italic text-amber-500">WAYLO</h1>
                    <button onclick="localStorage.clear();location.reload()" class="text-[10px] uppercase font-bold text-slate-500">Sortir</button>
                </div>
                <div class="bg-slate-900 p-6 rounded-[2rem] border border-white/5 mb-8">
                    <input id="it" placeholder="Quoi ?" class="w-full bg-black p-3 rounded-xl mb-2 text-sm">
                    <input id="ci" placeholder="Où ?" class="w-full bg-black p-3 rounded-xl mb-2 text-sm">
                    <input id="bu" placeholder="Budget €" class="w-full bg-black p-3 rounded-xl mb-4 text-sm">
                    <button onclick="post()" class="w-full bg-white text-black font-black py-3 rounded-xl">LANCER</button>
                </div>
                <div class="space-y-4">\` + 
                mis.map(m => \`
                    <div class="bg-slate-900 p-6 rounded-[2rem] border border-white/5 shadow-xl">
                        <div class="flex justify-between font-bold text-lg mb-1"><span>\${m.item}</span><span class="text-amber-500">\${m.budget}€</span></div>
                        <div class="text-[10px] text-slate-500 mb-4 italic uppercase tracking-widest">📍 \${m.city}</div>
                        \${m.status === 'OPEN' ? \`<button onclick="acc('\${m._id}')" class="w-full bg-amber-500/10 text-amber-500 py-3 rounded-xl text-xs font-black border border-amber-500/20">ACCEPTER</button>\` : 
                          m.status === 'IN_PROGRESS' && m.otp ? \`<div class="bg-amber-500/5 p-4 rounded-2xl text-center border border-amber-500/10"><p class="text-[10px] text-amber-500/60 mb-1 font-bold">CODE DE SÉCURITÉ</p><p class="text-3xl font-mono font-black text-amber-500 tracking-widest">\${m.otp}</p></div>\` : 
                          m.status === 'IN_PROGRESS' ? \`<div class="flex gap-2"><input id="c-\${m._id}" placeholder="Code" class="w-full bg-black p-3 rounded-xl text-center font-mono border border-white/5"><button onclick="val('\${m._id}')" class="bg-green-500 text-black px-6 rounded-xl font-black">OK</button></div>\` : 
                          \`<div class="text-center text-green-500 font-black text-xs uppercase tracking-widest py-2 italic font-bold">✓ Livraison Validée</div>\`}
                    </div>\`).join('') + 
                \`</div>\`;
        }
        window.auth = async (type) => { 
            const d = await req('/api/'+type, 'POST', {email: e.value, password: p.value}); 
            if(d && d.token) { t=d.token; localStorage.setItem('t', t); render(); } 
            else if(type==='register') alert("Compte prêt ! Connectez-vous."); 
            else alert("Identifiants incorrects.");
        };
        window.post = async () => { await req('/api/missions', 'POST', {item: it.value, city: ci.value, budget: Number(bu.value)}); render(); };
        window.acc = async (id) => { await req('/api/missions/'+id+'/accept', 'POST'); render(); };
        window.val = async (id) => { 
            const otp = document.getElementById('c-'+id).value; 
            const res = await req('/api/missions/'+id+'/validate', 'POST', {otp});
            if(res) render(); else alert("Code erroné !");
        };
        render();
    </script>
</body>
</html>
    `);
});

app.listen(process.env.PORT || 3000);
