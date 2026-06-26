# ---------- build the React UI ----------
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build      # -> /web/dist

# ---------- runtime: Express API + built UI ----------
FROM node:20-alpine
RUN apk add --no-cache git tar      # git: history; tar: download-all bundle
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/ ./
COPY --from=web /web/dist ./public
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "index.js"]
