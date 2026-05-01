const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const MONGO_URI = "mongodb+srv://Waylo:Code3210@waylo.r5axflu.mongodb.net/waylo_db?retryWrites=true&w=majority"; 
const JWT_SECRET = "waylo_secure_2026";

const User = mongoose.model('User', new mongoose.Schema({ email: { type: String, unique: true }, password: String }));
const Mission = mongoose.model('Mission', new mongoose.Schema({ item: String, city: String, budget: Number, status: { type: String, default: "OPEN" }, buyer: String, traveler: String, otp: String }));

mongoose.connect(MONGO_URI).then(() => console.log("DB OK")).catch(err => console.log(err));

const auth = (req, res, next) => {
    try { req.user = jwt.verify(req.headers.authorization?.split(' ')[1], JWT_SECRET); next(); } 
    catch { res.status(401).send("Auth Error"); }
};

app.post('/api/register', async (req, res) => {
    try {
        const hashed = await bcrypt.hash(req.body.password, 10);
        await User.create({ email: req.body.email.trim().toLowerCase(), password: hashed });
        res.json({ message: "OK" });
    } catch (e) { res.status(400).send("Email déjà utilisé"); }
});

app.post('/api/login', async (req, res) => {
    const user = await User.findOne({ email: req.body.email.trim().toLowerCase() });
    if (user && await bcrypt.compare(req.body.password, user.password)) {
        res.json({ token: jwt.sign({ email: user.email }, JWT_SECRET) });
    } else res.status(401).send("Erreur");
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
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><title>WAYLO</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-[#020617] text-white p-6 font-sans">
    <div id="app" class="max-w-md mx-auto"></div>
    <script>
        let t = localStorage.getItem('t');
        let view = 'login'; 

        async function render() {
            const app = document.getElementById('app');
            if(!t) {
                app.innerHTML = \`
                    <div class="mt-16 text-center">
                        <h1 class="text-6xl font-black mb-10 italic text-amber-500 tracking-tighter">WAYLO</h1>
                        
                        <div class="bg-slate-900 p-2 rounded-2xl mb-6 flex border border-white/5">
                            <button onclick="setView('login')" class="w-1/2 py-3 rounded-xl font-bold transition \${view === 'login' ? 'bg-amber-500 text-black' : 'text-slate-400'}">LOG IN</button>
                            <button onclick="setView('signup')" class="w-1/2 py-3 rounded-xl font-bold transition \${view === 'signup' ? 'bg-amber-500 text-black' : 'text-slate-400'}">SIGN UP</button>
                        </div>

                        <div class="bg-slate-900 p-8 rounded-[2rem] border border-white/5 shadow-2xl">
                            <p class="text-left text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">\${view === 'login' ? 'Connexion' : 'Inscription'}</p>
                            <input id="e" type="email" placeholder="Email" class="w-full bg-black p-4 rounded-2xl mb-4 border border-white/10 text-white outline-none focus:border-amber-500">
                            <input id="p" type="password" placeholder="Mot de passe" class="w-full bg-black p-4 rounded-2xl mb-6 border border-white/10 text-white outline-none focus:border-amber-500">
                            <button onclick="doAction()" class="w-full bg-white text-black font-black py-4 rounded-2xl uppercase shadow-lg shadow-white/5">
                                \${view === 'login' ? 'Entrer' : 'Créer mon compte'}
                            </button>
                        </div>
                    </div>\`;
            } else {
                const r = await fetch('/api/missions', {headers: {'Authorization': 'Bearer '+t}});
                if(!r.ok) { localStorage.clear(); location.reload(); return; }
                const mis = await r.json();
                app.innerHTML = \`
                    <div class="flex justify-between items-center mb-8">
                        <h1 class="text-3xl font-black italic text-amber-500">WAYLO</h1>
                        <button onclick="localStorage.clear();location.reload()" class="bg-white/5 px-4 py-2 rounded-full text-[10px] font-bold border border-white/10 text-slate-400">SORTIR</button>
                    </div>
                    <div class="space-y-4">\` + 
                    mis.map(m => \`
                        <div class="bg-slate-900 p-6 rounded-[2rem] border border-white/5 shadow-xl">
                            <div class="flex justify-between font-bold text-lg mb-1"><span>\${m.item}</span><span class="text-amber-500">\${m.budget}€</span></div>
                            <div class="text-[10px] text-slate-500 mb-4 uppercase italic">📍 \${m.city}</div>
                            \${m.status === 'OPEN' ? \`<button onclick="acc('\${m._id}')" class="w-full bg-amber-500/20 text-amber-500 py-3 rounded-xl text-xs font-black border border-amber-500/30 uppercase">Accepter</button>\` : 
                            \`<div class="bg-amber-500/5 p-4 rounded-2xl text-center border border-amber-500/10"><p class="text-[10px] text-amber-500/60 mb-1 font-bold">CODE SÉCURITÉ</p><p class="text-3xl font-mono font-black text-amber-500 tracking-widest">\${m.otp || "..."}</p></div>\`}
                        </div>\`).join('') + 
                    \`</div>\`;
            }
        }

        window.setView = (v) => { view = v; render(); };

        window.doAction = async () => {
            const email = document.getElementById('e').value.trim();
            const pass = document.getElementById('p').value.trim();
            if(!email || !pass) return alert("Remplis les cases !");
            
            const type = view === 'login' ? 'login' : 'register';
            const r = await fetch('/api/'+type, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password: pass })
            });
            
            if(type === 'register') {
                if(r.ok) { alert("Compte créé ! Connecte-toi maintenant."); setView('login'); }
                else alert("Erreur : Email déjà pris.");
            } else {
                const data = await r.json().catch(()=>({}));
                if(data.token) { localStorage.setItem('t', data.token); t=data.token; render(); }
                else alert("Email ou Mot de passe faux.");
            }
        };

        window.acc = async (id) => { await fetch('/api/missions/'+id+'/accept', {method:'POST', headers:{'Authorization': 'Bearer '+t}}); render(); };
        render();
    </script>
</body></html>
    `);
});

app.listen(process.env.PORT || 3000);
