# Image de staging — backend Waylo (Fastify + Prisma).
FROM node:20-slim
WORKDIR /app

# OpenSSL : requis par les moteurs Prisma sur node:slim.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
# prisma/schema.prisma AVANT npm ci : le postinstall (`prisma generate`,
# package.json) s'exécute pendant `npm ci` et échoue si le schéma est absent.
COPY prisma ./prisma
# tsx + prisma CLI sont en devDependencies mais REQUIS au runtime (start via tsx,
# migrate deploy) → on force leur installation malgré NODE_ENV=production.
RUN npm ci --include=dev || npm install --include=dev

COPY . .
RUN npx prisma generate

# Exécution non privilégiée : l'utilisateur `node` existe dans l'image officielle.
RUN chown -R node:node /app
USER node

EXPOSE 3000
# Applique les migrations versionnées puis démarre le serveur (cf. src/server.ts).
# Les secrets (DATABASE_URL, STRIPE_*, JWT_SECRET) sont injectés par l'environnement.
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
