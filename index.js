const express = require('express');
const { Client } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// Connexion à ta base de données Supabase via la variable Railway
const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

client.connect()
  .then(() => console.log('Connecté à Supabase avec succès !'))
  .catch(err => console.error('Erreur de connexion à la base de données', err.stack));

app.get('/', (req, res) => {
  res.send('Waylo est en ligne ! La connexion à la base de données est configurée.');
});

app.listen(port, () => {
  console.log(`Application Waylo lancée sur le port ${port}`);
});
