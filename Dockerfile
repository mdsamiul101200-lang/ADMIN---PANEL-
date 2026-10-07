FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY backend ./backend
COPY frontend ./frontend
RUN mkdir -p /app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "backend/server.js"]
