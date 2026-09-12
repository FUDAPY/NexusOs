import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type ApiSuccess<TData> = { success: true; data: TData };
export type ApiFailure = { success: false; error: string; code?: string };
export type ApiResult<TData> = ApiSuccess<TData> | ApiFailure;

export const ok = <TData>(data: TData): ApiSuccess<TData> => ({ success: true, data });

export const fail = (error: string, code?: string): ApiFailure =>
  code === undefined ? { success: false, error } : { success: false, error, code };

export const sendOk = <TData>(res: Response, data: TData, status = 200): Response =>
  res.status(status).json(ok<TData>(data));

export const sendFail = (res: Response, status: number, error: string, code?: string): Response =>
  res.status(status).json(fail(error, code));

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/** Adapta handlers async a la firma void de Express (evita promesas sin manejar). */
export const asyncHandler =
  (handler: AsyncRequestHandler): RequestHandler =>
  (req, res, next): void => {
    void handler(req, res, next).catch(next);
  };
