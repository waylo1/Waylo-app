const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = express();

app.use(express.json());

const MONGO_URI = "mongodb+srv://Waylo:Code3210@waylo.r5axflu.mongodb.net/waylo_db?retryWrites=true&w=majority"; 
const JWT_SECRET = "waylo_secure_2026";

const User = mongoose.model('User', new mongoose.Schema({ email: { type: String, unique: true }, password: String }));
const Mission = mongoose.model('Mission', new mongoose.Schema({ 
    item: String, city: String, budget: Number, 
    status: { type: String, default: "OPEN" }, 
    buyer: String, traveler: String, otp: String,
    legalAccepted: Boolean 
}));

mongoose.connect(MONGO_URI).then(() => console.log("DB Waylo OK")).catch(err => console.log(err));

const auth = (req, res, next) => {
    try { req.user = jwt.verify(req.headers.authorization?.split(' ')[1], JWT_SECRET); next(); } 
    catch { res.status(401).send("Auth Error"); }
};

// --- API ---
app.post('/api/register', async (req, res) => {
    try {
        const hashed = await bcrypt.hash(req.body.password, 10);
        await User.create({ email: req.body.email.trim().toLowerCase(), password: hashed });
        res.json({ message: "OK" });
    } catch (e) { res.status(400).send("Email déjà pris"); }
});

app.post('/api/login', async (req, res) => {
    const user = await User.findOne({ email: req.body.email.trim().toLowerCase() });
    if (user && await bcrypt.compare(req.body.password, user.password)) {
        res.json({ token: jwt.sign({ email: user.email }, JWT_SECRET) });
    } else res.status(401).send("Erreur");
});

app.get('/api/missions', auth, async (req, res) => {
    const missions = await Mission.find().sort({ _id: -1 });
    // On renvoie aussi le compte de missions du voyageur pour le verrou URSSAF
    const userMissionsCount = await Mission.countDocuments({ traveler: req.user.email, status: "IN_PROGRESS" });
    res.json({ missions, userMissionsCount });
});

app.post('/api/missions', auth, async (req, res) => {
    if(!req.body.legalAccepted) return res.status(400).send("CGU non acceptées");
    await Mission.create({ ...req.body, buyer: req.user.email });
    res.send("OK");
});

app.post('/api/missions/:id/accept', auth, async (req, res) => {
    const count = await Mission.countDocuments({ traveler: req.user.email, status: "IN_PROGRESS" });
    if(count >= 4) return res.status(403).send("Limite de 4 missions atteinte (Sécurité URSSAF)");
    
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    await Mission.findByIdAndUpdate(req.params.id, { traveler: req.user.email, status: "IN_PROGRESS", otp });
    res.send("OK");
});

