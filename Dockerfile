# Build web + server, then run the API server which also serves the web app.
FROM node:22-alpine AS build
# git only to stamp the build with the commit hash (shown under «Version» in the navigation)
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY server/package.json server/
COPY web/package.json web/
COPY website/package.json website/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production WEB_DIST=/app/web/dist WEBSITE_DIR=/app/website/dist MIGRATIONS_DIR=/app/server/drizzle PORT=3000 DATA_DIR=/app/data
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY server/package.json server/
COPY web/package.json web/
COPY website/package.json website/
RUN npm ci --omit=dev --workspace server --include-workspace-root=false
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/drizzle server/drizzle
COPY --from=build /app/web/dist web/dist
COPY --from=build /app/website/dist website/dist
COPY CHANGELOG.md ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "server/dist/main.js"]
