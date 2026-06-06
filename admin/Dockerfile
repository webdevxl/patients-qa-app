# Build stage — Next.js static export (output: 'export' -> out/).
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV CI=1 NEXT_TELEMETRY_DISABLED=1
COPY package*.json ./
RUN npm ci
COPY . .
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_ADMIN_USER=admin
ARG NEXT_PUBLIC_ADMIN_PASSWORD=admin
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_ADMIN_USER=$NEXT_PUBLIC_ADMIN_USER \
    NEXT_PUBLIC_ADMIN_PASSWORD=$NEXT_PUBLIC_ADMIN_PASSWORD
RUN npm run build

# Serve stage — nginx serving the static export.
FROM nginx:alpine
COPY --from=build /app/out /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
