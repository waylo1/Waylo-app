const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ta clé MongoDB avec le bon format
const MONGO_URI = "mongodb+srv://Waylo:Code3210@waylo.r5axflu.mongodb.net/waylo_db?retryWrites=true&w=majority"; 
const JWT_SECRET = "waylo_secure_2026";

const User = mongoose.model('User', new mongoose.Schema({ email: { type: String, unique: true }, password: String }));
const Mission = mongoose.model('Mission', new mongoose.Schema({ item: String, city: String, budget: Number, status: { type: String, default: "OPEN" }, buyer: String, traveler: String, otp: String }));

mongoose.connect(MONGO_URI).then(() => console.log("Connecté à MongoDB")).catch(err => console.log("Erreur DB:", err));

const auth = (req, res, next) => {
    try { req.user = jwt.verify(req.headers.authorization?.split(' ')[1], JWT_SECRET); next(); } 
    catch { res.status(401).send("Non autorisé"); }
};

app.post('/api/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).send("Champs vides");
        const hashed = await bcrypt.hash(password, 10);
        await User.create({ email, password: hashed });
        res.status(201).json({ message: "OK" });
    } catch (e) { res.status(400).send("Erreur: Email déjà utilisé"); }
});

app.post('/api/login', async (req, res) => {
    const user = await User.findOne({ email: req.body.email });
    if (user && await bcrypt.compare(req.body.password, user.password)) {
        res.json({ token: jwt.sign({ email: user.email }, JWT_SECRET) });
    } else res.status(401).send("Identifiants incorrects");
});

app.get('/api/missions', auth, async (req, res) => res.json(await Mission.find().sort({ _id: -1 })));
app.post('/api/missions', auth, async (req, res) => { await Mission.create({ ...req.body, buyer: req.user.email }); res.send("OK"); });
app.post('/api/missions/:id/accept', auth, async (req, res) => {
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    await Mission.findByIdAndUpdate(req.params.id, { traveler: req.user.email, status: "IN_PROGRESS", otp });
    res.send("OK");
});

app.get('*', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>WAYLO</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-[#020617] text-white p-6 font-sans"><div id="app" class="max-w-md mx-auto"></div><script>
let t = localStorage.getItem('t');
async function render() {
    const app = document.getElementById('app');
    if(!t) {
        app.innerHTML = '<div class="mt-20 text-center"><h1 class="text-5xl font-black mb-10 italic text-amber-500 italic">WAYLO</h1><div class="bg-slate-900 p-8 rounded-[2rem] border border-white/5"><input id="e" placeholder="Nouvel Email" class="w-full bg-black p-4 rounded-2xl mb-4 border border-white/10 text-white"><input id="p" type="password" placeholder="Nouveau Pass" class="w-full bg-black p-4 rounded-2xl mb-6 border border-white/10 text-white"><button onclick="action(\\'register\\')" class="w-full bg-amber-500 text-black font-black py-4 rounded-2xl mb-4 uppercase">1. Créer le compte</button><button onclick="action(\\'login\\')" class="w-full bg-white text-black font-black py-4 rounded-2xl uppercase text-xs">2. Se connecter</button></div></div>';
    } else {
        const r = await fetch('/api/missions', {headers: {'Authorization': 'Bearer '+t}});
        if(!r.ok) { localStorage.clear(); location.reload(); return; }
        const mis = await r.json();
        app.innerHTML = '<div class="flex justify-between items-center mb-8"><h1 class="text-3xl font-black italic text-amber-500">WAYLO</h1><button onclick="localStorage.clear();location.reload()" class="text-[10px] uppercase font-bold text-slate-500">Déconnexion</button></div>' + 
        '<div class="space-y-4">' + mis.map(m => '<div class="bg-slate-900 p-6 rounded-[2rem] border border-white/5 shadow-xl"><div class="flex justify-between font-bold text-lg mb-1"><span>'+m.item+'</span><span class="text-amber-500">'+m.budget+'€</span></div><div class="text-[10px] text-slate-500 mb-4 uppercase italic">📍 '+m.city+'</div>' + (m.status==='OPEN' ? '<button onclick="acc(\\''+m._id+'\\')" class="w-full bg-amber-500/20 text-amber-500 py-3 rounded-xl text-xs font-black border border-amber-500/30">ACCEPTER LA MISSION</button>' : '<div class="bg-amber-500/5 p-4 rounded-2xl text-center border border-amber-500/10"><p class="text-[10px] text-amber-500/60 mb-1 font-bold">CODE DE SÉCURITÉ</p><p class="text-3xl font-mono font-black text-amber-500 tracking-widest">'+(m.otp || "Attente")+'</p></div>') + '</div>').join('') + '</div>';
    }
}
window.action = async (type) => {
    const email = document.getElementById('e').value;
    const pass = document.getElementById('p').value;
    if(!email || !pass) return alert("Remplis les cases !");
    const r = await fetch('/api/'+type, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email, password:pass})});
    const res = await r.json().catch(()=>({}));
    if(type === 'register' && r.ok) alert("Compte créé avec succès ! Maintenant, clique sur le bouton SE CONNECTER.");
    else if(type === 'login' && r.ok) { localStorage.setItem('t', res.token); t=res.token; render(); }
    else alert("Erreur : " + (type==='login' ? "Identifiants faux" : "Email déjà pris"));
};
window.acc = async (id) => { await fetch('/api/missions/'+id+'/accept', {method:'POST', headers:{'Authorization': 'Bearer '+t}}); render(); };
render();
</script></body></html>
    `);
});

app.listen(process.env.PORT || 3000);
