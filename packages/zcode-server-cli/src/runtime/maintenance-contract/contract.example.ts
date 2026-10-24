import { readMaintenanceOperation } from "./contract.js";
export async function exampleMaintenanceMarker(path: string) {
  return await readMaintenanceOperation(path);
}
