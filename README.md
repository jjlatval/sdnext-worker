# sdnext-worker

This project uses SDNext with a Node application for taking tasks from the queue and recording results.

## Getting Started

To get started with this project, you will need to have Docker installed on your system. Once you have Docker installed, you can run the following command to start the sdnext container:

```bash
docker run --gpus all \
-e REPORTING_URL=https://someurl.com \
-e REPORTING_API_KEY=1234567890 \
-e REPORTING_AUTH_HEADER="X-Api-Key" \
-e QUEUE_URL=https://someurl.com/ \
<your_docker_hub_username>/sdnext-worker:latest
```
or

```bash
docker compose up
```

## Build the image

To build the image, run the following command:

```bash
docker buildx build -t sdnext-worker:latest --provenance=false --output type=docker --platform=linux/amd64 .
```

NB; this will take a while to complete. If you use e.g. MacOS, you might want to run this under `caffeinate -is`.

## Publishing the image to Dockerhub

```bash
export DOCKERHUB_USERNAME=<your_docker_hub_username>
docker tag sdnext-worker:latest ${DOCKERHUB_USERNAME}/sdnext-worker:latest
docker push ${DOCKERHUB_USERNAME}/sdnext-worker:latest
```