FROM node:22-bookworm-slim

# openssl is required by the Prisma engines at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

EXPOSE 3000

# `prisma db push` creates the schema (tables + pgvector extension) on an empty
# database without running any seed — seeding is a separate, later step.
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/src/main"]
