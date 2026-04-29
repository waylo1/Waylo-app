const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://cdn.tailwindcss.com"></script>
        <title>Waylo | Next Gen</title>
      </head>
      <body class="bg-slate-900 text-white flex items-center justify-center min-h-screen p-6">
        <div class="max-w-md w-full bg-slate-800 border border-slate-700 rounded-3xl p-8 shadow-2xl transform transition hover:scale-105 duration-500">
          <div class="flex justify-center mb-6">
            <div class="bg-amber-400 p-3 rounded-2xl shadow-lg shadow-amber-400/20">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-slate-900" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
          </div>
          <h1 class="text-4xl font-black text-center mb-2 tracking-tighter bg-gradient-to-r from-amber-200 to-amber-500 bg-clip-text text-transparent">WAYLO</h1>
          <p class="text-slate-400 text-center mb-8 text-sm uppercase tracking-widest font-bold">L'innovation est en route</p>
          
          <div class="space-y-4">
            <button class="w-full bg-amber-400 hover:bg-amber-500 text-slate-900 font-black py-4 rounded-2xl transition-all shadow-lg shadow-amber-400/10">
              ACCÉDER AU DASHBOARD
            </button>
            <button class="w-full bg-slate-700 hover:bg-slate-600 text-white font-bold py-4 rounded-2xl transition-all">
              PARAMÈTRES
            </button>
          </div>
          
          <div class="mt-8 pt-6 border-t border-slate-700 text-center text-xs text-slate-500 font-medium uppercase">
            Statut Serveur: <span class="text-emerald-400">● Live</span>
          </div>
        </div>
      </body>
    </html>
  `);
});

app.listen(process.env.PORT || 3000);
