FROM node:20

WORKDIR /app

COPY package.json .
RUN NODE_OPTIONS="--max-old-space-size=128" npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
