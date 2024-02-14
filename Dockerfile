# We use a multi-stage build to build the benchmark worker and then copy it into
# the inference image. This way we don't have to set up a node environment in
# the inference image.
FROM node:18-slim as build

WORKDIR /app

# Install the worker dependencies
COPY package*.json /app/
RUN npm install
COPY . .

# Build the worker with typescript
RUN npm run build

# Build the benchmark worker into a standalone binary with pkg.
# This way we don't have to set up a node environment in the inference image.
RUN npx pkg -t node18-linux-x64 --out-path ./worker .

# Rebase the image to the inference server image
FROM saladtechnologies/sdnext:dynamic

# And then copy the worker into the inference image
COPY --from=build /app/worker ./worker

# The inference image supports
ENV HOST='0.0.0.0'
ENV PORT=7860

# Override the entrypoint, as we need to launch a little differently in this context
ENTRYPOINT []

# Start the inference server in the background and then run the worker
# in the foreground.

CMD [\
  "/bin/bash",\
  "-c",\
  "${INSTALLDIR}/entrypoint \
  & worker/sdnext-worker"]
