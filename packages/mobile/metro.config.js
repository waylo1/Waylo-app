// Metro — configuration monorepo (npm workspaces).
// Sans ceci, Metro ne résout pas @waylo/shared (hoisté à la racine) ni ne surveille
// les paquets frères. Boilerplate officiel Expo « Working with monorepos ».
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Surveiller tout le monorepo (pour @waylo/shared et les futurs paquets).
config.watchFolders = [workspaceRoot];
// 2. Résolution des modules : node_modules du paquet PUIS node_modules hoistés à la racine.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
