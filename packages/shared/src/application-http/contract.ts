import { z } from "zod";

export const APPLICATION_HTTP_CHANNEL = "zcode:application-http-request";
export const APPLICATION_HTTP_CANCEL_CHANNEL = "zcode:application-http-cancel";
export const APPLICATION_HTTP_MAX_BYTES = 16 * 1024 * 1024;
export const applicationHttpRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    path: z.string().min(1).max(8192),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
    contentType: z.enum(["application/json", "application/zip"]).optional(),
    body: z
      .instanceof(ArrayBuffer)
      .refine((value) => value.byteLength <= APPLICATION_HTTP_MAX_BYTES)
      .optional(),
  })
  .strict();
export type ApplicationHttpRequest = z.infer<typeof applicationHttpRequestSchema>;
export interface ApplicationHttpResponse {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
}
/** The host fixes destination, authentication and CSRF. Request data cannot select any of them. */
export interface ApplicationHttpPort {
  request(input: ApplicationHttpRequest): Promise<ApplicationHttpResponse>;
  cancel(requestId: string): Promise<void>;
}
