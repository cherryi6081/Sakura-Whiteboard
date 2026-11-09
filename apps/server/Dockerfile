# 多阶段构建：build 阶段编译 server + web，runtime 阶段只带生产依赖
# 前端产物由 API 同源托管（WEB_DIST），因此不需要额外的 nginx 服务
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci

COPY apps/server apps/server
COPY apps/web apps/web
COPY packages/shared packages/shared
RUN npm run build -w @whiteboard/server && npm run build -w @whiteboard/web

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 前端静态资源与图片资产落盘目录（compose 里把后者挂成卷）
ENV WEB_DIST=apps/web/dist
ENV STORAGE_ROOT=/app/storage

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev

COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/migrations apps/server/migrations
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/web/dist apps/web/dist

EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
