# The Magnus relay in a container (for hosts that run containers, e.g. Railway).
# Build the phone app first (npm run build -w @magnus/phone) so public/ is filled.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
COPY public ./public
ENV PORT=8080 HOST=0.0.0.0 DATA_FILE=/app/data/rooms.json
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
