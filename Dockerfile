FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

FROM dependencies AS build
WORKDIR /app
COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN npx prisma generate && npm run build

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache dumb-init
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
