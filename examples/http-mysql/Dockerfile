FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache curl && curl --fail --silent --show-error https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /app/rds-ca.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-ca.pem
COPY package*.json ./
RUN npm ci --omit=dev
COPY app.mjs ./
USER node
EXPOSE 3000
CMD ["node","app.mjs"]
