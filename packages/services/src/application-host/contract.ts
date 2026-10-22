import { createServiceDescriptor } from "../descriptors.js";

/** Trusted optional application bridge. Native execution semantics never enter this channel. */
export interface IApplicationHostService {
  call(method: string, input: unknown): Promise<unknown>;
}
export const IApplicationHostService =
  createServiceDescriptor<IApplicationHostService>("application-host");
