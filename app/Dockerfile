# ---------- build the React UI ----------
FROM node:26-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build      # -> /web/dist

# ---------- runtime: Express API + built UI ----------
FROM node:26-alpine
RUN apk add --no-cache git tar      # git: history; tar: download-all bundle
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=web /web/dist ./public
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "index.js"]
