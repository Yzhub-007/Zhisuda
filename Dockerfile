# 魔搭 Docker 创空间镜像。构建上下文为仓库根目录；应用代码在 知速达-App/。
# 基础镜像可用 --build-arg BASE_IMAGE=... 替换（例如平台推荐的国内镜像源）。
ARG BASE_IMAGE=node:22-slim
FROM ${BASE_IMAGE}

WORKDIR /app/知速达-App
ENV NODE_ENV=production

# 先装依赖以利用构建缓存；不运行依赖的安装脚本，也不装可选依赖。
COPY 知速达-App/package.json 知速达-App/package-lock.json ./
RUN npm ci --ignore-scripts --omit=optional && npm cache clean --force

COPY 知速达-App/server.js ./
COPY 知速达-App/lib ./lib
COPY 知速达-App/public ./public

# 公开部署模式：监听 0.0.0.0:7860。写请求默认只接受与访问域名同源的来源；
# 拿到创空间的准确域名后，建议在平台环境变量里设置 ZHISUDA_ALLOWED_ORIGINS=https://域名 收紧为名单。
# 镜像里不预设域名，也不会放开所有来源。
# 数据目录指向平台的持久化路径；不要在这里放任何密钥。
ENV PORT=7860 \
    ZHISUDA_PUBLIC=1 \
    ZHISUDA_DATA_DIR=/mnt/workspace/zhisuda

EXPOSE 7860
CMD ["node", "server.js"]
