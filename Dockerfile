# ----- Base Image -----
FROM node:22-alpine AS base

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the app source code
COPY . .

# ----- Production Image -----
FROM node:22-alpine

WORKDIR /app

# Copy only what we need for production
COPY --from=base /app /app

ENV NODE_ENV=production
EXPOSE 3050

CMD ["npm", "run", "start"]
