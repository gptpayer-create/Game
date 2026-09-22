FROM node:20-slim
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=2567
EXPOSE 2567

CMD ["node", "index.js"]
