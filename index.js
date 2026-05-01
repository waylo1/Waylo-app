const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = express();

app.use(express.json());

const MONGO_URI = "mongodb+srv://Waylo:Code3210@waylo.r5axflu.mongodb.net/waylo_db?retryWrites=true&w=majority"; 
const JWT_SECRET = "waylo_secure_2026";

// Schémas
const User = mongoose.model('User', new mongoose.Schema({ email: { type: String, unique: true }, password: String }));
const Mission = mongoose.model('Mission', new mongoose.Schema({ 
    item: String, city: String, budget: Number, 
    status: { type: String, default: "OPEN" }, 
    buyer: String, traveler: String, otp: String,
    legalAccepted: Boolean 
}));

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Connexion MongoDB Réussie"))
    .catch(err => console.error("❌ Erreur DB:", err));

const auth = (req, res, next) => {
    try { 
        const token = req.headers.authorization?.split(' ')[1];
        req.user = jwt.verify(token, JWT_SECRET); 
        next(); 
    } catch { res.status(401).send("Session expirée"); }
};

// Routes API
app.post('/api/register', async (req, res) => {
    try {
        const hashed = await bcrypt.hash(req.body.password, 10);
        await User.create({ email: req.body.email.trim().toLowerCase(), password: hashed });
        res.json({ message: "OK" });
    } catch (e) { res.status(400).send("Email déjà pris"); }
});

app.post('/api/login', async (req, res) => {
    try {
        const user = await User.findOne({ email: req.body.email.trim().toLowerCase() });
        if (user && await bcrypt.compare(req.body.password, user.password)) {
            res.json({ token: jwt.sign({ email: user.email }, JWT_SECRET) });
        } else res.status(401).send("Identifiants incorrects");
    } catch (e) { res.status(500).send("Erreur serveur"); }
});

app.get('/api/missions', auth, async (req, res) => {
    const missions = await Mission.find().sort({ _id: -1 }).limit(20);
    const count = await Mission.countDocuments({ traveler: req.user.email, status: "IN_PROGRESS" });
    res.json({ missions, userMissionsCount: count });
});

app.post('/api/missions', auth, async (req, res) => {
    if(!req.body.legalAccepted) return res.status(400).send("CGU manquantes");
    await Mission.create({ ...req.body, buyer: req.user.email });
    res.send("OK");
});

app.post('/api/missions/:id/accept', auth, async (req, res) => {
    const count = await Mission.countDocuments({ traveler: req.user.email, status: "IN_PROGRESS" });
    if(count >= 4) return res.status(403).send("Limite URSSAF (4/4)");
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    await Mission.findByIdAndUpdate(req.params.id, { traveler: req.user.email, status: "IN_PROGRESS", otp });
    res.send("OK");
});

