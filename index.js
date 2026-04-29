const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// "Base de données" temporaire (stockée dans la RAM du serveur)
let projects = [
  { id: 1, name: "Lancement Waylo", desc: "Phase de test bêta" },
  { id: 2, name: "Design UI", desc: "Look moderne 2026" }
];

// ================= API SIMPLIFIÉE =================

// Récupérer les projets
app.get('/api/projects', (req, res) => {
  res.json(projects);
});

// Ajouter un projet
app.post('/api/projects', (req, res) => {
  const { name, desc } = req.body;
  const newProject = { id: Date.now(), name, desc };
  projects.push(newProject);
  res.status(201).json(newProject);
});

// Supprimer un projet
app.delete('/api/projects/:id', (req, res) => {
  projects = projects.filter(p => p.id !== parseInt(req.params.id));
  res.send("OK");
});

// ================= FRONTEND DYNAMIQUE =================

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
<body class="bg-[#020617] text-white font-sans min-h-screen">
    <div class="max-w-4xl mx-auto p-6">
        <div class="flex justify-between items-center mb-10">
            <h1 class="text-3xl font-black tracking-tighter bg-gradient-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent">WAYLO</h1>
            <div class="flex items-center gap-2">
                <span class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                <span class="text-xs font-bold uppercase tracking-widest text-slate-400">Mode Live Gratuit</span>
            </div>
        </div>

        <div class="bg-slate-900/50 border border-slate-800 p-6 rounded-3xl mb-10 backdrop-blur-md">
            <h2 class="text-sm font-bold uppercase text-amber-500 mb-4">Ajouter un nouveau projet</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <input id="pName" type="text" placeholder="Nom du projet..." class="bg-slate-950 border border-slate-700 p-3 rounded-xl focus:outline-none focus:border-amber-500">
                <input id="pDesc" type="text" placeholder="Description..." class="bg-slate-950 border border-slate-700 p-3 rounded-xl focus:outline-none focus:border-amber-500">
            </div>
            <button onclick="addProject()" class="w-full mt-4 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-3 rounded-xl transition-all">
                + CRÉER
            </button>
        </div>

        <div id="projectList" class="grid gap-4">
            </div>
    </div>

    <script>
        async function fetchProjects() {
            const res = await fetch('/api/projects');
            const data = await res.json();
            const list = document.getElementById('projectList');
            list.innerHTML = '';
            data.forEach(p => {
                list.innerHTML += \`
                    <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex justify-between items-center hover:border-slate-600 transition-all">
                        <div>
                            <h3 class="font-bold text-lg text-white">\${p.name}</h3>
                            <p class="text-slate-400 text-sm">\${p.desc}</p>
                        </div>
                        <button onclick="deleteProject(\${p.id})" class="text-slate-500 hover:text-red-500 transition-colors">
                           Effacer
                        </button>
                    </div>
                \`;
            });
        }

        async function addProject() {
            const name = document.getElementById('pName').value;
            const desc = document.getElementById('pDesc').value;
            if(!name) return alert('Donne un nom !');
            
            await fetch('/api/projects', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ name, desc })
            });
            
            document.getElementById('pName').value = '';
            document.getElementById('pDesc').value = '';
            fetchProjects();
        }

        async function deleteProject(id) {
            await fetch('/api/projects/' + id, { method: 'DELETE' });
            fetchProjects();
        }

        fetchProjects();
    </script>
</body>
</html>
  `);
});

app.listen(process.env.PORT || 3000, () => {
    console.log("Waylo est prêt sur le port 3000");
});
