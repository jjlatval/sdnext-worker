import { SQSClient, DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import {
  Text2ImageRequest,
  ServerStatus,
  InpaintingRequest,
  Image2ImageRequest,
  AnyRequest,
  AnyResponse,
} from "./types";
import { exec } from "node:child_process";
import os from "node:os";
import * as fs from "fs/promises";
import { Buffer } from "buffer";

const {
  METHODS = "[\"txt2img\", \"img2img\"]",
  LOAD_REFINER = "0",
  SDNEXT_URL = "http://0.0.0.0:7860",
  REPORTING_URL = "",
  REPORTING_AUTH_HEADER = "X-Api-Key",
  REPORTING_API_KEY = "abc1234567890",
  QUEUE_URL = "http://localhost:3001",
  MODEL_CHECKPOINT_NAMES = "{}",
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
  WEBHOOK_CALLBACK_URL = ""
} = process.env;

let modelCheckpointNames = MODEL_CHECKPOINT_NAMES;
if (typeof MODEL_CHECKPOINT_NAMES === "string") {
  modelCheckpointNames = JSON.parse(modelCheckpointNames);
}

let methods: string [];
try {
  methods = JSON.parse(METHODS);
  if (!Array.isArray(methods)) {
    throw new Error("METHODS environment variable is not an array");
  }
} catch (error) {
  console.error("Error parsing METHODS environment variable:", error);
  process.exit(1); // Exit if we cannot parse the methods
}

interface JobRequest extends Partial<Text2ImageRequest & Image2ImageRequest & InpaintingRequest> {
    track_id: string;
    method: string;
    upload_url: string[];
}

interface JobFetchResult {
    jobId: string;
    request: JobRequest;
    messageId: string;
    receiptHandle: string;
    upload_url: string[];
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
//@ts-ignore
const sqsClient = new SQSClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY
  }
});

/**
 * This is the job that will be submitted to the server,
 * set to the configured batch size.
 *
 * You can change this to whatever you want, and there are a lot
 * of options. See the SDNext API docs for more info.
 *
 *  All models have text2image and image2image endpoints. Only inpaingting models have inpainting endpoint.
 */
const txt2imgTestJob: Text2ImageRequest = {
  model_id: "test-model",
  track_id: "test-track",
  prompt: "cat",
  steps: 20,
  width: 1216,
  method: "txt2img",
  height: 896,
  cfg_scale: 7
} as Text2ImageRequest;

const img2imgTestJob: Image2ImageRequest = {
  model_id: "test-model",
  track_id: "test-track",
  prompt: "Make an image of a woman in a forest.",
  steps: 20,
  width: 1216,
  method: "img2img",
  height: 896,
  cfg_scale: 7,
  init_images: ["/app/data/woman.png"]
} as Image2ImageRequest;

const inpaintingTestJob: InpaintingRequest = {
  model_id: "test-model",
  track_id: "test-track",
  prompt: "Make the woman's hair red.",
  init_images: ["/app/data/woman.png"],
  mask: "/app/data/mask.jpeg",
  steps: 20,
  width: 512,
  height: 768,
  method: "inpainting",
  sampler_name: "Euler a",
  resize_mode: 0,
  cfg_scale: 7.5,
  inpainting_fill: 0,
  inpainting_full_res: true,
  inpainting_full_res_padding: 0,
  inpainting_mask_invert: false
} as InpaintingRequest;


/**
 *
 * @returns The GPU type as reported by nvidia-smi
 */
