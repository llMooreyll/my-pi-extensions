FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV RELAY_PORT=7443
EXPOSE 7443
USER node
CMD ["node", "src/main.ts"]
