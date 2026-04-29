const express = require('express');
const { Client } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// On essaie de se connecter seulement si la variable existe
if (process.env.DATABASE_URL) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Important pour Supabase/Railway
  });

  client.connect()
    .then(() => console.log('Base de données connectée !'))
    .catch(err => console.error('Erreur de connexion DB:', err.message));
} else {
  console.log("Attention : DATABASE_URL manquante, mais je lance quand même le serveur.");
}

app.get('/', (req, res) => {
  res.send('<h1>🚀 Waylo est en ligne !</h1><p>Le serveur fonctionne parfaitement.</p>');
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Serveur prêt sur le port ${port}`);
});
