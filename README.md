# sdnext-benchmark

This project provides a pattern for creating benchmarks with an sdnext container. This example uses a preconfigured [Stable Diffusion XL 1.0 image](https://hub.docker.com/r/saladtechnologies/sdnext-sdxl10).

## Getting Started

To get started with this project, you will need to have Docker installed on your system. Once you have Docker installed, you can run the following command to start the sdnext container:

```bash
docker run --gpus all \
-e BENCHMARK_SIZE=10 \
-e BATCH_SIZE=4 \
saladtechnologies/sdxl-benchmark:latest
```

The `BENCHMARK_SIZE` and `BATCH_SIZE` environment variables can be adjusted to change the size of the benchmark (total images to generate) and the batch size (number of images submitted per request) used for inference. The default values are `10` and `4` respectively.

