FROM node:26-alpine AS build
RUN apk add --no-cache python3 make g++
RUN npm install -g corepack@0.36.0 && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

FROM node:26-alpine AS deps
RUN apk add --no-cache python3 make g++
RUN npm install -g corepack@0.36.0 && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:26-alpine
RUN apk add --no-cache nginx gettext
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docker/nginx.conf.template /etc/nginx/nginx.conf.template
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV NODE_ENV=production
EXPOSE 80
ENTRYPOINT ["docker-entrypoint.sh"]
