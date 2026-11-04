export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found`);
export const forbidden = () => new HttpError(403, "forbidden", "You don't have access to this");
export const unauthorized = () => new HttpError(401, "unauthorized", "Sign in required");
export const conflict = (message: string) => new HttpError(409, "conflict", message);
export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