// Interface Front-end
app.get('*', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><title>WAYLO</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-[#020617] text-white p-4 font-sans italic">
    <div id="app" class="max-w-md mx-auto mt-4"></div>
    <script>
        let t = localStorage.getItem('t');
        let view = 'login';

        async function render() {
            const app = document.getElementById('app');
            if(!t) {
                app.innerHTML = '<div class="text-center mt-12"><h1 class="text-6xl font-black mb-10 text-amber-500 tracking-tighter">WAYLO</h1>' +
                '<div class="bg-slate-900 p-2 rounded-2xl mb-6 flex border border-white/5"><button onclick="view=\\'login\\';render()" class="w-1/2 py-3 rounded-xl font-bold '+(view==='login'?'bg-amber-500 text-black':'text-slate-500')+'">ENTRER</button><button onclick="view=\\'signup\\';render()" class="w-1/2 py-3 rounded-xl font-bold '+(view==='signup'?'bg-amber-500 text-black':'text-slate-500')+'">REJOINDRE</button></div>' +
                '<div class="bg-slate-900 p-6 rounded-[2.5rem] border border-white/5 shadow-2xl"><input id="e" placeholder="Email" class="w-full bg-black p-4 rounded-2xl mb-4 border border-white/10 text-white outline-none focus:border-amber-500"><input id="p" type="password" placeholder="Mot de passe" class="w-full bg-black p-4 rounded-2xl mb-6 border border-white/10 text-white outline-none focus:border-amber-500"><button onclick="doAction()" class="w-full bg-white text-black font-black py-4 rounded-2xl uppercase tracking-widest">'+(view==='login'?'Connexion':'Créer Profil')+'</button></div></div>';
            } else {
                const r = await fetch('/api/missions', {headers: {'Authorization': 'Bearer '+t}});
                if(!r.ok) { localStorage.clear(); location.reload(); return; }
                const data = await r.json();
                app.innerHTML = '<div class="flex justify-between items-center mb-6"><h1 class="text-2xl font-black text-amber-500">WAYLO</h1><div class="flex items-center gap-2"><span class="text-[9px] font-bold text-amber-500 bg-amber-500/10 px-2 py-1 rounded">MISIONS: '+data.userMissionsCount+'/4</span><button onclick="localStorage.clear();location.reload()" class="text-[9px] text-slate-500 font-bold underline">QUITTER</button></div></div>' +
                '<div class="bg-amber-500 p-6 rounded-[2rem] mb-6 text-black shadow-lg shadow-amber-500/10"><p class="text-[10px] font-black uppercase mb-3 opacity-70 tracking-widest">Nouveau Mandat</p><input id="m_i" placeholder="Objet" class="w-full bg-white/30 p-3 rounded-xl mb-2 border-none placeholder-black/50 font-bold"><input id="m_c" placeholder="Ville" class="w-full bg-white/30 p-3 rounded-xl mb-2 border-none placeholder-black/50 font-bold"><input id="m_b" type="number" placeholder="Budget (€)" class="w-full bg-white/30 p-3 rounded-xl mb-4 border-none placeholder-black/50 font-bold"><div class="flex gap-2 mb-4 bg-black/5 p-3 rounded-xl"><input type="checkbox" id="m_l"><label for="m_l" class="text-[8px] leading-tight font-black uppercase">Accepter Art. L.221-28 (Renoncement rétractation)</label></div><button onclick="addMission()" class="w-full bg-black text-white font-black py-3 rounded-xl text-xs uppercase">Publier</button></div>' +
                '<div class="space-y-4">' + data.missions.map(m => '<div class="bg-slate-900 p-5 rounded-[2rem] border border-white/5"><div class="flex justify-between font-bold"><span>'+m.item+'</span><span class="text-amber-500">'+m.budget+'€</span></div><div class="text-[10px] text-slate-500 mb-4">📍 '+m.city+'</div>' + (m.status === 'OPEN' ? (data.userMissionsCount < 4 ? '<button onclick="acc(\\''+m._id+'\\')" class="w-full bg-white/5 border border-white/10 py-3 rounded-xl text-[10px] font-black uppercase">Accepter</button>' : '<p class="text-center text-[9px] text-red-500 font-bold">LIMITE URSSAF</p>') : '<div class="bg-amber-500/10 p-3 rounded-xl text-center border border-amber-500/20"><p class="text-[9px] text-amber-500 mb-1">CODE OTP</p><p class="text-2xl font-mono font-black text-amber-500 tracking-widest">'+m.otp+'</p></div>') + '</div>').join('') + '</div>';
            }
        }

        window.doAction = async () => {
            const e = document.getElementById('e').value.trim();
            const p = document.getElementById('p').value.trim();
            if(!e || !p) return alert("Cases vides !");
            const type = view === 'login' ? 'login' : 'register';
            const r = await fetch('/api/'+type, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:e, password:p})});
            if(r.ok) { 
                if(type==='register') { alert("Bienvenue ! Connecte-toi."); view='login'; render(); }
                else { const d = await r.json(); localStorage.setItem('t', d.token); t=d.token; render(); }
            } else alert("Erreur d'accès");
        };

        window.addMission = async () => {
            const item = document.getElementById('m_i').value;
            const city = document.getElementById('m_c').value;
            const budget = document.getElementById('m_b').value;
            const legal = document.getElementById('m_l').checked;
            if(!legal) return alert("Case L.221-28 obligatoire !");
            await fetch('/api/missions', {method:'POST', headers:{'Content-Type':'application/json', 'Authorization': 'Bearer '+t}, body:JSON.stringify({item, city, budget, legalAccepted:legal})});
            render();
        };

        window.acc = async (id) => { 
            const r = await fetch('/api/missions/'+id+'/accept', {method:'POST', headers:{'Authorization': 'Bearer '+t}}); 
            if(!r.ok) alert("Action impossible");
            render(); 
        };
        render();
    </script>
</body></html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Waylo prêt sur le port " + PORT));
