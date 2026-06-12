const fs = require('fs');
const path = require('path');

const ORDRES_FILE = path.join(__dirname, 'ordres.txt');

console.log("--- Agent Waylo V2 Initialisé ---");

function surveillerOrdres() {
    if (fs.existsSync(ORDRES_FILE)) {
        const ordre = fs.readFileSync(ORDRES_FILE, 'utf8').trim();
        if (ordre !== "") {
            console.log(`Action reçue : ${ordre}`);
            // Ici, nous traiterons l'ordre spécifié
            executeAction(ordre);
            // On vide le fichier après traitement pour éviter la répétition
            fs.writeFileSync(ORDRES_FILE, "");
        }
    }
}

function executeAction(cmd) {
    // Logique d'exécution simplifiée
    console.log(`Exécution de la mission : ${cmd}`);
}

setInterval(surveillerOrdres, 2000); // Vérification toutes les 2 secondes