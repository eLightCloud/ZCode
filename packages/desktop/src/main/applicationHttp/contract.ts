export interface ApplicationHttpLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}
export interface ApplicationHttpRegistrationOptions {
  logger: ApplicationHttpLogger;
}
