declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      /** The caller's own x-request-id, when valid: for log correlation only, never as a key. */
      clientRequestId?: string;
    }
  }
}

export {};
