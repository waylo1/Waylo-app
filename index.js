const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ======================
   🧠 DATA (IN MEMORY)
====================== */
let users = [];
let missions = [];
let currentUser = null;

/* ======================
   🎨 HTML TEMPLATE
====================== */
function renderPage(content) {
  return `
  <!DOCTYPE html>
  <html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <title>WAYLO</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
  </head>

  <body class="bg-[#020617] text-white min-h-screen">

    <div class="p-6 max-w-6xl mx-auto">

      <h1 class="text-3xl font-bold mb-6 bg-gradient-to-r from-amber-400 to-yellow-600 bg-clip-text text-transparent">
        WAYLO
      </h1>

      ${content}

    </div>

    <script>lucide.createIcons()</script>
  </body>
  </html>
  `;
}

/* ======================
   🔐 AUTH
====================== */

app.get("/", (req, res) => {
  if (!currentUser) {
    return res.send(renderPage(authPage()));
  }
  res.send(renderPage(dashboard()));
});

function authPage() {
  return `
  <div class="grid grid-cols-2 gap-6">

    <form method="POST" action="/login" class="backdrop-blur bg-white/5 p-6 rounded-2xl border border-white/10">
      <h2 class="text-xl mb-4">Login</h2>
      <input name="email" placeholder="Email" class="w-full mb-3 p-2 bg-black/40 rounded" />
      <input name="password" type="password" placeholder="Password" class="w-full mb-3 p-2 bg-black/40 rounded" />
      <button class="w-full bg-amber-500 hover:bg-amber-600 p-2 rounded">Connexion</button>
    </form>

    <form method="POST" action="/register" class="backdrop-blur bg-white/5 p-6 rounded-2xl border border-white/10">
      <h2 class="text-xl mb-4">Register</h2>
      <input name="email" placeholder="Email" class="w-full mb-3 p-2 bg-black/40 rounded" />
      <input name="password" type="password" placeholder="Password" class="w-full mb-3 p-2 bg-black/40 rounded" />
      <button class="w-full bg-gradient-to-r from-amber-400 to-yellow-600 p-2 rounded">Créer compte</button>
    </form>

  </div>
  `;
}

app.post("/register", (req, res) => {
  const { email, password } = req.body;
  users.push({ email, password });
  currentUser = { email };
  res.redirect("/");
});

app.post("/login", (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email && u.password === password);
  if (user) {
    currentUser = user;
  }
  res.redirect("/");
});

app.get("/logout", (req, res) => {
  currentUser = null;
  res.redirect("/");
});

/* ======================
   📦 MISSIONS
====================== */

function dashboard() {
  return `
  <div class="flex justify-between mb-6">
    <span class="text-white/60">Connecté : ${currentUser.email}</span>
    <a href="/logout" class="text-red-400">Logout</a>
  </div>

  ${createMissionForm()}

  <div class="mt-8 grid gap-4">
    ${missions.map(m => missionCard(m)).join("")}
  </div>
  `;
}

function createMissionForm() {
  return `
  <form method="POST" action="/mission" class="backdrop-blur bg-white/5 p-6 rounded-2xl border border-white/10">
    <h2 class="mb-4 text-lg">Nouvelle mission</h2>

    <input name="objet" placeholder="Objet" class="w-full mb-3 p-2 bg-black/40 rounded"/>
    <input name="ville" placeholder="Ville" class="w-full mb-3 p-2 bg-black/40 rounded"/>
    <input name="budget" placeholder="Budget €" class="w-full mb-3 p-2 bg-black/40 rounded"/>

    <button class="bg-gradient-to-r from-amber-400 to-yellow-600 px-4 py-2 rounded">
      Publier
    </button>
  </form>
  `;
}

app.post("/mission", (req, res) => {
  const { objet, ville, budget } = req.body;

  missions.push({
    id: Date.now(),
    objet,
    ville,
    budget,
    buyer: currentUser.email,
    traveler: null,
    status: "OPEN",
    code: null
  });

  res.redirect("/");
});

/* ======================
   🤝 ACCEPT MISSION
====================== */

app.get("/accept/:id", (req, res) => {
  const mission = missions.find(m => m.id == req.params.id);

  if (mission && mission.status === "OPEN") {
    mission.status = "IN_PROGRESS";
    mission.traveler = currentUser.email;

    // 🔐 Generate 4 digit code
    mission.code = Math.floor(1000 + Math.random() * 9000);
  }

  res.redirect("/");
});

/* ======================
   🔐 VALIDATE DELIVERY
====================== */

app.post("/validate/:id", (req, res) => {
  const mission = missions.find(m => m.id == req.params.id);
  const { code } = req.body;

  if (mission && mission.code == code) {
    mission.status = "COMPLETED";
  }

  res.redirect("/");
});

/* ======================
   🧊 UI CARD
====================== */

function missionCard(m) {
  return `
  <div class="backdrop-blur bg-white/5 p-6 rounded-2xl border border-white/10">

    <div class="flex justify-between mb-2">
      <h3 class="text-lg">${m.objet}</h3>
      <span class="text-amber-400">${m.budget}€</span>
    </div>

    <p class="text-white/50 text-sm mb-4">${m.ville}</p>

    <p class="mb-3">Status : 
      <span class="
        ${m.status === "OPEN" ? "text-white/50" : ""}
        ${m.status === "IN_PROGRESS" ? "text-yellow-400" : ""}
        ${m.status === "COMPLETED" ? "text-green-400" : ""}
      ">
        ${m.status}
      </span>
    </p>

    ${
      m.status === "OPEN" && currentUser.email !== m.buyer
        ? `<a href="/accept/${m.id}" class="bg-amber-500 px-3 py-1 rounded">Accepter</a>`
        : ""
    }

    ${
      m.status === "IN_PROGRESS" && currentUser.email === m.buyer
        ? `<p class="text-sm text-white/60 mt-2">Code secret : 
            <span class="text-amber-400 text-lg">${m.code}</span>
           </p>`
        : ""
    }

    ${
      m.status === "IN_PROGRESS" && currentUser.email === m.traveler
        ? `
        <form method="POST" action="/validate/${m.id}" class="mt-3 flex gap-2">
          <input name="code" placeholder="Entrer code" class="p-2 bg-black/40 rounded"/>
          <button class="bg-green-500 px-3 rounded">Valider</button>
        </form>
        `
        : ""
    }

    ${
      m.status === "COMPLETED"
        ? `<p class="mt-3 text-green-400 font-bold">✔ Livraison confirmée</p>`
        : ""
    }

  </div>
  `;
}

/* ======================
   🚀 START
====================== */

app.listen(PORT, () => {
  console.log("WAYLO running on port " + PORT);
});
