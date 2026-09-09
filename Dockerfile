FROM public.ecr.aws/docker/library/node:22-slim
LABEL "language"="nodejs"
WORKDIR /src
COPY . .
RUN npm ci --omit=dev
EXPOSE 8080
CMD ["./node_modules/.bin/tsx", "contractor/server.ts"]
