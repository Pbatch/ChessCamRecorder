// Why detection failed, as a code for the app to show in its own words
export type RecorderErrorCode =
  // The model isn't loaded, or the video has no frame yet
  | "not-ready"
  // The CPU worker crashed (e.g. it ran out of memory), so the model must be loaded again
  | "worker-stopped"
  // The model was deleted
  | "unloaded"
  // Anything else; the message says more
  | "detection-failed";

export class RecorderError extends Error {
  readonly code: RecorderErrorCode;

  constructor(code: RecorderErrorCode, message: string = code, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecorderError";
    this.code = code;
  }
}

export const toRecorderError = (error: unknown): RecorderError => (error instanceof RecorderError) ? error
  : new RecorderError("detection-failed", (error instanceof Error) ? error.message : String(error), { cause: error });
