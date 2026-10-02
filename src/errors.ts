export type ErrorCode =
  | 'INVALID_JSON'
  | 'VALIDATION_ERROR'
  | 'POINTER_INVALID'
  | 'POINTER_NOT_FOUND'
  | 'POINTER_PARENT_NOT_FOUND'
  | 'INDEX_OUT_OF_BOUNDS'
  | 'BAD_ARRAY_INDEX'
  | 'OP_NOT_SUPPORTED'
  | 'TEST_FAILED'
  | 'MOVE_INTO_DESCENDANT'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'DOC_EXISTS'
  | 'INTERNAL_ERROR';

export class PatchError extends Error {
  readonly code: ErrorCode;
  readonly opIndex: number;
  readonly path: string;
  readonly from?: string;

  constructor(
    code: ErrorCode,
    message: string,
    opIndex: number,
    path: string,
    from?: string,
  ) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    this.opIndex = opIndex;
    this.path = path;
    this.from = from;
  }
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
