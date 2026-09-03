# fmsg-mcp in Streamable HTTP mode. Clients send their own fmsg API key as a bearer token.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8765
# FMSG_API_URL must be provided at run time.
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--http", "0.0.0.0:8765"]
