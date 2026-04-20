FROM node:18-alpine

WORKDIR /app

# Зависимости для sharp (native)
RUN apk add --no-cache vips-dev

COPY package*.json ./
RUN npm ci --production

COPY . .

EXPOSE 3001

CMD ["node", "src/index.js"]
