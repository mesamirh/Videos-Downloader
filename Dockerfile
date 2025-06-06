FROM node:20-slim

# Install required dependencies
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg && \
    pip3 install yt-dlp

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy app source
COPY . .

# Create downloads directory
RUN mkdir -p downloads

# Set permissions
RUN chmod -R 755 downloads

# Expose port
EXPOSE 3000

# Start command
CMD ["node", "server.js"]