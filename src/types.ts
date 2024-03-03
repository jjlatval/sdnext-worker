interface BaseRequest {
  prompt: string;
  model_id: string;
  method: string;
  num_generations?: number;
  width: number;
  height: number;
  steps: number;
  sampler_name?: string;
  seed?: number;
  cfg_scale: number;
  track_id: string;
  upload_url: string[];
}

interface BaseGenerationRequest extends BaseRequest {
  negative_prompt?: string;
}

export interface InpaintingRequest extends BaseRequest {
  denoising_strength?: number;
  resize_mode?: number;
  mask?: string;
  init_images?: string;
  mask_blur?: number;
  inpainting_fill?: number;
  inpainting_full_res?: boolean;
  inpainting_full_res_padding?: number;
  inpainting_mask_invert?: boolean;
}

export interface Image2ImageRequest extends BaseGenerationRequest {
  init_images: string[];
  denoising_strength?: number;
}
export interface Text2ImageRequest extends BaseGenerationRequest {}

export interface Response {
  track_id: string;
  sample_images?: string[];  // This is what will be sent to Onlyfakes
  images?: string[];  // This is what SDNext returns
}

export type AnyRequest = Text2ImageRequest | Image2ImageRequest | InpaintingRequest;
export type AnyResponse = Response;

export interface OverrideSettings {}

export interface AlwaysonScripts {}

export interface Text2ImageResponse {
  images: string[];
  parameters: Text2ImageRequest;
  info: string;
}

export interface ServerStatus {
  version: Version
  uptime: string
  timestamp: string
  state: State
  memory: Memory
  platform: Platform
  torch: string
  gpu: Gpu2
  optimizations: string[]
  crossatention: string
  device: Device
  backend: string
  pipeline: string
}

export interface Version {
  app: string
  updated: string
  hash: string
  url: string
}

export interface State {
  started: string
  step: string
  jobs: string
  flags: string
  job: string
  "text-info": string | null
}

export interface Memory {
  ram: Ram
  gpu: Gpu
  "gpu-active": GpuActive
  "gpu-allocated": GpuAllocated
  "gpu-reserved": GpuReserved
  "gpu-inactive": GpuInactive
  events: Events
  utilization: number
}

export interface Ram {
  free: number
  used: number
  total: number
}

export interface Gpu {
  free: number
  used: number
  total: number
}

export interface GpuActive {
  current: number
  peak: number
}

export interface GpuAllocated {
  current: number
  peak: number
}

export interface GpuReserved {
  current: number
  peak: number
}

export interface GpuInactive {
  current: number
  peak: number
}

export interface Events {
  retries: number
  oom: number
}

export interface Platform {
  arch: string
  cpu: string
  system: string
  release: string
  python: string
}

export interface Gpu2 {
  device: string
  cuda: string
  cudnn: number
  driver: string
}

export interface Device {
  active: string
  dtype: string
  vae: string
  unet: string
}

/**
 * These are types for interacting with our
 * queue service.
 */
export type QueueMessage = {
  /**
   * This is the receipt handle for the message,
   * and it will need to be URI encoded in order to be used by the api.
   * 
   * It is used to delete the message.
   * 
   * It is not the id of the job.
   */
  messageId: string;

  /**
   * This message body will JSON.parse
   * into an SDJob.
   */
  body: string;
};

export type SDJob = {
  prompt: string;
  id: string;
  track_id: string;
  batch_size: number;
  upload_url: string[];
};