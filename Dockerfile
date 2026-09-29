# -------------------------------------------------------------
# Estágio 1: Build da Aplicação e do Servidor Backend
# -------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Copia os manifestos de dependências
COPY package.json package-lock.json* ./

# Instala dependências para compilar a aplicação
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copia o código-fonte da aplicação
COPY . .

# Compila o frontend Vite e empacota o backend Express (esbuild)
RUN npm run build

# Remove as dependências de desenvolvimento para manter a imagem enxuta
RUN npm prune --production

# -------------------------------------------------------------
# Estágio 2: Imagem Final de Execução (Produção)
# -------------------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /app

# Configuração de ambiente de produção e porta 8080
ENV NODE_ENV=production
ENV PORT=8080

# Cria usuário não-root por segurança
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copia dependências de produção e artefatos compilados
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Copia configurações opcionais de runtime se presentes
COPY --from=builder /app/firebase-applet-config.json* ./

# Ajusta propriedade dos arquivos
RUN chown -R appuser:appgroup /app

USER appuser

# Expõe a porta 8080
EXPOSE 8080

# Inicia o servidor Node.js
CMD ["node", "dist/server.cjs"]
