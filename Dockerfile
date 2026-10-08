FROM node:20-alpine

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy remaining source code
COPY . .

# Expose server port
EXPOSE 3000

# Start command
CMD ["node", "server.js"]
