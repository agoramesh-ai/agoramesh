FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
EXPOSE 3401
CMD ["node", "dist/http.js"]
