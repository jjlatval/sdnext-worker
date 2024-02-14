import {
  Text2ImageRequest,
  ServerStatus,
  SDJob,
  GetJobFromQueueResponse,
  DeleteQueueMessageResponse,
  InpaintingRequest,
  Image2ImageRequest,
  Response
} from "./types";
import { exec } from "node:child_process";
import os from "node:os";

const {
  METHODS = ["txt2img", "img2img"],
  SDNEXT_URL = "http://0.0.0.0:7860",
  REPORTING_URL = "http://localhost:3000",
  REPORTING_AUTH_HEADER = "X-Api-Key",
  REPORTING_API_KEY = "abc1234567890",
  QUEUE_URL = "http://localhost:3001",
  WEBHOOK_CALLBACK_URL = "https://onlyfakes.app/.netlify/functions/handleWebhookResponseGeneration"  // TODO now hardcoded
} = process.env;

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
};

// TODO img2ImgTestJob
// All models that have txt2img also have img2img endpoint, so the testing is not that crucial.


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

/**
 * You can replace this function with your own implementation.
 * Could be submitting stats to a database, or to an api, or just
 * printing to the console.
 * 
 * In this case, we're sending the results to our reporting server.
 */
async function recordResult(result: {
  prompt: string, 
  id: string, 
  inference_time: number, 
  output_urls: string[], 
  system_info: {
    vCPU: number,
    MemGB: number,
    gpu: string
  }}): Promise<void> {
  const url = new URL("/" + REPORTING_URL);
  await fetch(url.toString(), {
    method: "POST",
    body: JSON.stringify(result),
    headers: {
      "Content-Type": "application/json",
      [REPORTING_AUTH_HEADER]: REPORTING_API_KEY,
    },
  });
}


/**
 * This function gets a job from the queue, and returns it in a format that is usable
 * by the SDNext server, along with additional information needed to finish processing the job.
 * 
 * @returns A job to submit to the server
 */
async function getJob(): Promise<{request: Text2ImageRequest | Image2ImageRequest | InpaintingRequest, messageId: string, uploadUrls: string[], jobId: string } | null> {
  const url = new URL(QUEUE_URL);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      [REPORTING_AUTH_HEADER]: REPORTING_API_KEY,
    },
  });
  const queueMessage = await response.json() as GetJobFromQueueResponse;
  if (queueMessage.messages?.length) {
    const job = JSON.parse(queueMessage.messages[0].body) as SDJob;

    return {
      /**
       * We need to return the jobId so we can send it to the reporting server
       * to identify the results of the job.
       */
      jobId: job.id,
      /**
       * We only take the prompt and batch size from the job.
       *  */
      // TODO now hardcoded to be txt2img test job
      request: {
        ...txt2imgTestJob,
        prompt: job.prompt
      },

      /**
       * We need to return the messageId so we can delete the message
       * from the queue when we're done with it.
       */
      messageId: queueMessage.messages[0].messageId,

      /**
       * We need to return the signed upload urls so we can upload the images
       * to s3 when we're done with them.
       */
      uploadUrls: job.upload_url,
    };

  } else {
    return null;
  }
}

/**
 * Deletes a message from the queue, indicating it does not need to be processed again.
 * @param messageId The id of the message to delete from the queue
 * @returns 
 */
async function markJobComplete(messageId: string): Promise<DeleteQueueMessageResponse> {
  const url = new URL(`/${encodeURIComponent(messageId)}`, QUEUE_URL);
  const response = await fetch(url.toString(), {
    method: "DELETE",
    headers: {
      [REPORTING_AUTH_HEADER]: REPORTING_API_KEY,
    },
  });
  const json = await response.json() as DeleteQueueMessageResponse;

  return json;
}

/**
 * Submits a job to the SDNext server and returns the response.
 * @param job The job to submit to the server
 * @returns The response from the server
 */
async function submitText2ImageJob(job: Text2ImageRequest): Promise<Response> {
  // POST to SDNEXT_URL
  const url = new URL("/sdapi/v1/txt2img", SDNEXT_URL);
  const response = await fetch(url.toString(), {
    method: "POST", 
    body: JSON.stringify(job),
    headers: {
      "Content-Type": "application/json"
    },
  });

  const json = await response.json();
  return json as Response;
}

async function submitImage2ImageJob(job: Image2ImageRequest): Promise<Response> {
  const url = new URL("/sdapi/v1/img2img", SDNEXT_URL);
  const response = await fetch(url.toString(), {
    method: "POST",
    body: JSON.stringify(job),
    headers: {
      "Content-Type": "application/json"
    },
  });

  const json = await response.json();
  return json as Response;
}

// Inpainting job uses the same API as image2image
async function submitInpaintingJob(job: InpaintingRequest): Promise<Response> {
  const url = new URL("/sdapi/v1/img2img", SDNEXT_URL);
  const response = await fetch(url.toString(), {
    method: "POST",
    body: JSON.stringify(job),
    headers: {
      "Content-Type": "application/json"
    },
  });

  const json = await response.json();
  return json as Response;
}

/**
 * Uploads an image to s3 using the signed url provided by the job
 * @param image The image to upload, base64 encoded
 * @param url The signed url to upload the image to
 * 
 * @returns The download url of the uploaded image
 */
async function uploadImage(image: string, url: string): Promise<string> {
  await fetch(url, {
    method: "PUT",
    body: Buffer.from(image, "base64"),
    headers: {
      "Content-Type": "image/jpeg",
    },
  });

  // Return the full url, minus the query string
  return url.split("?")[0];
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
      console.log(`(${attempts}/${maxAttempts}) Waiting for server to start...`);
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

    const responseData = await response.json();
    console.log("Webhook notified successfully:", responseData);
  } catch (error: any) {
    console.error("Failed to notify webhook:", error.message);
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

  let response;
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
    await enableRefiner();

    /**
     * We run a single job to verify that everything is working.
     */
    if (METHODS.indexOf("txt2img") !== -1) {
      response = await submitText2ImageJob(txt2imgTestJob);
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

    const { request, messageId, uploadUrls, jobId } = job;

    console.log("Submitting Job...");
    const jobStart = Date.now();

    switch(request.method) {
    case "txt2img":
      response = await submitText2ImageJob(request);
      break;
    case "img2img":
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      //@ts-ignore
      response = await submitImage2ImageJob(request);
      break;
    case "inpainting":
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      //@ts-ignore
      response = await submitInpaintingJob(request);
      break;
    }
    const jobEnd = Date.now();
    const jobElapsed = jobEnd - jobStart;
    console.log(`${response?.images?.length || 0} images generated in ${jobElapsed}ms`);

    /**
     * By not awaiting this, we can get started on the next job
     * while the images are uploading.
     */
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-ignore
    Promise.all(response?.images?.map((image, i) => {
      return uploadImage(image, uploadUrls[i]);
    })).then(async (downloadUrls) => {
      await recordResult({
        id: jobId,
        prompt: request.prompt,
        inference_time: jobElapsed,
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        //@ts-ignore
        output_urls: downloadUrls,
        system_info: systemInfo
      });

      // Now that images are uploaded and the result is recorded, notify the webhook
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      //@ts-ignore
      await notifyWebhook(jobId, downloadUrls);

      return downloadUrls;
    }).then((downloadUrls) => {
      markJobComplete(messageId);
      prettyPrint({prompt: request.prompt, inference_time: jobElapsed, output_urls: downloadUrls});
    });
  }
}

// Start the worker
main();
