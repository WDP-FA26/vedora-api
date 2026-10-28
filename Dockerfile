FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM dependencies AS build
WORKDIR /app
COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
# ffmpeg cuts the audio for video captions; the static npm build can't
# resolve hostnames and isn't needed here.
RUN apk add --no-cache dumb-init ffmpeg
ENV FFMPEG_PATH=/usr/bin/ffmpeg
COPY package*.json ./
COPY seed-data ./seed-data
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
# MongoDB has no migrations: the Mongoose schemas declare the collections and
# indexes, and the API creates them on startup.
CMD ["sh", "-c", "(node dist/database/seed-cli.js || echo 'Seed failed; starting the API anyway.') && node dist/main.js"]
