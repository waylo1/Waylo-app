const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ======================
   🧠 STATE (IN MEMORY)
====================== */

let users = [];
let missions = [];
let currentUser = null;

/* ======================
   🧾 LEGAL STATUS ENUM
====================== */

const STATUS = {
  OPEN: "OPEN",
  ACCEPTED: "ACCEPTED",
  IN_PROGRESS: "IN_PROGRESS",
  DELIVERY_PROOF: "DELIVERY_PROOF",
  COMPLETED: "COMPLETED"
};

/* ======================
   🎨 UI
====================== */

function layout(content) {
  return `
  <html>
  <head>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="bg-[#020617] text-white p-8">

    <h1 class="text-3xl mb-6 bg-gradient-to-r from-amber-400 to-yellow-600 text-transparent bg-clip-text">
      WAYLO • Mandat sécurisé
    </h1>

    ${content}

  </body>
  </html>
  `;
}

/* ======================
   🔐 AUTH
====================== */

app.get("/", (req, res) => {
  if (!currentUser) return res.send(layout(auth()));
  res.send(layout(dashboard()));
});

function auth() {
  return `
  <div class="grid grid-cols-2 gap-6">

    <form method="POST" action="/login" class="bg-white/5 p-6 rounded-xl">
      <input name="email" placeholder="email" class="w-full mb-2 p-2 bg-black/40"/>
      <input name="password" type="password" placeholder="password" class="w-full mb-2 p-2 bg-black/40"/>
      <button class="bg-amber-500 p-2 w-full">Login</button>
    </form>

    <form method="POST" action="/register" class="bg-white/5 p-6 rounded-xl">
      <input name="email" placeholder="email" class="w-full mb-2 p-2 bg-black/40"/>
      <input name="password" type="password" placeholder="password" class="w-full mb-2 p-2 bg-black/40"/>
      <button class="bg-green-500 p-2 w-full">Register</button>
    </form>

  </div>
  `;
}

app.post("/register", (req, res) => {
  users.push(req.body);
  currentUser = req.body;
  res.redirect("/");
});

app.post("/login", (req, res) => {
  const user = users.find(u => u.email === req.body.email && u.password === req.body.password);
  if (user) currentUser = user;
  res.redirect("/");
});

/* ======================
   📦 MISSIONS (MANDAT)
====================== */

function dashboard() {
  return `
  <a href="/logout" class="text-red-400">Logout</a>

  ${createMission()}

  <div class="mt-6 space-y-4">
    ${missions.map(m => missionCard(m)).join("")}
  </div>
  `;
}

function createMission() {
  return `
  <form method="POST" action="/mission" class="bg-white/5 p-4 rounded-xl">
    <input name="objet" placeholder="Objet à acheter" class="w-full mb-2 p-2 bg-black/40"/>
    <input name="ville" placeholder="Ville" class="w-full mb-2 p-2 bg-black/40"/>
    <input name="budget" placeholder="Budget €" class="w-full mb-2 p-2 bg-black/40"/>

    <button class="bg-amber-500 p-2 w-full">Créer mandat</button>
  </form>
  `;
}

app.post("/mission", (req, res) => {
  missions.push({
    id: Date.now(),
    ...req.body,
    buyer: currentUser.email,
    traveler: null,
    status: STATUS.OPEN,
    escrow: "PENDING", // simulation PSP
    otp: null,
    proof: null
  });
  res.redirect("/");
});

/* ======================
   🤝 ACCEPTATION MANDAT
====================== */

app.get("/accept/:id", (req, res) => {
  const m = missions.find(x => x.id == req.params.id);

  if (m && m.status === STATUS.OPEN) {
    m.status = STATUS.ACCEPTED;
    m.traveler = currentUser.email;
  }

  res.redirect("/");
});

/* ======================
   🚀 START MISSION
====================== */

app.get("/start/:id", (req, res) => {
  const m = missions.find(x => x.id == req.params.id);

  if (m && m.status === STATUS.ACCEPTED) {
    m.status = STATUS.IN_PROGRESS;
    m.otp = Math.floor(1000 + Math.random() * 9000);
  }

  res.redirect("/");
});

/* ======================
   🔐 PROOF (PPR)
====================== */

app.post("/proof/:id", (req, res) => {
  const m = missions.find(x => x.id == req.params.id);

  if (m && m.status === STATUS.IN_PROGRESS) {
    m.status = STATUS.DELIVERY_PROOF;
    m.proof = "uploaded"; // simulation image/gps
  }

  res.redirect("/");
});

/* ======================
   ✅ VALIDATION OTP
====================== */

app.post("/validate/:id", (req, res) => {
  const m = missions.find(x => x.id == req.params.id);

  if (m && m.otp == req.body.otp) {
    m.status = STATUS.COMPLETED;
    m.escrow = "RELEASED"; // simulation PSP release
  }

  res.redirect("/");
});

/* ======================
   🧊 UI CARD
====================== */

function missionCard(m) {
  return `
  <div class="bg-white/5 p-4 rounded-xl">

    <div class="flex justify-between">
      <b>${m.objet}</b>
      <span>${m.budget}€</span>
    </div>

    <p class="text-sm text-white/50">${m.ville}</p>

    <p>Status: ${m.status}</p>
    <p class="text-xs text-white/40">Escrow: ${m.escrow}</p>

    ${
      m.status === STATUS.OPEN && m.buyer !== currentUser.email
        ? `<a href="/accept/${m.id}" class="text-amber-400">Accepter mandat</a>`
        : ""
    }

    ${
      m.status === STATUS.ACCEPTED && m.traveler === currentUser.email
        ? `<a href="/start/${m.id}" class="text-green-400">Démarrer mission</a>`
        : ""
    }

    ${
      m.status === STATUS.IN_PROGRESS && m.traveler === currentUser.email
        ? `
        <form method="POST" action="/proof/${m.id}">
          <button class="bg-blue-500 px-2 py-1 mt-2">Envoyer preuve</button>
        </form>`
        : ""
    }

    ${
      m.status === STATUS.IN_PROGRESS && m.buyer === currentUser.email
        ? `<p class="text-amber-400">Code OTP: ${m.otp}</p>`
        : ""
    }

    ${
      m.status === STATUS.DELIVERY_PROOF && m.buyer === currentUser.email
        ? `
        <form method="POST" action="/validate/${m.id}">
          <input name="otp" placeholder="OTP" class="p-1 bg-black/40"/>
          <button class="bg-green-500 px-2">Valider</button>
        </form>`
        : ""
    }

    ${
      m.status === STATUS.COMPLETED
        ? `<p class="text-green-400">✔ Mission validée (fonds libérés)</p>`
        : ""
    }

  </div>
  `;
}

app.get("/logout", (req, res) => {
  currentUser = null;
  res.redirect("/");
});

/* ======================
   🚀 START
====================== */

app.listen(PORT, () => {
  console.log("WAYLO running on " + PORT);
});