FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --production

ENV NODE_ENV=production
EXPOSE 3100
VOLUME ["/app/sessions"]

CMD ["node", "dist/index.js"]
