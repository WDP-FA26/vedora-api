FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

FROM dependencies AS build
WORKDIR /app
COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN npx prisma generate && npm run build

FROM node:24-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
# ffmpeg cuts the audio for video captions; the static npm build can't
# resolve hostnames and isn't needed here.
RUN apk add --no-cache dumb-init ffmpeg
ENV FFMPEG_PATH=/usr/bin/ffmpeg
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
# Migrations take a session advisory lock, which a transaction-mode pooler
# (PgBouncer, Neon's "-pooler" host) cannot hold: prisma then fails with P1002.
# When DIRECT_URL is set, migrations use it and the API keeps DATABASE_URL.
CMD ["sh", "-c", "DATABASE_URL=\"${DIRECT_URL:-$DATABASE_URL}\" npx prisma migrate deploy && (node dist/database/seed-cli.js || echo 'Seed failed; starting the API anyway.') && node dist/main.js"]
