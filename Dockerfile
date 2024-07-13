# Use the official Bun image
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# Copy the entire project
COPY . .

# Install dependencies
FROM base AS build
RUN bun install

# Install jq, curl, Node.js, and sharp dependencies
RUN apt-get update && apt-get install -y jq curl \
    libvips-dev \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs

# Debugging: Show the contents of the Prisma schema file
RUN cd apps/web && cat prisma/schema.prisma

# Install Prisma CLI for generating the client
RUN npm install -g prisma

# Generate Prisma client specifically for gemi-app and check if generated
RUN cd apps/web && npx prisma generate --schema=./prisma/schema.prisma || (echo "Prisma client generation failed" && exit 1)

# Verify Prisma client files
RUN cd apps/web && ls -l node_modules/.prisma || echo "Prisma client files not found"

# Modify prisma.ts file
RUN echo "import { PrismaClient } from '@prisma/client';\n\nlet prisma: PrismaClient;\n\nif (typeof window === 'undefined') {\n  if (process.env.NODE_ENV === 'production') {\n    prisma = new PrismaClient();\n  } else {\n    if (!(global as any).prisma) {\n      (global as any).prisma = new PrismaClient();\n    }\n    prisma = (global as any).prisma;\n  }\n}\n\nexport { prisma };" > apps/web/app/database/prisma.ts

# Build gemi first
RUN cd packages/gemi && bun run build

# Make gemi available globally
RUN ln -s /usr/src/app/packages/gemi/dist/bin/index.js /usr/local/bin/gemi

# Modify gemi-app's package.json to include Prisma generation in build script
RUN cd apps/web && jq '.scripts.build = "npx prisma generate --schema=./prisma/schema.prisma && gemi build"' package.json > temp.json && mv temp.json package.json

# Ensure the root package.json contains a valid script
RUN cat /usr/src/app/package.json

# Now build the rest of the project
RUN cd apps/web && bunx prisma generate --schema=./prisma/schema.prisma || (echo "Prisma client generation failed in final build" && exit 1)
RUN cd apps/web && ls -l node_modules/.prisma || echo "Prisma client files not found in final build"
RUN bun run build
                      
# Ensure the dist directory exists after build
RUN mkdir -p /usr/src/app/dist && cp -r apps/web/dist/* /usr/src/app/dist/
#RUN cp -r apps/web/dist/* /usr/src/app/apps/web/dist/
# Debugging: List contents of /usr/src/app after build
RUN ls -l /usr/src/app
RUN ls -l /usr/src/app/node_modules
RUN ls -l /usr/src/app/dist
RUN ls -l /usr/src/app/dist/server
# Production stage
FROM base AS release
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/dist /usr/src/app/apps/web/dist
COPY --from=build /usr/src/app/apps/web/package.json ./package.json
COPY --from=build /usr/src/app/node_modules/.prisma ./apps/web/node_modules/.prisma
COPY --from=build /usr/src/app/apps/web/prisma ./apps/web/prisma
COPY --from=build /usr/local/bin/gemi /usr/local/bin/gemi
COPY --from=build /usr/src/app/packages/gemi/dist/bin/index.js /usr/src/app/packages/gemi/dist/bin/index.js

# Install sharp dependencies in the production stage
RUN apt-get update && apt-get install -y libvips-dev

# Reinstall sharp for the current platform using bun
RUN bun add sharp

# Set production environment
ENV NODE_ENV=production

# Run the app
USER bun
CMD ["bun", "run", "start"]
