# Build stage — export the Expo app as a static web bundle.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV CI=1
COPY package*.json ./
RUN npm ci
COPY . .
# Expo inlines EXPO_PUBLIC_* at build time, so the API URL must be passed here.
ARG EXPO_PUBLIC_API_URL
ENV EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL
RUN npx expo export --platform web

# Serve stage — plain nginx serving the static export.
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
