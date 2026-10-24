import type { NativeAppFactory, ZCodeAppOptions } from "./contract.js";
/** 宿主传入既有构造器；不在合同导入时初始化 IO/Provider。 */
export async function withNativeApp(
  createApp: NativeAppFactory,
  options: ZCodeAppOptions,
  input: string,
) {
  const app = await createApp(options);
  try {
    return await app.sendInput(input);
  } finally {
    await app.close?.();
  }
}
