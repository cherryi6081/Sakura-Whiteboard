/**
 * 历史游客容量（**已不再作用于公共临时板**）。
 *
 * 临时板已收敛为「一块公共临时板」：任何匿名访客打开都落到同一个 id，
 * 不再按 `wb_gid` 各建各的，因此 12 块 / 24h 3 块这两条规则不再生效。
 * 常量暂时保留，供历史游客板（只有 `owner_guest_id`、无 `owner_id`）的
 * 兼容逻辑与审计文案引用；新代码不要再用它们限制匿名建板。
 */
export const BOARD_CAPACITY = 12;

/** 见 `BOARD_CAPACITY`：历史常量，公共临时板不再有 24h 建板频率限制。 */
export const GUEST_BOARDS_PER_24H = 3;

/**
 * 公共临时板的固定 id（12 位，符合 `LIMITS.boardIdPattern`）。
 *
 * 所有未登录访客共用这一块板：地址栏、本地缓存、协作房间都以它为准，
 * 任何设备打开都是同一间房。id 常量前后端共用，不要在别处再写一份。
 */
export const PUBLIC_BOARD_ID = 'pub_temp_001';

/** 公共临时板的展示标题（服务端建行与前端游客卡片共用）。 */
export const PUBLIC_BOARD_TITLE = '公共临时板';
