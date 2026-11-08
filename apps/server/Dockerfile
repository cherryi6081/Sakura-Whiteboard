# 多阶段构建：build 阶段编译 TS，runtime 阶段只带生产依赖
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN npm ci

COPY apps/server apps/server
COPY packages/shared packages/shared
RUN npm run build -w @whiteboard/server

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev

COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/migrations apps/server/migrations
COPY --from=build /app/packages/shared/dist packages/shared/dist

EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
