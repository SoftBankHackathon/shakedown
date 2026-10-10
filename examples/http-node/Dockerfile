FROM node:24-alpine3.24
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY app.mjs ./
USER node
CMD ["node","app.mjs"]
