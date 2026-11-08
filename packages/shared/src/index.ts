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

/**
 * 元素级 op 协议（纯类型，服务端裁决逻辑在 C3 实现）。
 *
 * 约定：
 * - `upsert`：整块元素覆盖写；`baseVersion` 为客户端上次看到的版本，新建时为 null。
 * - `delete`：墓碑语义（`isDeleted=true` + 新版本），不物理删除，删除也参与 LWW。
 * - `versionNonce`：同版本时的决胜位（小者胜，见文档 §2.4）。
 */
export type ElementSnapshot = {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
};

export type ElementUpsertOp = {
  kind: "upsert";
  id: string;
  baseVersion: number | null;
  version: number;
  versionNonce: number;
};

export type ElementDeleteOp = {
  kind: "delete";
  id: string;
  baseVersion: number;
  version: number;
  versionNonce: number;
};

export type ElementOp = ElementUpsertOp | ElementDeleteOp;

/** 一次上行批量：同 id 只保留最后一条（C2 的 batcher 保证，C3 入站再按 opId 幂等）。 */
export type OpBatch = {
  boardId: string;
  clientId: string;
  ops: ElementOp[];
};