function getGpuType() : Promise<string> {
  return new Promise((resolve, reject) => {
    exec("nvidia-smi --query-gpu=name --format=csv,noheader,nounits", (error, stdout, stderr) => {
      if (error) {
        reject("Error fetching GPU info or nvidia-smi might not be installed");
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 *
 * @returns The number of vCPUs and the total memory in GB
 */
function getSystemInfo() : { vCPU: number, MemGB: number } {
  const vCPU = os.cpus().length;
  const MemGB = Math.round((os.totalmem() / (1024 ** 3)) * 100) / 100; // Convert bytes to GB and round to 2 decimal places

  return { vCPU, MemGB };
}

// Combines the request and response information
interface FullRecord {
  track_id: string;
  request: AnyRequest;
  response: AnyResponse;
  output_urls: string[];
  system_info: {
    vCPU: number;
    MemGB: number;
    gpu: string;
  };
}

/**
 * Retries an async function with exponential backoff.
 * @param fn The async function to retry.
 * @param retries Number of retries.
 * @param delay Initial delay between retries in milliseconds.
 * @param scaleFactor Factor by which to scale the delay after each retry.
 */
async function retryWithExponentialBackoff<T>(fn: () => Promise<T>, retries: number = 3, delay: number = 1000, scaleFactor: number = 2): Promise<T> {
  let attempt = 0;
  let error: any;

  while (attempt < retries) {
    try {
      return await fn(); // Attempt the operation
    } catch (err: any) {
      error = err; // Save the error to rethrow if all retries fail
      console.log(`Attempt ${attempt + 1} failed: ${err?.message}. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay)); // Wait for the specified delay
      delay *= scaleFactor; // Increase the delay for the next attempt
      attempt++;
    }
  }

  console.log("All retry attempts failed.");
  throw error; // Rethrow the last error encountered
}


async function recordResult(record: FullRecord): Promise<void> {
  let response;
  try {
    response = await fetch(REPORTING_URL, {
      method: "POST",
      body: JSON.stringify(record),
      headers: {
        "Content-Type": "application/json",
        [REPORTING_AUTH_HEADER]: REPORTING_API_KEY,
      },
    });

    console.log(`Response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Error response body: ${errorBody}`);
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  } catch (error) {
    console.log("RESPONSE", response);
    console.error("Error recording result:", error);
    throw error;
  }
}


/**
 * This function gets a job from the queue, and returns it in a format that is usable
 * by the SDNext server, along with additional information needed to finish processing the job.
 *
 * @returns A job to submit to the server
 */

async function getJob(): Promise<JobFetchResult | null> {
  const params = {
    QueueUrl: process.env.QUEUE_URL!,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 20,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-ignore
    const { Messages } = await sqsClient.send(new ReceiveMessageCommand(params));

    if (!Messages || Messages.length === 0) {
      console.log("No messages available in the queue.");
      return null;
    }

    const message = Messages[0];
    const body = JSON.parse(message.Body!) as JobRequest;

    // Optionally manipulate the job object here if needed
    // For example, excluding 'upload_url' from the request object to be passed on,
    // but keeping it for other uses like forming upload_urls

    const { upload_url, ...requestWithoutUploadUrl } = body;

    return {
      jobId: body.track_id,
      request: requestWithoutUploadUrl as JobRequest, // This line simplifies the object to its needed form
      messageId: message.MessageId!,
      receiptHandle: message.ReceiptHandle!,
      upload_url: upload_url,
    };
  } catch (error) {
    console.error("Failed to receive messages from SQS:", error);
    return null;
  }
}

/**
 * Deletes a message from the SQS queue using its receipt handle, indicating the message
 * has been successfully processed and does not need to be retained in the queue.
 *
 * @param receiptHandle A unique identifier for the message to be deleted. This identifier
 *                      is different from the message's MessageId and is obtained when
 *                      the message is received from the queue.
 * @returns A promise that resolves when the message is successfully deleted or rejects
 *          if an error occurs during the deletion process.
 */
async function markJobComplete(receiptHandle: string): Promise<void> {
  const deleteParams = {
    QueueUrl: QUEUE_URL, // The URL of the Amazon SQS queue from which messages are deleted.
    ReceiptHandle: receiptHandle, // The receipt handle associated with the message to delete.
  };
  try {
    // Create a new instance of the DeleteMessageCommand with the specified parameters.
    const command = new DeleteMessageCommand(deleteParams);
    // Send the command to the SQS client to delete the message.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-ignore
    await sqsClient.send(command);
    console.log("Message deleted successfully.");
  } catch (error: any) {
    // Handle specific errors if needed
    if (error.name === "InvalidParameterValue" && error.message.includes("ReceiptHandle is invalid")) {
      console.warn("Message deletion failed due to an expired receipt handle.");
      // Implement retry logic here if necessary
    } else {
      console.error("Error deleting message:", error);
      // You can choose to rethrow the error if necessary
      // throw error;
    }
  }
}

async function fetchImageAsBase64(pathOrUrl: string): Promise<string> {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    // Handle URL
    const response = await fetch(pathOrUrl);
    if (!response.ok) throw new Error(`Failed to fetch ${pathOrUrl}: ${response.statusText}`);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer).toString("base64");
  } else {
    // Handle local file path
    const fileBuffer = await fs.readFile(pathOrUrl);
    return fileBuffer.toString("base64");
  }
}

async function submitJob<TRequest extends AnyRequest, TResponse extends AnyResponse>(job: TRequest): Promise<TResponse> {

  // Validate job
  if (!job.height || job.height <= 0 || job.height > 2048) {
    console.log(`Invalid height ${job.height}.`);
    return {} as TResponse;
  }
  if (!job.width || job.width <= 0 || job.width > 2048) {
    console.log(`Invalid width ${job.width}.`);
    return {} as TResponse;
  }

  // Check if the job requires converting init_images URLs to base64
  if ("init_images" in job && Array.isArray(job.init_images)) {
    // Convert all init_images URLs to base64 strings
    const base64Images = await Promise.all(job.init_images.map(url => fetchImageAsBase64(url)));
    // Update the job with base64 encoded images
    job = { ...job, init_images: base64Images } as TRequest;
  }
  if ("mask" in job) {
    // Convert mask to base64 string
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-ignore
    const base64Mask = await fetchImageAsBase64(job.mask);
    job = { ...job, mask: base64Mask } as TRequest;
  }

  let adjustedJob: any = { ...job };
  // Prefer batch_count over batch_size in cases where VRAM is limited => did not work!
  if ("num_generations" in job) {
    const { num_generations, ...rest } = job;
    adjustedJob = { ...rest, batch_size: num_generations };
  }

  const endpointMap: { [key: string]: string } = {
    "txt2img": "/sdapi/v1/txt2img",
    "img2img": "/sdapi/v1/img2img",
    "inpainting": "/sdapi/v1/img2img",
  };

  const endpoint = endpointMap[adjustedJob.method as keyof typeof endpointMap];
  const url = new URL(endpoint, SDNEXT_URL);

  // In case there are multiple models loaded, there might be a case to switch the model
  if (Object.keys(modelCheckpointNames).length > 1) {
    const optsUrl = new URL("/sdapi/v1/options", SDNEXT_URL);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-ignore
    const optsRequest = {"sd_model_checkpoint": modelCheckpointNames[adjustedJob.model_id]};
    const modelChangeResponse = await fetch(optsUrl.toString(), {
      method: "POST",
      body: JSON.stringify(optsRequest),
      headers: { "Content-Type": "application/json"}
    });
    if (!modelChangeResponse.ok) {
      console.log("Could not switch model");
    }
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    body: JSON.stringify(adjustedJob),
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    console.error(`Failed to submit job: ${response.statusText}`);
    console.log(`Failed job was: ${JSON.stringify(adjustedJob)}`);
    // Kill a misbehaving worker
    process.exit(1);
  }
  return await response.json() as Promise<TResponse>;
}


/**
 * Uploads an image to s3 using the signed url provided by the job
 * @param image The image to upload, base64 encoded
 * @param url The signed url to upload the image to
 *
 * @returns The download url of the uploaded image
 */
async function uploadImage(image: string, url: string): Promise<string> {
  let response;
  try {
    response = await fetch(url, {
      method: "PUT",
      body: Buffer.from(image, "base64"),
      headers: {
        "Content-Type": "image/jpeg",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Return the full URL, minus the query string
    return url.split("?")[0];
  } catch (error) {
    console.error("Upload failed:", error);
    return ""; // or handle the error appropriately
  }
}


/**
 * Uses the status endpoint to get the status of the SDNext server.
 * @returns The status of the SDNext server
 */
async function getServerStatus(): Promise<ServerStatus> {
  const url = new URL("/sdapi/v1/system-info/status?state=true&memory=true&full=true&refresh=true", SDNEXT_URL);
  const response = await fetch(url.toString());
  const json = await response.json();
  return json as ServerStatus;
}

/**
 * Uses the log endpoint to get the last 5 lines of the SDNext server logs.
 * This is used to determine when the model has finished loading.
 * @returns The last 5 lines of the SDNext server logs
 */
async function getSDNextLogs(): Promise<string[]> {
  const url = new URL("/sdapi/v1/log?lines=5&clear=true", SDNEXT_URL);
  const response = await fetch(url.toString());
  const json = await response.json();
  return json as string[];
}

/**
 * Enables the refiner model. This can take quite a while,
 * but must be done before inference can be run.
 */
async function enableRefiner(): Promise<void> {
  console.log("Enabling refiner...");
  const url = new URL("/sdapi/v1/options", SDNEXT_URL);
  await fetch(url.toString(), {
    method: "POST",
    body: JSON.stringify({"sd_model_refiner": "refiner/sd_xl_refiner_1.0.safetensors"}),
    headers: {
      "Content-Type": "application/json"
    },
  });
}

async function sleep(ms: number): Promise<unknown> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let stayAlive = true;
process.on("SIGINT", () => {
  stayAlive = false;
});

process.on("exit", () => {
  /**
   * This is where to put any cleanup code,
   * or a last chance to fire stats off to wherever they live.
   */
});


/**
 * Waits for the SDNext server to start listening at the configured URL.
 */
async function waitForServerToStart(): Promise<void> {
  const maxAttempts = 6000;
  let attempts = 0;
  while (stayAlive && attempts++ < maxAttempts) {
    try {
      await getServerStatus();
      return;
    } catch (e) {
      // console.log(`(${attempts}/${maxAttempts}) Waiting for server to start...`);
      await sleep(1000);
    }
  }
}

/**
 * Waits for the SDNext server to finish loading the model.
 * This is done by checking the logs for the "Startup time:" line.
 */
async function waitForModelToLoad(): Promise<void> {
  const maxAttempts = 600;
  const maxFailures = 10;
  let attempts = 0;
  let failures = 0;
  while (stayAlive && attempts++ < maxAttempts) {
    try {
      const logLines = await getSDNextLogs();
      if (logLines.some((line) => line.includes("Startup time:"))) {
        return;
      } else if (logLines.length > 0) {
        // prettyPrint(logLines);
      }

      console.log(`(${attempts}/${maxAttempts}) Waiting for model to load...`);
    } catch(e) {

      failures++;
      if (failures > maxFailures) {
        throw e;
      }
      console.log(`(${failures}/${maxFailures}) Request failed. Retrying...`);
    }

    await sleep(1000);
  }
  throw new Error("Timed out waiting for model to load");
}

async function notifyWebhook(track_id: string, sample_images: string[]) {
  try {
    const response = await fetch(WEBHOOK_CALLBACK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        "track_id": track_id,
        "sample_images": sample_images
      }),
    });

    if (!response.ok) {
      throw new Error(`Error: ${response.statusText}`);
    }

    await response.json();
  } catch (error: any) {
    console.error("Failed to notify webhook:", error.message);
    if (error.response) {
      console.error(`Server responded with status: ${error.response.status}`);
      try {
        console.log("Failed request body:", JSON.stringify({
          "track_id": track_id,
          "sample_images": sample_images
        }));
        const errorBody = await error.response.text(); // or .json() if the response is JSON
        console.error("Response body:", errorBody);
      } catch (bodyError) {
        console.error("Failed to parse error response body");
      }
    }
  }
}


/**
 * This is a helper function to pretty print an object,
 * useful for debugging.
 * @param obj The object to pretty print
 * @returns
 */
const prettyPrint = (obj: any): void => console.log(JSON.stringify(obj, null, 2));

/**
 * This is the main function that runs the worker.
 */
async function main(): Promise<void> {
  /**
   * We get the GPU type and system info before we start the worker.
   * We intentionally do not put this in a try/catch block, because if it fails,
   * it means there isn't a gpu available, and we want to fail fast.
   */

  let response: AnyResponse;
  let systemInfo: never;
  try {
    const loadStart = Date.now();
    const gpu = await getGpuType();
    const systemInfo = {...getSystemInfo(), gpu };
    console.log("System Info:", JSON.stringify(systemInfo));

    /**
     * This is where we wait for the server to start and the model to load.
     * It can take several minutes.
     */
    await waitForServerToStart();
    await waitForModelToLoad();
    if (["1", "true"].includes(String(LOAD_REFINER).toLowerCase())) {
      await enableRefiner();
    }

    /**
     * We run a single job to verify that everything is working.
     */
    if (methods.indexOf("txt2img") !== -1) {
      response = await submitJob(txt2imgTestJob);
    }
    if (methods.indexOf("img2img") !== -1) {
      response = await submitJob(img2imgTestJob);
    }
    if (methods.indexOf("inpainting") !== -1) {
      response = await submitJob(inpaintingTestJob);
    }
    const loadEnd = Date.now();
    const loadElapsed = loadEnd - loadStart;
    console.log(`Server fully warm in ${loadElapsed}ms`);
  } catch (error) {
    console.error("Failed to initialize:", error);
    // Handle initialization failure (e.g., exit the process or retry initialization)
    process.exit(1); // Or any other logic you deem appropriate
  }

  while (stayAlive) {
    console.log("Fetching Job...");
    const job = await getJob();

    if (!job) {
      console.log("No jobs available. Waiting...");
      await sleep(1000);
      continue;
    }

    let request: AnyRequest;
    switch (job.request.method) {
    case "txt2img":
      request = {
        ...job.request,
        // Assume default values or transform as necessary
        // Ensure all required properties for Text2ImageRequest are provided
      } as Text2ImageRequest;
      break;
    case "img2img":
      request = {
        ...job.request,
        // Ensure all required properties for Image2ImageRequest are provided
      } as Image2ImageRequest;
      break;
    case "inpainting":
      request = {
        ...job.request,
      } as InpaintingRequest;
      break;
    default:
      console.error("Unsupported job method:", job.request.method);
      continue; // Skip to the next iteration if method is unsupported
    }


    const { receiptHandle, jobId } = job;

    console.log("Submitting Job...");
    const jobStart = Date.now();
    // No exponential backoff tries here, it runs on localhost
    response = await submitJob(request);
    const jobEnd = Date.now();
    const jobElapsed = jobEnd - jobStart;
    console.log(`${response?.images?.length || 0} images generated in ${jobElapsed}ms`);

    /**
     * By not awaiting this, we can get started on the next job
     * while the images are uploading.
     */
    const images = response?.images || [];
    if (images.length <= 0) {
      console.log("No images to upload");
      console.log("Response:", response);
      console.log("Job", job);
    }
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-ignore
    Promise.all(images.map((image, i) => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      //@ts-ignore
      return retryWithExponentialBackoff(() => uploadImage(image, job.upload_url[i]));
    })).then(async (downloadUrls) => {
      if (downloadUrls.length === 0) {
        console.log("No download URLs");
      } else {
        // Remove the Base64 images from the response before recording the result
        const responseWithoutImages = { ...response };
        delete responseWithoutImages.images;
        const fullRecord: FullRecord = {
          track_id: jobId,
          request: request,
          response: responseWithoutImages,
          system_info: systemInfo,
          output_urls: downloadUrls
        };
        if (REPORTING_URL) {
          await recordResult(fullRecord);
        }

        // Now that images are uploaded and the result is recorded, notify the webhook
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        //@ts-ignore
        if (WEBHOOK_CALLBACK_URL) {
          try {
            await retryWithExponentialBackoff(() => notifyWebhook(jobId as string, downloadUrls));
          } catch(error: any) {
            console.log("Failed to notify webhook:", error);
            if (error.response) {
              console.error(`Server responded with status: ${error.response.status}`);
              try {
                const errorBody = await error.response.text(); // or .json() if the response is JSON
                console.error("Response body:", errorBody);
              } catch (bodyError) {
                console.error("Failed to parse error response body");
              }
            }
          }
        }
      }
      return downloadUrls;
    }).then(async (downloadUrls) => {
      await retryWithExponentialBackoff(() => markJobComplete(receiptHandle));
      prettyPrint({prompt: request.prompt, track_id: jobId, model_id: request?.model_id, inference_time: jobElapsed, output_urls: downloadUrls});
    });
  }
}

// Start the worker
main();
