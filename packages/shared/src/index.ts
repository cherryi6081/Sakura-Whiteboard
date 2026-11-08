export const BOARD_ROLES = ['owner', 'editor', 'viewer'] as const;
export type BoardRole = (typeof BOARD_ROLES)[number];

export const SHARE_PERMISSIONS = ['read', 'edit'] as const;
export type SharePermission = (typeof SHARE_PERMISSIONS)[number];

export const OP_KINDS = ['upsert', 'delete', 'zindex'] as const;
export type OpKind = (typeof OP_KINDS)[number];

export const LIMITS = {
  /** 单条 op 载荷上限（字节） */
  opPayloadBytes: 64 * 1024,
  /** 单次批量补发上限 */
  opBatchMax: 100,
  /** 补拉分页上限 */
  opsPageMax: 500,
  /** 超过该 gap 直接整板重载 */
  resyncThreshold: 500,
  /** 白板 ID 长度与字符集 */
  boardIdPattern: /^[A-Za-z0-9_-]{12}$/,
} as const;

export const ERROR_CODES = {
  NOT_FOUND: 'NOT_FOUND',
  INVALID_INPUT: 'INVALID_INPUT',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  LINK_EXPIRED: 'LINK_EXPIRED',
  ROLE_CHANGED: 'ROLE_CHANGED',
  RATE_LIMITED: 'RATE_LIMITED',
  NO_PERMISSION: 'NO_PERMISSION',
  KICKED: 'KICKED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
