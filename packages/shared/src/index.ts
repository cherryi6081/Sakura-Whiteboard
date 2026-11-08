import { z } from 'zod';

export const BOARD_ROLES = ['owner', 'editor', 'viewer'] as const;
export type BoardRole = (typeof BOARD_ROLES)[number];

export const SHARE_PERMISSIONS = ['read', 'edit'] as const;
export type SharePermission = (typeof SHARE_PERMISSIONS)[number];

export const OP_KINDS = ['upsert', 'delete', 'zindex'] as const;
export type OpKind = (typeof OP_KINDS)[number];

/** 与 `0001_init.sql` 中 `elements.type` 的 check 约束保持一致。 */
export const ELEMENT_TYPES = ['rectangle', 'ellipse', 'diamond', 'arrow', 'text', 'freedraw', 'note'] as const;

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

/* ------------------------------------------------------------------------------------
 * 元素级 op 协议：zod schema 为唯一来源，类型一律 `z.infer` 派生。
 *
 * 约定：
 * - `upsert`：整块元素覆盖写；`baseVersion` 为客户端上次看到的版本，新建时为 null。
 * - `delete`：墓碑语义（`is_deleted=true` + 新版本），不物理删除，删除也参与 LWW。
 * - `versionNonce`：同版本时的决胜位（**小者胜**，见文档 §2.4）。
 * - `opId`：客户端生成（UUID），服务端以它做 Redis 幂等键。
 * ------------------------------------------------------------------------------------ */

export const elementTypeSchema = z.enum(ELEMENT_TYPES);
export type ElementType = z.infer<typeof elementTypeSchema>;

/** 派生 op 时的"上一帧"快照，不含渲染数据。 */
export const elementSnapshotSchema = z.object({
  id: z.string().min(1).max(128),
  type: elementTypeSchema.optional(),
  version: z.number().int().positive(),
  versionNonce: z.number().int().nonnegative(),
  isDeleted: z.boolean(),
});
export type ElementSnapshot = z.infer<typeof elementSnapshotSchema>;

const opBaseShape = {
  opId: z.string().min(1).max(64),
  id: z.string().min(1).max(128),
  type: elementTypeSchema,
  baseVersion: z.number().int().nonnegative().nullable(),
  version: z.number().int().positive(),
  versionNonce: z.number().int().nonnegative(),
};

export const elementUpsertOpSchema = z.object({
  ...opBaseShape,
  kind: z.literal('upsert'),
  /** 整块元素（Excalidraw 元素对象），落库到 `elements.data`。 */
  data: z.record(z.unknown()),
  /** 分数索引字符串，落库到 `elements.zindex_key`。 */
  zindexKey: z.string().min(1).max(256),
});
export type ElementUpsertOp = z.infer<typeof elementUpsertOpSchema>;

export const elementDeleteOpSchema = z.object({
  ...opBaseShape,
  kind: z.literal('delete'),
  baseVersion: z.number().int().nonnegative(),
});
export type ElementDeleteOp = z.infer<typeof elementDeleteOpSchema>;

export const elementOpSchema = z.discriminatedUnion('kind', [elementUpsertOpSchema, elementDeleteOpSchema]);
export type ElementOp = z.infer<typeof elementOpSchema>;

/** 一次上行批量：同 id 只保留最后一条（C2 的 batcher 保证，服务端按 opId 再幂等）。 */
export const opSubmitSchema = z.object({
  boardId: z.string().regex(LIMITS.boardIdPattern),
  clientId: z.string().min(1).max(64),
  ops: z.array(elementOpSchema).min(1).max(LIMITS.opBatchMax),
});
export type OpBatch = z.infer<typeof opSubmitSchema>;
