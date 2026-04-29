const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Waylo</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { 
            background: #0f172a; 
            color: white; 
            font-family: sans-serif; 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            height: 100vh; 
            margin: 0; 
          }
          .card { 
            text-align: center; 
            padding: 40px; 
            border: 2px solid #fbbf24; 
            border-radius: 20px; 
            background: #1e293b;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
          }
          h1 { color: #fbbf24; font-size: 3rem; margin: 0; }
          p { color: #94a3b8; font-size: 1.2rem; }
          .btn { 
            display: inline-block; 
            margin-top: 20px; 
            padding: 10px 25px; 
            background: #fbbf24; 
            color: #0f172a; 
            text-decoration: none; 
            border-radius: 50px; 
            font-weight: bold; 
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>WAYLO</h1>
          <p>L'aventure commence ici.</p>
          <a href="#" class="btn">Bientôt disponible</a>
        </div>
      </body>
    </html>
  `);
});

app.listen(port, '0.0.0.0', () => {
  console.log('Serveur Waylo prêt !');
});