// --- FRONT-END ---
app.get('*', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>WAYLO</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-[#020617] text-white p-4 font-sans">
    <div id="app" class="max-w-md mx-auto"></div>
    <script>
        let t = localStorage.getItem('t');
        let view = 'login';

        async function render() {
            const app = document.getElementById('app');
            if(!t) {
                app.innerHTML = \`
                    <div class="mt-10 text-center">
                        <h1 class="text-5xl font-black mb-8 italic text-amber-500 italic">WAYLO</h1>
                        <div class="bg-slate-900 p-2 rounded-2xl mb-6 flex border border-white/5">
                            <button onclick="view='login';render()" class="w-1/2 py-3 rounded-xl font-bold \${view==='login'?'bg-amber-500 text-black':'text-slate-500'}">LOG IN</button>
                            <button onclick="view='signup';render()" class="w-1/2 py-3 rounded-xl font-bold \${view==='signup'?'bg-amber-500 text-black':'text-slate-500'}">SIGN UP</button>
                        </div>
                        <div class="bg-slate-900 p-6 rounded-[2rem] border border-white/5">
                            <input id="e" type="email" placeholder="Email" class="w-full bg-black p-4 rounded-xl mb-4 border border-white/10 text-white">
                            <input id="p" type="password" placeholder="Mot de passe" class="w-full bg-black p-4 rounded-xl mb-6 border border-white/10 text-white">
                            <button onclick="doAction()" class="w-full bg-white text-black font-black py-4 rounded-xl uppercase">\${view==='login'?'Entrer':'Créer mon compte'}</button>
                        </div>
                    </div>\`;
            } else {
                const r = await fetch('/api/missions', {headers: {'Authorization': 'Bearer '+t}});
                const data = await r.json();
                const mis = data.missions;
                const count = data.userMissionsCount;

                app.innerHTML = \`
                    <div class="flex justify-between items-center mb-6">
                        <h1 class="text-2xl font-black italic text-amber-500">WAYLO</h1>
                        <span class="text-[10px] bg-white/10 px-2 py-1 rounded text-slate-400 uppercase font-bold">Actif: \${count}/4</span>
                    </div>
                    
                    <div class="bg-amber-500 p-6 rounded-[2rem] mb-8 text-black">
                        <h2 class="font-black uppercase text-sm mb-4 italic">Créer un Mandat d'Achat</h2>
                        <input id="m_i" placeholder="Objet (ex: iPhone 15)" class="w-full bg-white/20 p-3 rounded-xl mb-2 placeholder-black/50 border-none font-bold">
                        <input id="m_c" placeholder="Ville" class="w-full bg-white/20 p-3 rounded-xl mb-2 placeholder-black/50 border-none font-bold">
                        <input id="m_b" type="number" placeholder="Budget (€)" class="w-full bg-white/20 p-3 rounded-xl mb-4 placeholder-black/50 border-none font-bold">
                        
                        <div class="flex items-start gap-2 mb-4 bg-black/10 p-3 rounded-xl">
                            <input type="checkbox" id="m_l" class="mt-1">
                            <label for="m_l" class="text-[9px] leading-tight font-bold uppercase">
                                Je demande l'exécution immédiate du mandat et je renonce à mon droit de rétractation (Art. L221-28)
                            </label>
                        </div>
                        
                        <button onclick="addMission()" class="w-full bg-black text-white font-black py-3 rounded-xl uppercase text-xs">Publier la mission</button>
                    </div>

                    <div class="space-y-4">\` + 
                    mis.map(m => \`
                        <div class="bg-slate-900 p-5 rounded-[2rem] border border-white/5">
                            <div class="flex justify-between font-bold text-lg"><span>\${m.item}</span><span class="text-amber-500">\${m.budget}€</span></div>
                            <div class="text-[10px] text-slate-500 mb-4 uppercase italic">📍 \${m.city}</div>
                            \${m.status === 'OPEN' ? 
                                (count < 4 ? \`<button onclick="acc('\${m._id}')" class="w-full bg-amber-500 text-black py-3 rounded-xl text-xs font-black uppercase">Accepter la mission</button>\` : \`<div class="text-center text-[9px] text-red-500 font-bold">LIMITE URSSAF ATTEINTE</div>\`) : 
                                \`<div class="bg-white/5 p-3 rounded-xl text-center"><p class="text-[9px] text-slate-500 mb-1">CODE OTP</p><p class="text-2xl font-mono font-black text-amber-500">\${m.otp}</p></div>\`
                            }
                        </div>\`).join('') + 
                    \`</div>\`;
            }
        }

        window.doAction = async () => {
            const email = document.getElementById('e').value;
            const pass = document.getElementById('p').value;
            const type = view === 'login' ? 'login' : 'register';
            const r = await fetch('/api/'+type, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email, password:pass})});
            if(r.ok) { 
                if(type==='register') { alert("Compte créé !"); view='login'; render(); }
                else { const d = await r.json(); localStorage.setItem('t', d.token); t=d.token; render(); }
            } else alert("Erreur");
        };

        window.addMission = async () => {
            const item = document.getElementById('m_i').value;
            const city = document.getElementById('m_c').value;
            const budget = document.getElementById('m_b').value;
            const legalAccepted = document.getElementById('m_l').checked;
            if(!legalAccepted) return alert("Tu dois accepter les conditions L.221-28 !");
            await fetch('/api/missions', {method:'POST', headers:{'Content-Type':'application/json', 'Authorization': 'Bearer '+t}, body:JSON.stringify({item, city, budget, legalAccepted})});
            render();
        };

        window.acc = async (id) =>
