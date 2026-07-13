FROM node:18-alpine
WORKDIR /app
RUN apk add --no-cache git
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p session
ENV PORT=3000
EXPOSE 3000
CMD ["node", "index.js"]
