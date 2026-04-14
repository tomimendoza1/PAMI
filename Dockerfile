FROM mcr.microsoft.com/playwright:v1.57.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV PAMI_BROWSER_CHANNEL=
ENV PAMI_HEADLESS=true

EXPOSE 3000

CMD ["npm", "start"]
